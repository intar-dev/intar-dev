//! `intar-image-cli build`: what a scenario repository's pipeline runs to make
//! one image (#438). It bakes the image with the library the builder uses,
//! checks it as a host checks an image before booting it, and then boots the
//! finished image once the way a run does, until the lab reports ready.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use intar_contracts::bridge_v9::{CheckStatus, LabState};
use intar_contracts::oci::OciDigest;
use intar_contracts::scenario::SpecMode;
use intar_contracts::source::SourceBundleV2;
use intar_image_build::{
    BuildArch, BuildTarget, MachineBuildRequest, QemuBuildConfig, build_machine_image,
    reconstruct_machine_disk, sha256_file_hex, verify_machine_image,
};
use intar_image_scenario::loader::compile;
use zpm::machine::{CMDLINE_FILE, Cache, Plan};
use zpm::{Accel, Arch};

/// A key the booted guest lets in, so it starts SSH as it does for a run.
/// Nobody holds its private half: it was thrown away when this was written.
const NOBODYS_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEj6vP9F5WJTR6eOGYdjGkibJRysQZNdA4emo8hYFNbu intar-image-cli-boot-check";

/// What Kino gives a lab's ready scripts.
const READY_SECONDS: u32 = 300;
/// An emulated guest gets this many times as long, as an emulated bake does.
const EMULATED_BOOT_FACTOR: u32 = 6;
/// How long a guest may take before its ready scripts start.
const BOOT_SECONDS: u64 = 120;

#[derive(Debug, Args)]
pub(crate) struct BuildCommand {
    /// What to build: SCENARIO/MACHINE, image:NAME or base.
    target: String,
    /// The architecture to build for: amd64 or arm64. One that is not this
    /// computer's own is built and booted by emulation.
    #[arg(long)]
    arch: String,
    /// Where the image is written, as an OCI layout's blobs.
    #[arg(long)]
    out: PathBuf,
    /// The repository root.
    #[arg(long, default_value = ".")]
    root: PathBuf,
    /// The build settings as JSON, the builder's own: where the tools are,
    /// the work directories and the caches. Without it the defaults apply.
    #[arg(long)]
    config: Option<PathBuf>,
    /// The Kino binary of the image's architecture; the boot puts it on the
    /// run disk as a host does. An emulated boot gives the lab longer to
    /// become ready, which takes a Kino that knows `ready_seconds`.
    #[arg(long, required_unless_present = "no_boot")]
    kino: Option<PathBuf>,
    /// Bake only. An image that is not a machine is never booted: it has no lab.
    #[arg(long)]
    no_boot: bool,
    /// Seconds the booted image has to report its lab ready.
    #[arg(long)]
    boot_timeout: Option<u64>,
}

/// `intar-image-cli relay <port>`: how a booted guest without internet access
/// reaches this program. QEMU runs it per connection.
#[derive(Debug, Args)]
pub(crate) struct RelayCommand {
    port: u16,
}

pub(crate) fn relay_command(args: &RelayCommand) -> Result<()> {
    zpm::relay::relay(args.port).context("relay the guest's connection")
}

fn target_of(text: &str) -> Result<BuildTarget> {
    if text == "base" {
        return Ok(BuildTarget::Base);
    }
    if let Some(name) = text.strip_prefix("image:") {
        ensure!(!name.is_empty(), "image: needs a name");
        return Ok(BuildTarget::Image(name.to_owned()));
    }
    match text.split_once('/') {
        Some((scenario, machine)) if !scenario.is_empty() && !machine.is_empty() => {
            Ok(BuildTarget::Machine {
                scenario: scenario.to_owned(),
                machine: machine.to_owned(),
            })
        }
        _ => bail!("a target is SCENARIO/MACHINE, image:NAME or base, not '{text}'"),
    }
}

pub(crate) fn build_command(args: &BuildCommand) -> Result<()> {
    let target = target_of(&args.target)?;
    let arch = BuildArch::parse(&args.arch)
        .with_context(|| format!("no image is built for '{}'", args.arch))?;
    let (bundle, _) = compile(&args.root).map_err(|problems| crate::report(&problems))?;
    let host: QemuBuildConfig = match &args.config {
        Some(path) => serde_json::from_slice(
            &std::fs::read(path).with_context(|| format!("read {}", path.display()))?,
        )
        .with_context(|| format!("{} is not a build configuration", path.display()))?,
        None => QemuBuildConfig::default(),
    };
    let config = host.for_arch(arch);

    let output = build_machine_image(&MachineBuildRequest {
        bundle: bundle.clone(),
        target: target.clone(),
        expected_key: None,
        config: config.clone(),
        output_dir: args.out.clone(),
    })?;
    let image = &output.image;
    verify_machine_image(&args.out, &image.manifest_digest)?;
    println!("build_key={}", output.plan.build_key.as_str());
    println!("manifest={}", image.manifest_digest.as_str());
    println!(
        "arch={} accelerator={} stages={} disk_bytes={} chunk_layers={}",
        arch.debian(),
        config.accelerator,
        output.plan.stages.len(),
        image.disk_bytes,
        image.chunk_layers
    );
    println!(
        "base_s={:.1} build_s={:.1} output_s={:.1} log={}",
        output.base_seconds,
        output.build_seconds,
        output.output_seconds,
        output.log_path.display()
    );

    let BuildTarget::Machine { scenario, machine } = &target else {
        return Ok(());
    };
    let Some(kino) = args.kino.as_deref().filter(|_| !args.no_boot) else {
        return Ok(());
    };
    let boot = Boot {
        bundle: &bundle,
        scenario,
        machine,
        image_dir: &args.out,
        manifest: &image.manifest_digest,
        kino,
        arch,
        config: &config,
        seconds: args.boot_timeout,
    };
    let booted = boot.run()?;
    println!(
        "boot_s={:.1} boot_accelerator={} tasks={} passed={}",
        booted.seconds, booted.accelerator, booted.tasks, booted.passed
    );
    Ok(())
}

struct Boot<'a> {
    bundle: &'a SourceBundleV2,
    scenario: &'a str,
    machine: &'a str,
    image_dir: &'a Path,
    manifest: &'a OciDigest,
    kino: &'a Path,
    arch: BuildArch,
    config: &'a QemuBuildConfig,
    seconds: Option<u64>,
}

struct Booted {
    seconds: f64,
    accelerator: &'static str,
    tasks: usize,
    passed: usize,
}

/// `sha256:<hex>` of a file, the form the run engine's cache is keyed by.
fn digest_of(path: &Path) -> Result<String> {
    Ok(format!("sha256:{}", sha256_file_hex(path)?))
}

impl Boot<'_> {
    /// Boots the finished image as a run does and waits for its lab.
    fn run(&self) -> Result<Booted> {
        let declared = self
            .bundle
            .scenarios
            .iter()
            .find(|entry| entry.slug == self.scenario)
            .with_context(|| format!("no scenario '{}'", self.scenario))?;
        let machine = declared
            .machines
            .iter()
            .find(|entry| entry.name == self.machine)
            .with_context(|| format!("no machine '{}' in '{}'", self.machine, self.scenario))?;
        // The namespace comes from the repository's binding; `-` stands in.
        let spec = declared
            .machine_spec(
                &format!("-/{}", declared.slug),
                &machine.name,
                SpecMode::Learn,
            )
            .context("the machine has no spec")?;

        // The run engine's cache, filled with exactly this image: the disk
        // put together from its chunks, as a pull does.
        std::fs::create_dir_all(&self.config.work_root)?;
        let work = tempfile::Builder::new()
            .prefix("boot-")
            .tempdir_in(&self.config.work_root)
            .context("create the boot's directory")?;
        let cache = Cache::new(work.path().join("cache"));
        let verified = verify_machine_image(self.image_dir, self.manifest)?;
        let files = cache
            .entry("machines", self.manifest.as_str())
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        std::fs::create_dir_all(&files)?;
        std::fs::copy(&verified.kernel, files.join("kernel"))?;
        if let Some(initrd) = &verified.initrd {
            std::fs::copy(initrd, files.join("initrd"))?;
        }
        std::fs::write(files.join(CMDLINE_FILE), &verified.config.boot.cmdline)?;
        reconstruct_machine_disk(self.image_dir, self.manifest, &files.join("root.raw"))?;

        let spec_file = work.path().join("spec.json");
        std::fs::write(&spec_file, serde_json::to_vec(&spec)?)?;
        let (spec_digest, kino_digest) = (digest_of(&spec_file)?, digest_of(self.kino)?);
        for (kind, digest, source) in [
            ("specs", &spec_digest, spec_file.as_path()),
            ("kino", &kino_digest, self.kino),
        ] {
            let entry = cache
                .entry(kind, digest)
                .map_err(|error| anyhow::anyhow!("{error}"))?;
            if let Some(parent) = entry.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(source, entry).with_context(|| format!("read {}", source.display()))?;
        }

        let (guest, emulated) = match self.arch {
            BuildArch::Amd64 => (Arch::X86_64, Arch::host() != Some(Arch::X86_64)),
            BuildArch::Arm64 => (Arch::Aarch64, Arch::host() != Some(Arch::Aarch64)),
        };
        let accel = if emulated {
            Accel::Tcg
        } else {
            Accel::detect(guest).map_err(|error| anyhow::anyhow!("{error}"))?
        };
        let factor = if emulated { EMULATED_BOOT_FACTOR } else { 1 };
        let seconds = self
            .seconds
            .unwrap_or((BOOT_SECONDS + u64::from(READY_SECONDS)) * u64::from(factor));
        // An emulated guest is several times slower than a learner's; its lab
        // gets that much longer to become ready.
        let ready_seconds = emulated.then_some(READY_SECONDS * EMULATED_BOOT_FACTOR);
        let relay = std::env::current_exe().context("find this program's own file")?;
        let run = work.path().join("run");
        let started = Instant::now();
        let mut running = zpm::machine::start(
            Path::new(guest.qemu_binary()),
            &self.config.layered.qemu_img_binary,
            &cache,
            &run,
            &Plan {
                name: &machine.name,
                image: self.manifest.as_str(),
                spec: &spec_digest,
                kino: &kino_digest,
                cpu_millis: u64::from(machine.cpu_millis),
                memory_mib: u64::from(machine.memory_mib),
                disk_mib: u64::from(machine.disk_mib),
                egress: machine.egress,
                relay: &relay,
                authorized_keys: &[NOBODYS_KEY.to_owned()],
                on: Some((guest, accel)),
                ready_seconds,
            },
            // Nobody types `intar` in this guest.
            |_| None,
        )
        .map_err(|error| anyhow::anyhow!("{error}"))?;

        let deadline = started + Duration::from_secs(seconds);
        // What the guest last said about each ready script, to say each change once.
        let mut said: Vec<(String, CheckStatus)> = Vec::new();
        let mut heard = false;
        let outcome = loop {
            let mut latest = None;
            while let Ok(report) = running.reports.reports.try_recv() {
                latest = Some(report);
            }
            if let Some(report) = latest {
                let waited = started.elapsed().as_secs();
                if !heard {
                    heard = true;
                    eprintln!("boot: {waited} s: the guest's Kino reports");
                }
                let now: Vec<(String, CheckStatus)> = report
                    .lab
                    .ready
                    .iter()
                    .map(|ready| (ready.name.clone(), ready.status))
                    .collect();
                for (index, (name, status)) in now.iter().enumerate() {
                    if said.get(index) != Some(&(name.clone(), *status)) {
                        eprintln!("boot: {waited} s: ready '{name}': {status:?}");
                        let tail = report.lab.ready[index].tail.trim();
                        if *status != CheckStatus::Pass && !tail.is_empty() {
                            for line in tail.lines().rev().take(3).collect::<Vec<_>>().iter().rev()
                            {
                                eprintln!("boot:   {line}");
                            }
                        }
                    }
                }
                said = now;
                if let Some(reason) = report.failed {
                    break Err(format!("the guest failed to start: {reason}"));
                }
                match report.lab.state {
                    LabState::Ready => break Ok(report.lab),
                    LabState::Failed => {
                        break Err(format!(
                            "the lab failed to start: {}",
                            report.lab.failure.as_deref().unwrap_or("no reason given")
                        ));
                    }
                    LabState::Preparing => {}
                }
            }
            if !running.is_running() {
                // A guest that cannot read its boot document turns itself
                // off without a word: it does not know where to report.
                let silent = if heard || ready_seconds.is_none() {
                    ""
                } else {
                    " and never reported; a Kino older than `ready_seconds`, which an emulated boot sets, refuses its boot document"
                };
                break Err(format!(
                    "the machine stopped before its lab was ready{silent}"
                ));
            }
            if Instant::now() >= deadline {
                break Err(format!("the lab was not ready after {seconds} s"));
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        let waited = started.elapsed().as_secs_f64();
        running.stop();
        match outcome {
            Ok(lab) => Ok(Booted {
                seconds: waited,
                accelerator: accel.qemu_name(),
                tasks: lab.tasks.len(),
                passed: lab
                    .tasks
                    .iter()
                    .filter(|task| task.status == CheckStatus::Pass)
                    .count(),
            }),
            Err(reason) => {
                // The console says why; the directory goes with this function.
                let console = std::fs::read(run.join("serial.log")).unwrap_or_default();
                let console = String::from_utf8_lossy(&console);
                let tail: Vec<&str> = console.lines().rev().take(40).collect();
                for line in tail.into_iter().rev() {
                    eprintln!("console: {line}");
                }
                bail!("the finished image does not run: {reason}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::{NOBODYS_KEY, target_of};
    use intar_image_build::BuildTarget;

    #[test]
    fn a_target_is_a_machine_an_image_or_the_base() {
        assert_eq!(target_of("base").unwrap(), BuildTarget::Base);
        assert_eq!(
            target_of("image:k3s").unwrap(),
            BuildTarget::Image("k3s".to_owned())
        );
        assert_eq!(
            target_of("broken-nginx/webserver").unwrap(),
            BuildTarget::Machine {
                scenario: "broken-nginx".to_owned(),
                machine: "webserver".to_owned()
            }
        );
        for wrong in ["", "webserver", "image:", "/webserver", "broken-nginx/"] {
            assert!(target_of(wrong).is_err(), "{wrong:?}");
        }
    }

    #[test]
    fn the_boot_key_is_one_public_key_line() {
        assert!(NOBODYS_KEY.starts_with("ssh-ed25519 "));
        assert!(!NOBODYS_KEY.contains('\n'));
    }
}
