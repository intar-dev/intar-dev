//! `intar-image-cli setup`: what a pipeline's job runs before `build` (#441).
//! It brings the tools no package does, each checked against a pinned hash,
//! writes the build configuration, and checks the rest of the computer by
//! using it. It installs no package and starts no daemon.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use intar_image_build::tools::{
    BUILDKIT_ARCHIVE_SHA256, BUILDKIT_IMAGE, BUILDKIT_MAX_USED_BYTES, BUILDKIT_VERSION,
    UMOCI_SHA256, UMOCI_VERSION, extract_member,
};
use intar_image_build::{BuildArch, sha256_file_hex};

/// The oldest QEMU whose `migrate` takes the channels a checkpoint is saved
/// and restored through.
const QEMU_FLOOR: (u32, u32) = (8, 2);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const DOWNLOAD_TRIES: u32 = if cfg!(test) { 1 } else { 3 };

#[derive(Debug, Args)]
pub(crate) struct SetupCommand {
    /// Where the tools, the configuration and the work directories go.
    #[arg(long)]
    dir: PathBuf,
    /// The compiler descriptor (`GET /registry/v1/sources/compiler`), as the
    /// workflow fetched it to install this program: it names the Kino the
    /// platform runs.
    #[arg(long)]
    descriptor: PathBuf,
    /// Where the caches go: a directory that outlives the job, when there is
    /// one. Defaults to `<dir>/cache`.
    #[arg(long)]
    cache: Option<PathBuf>,
    /// The free space the caches leave on their disk, in GiB. Below it a
    /// build stores nothing more and evicts checkpoints to get back above
    /// it. A builder host keeps 20 for the work it shares its disk with; a
    /// job's cache volume has no such neighbour, and with 20 kept free a
    /// 50 GB volume holds one lab's checkpoints, not two.
    #[arg(long, default_value_t = 4)]
    cache_min_free_gib: u32,
    /// Also append what is printed to this file, as a workflow step's outputs.
    #[arg(long)]
    github_output: Option<PathBuf>,
}

/// Where the tools are downloaded from and the hashes they must have.
pub(crate) struct Sources {
    /// `https://github.com`, or a test's server.
    pub(crate) github: String,
    pub(crate) buildkit_sha256: String,
    pub(crate) umoci_sha256: String,
}

impl Default for Sources {
    fn default() -> Self {
        Self {
            github: "https://github.com".to_owned(),
            buildkit_sha256: BUILDKIT_ARCHIVE_SHA256.to_owned(),
            umoci_sha256: UMOCI_SHA256.to_owned(),
        }
    }
}

/// The Kino release of one architecture, as the descriptor names it.
#[derive(Debug, serde::Deserialize)]
struct KinoRelease {
    version: String,
    sha256: String,
}

/// What `setup` laid out; printed as `name=value` lines.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Installed {
    pub(crate) config: PathBuf,
    pub(crate) kino_amd64: PathBuf,
    pub(crate) kino_arm64: PathBuf,
    pub(crate) buildkit_socket: PathBuf,
    /// The daemon's image and arguments, for `docker run … <this>`.
    pub(crate) buildkit_run: String,
}

impl Installed {
    fn lines(&self) -> String {
        format!(
            "config={}\nkino_amd64={}\nkino_arm64={}\nbuildkit_socket={}\nbuildkit_run={}\n",
            self.config.display(),
            self.kino_amd64.display(),
            self.kino_arm64.display(),
            self.buildkit_socket.display(),
            self.buildkit_run
        )
    }
}

pub(crate) fn setup_command(args: &SetupCommand) -> Result<()> {
    // The pipeline builds on amd64 and emulates arm64 (#438); the pinned
    // tools are that computer's.
    ensure!(
        cfg!(all(target_os = "linux", target_arch = "x86_64")),
        "setup is for a Linux amd64 computer"
    );
    let installed = install(args, &Sources::default())?;
    let problems = check_host();
    for problem in &problems {
        eprintln!("{problem}");
    }
    ensure!(
        problems.is_empty(),
        "this computer cannot build images yet: {} problem(s)",
        problems.len()
    );
    print!("{}", installed.lines());
    if let Some(path) = &args.github_output {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| file.write_all(installed.lines().as_bytes()))
            .with_context(|| format!("failed to write {}", path.display()))?;
    }
    Ok(())
}

/// Downloads and lays out the tools and writes the configuration.
pub(crate) fn install(args: &SetupCommand, sources: &Sources) -> Result<Installed> {
    let descriptor: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&args.descriptor)
            .with_context(|| format!("read {}", args.descriptor.display()))?,
    )
    .with_context(|| format!("{} is not a compiler descriptor", args.descriptor.display()))?;
    let kino = |arch: BuildArch| -> Result<KinoRelease> {
        let release: KinoRelease = descriptor
            .get("kino")
            .and_then(|kino| kino.get(arch.debian()))
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .context("the descriptor's Kino is not a release")?
            .with_context(|| {
                format!(
                    "the descriptor names no {} Kino yet: the platform has to pin a Kino release first",
                    arch.debian()
                )
            })?;
        ensure!(
            release
                .version
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
                && !release.version.is_empty(),
            "the descriptor's Kino version '{}' is not a version",
            release.version
        );
        Ok(release)
    };
    let kinos = [
        (BuildArch::Amd64, kino(BuildArch::Amd64)?),
        (BuildArch::Arm64, kino(BuildArch::Arm64)?),
    ];

    let dir = absolute(&args.dir)?;
    let cache = match &args.cache {
        Some(cache) => absolute(cache)?,
        None => dir.join("cache"),
    };
    let downloads = dir.join("downloads");
    let bin = dir.join("bin");
    let oci = cache.join("oci");
    for path in [
        &downloads,
        &bin,
        &oci,
        &cache.join("checkpoints"),
        &cache.join("buildkit"),
        &dir.join("work"),
        &dir.join("dist"),
    ] {
        std::fs::create_dir_all(path)
            .with_context(|| format!("failed to create {}", path.display()))?;
    }

    let github = sources.github.trim_end_matches('/');
    let archive = downloads.join("buildkit.tar.gz");
    fetch(
        &format!(
            "{github}/moby/buildkit/releases/download/{BUILDKIT_VERSION}/buildkit-{BUILDKIT_VERSION}.linux-amd64.tar.gz"
        ),
        &sources.buildkit_sha256,
        &archive,
    )?;
    let buildctl = bin.join("buildctl");
    extract_member(&archive, "bin/buildctl", &buildctl)?;
    executable(&buildctl)?;
    let umoci = bin.join("umoci");
    fetch(
        &format!(
            "{github}/opencontainers/umoci/releases/download/{UMOCI_VERSION}/umoci.linux.amd64"
        ),
        &sources.umoci_sha256,
        &umoci,
    )?;
    executable(&umoci)?;
    let mut kino_paths = Vec::new();
    for (arch, release) in &kinos {
        let name = arch.debian();
        let archive = downloads.join(format!("kino-{name}.tar.gz"));
        fetch(
            &format!(
                "{github}/intar-dev/intar-dev/releases/download/kino%2Fv{version}/kino_{version}_linux_{name}.tar.gz",
                version = release.version
            ),
            &release.sha256,
            &archive,
        )?;
        let path = dir.join("kino").join(name).join("kino");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        extract_member(&archive, "kino", &path)?;
        executable(&path)?;
        kino_paths.push(path);
    }

    // The daemon collects what it keeps beyond its share of the OCI cache.
    let daemon_config = oci.join("buildkitd.toml");
    std::fs::write(
        &daemon_config,
        format!(
            "[worker.oci]\n  enabled = true\n  gc = true\n  max-parallelism = 2\n  maxUsedSpace = {BUILDKIT_MAX_USED_BYTES}\n\n[worker.containerd]\n  enabled = false\n"
        ),
    )
    .with_context(|| format!("failed to write {}", daemon_config.display()))?;
    let socket = oci.join("buildkitd.sock");

    // The work directories are here, not in the directory `build` is run
    // from, which is the repository's checkout.
    let config = dir.join("build.json");
    let document = serde_json::json!({
        "target_arch": "amd64",
        "work_root": dir.join("work"),
        "output_root": dir.join("dist"),
        "layered": {
            "buildctl_binary": buildctl,
            "umoci_binary": umoci,
            "oci_cache_root": oci,
            "checkpoint_cache_root": cache.join("checkpoints"),
            "use_cache": true,
            "minimum_free_bytes": u64::from(args.cache_min_free_gib) * 1024 * 1024 * 1024,
        },
    });
    std::fs::write(&config, serde_json::to_vec_pretty(&document)?)
        .with_context(|| format!("failed to write {}", config.display()))?;

    Ok(Installed {
        config,
        kino_amd64: kino_paths.remove(0),
        kino_arm64: kino_paths.remove(0),
        buildkit_run: format!(
            "{BUILDKIT_IMAGE} --addr unix://{} --root {} --config {}",
            socket.display(),
            cache.join("buildkit").display(),
            daemon_config.display()
        ),
        buildkit_socket: socket,
    })
}

fn absolute(path: &Path) -> Result<PathBuf> {
    std::path::absolute(path).with_context(|| format!("{} is not a path", path.display()))
}

/// Downloads `url` to `dest` and keeps it only with the hash `sha256`.
fn fetch(url: &str, sha256: &str, dest: &Path) -> Result<()> {
    // Beside its place until it has its hash: nothing cut short or with
    // another hash is ever where a later step, or a later run, could use it.
    let part = dest.with_extension("part");
    let _ = std::fs::remove_file(dest);
    let download = || -> Result<()> {
        let mut response = reqwest::blocking::Client::builder()
            .timeout(DOWNLOAD_TIMEOUT)
            .build()?
            .get(url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)?;
        let mut file = std::fs::File::create(&part)
            .with_context(|| format!("failed to create {}", part.display()))?;
        response.copy_to(&mut file)?;
        Ok(())
    };
    let mut tries = 0;
    loop {
        tries += 1;
        match download() {
            Ok(()) => break,
            Err(error) if tries >= DOWNLOAD_TRIES => {
                let _ = std::fs::remove_file(&part);
                return Err(error.context(format!("failed to download {url}")));
            }
            Err(_) => std::thread::sleep(Duration::from_secs(2)),
        }
    }
    let actual = sha256_file_hex(&part)?;
    if actual != sha256 {
        let _ = std::fs::remove_file(&part);
        bail!("{url} has the SHA-256 {actual}, not the pinned {sha256}");
    }
    std::fs::rename(&part, dest).with_context(|| format!("failed to write {}", dest.display()))
}

fn executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("failed to make {} executable", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// The `major.minor` of `qemu --version`'s first line.
pub(crate) fn qemu_version(output: &str) -> Option<(u32, u32)> {
    let version = output.lines().next()?.split("version ").nth(1)?;
    let mut parts = version.split(|c: char| !c.is_ascii_digit());
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// What of this computer a build would fail on, each as one line that says
/// what to do. Checked by using it: a program that is there but cannot start
/// with the devices a build gives it is found here, not twenty minutes in.
fn check_host() -> Vec<String> {
    let mut problems = Vec::new();
    if let Err(error) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/kvm")
    {
        problems.push(format!(
            "/dev/kvm cannot be opened ({error}): this computer needs KVM, and `setup` and `build` run as root"
        ));
    }
    for (qemu, package, machine) in [
        (
            "qemu-system-x86_64",
            "qemu-system-x86",
            "-M q35 -accel kvm -cpu host",
        ),
        (
            "qemu-system-aarch64",
            "qemu-system-arm",
            "-M virt,highmem=on -accel tcg -cpu max,pauth-impdef=on",
        ),
    ] {
        match Command::new(qemu).arg("--version").output() {
            Err(_) => {
                problems.push(format!("{qemu} is missing: install the package {package}"));
                continue;
            }
            Ok(output) => match qemu_version(&String::from_utf8_lossy(&output.stdout)) {
                Some(version) if version >= QEMU_FLOOR => {}
                version => {
                    problems.push(format!(
                        "{qemu} is {}; a build needs QEMU {}.{} or newer",
                        version.map_or("of an unknown version".to_owned(), |(major, minor)| {
                            format!("{major}.{minor}")
                        }),
                        QEMU_FLOOR.0,
                        QEMU_FLOOR.1
                    ));
                    continue;
                }
            },
        }
        if let Some(problem) = start_once(qemu, machine) {
            problems.push(problem);
        }
    }
    for (tool, package) in [
        ("qemu-img", "qemu-utils"),
        ("mke2fs", "e2fsprogs"),
        ("e2fsck", "e2fsprogs"),
        ("resize2fs", "e2fsprogs"),
        // A checkpoint's memory is compressed and read back with it.
        ("zstd", "zstd"),
    ] {
        // Every one of them answers -V, or at least starts.
        if Command::new(tool)
            .arg("-V")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_err()
        {
            problems.push(format!("{tool} is missing: install the package {package}"));
        }
    }
    problems
}

/// Starts `qemu` paused with a build's machine, its firmware and its network
/// device, and stops it. A problem when it does not stay up.
fn start_once(qemu: &str, machine: &str) -> Option<String> {
    let mut child = Command::new(qemu)
        .args(machine.split(' '))
        .args([
            "-m",
            "256",
            "-nodefaults",
            "-display",
            "none",
            "-S",
            "-serial",
            "none",
            "-monitor",
            "none",
            "-netdev",
            "user,id=net0",
            "-device",
            "virtio-net-pci,netdev=net0",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    std::thread::sleep(Duration::from_millis(1500));
    let stopped = child.try_wait().ok().flatten();
    let _ = child.kill();
    let output = child.wait_with_output().ok()?;
    stopped.map(|status| {
        format!(
            "{qemu} does not start as a build starts it ({status}): {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })
}
