//! One machine of a run, from the files in the local cache to a running
//! guest: the pieces of this crate put together in the order a run needs.
//!
//! The cache holds what a pull stores, by digest:
//! `machines/<hex>/{kernel,initrd,root.raw}`, `kino/<hex>` and `specs/<hex>`.
//! The caller fills it ([`Cache::entry`] says where); a machine whose files
//! are missing is refused with [`Error::NotCached`].
//
// ponytail: one machine per run. QEMU's built-in network gives every guest
// the same private address and no way to reach another guest; several
// machines need the app's own network (#408).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use intar_contracts::guest::GuestHostV3;
use intar_contracts::run_cli::{RunCliRequestV1, RunCliResponseV1};

use crate::broker::{RunCliBroker, serve_tcp};
use crate::preflight::{Has, Needs, check};
use crate::reports::{TcpReports, listen_tcp};
use crate::rundisk::{Boot, boot_json, write_recording_disk, write_run_disk};
use crate::{
    Accel, Arch, Disk, DiskFormat, Error, HostLink, Machine, UserNetwork, Vm, create_overlay,
};

/// The guest's side of QEMU's built-in network. The gateway is where the
/// guest reaches this computer's loopback interface.
const NETWORK: &str = "10.77.52.0/28";
const GATEWAY: &str = "10.77.52.1";
const GUEST: &str = "10.77.52.2";
const DNS: &str = "10.77.52.3";
/// Where a guest without internet access reaches this computer instead of
/// the gateway.
const HOST_LINK: &str = "10.77.52.4";
/// The overlay and the two small disks; the image itself is in the cache.
const RUN_DISK_MIB: u64 = 512;

/// Where pulled files are kept.
pub struct Cache {
    root: PathBuf,
}

/// The files of one machine image.
pub struct ImageFiles {
    pub kernel: PathBuf,
    pub initrd: Option<PathBuf>,
    pub root: PathBuf,
    /// The kernel command line the image was published with, when the pull
    /// kept it and it is one plain line.
    pub cmdline: Option<String>,
}

/// The name of the file that holds an image's kernel command line.
pub const CMDLINE_FILE: &str = "cmdline";
/// No command line an image is published with comes near this.
const MAX_CMDLINE_BYTES: usize = 512;

/// A command line as an image may state it: one line of printable ASCII.
fn plain_cmdline(text: &str) -> Option<String> {
    let line = text.trim_end_matches('\n');
    let plain = !line.is_empty()
        && line.len() <= MAX_CMDLINE_BYTES
        && line
            .bytes()
            .all(|byte| byte == b' ' || byte.is_ascii_graphic());
    plain.then(|| line.to_owned())
}

impl Cache {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The directory or file for `digest` under `kind`. A digest is used as
    /// a path only when it is exactly `sha256:` and 64 hex digits.
    pub fn entry(&self, kind: &str, digest: &str) -> Result<PathBuf, Error> {
        match digest.strip_prefix("sha256:") {
            Some(hex)
                if hex.len() == 64
                    && hex
                        .bytes()
                        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) =>
            {
                Ok(self.root.join(kind).join(hex))
            }
            _ => Err(Error::NotCached(format!(
                "{digest:?} is not a sha256 digest"
            ))),
        }
    }

    fn missing(what: &str) -> Error {
        Error::NotCached(format!("{what} is not on this computer yet."))
    }

    pub fn image(&self, digest: &str) -> Result<ImageFiles, Error> {
        let dir = self.entry("machines", digest)?;
        let (kernel, root, initrd) = (dir.join("kernel"), dir.join("root.raw"), dir.join("initrd"));
        if !kernel.is_file() || !root.is_file() {
            return Err(Self::missing("This lab's machine image"));
        }
        let cmdline = std::fs::read_to_string(dir.join(CMDLINE_FILE))
            .ok()
            .and_then(|text| plain_cmdline(&text));
        Ok(ImageFiles {
            kernel,
            initrd: initrd.is_file().then_some(initrd),
            root,
            cmdline,
        })
    }

    pub fn kino(&self, digest: &str) -> Result<Vec<u8>, Error> {
        std::fs::read(self.entry("kino", digest)?)
            .map_err(|_| Self::missing("The lab's guest program"))
    }

    pub fn spec(&self, digest: &str) -> Result<Vec<u8>, Error> {
        std::fs::read(self.entry("specs", digest)?)
            .map_err(|_| Self::missing("This lab's description"))
    }
}

/// What to run, as intar's answer to a start names it.
pub struct Plan<'a> {
    pub name: &'a str,
    /// Digests of the machine image, the spec blob and the Kino artifact.
    pub image: &'a str,
    pub spec: &'a str,
    pub kino: &'a str,
    pub cpu_millis: u64,
    pub memory_mib: u64,
    /// The disk the scenario asks for; the image's own size when that is larger.
    pub disk_mib: u64,
    /// False cuts the guest off from the internet and from this computer,
    /// except for its link to the app.
    pub egress: bool,
    /// The program that carries that link: run as `<relay> relay <port>`, it
    /// has to call [`crate::relay::relay`].
    pub relay: &'a Path,
    /// OpenSSH public keys that may log in; none starts no SSH in the guest.
    pub authorized_keys: &'a [String],
    /// The processor and accelerator to run on. `None` is this computer's
    /// own, accelerated, which is all a learner's lab ever gets; an image
    /// build names them to boot what it built, emulated when the image is
    /// for another processor.
    pub on: Option<(Arch, Accel)>,
}

/// A running machine with its links to this computer. Dropping it stops the
/// machine and closes the links.
pub struct RunningMachine {
    pub name: String,
    /// SSH to the guest, on 127.0.0.1.
    pub ssh_port: u16,
    /// What the guest's Kino says about its boot and its lab.
    pub reports: TcpReports,
    _broker: RunCliBroker,
    vm: Vm,
}

impl RunningMachine {
    pub fn is_running(&mut self) -> bool {
        self.vm.is_running()
    }

    /// Asks the guest to stop and waits a little; then it is killed.
    pub fn stop(self) {
        self.vm.stop(Duration::from_secs(5));
    }
}

/// Starts `plan` in `dir`, which holds this machine's disks and logs.
/// `answer` serves the learner's `intar` command in the guest. `qemu` and
/// `qemu_img` are the binaries to run.
pub fn start(
    qemu: &Path,
    qemu_img: &Path,
    cache: &Cache,
    dir: &Path,
    plan: &Plan<'_>,
    answer: impl Fn(&RunCliRequestV1) -> Option<RunCliResponseV1> + Send + Sync + 'static,
) -> Result<RunningMachine, Error> {
    let (arch, accel) = match plan.on {
        Some(on) => on,
        None => {
            let arch = Arch::host().ok_or_else(|| {
                Error::NoAcceleration(
                    "No machine images exist for this computer's processor.".into(),
                )
            })?;
            (arch, Accel::detect(arch)?)
        }
    };
    // A started fraction of a processor is a whole one to QEMU.
    let cpus = u32::try_from(plan.cpu_millis.div_ceil(1000).max(1)).unwrap_or(u32::MAX);
    check(
        &Needs {
            cpus,
            memory_mib: plan.memory_mib,
            disk_mib: RUN_DISK_MIB,
        },
        &Has::measure(dir),
    )?;
    let image = cache.image(plan.image)?;
    let (spec, kino) = (cache.spec(plan.spec)?, cache.kino(plan.kino)?);

    // A scenario may ask for more disk than its image has.
    let image_mib = std::fs::metadata(&image.root)?.len().div_ceil(1024 * 1024);
    let grow = (plan.disk_mib > image_mib).then_some(plan.disk_mib);

    std::fs::create_dir_all(dir)?;
    // Listen before the guest exists, so its first report is not missed.
    let reports = listen_tcp()?;
    let broker = serve_tcp(answer)?;
    let json = boot_json(&Boot {
        hostname: plan.name,
        ip_cidr: &format!("{GUEST}/28"),
        gateway: GATEWAY,
        dns: &[DNS.to_owned()],
        peers: &BTreeMap::new(),
        authorized_keys: plan.authorized_keys,
        spec: &spec,
        host: Some(GuestHostV3::Tcp {
            address: if plan.egress { GATEWAY } else { HOST_LINK }.to_owned(),
            report_port: reports.port,
            run_cli_port: broker.port,
        }),
        root_resize: grow.is_some(),
    })?;
    let (overlay, run_disk, recordings) = (
        dir.join("root.qcow2"),
        dir.join("run.raw"),
        dir.join("rec.vfat"),
    );
    // A leftover of this run holds the old overlay; it goes before the file does.
    let control = crate::qemu::control_socket(dir);
    crate::qemu::stop_leftover(&control)?;
    let _ = std::fs::remove_file(&overlay);
    create_overlay(qemu_img, &image.root, &overlay, grow)?;
    write_run_disk(&run_disk, &json, &kino)?;
    write_recording_disk(&recordings)?;

    // A free port now; QEMU binds it a moment later.
    let ssh_port = std::net::TcpListener::bind(("127.0.0.1", 0))?
        .local_addr()?
        .port();
    let machine = Machine {
        arch,
        accel,
        cpus,
        memory_mib: plan.memory_mib,
        kernel: image.kernel,
        initrd: image.initrd,
        // The image says how it boots; one pulled before the cache kept that
        // gets the line every image of its architecture has had.
        cmdline: image.cmdline.unwrap_or_else(|| {
            format!(
                "root=/dev/vda rw console={} quiet loglevel=4 systemd.show_status=false",
                arch.console()
            )
        }),
        disks: vec![
            Disk {
                path: overlay,
                format: DiskFormat::Qcow2,
                read_only: false,
            },
            Disk {
                path: run_disk,
                format: DiskFormat::Raw,
                read_only: true,
            },
            Disk {
                path: recordings,
                format: DiskFormat::Raw,
                read_only: false,
            },
        ],
        network: UserNetwork {
            network: NETWORK.to_owned(),
            gateway: GATEWAY.to_owned(),
            dns: DNS.to_owned(),
            guest: GUEST.to_owned(),
            mac: "02:00:00:00:34:02".to_owned(),
            cut_off: (!plan.egress).then(|| HostLink {
                relay: plan.relay.to_owned(),
                address: HOST_LINK.to_owned(),
                ports: vec![reports.port, broker.port],
            }),
        },
        ssh_port,
        vsock_cid: None,
        serial_log: dir.join("serial.log"),
        qmp_socket: control,
    };
    let vm = Vm::start(qemu, &machine, &dir.join("qemu.log"))?;
    Ok(RunningMachine {
        name: plan.name.to_owned(),
        ssh_port,
        reports,
        _broker: broker,
        vm,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn only_a_plain_single_line_is_taken_as_a_command_line() {
        assert_eq!(
            plain_cmdline("root=/dev/vda rw console=ttyAMA0 quiet\n").as_deref(),
            Some("root=/dev/vda rw console=ttyAMA0 quiet")
        );
        for refused in ["", "\n", "a\nb", "tab\there", "caf\u{e9}", &"x".repeat(513)] {
            assert_eq!(plain_cmdline(refused), None, "{refused:?}");
        }
    }

    #[test]
    fn the_cache_finds_files_by_digest_and_says_when_they_are_not_there() {
        let dir = tempfile::tempdir().expect("dir");
        let cache = Cache::new(dir.path());
        let hex = DIGEST.trim_start_matches("sha256:");

        // Nothing pulled yet: each lookup says so in words a learner can read.
        for missing in [
            cache.image(DIGEST).err(),
            cache.kino(DIGEST).err(),
            cache.spec(DIGEST).err(),
        ] {
            assert!(
                matches!(&missing, Some(Error::NotCached(reason)) if reason.contains("not on this computer yet")),
                "{missing:?}"
            );
        }

        let machine = dir.path().join("machines").join(hex);
        std::fs::create_dir_all(&machine).expect("mkdir");
        std::fs::write(machine.join("kernel"), b"k").expect("kernel");
        assert!(
            cache.image(DIGEST).is_err(),
            "a kernel without a root disk is not an image"
        );
        std::fs::write(machine.join("root.raw"), b"r").expect("root");
        let image = cache.image(DIGEST).expect("image");
        assert!(image.initrd.is_none() && image.root.ends_with("root.raw"));
        std::fs::write(machine.join("initrd"), b"i").expect("initrd");
        assert!(cache.image(DIGEST).expect("image").initrd.is_some());

        std::fs::create_dir_all(dir.path().join("specs")).expect("mkdir");
        std::fs::write(dir.path().join("specs").join(hex), b"{}").expect("spec");
        assert_eq!(cache.spec(DIGEST).expect("spec"), b"{}");

        // A digest is never a path: nothing outside the cache is read.
        for hostile in [
            "sha256:../../etc/passwd",
            "../x",
            "sha256:ABCDEF",
            "md5:0123",
            "",
        ] {
            assert!(
                matches!(cache.spec(hostile), Err(Error::NotCached(reason)) if reason.contains("not a sha256")),
                "{hostile}"
            );
        }
    }

    #[test]
    fn a_machine_whose_image_is_not_cached_is_refused_before_anything_starts() {
        let dir = tempfile::tempdir().expect("dir");
        let cache = Cache::new(dir.path().join("cache"));
        let plan = Plan {
            name: "web",
            image: DIGEST,
            spec: DIGEST,
            kino: DIGEST,
            cpu_millis: 1000,
            memory_mib: 64,
            disk_mib: 0,
            egress: true,
            relay: Path::new("relay"),
            authorized_keys: &[],
            on: None,
        };
        let run = dir.path().join("run");
        match start(
            Path::new("false"),
            Path::new("false"),
            &cache,
            &run,
            &plan,
            |_| None,
        ) {
            // Without acceleration (a CI runner) that is what refuses first.
            Err(Error::NotCached(_) | Error::NoAcceleration(_)) => {}
            other => panic!("expected a refusal, got {:?}", other.err()),
        }
        assert!(
            !run.exists(),
            "nothing was written for a machine that cannot start"
        );
    }
}
