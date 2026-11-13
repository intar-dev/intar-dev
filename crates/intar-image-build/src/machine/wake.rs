//! The wake steps (#348 §3): a wake image's base step boots its repacked
//! disk in cloud-hypervisor and suspends it; a pack wakes its base, runs the
//! machine's own stages and suspends again, published as a RAM delta.
//!
//! The VMM runs unprivileged in a user and network namespace of its own:
//! the builder re-executes itself under `unshare` with [`WAKE_CHILD_ARG`],
//! and that child makes the TAP (no uplink), runs the VMM and talks to the
//! guest. Everything around it (RAM, stub, image) is the parent's.

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::{Read as _, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};
use cloud_hypervisor_client::machine::{
    MachineVmInput, WakeShape, machine_vm_config, wake_vm_config,
};
use intar_contracts::guest::{
    BOOT_JSON_FILENAME, GUEST_CONTRACT, GUEST_USERNAME, GuestBootV3, GuestNetworkV3, GuestSshV3,
    KINO_FILENAME, RECORDING_DISK_LABEL, REPORT_PORT, RUNTIME_DISK_LABEL,
};
use intar_contracts::oci::verify::MAX_WAKE_DELTA_BYTES;
use intar_contracts::oci::{
    DISK_CHUNK_MEDIA_TYPE, IMAGE_FORMAT, INITRD_MEDIA_TYPE, KERNEL_MEDIA_TYPE, MachineBootV1,
    MachineConfigV1, OciDigest, Sha256Hex, WAKE_CPU_PROFILE_MEDIA_TYPE, WAKE_DELTA_MEDIA_TYPE,
    WAKE_RAM_CHUNK_MEDIA_TYPE, WAKE_STUB_MEDIA_TYPE, WakePackV1, WakeRamV1, WakeShapeV1, WakeV1,
    WakeVmmV1,
};
use intar_contracts::scenario::{MachineSpecV1, SpecMode};
use serde::{Deserialize, Serialize};

use super::output::{ImageWriter, MachineImage};
use super::plan::{BuildPlan, BuildTarget, WakeRole, plan_build};
use super::script::{
    UPLOAD_PATH, as_root, finalize_script, record_boot_files, stage_command, stage_file,
};
use super::{MachineBuildRequest, vm};
use crate::config::{QemuBuildConfig, WakeBuildConfig};
use crate::rootfs::BaseRootfsArtifact;
use crate::sha256::sha256_file_hex;
use crate::ssh::{
    BUILD_LOG_LIMIT_BYTES, BuildSshSession, generate_build_ssh_key, private_key_to_openssh,
};
use crate::wake::{
    WAKE_BALLOON, WAKE_BOOT_VCPUS, WAKE_MAX_PHYS_BITS, WAKE_MAX_VCPUS, WAKE_MEMORY_BYTES,
    find_wake_vector, parse_bar_table, patch_stub, save_acpi_tables, stub_template, wake_cmdline,
};

/// The hidden first argument of the namespace child.
pub const WAKE_CHILD_ARG: &str = "__intar-wake-child";

/// The build guest's network: a TAP with no uplink.
const TAP: &str = "intarwake0";
const HOST_CIDR: &str = "10.77.0.1/28";
const GATEWAY: &str = "10.77.0.1";
const GUEST_ADDRESS: &str = "10.77.0.2";
const GUEST_CIDR: &str = "10.77.0.2/28";
/// The NIC and vsock identity a wake image is suspended with.
pub const WAKE_BUILD_MAC: &str = "02:00:00:00:00:02";
pub const WAKE_BUILD_VSOCK_CID: u32 = 10_000;

const RUN_DISK_BYTES: u64 = 16 * 1024 * 1024;
const RECORDING_DISK_BYTES: u64 = 256 * 1024 * 1024;
const RECORDING_VOLUME_ID: u32 = 0x494e_5441;
/// A pack's delta is published in parts of this size.
const DELTA_PART_BYTES: usize = 32 * 1024 * 1024;
const DELTA_LEVEL: i32 = 19;

const READY_TIMEOUT: Duration = Duration::from_secs(300);
const SUSPEND_TIMEOUT: Duration = Duration::from_secs(120);
/// The quiet rule: the vCPU threads used at most one CPU in each of the
/// last [`QUIET_SECONDS`] seconds, waited for at most [`QUIET_BOUND`].
const QUIET_SECONDS: usize = 5;
const QUIET_BOUND: Duration = Duration::from_secs(180);
// ponytail: USER_HZ is 100 on every Linux the builder runs on.
const TICKS_PER_SECOND: u64 = 100;

/// The guest's BAR table: `<bb:dd.f> <offset> <value>` for every BAR 0
/// with an address, a 64-bit BAR's lower half first.
const BARS_SCRIPT: &str = r#"for d in /sys/bus/pci/devices/*; do
  set -- $(od -An -tx4 -j16 -N8 "$d/config")
  [ "$1" != 00000000 ] || continue
  n=$(basename "$d"); n=${n#0000:}
  echo "$n 0x10 0x$1"
  [ $(( 0x$1 & 7 )) -ne 4 ] || echo "$n 0x14 0x$2"
done
"#;

/// The suspend, as a transient unit so no SSH session holds it: drop the
/// page cache, take the random device and the NIC off the bus, suspend to
/// RAM (the `\_S3_` table makes that the VMM's exit), and after a wake
/// rescan. The rescan probes the NIC again, so a woken guest takes its VM's
/// MAC, not the build's: two woken VMs on one bridge never share one.
const SUSPEND_SCRIPT: &str = r"echo deep >/sys/power/mem_sleep
sync
echo 3 >/proc/sys/vm/drop_caches
for d in /sys/bus/pci/devices/*; do
  case $(cat $d/vendor):$(cat $d/device) in
  0x1af4:0x1041|0x1af4:0x1044) echo 1 >$d/remove ;;
  esac
done
echo mem >/sys/power/state
echo 1 >/sys/bus/pci/rescan
";

fn shape() -> WakeShapeV1 {
    WakeShapeV1 {
        memory_bytes: WAKE_MEMORY_BYTES,
        boot_vcpus: WAKE_BOOT_VCPUS,
        max_vcpus: WAKE_MAX_VCPUS,
        balloon: WAKE_BALLOON,
        max_phys_bits: WAKE_MAX_PHYS_BITS,
    }
}

/// Why this host cannot build wake images, or `None` when it can.
#[must_use]
pub fn wake_unavailable(config: &QemuBuildConfig) -> Option<String> {
    let Some(wake) = config.wake.as_ref() else {
        return Some("wake is off".to_owned());
    };
    let check = || -> Result<()> {
        for device in ["/dev/kvm", "/dev/net/tun"] {
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(device)
                .with_context(|| format!("{device} is not usable"))?;
        }
        check_vmm(wake)?;
        for (what, path) in [("CPU profile", &wake.cpu_profile), ("Kino", &wake.kino)] {
            ensure!(
                fs::metadata(path).is_ok_and(|metadata| metadata.is_file()),
                "the {what} {} is missing",
                path.display()
            );
        }
        let status = Command::new("unshare")
            .args(["--user", "--map-root-user", "--net", "true"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .context("unshare is not installed")?;
        ensure!(
            status.success(),
            "unprivileged user and network namespaces are not available"
        );
        Ok(())
    };
    check().err().map(|error| format!("{error:#}"))
}

fn check_vmm(wake: &WakeBuildConfig) -> Result<()> {
    let actual = sha256_file_hex(&wake.vmm_binary)
        .with_context(|| format!("the VMM {} is missing", wake.vmm_binary.display()))?;
    ensure!(
        actual.eq_ignore_ascii_case(&wake.vmm_sha256),
        "the VMM {} is {actual}, not the pinned {}",
        wake.vmm_binary.display(),
        wake.vmm_sha256
    );
    Ok(())
}

fn log_line(log: &Path, line: &str) -> Result<()> {
    let mut file = fs::OpenOptions::new().create(true).append(true).open(log)?;
    writeln!(file, "[wake] {line}")?;
    Ok(())
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Build a wake image or a pack into `request.output_dir`.
pub(crate) fn build_wake_target(
    request: &MachineBuildRequest,
    plan: &BuildPlan,
    base: &BaseRootfsArtifact,
    work: &Path,
    log: &Path,
) -> Result<MachineImage> {
    let wake = request.config.wake.as_ref().context("wake is off")?;
    let steps = Steps {
        config: &request.config,
        wake,
        base,
        log,
    };
    match &plan.wake {
        // The image and its packs share one base: the cache's.
        Some(WakeRole::Base) => {
            let BuildTarget::Image(name) = &request.target else {
                bail!("a wake base is an image");
            };
            let cached = steps.cached_base(request, name, Some(&request.output_dir))?;
            cached.image.context("the base was not published")
        }
        Some(WakeRole::Pack { base: name }) => {
            let cached = steps.cached_base(request, name, None)?;
            steps.pack(
                plan,
                &(cached.dir.clone(), cached.record.clone()),
                &work.join("pack"),
                &request.output_dir,
            )
        }
        None => bail!("not a wake target"),
    }
}

struct Steps<'a> {
    config: &'a QemuBuildConfig,
    wake: &'a WakeBuildConfig,
    base: &'a BaseRootfsArtifact,
    log: &'a Path,
}

/// A suspended base, as the base step leaves it.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct BaseRecord {
    manifest: OciDigest,
    config: MachineConfigV1,
    vector: u32,
    bars: String,
    disk_sha256: String,
    stub_sha256: String,
    kernel_sha256: String,
    initrd_sha256: String,
}

/// A base of the cache, held against eviction while this lives.
struct CachedBase {
    dir: PathBuf,
    record: BaseRecord,
    image: Option<MachineImage>,
    _in_use: fs::File,
}

/// A base in the cache is rebuilt after this many days: packs carry the
/// base's `booted_at`, and run hosts stop waking a guest booted 330 days
/// ago, so an old base would publish packs that soon cold-boot only.
const MAX_CACHED_BASE_AGE_DAYS: u64 = 30;
const BUILDING_PREFIX: &str = ".building-";

fn expired(booted_at_unix_ms: u64, now_unix_ms: u64) -> bool {
    now_unix_ms.saturating_sub(booted_at_unix_ms) > MAX_CACHED_BASE_AGE_DAYS * 24 * 3_600_000
}

/// Remove the least recently used bases past `max`, counting `keep`; never
/// `keep`, nor one a build holds.
fn evict_bases(cache: &Path, keep: &Path, max: usize) -> Result<Vec<PathBuf>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(cache)? {
        let path = entry?.path();
        let hidden = path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with('.'));
        if hidden || path == keep || !path.is_dir() {
            continue;
        }
        let used = fs::metadata(path.join("base.json"))
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        entries.push((used, path));
    }
    entries.sort();
    let excess = (entries.len() + 1).saturating_sub(max.max(1));
    let mut removed = Vec::new();
    for (_, path) in entries {
        if removed.len() == excess {
            break;
        }
        let held = fs::File::open(path.join(".lock"))
            .is_ok_and(|lock| fs2::FileExt::try_lock_exclusive(&lock).is_err());
        if held {
            continue;
        }
        fs::remove_dir_all(&path)?;
        removed.push(path);
    }
    Ok(removed)
}

struct BuiltBase {
    image: MachineImage,
    record: BaseRecord,
}

/// What the namespace child runs.
#[derive(Debug, Default, Deserialize, Serialize)]
struct ChildJob {
    vmm: PathBuf,
    kernel: String,
    initramfs: String,
    cmdline: String,
    disk: String,
    run_disk: String,
    recording_disk: String,
    serial: String,
    console: String,
    vsock: String,
    api: String,
    ram: String,
    cpu_profile: String,
    boot_sha256: String,
    ssh_key: String,
    log: PathBuf,
    steps: Vec<GuestStep>,
    expected_bars: Option<String>,
    result: PathBuf,
    timeout_seconds: u64,
}

#[derive(Debug, Deserialize, Serialize)]
enum GuestStep {
    Run { label: String, command: String },
    Upload { local: PathBuf },
}

/// One boot of the wake VM.
struct GuestRun<'a> {
    kernel: &'a str,
    cmdline: &'a str,
    disk: &'a Path,
    ram: &'a Path,
    steps: Vec<GuestStep>,
    expected_bars: Option<&'a str>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct ChildResult {
    booted_at_unix_ms: u64,
    first_report_ms: u64,
    ready_ms: u64,
    steps_ms: u64,
    quiet_ms: u64,
    quiet: bool,
    bars: String,
    suspend_ms: u64,
}

impl Steps<'_> {
    /// Boot the repacked disk of `plan` and suspend it.
    fn base(&self, plan: &BuildPlan, dir: &Path, output: &Path) -> Result<BuiltBase> {
        let started = Instant::now();
        let qemu = dir.join("qemu");
        fs::create_dir_all(&qemu)?;
        let raw = vm::build_disk(plan, self.config, self.base, &qemu, self.log)?;
        let disk = dir.join("disk.raw");
        crate::wake::clone_or_sparse_copy(&raw, &disk)?;
        fs::remove_dir_all(&qemu)?;
        log_line(
            self.log,
            &format!("qemu build elapsed_ms={}", started.elapsed().as_millis()),
        )?;
        let ram = dir.join("ram");
        fs::File::create(&ram)?.set_len(WAKE_MEMORY_BYTES)?;
        let initrd_bytes = fs::metadata(&self.base.initrd_path)?.len();
        let cmdline = wake_cmdline(initrd_bytes);
        let finalize = as_root(&finalize_script(&plan.defer, true));
        let steps = vec![
            GuestStep::Run {
                label: "record boot files".to_owned(),
                command: record_boot_files(),
            },
            GuestStep::Run {
                label: "finalize".to_owned(),
                command: finalize,
            },
        ];
        let kernel = self.base.kernel_path.display().to_string();
        let result = self.run_guest(
            dir,
            GuestRun {
                kernel: &kernel,
                cmdline: &cmdline,
                disk: &disk,
                ram: &ram,
                steps,
                expected_bars: None,
            },
        )?;

        let started = Instant::now();
        let allocated = crate::wake::allocated_bytes(&ram)?;
        crate::wake::punch_zero_pages(&ram)?;
        let holes = crate::wake::allocated_bytes(&ram)?;
        let mut low = vec![0_u8; 1024 * 1024];
        fs::File::open(&ram)?.read_exact(&mut low)?;
        let vector = find_wake_vector(&low)?;
        let acpi = save_acpi_tables(&ram)?;
        let bars = parse_bar_table(&result.bars)?;
        let templates = stub_templates(&self.base.base_ext4_path)?;
        let stub = patch_stub(&stub_template(&templates, bars.len())?, vector, &bars, acpi)?;
        let stub_path = dir.join("stub");
        fs::write(&stub_path, &stub)?;
        let ram_sha256 = sha256_file_hex(&ram)?;
        log_line(
            self.log,
            &format!(
                "ram allocated={allocated} after_holes={holes} vector={vector:#x} acpi={acpi} bars={} elapsed_ms={}",
                bars.len(),
                started.elapsed().as_millis()
            ),
        )?;

        let started = Instant::now();
        let mut writer = ImageWriter::new(output)?;
        writer.file(&self.base.kernel_path, KERNEL_MEDIA_TYPE)?;
        writer.file(&self.base.initrd_path, INITRD_MEDIA_TYPE)?;
        let disk_chunks = writer.chunks(&disk, DISK_CHUNK_MEDIA_TYPE)?;
        let ram_chunks = writer.chunks(&ram, WAKE_RAM_CHUNK_MEDIA_TYPE)?;
        writer.bytes(&stub, WAKE_STUB_MEDIA_TYPE)?;
        let profile = writer.file(&self.wake.cpu_profile, WAKE_CPU_PROFILE_MEDIA_TYPE)?;
        let config = MachineConfigV1 {
            guest_contract: GUEST_CONTRACT,
            image_format: IMAGE_FORMAT.to_owned(),
            build_key: plan.build_key.clone(),
            boot: MachineBootV1 { cmdline },
            disk: disk_chunks.disk,
            wake: Some(WakeV1 {
                ram: WakeRamV1 {
                    size_bytes: ram_chunks.disk.size_bytes,
                    chunk_size: ram_chunks.disk.chunk_size,
                    chunks: ram_chunks.disk.chunks,
                    sha256: Sha256Hex::try_from(ram_sha256).map_err(anyhow::Error::msg)?,
                },
                pack: None,
                shape: shape(),
                cpu_profile: profile.digest,
                vmm: self.vmm(),
                booted_at_unix_ms: result.booted_at_unix_ms,
            }),
        };
        let image = writer.finish(config.clone())?;
        log_line(
            self.log,
            &format!(
                "base image manifest={} ram_chunks={} elapsed_ms={}",
                image.manifest_digest.as_str(),
                ram_chunks.count,
                started.elapsed().as_millis()
            ),
        )?;
        Ok(BuiltBase {
            record: BaseRecord {
                manifest: image.manifest_digest.clone(),
                config,
                vector,
                bars: result.bars,
                disk_sha256: sha256_file_hex(&disk)?,
                stub_sha256: sha256_file_hex(&stub_path)?,
                kernel_sha256: sha256_file_hex(&self.base.kernel_path)?,
                initrd_sha256: sha256_file_hex(&self.base.initrd_path)?,
            },
            image,
        })
    }

    fn vmm(&self) -> WakeVmmV1 {
        WakeVmmV1 {
            min_version: self.wake.vmm_version.clone(),
            built_with: self.wake.vmm_version.clone(),
        }
    }

    /// The suspended base `name` of the cache, verified, or built into it;
    /// with `publish`, also its image there. The returned lock keeps the
    /// entry from eviction while the caller reads it.
    ///
    /// ponytail: one lock for the whole cache, so base builds wait for each
    /// other; lock per entry if bases are built often.
    fn cached_base(
        &self,
        request: &MachineBuildRequest,
        name: &str,
        publish: Option<&Path>,
    ) -> Result<CachedBase> {
        let plan = plan_build(&request.bundle, &BuildTarget::Image(name.to_owned()), None)?;
        let recipe = self.recipe(&plan)?;
        let cache = &self.wake.base_cache;
        fs::create_dir_all(cache)?;
        let cache_lock = fs::File::create(cache.join(".lock"))?;
        fs2::FileExt::lock_exclusive(&cache_lock)?;
        let dir = cache.join(recipe);
        fs::create_dir_all(&dir)?;
        let in_use = fs::File::create(dir.join(".lock"))?;
        fs2::FileExt::lock_shared(&in_use)?;
        let record_path = dir.join("base.json");
        let reused = fs::read(&record_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<BaseRecord>(&bytes).ok())
            .map(|record| self.verify_cached(&dir, &record).map(|()| record));
        match reused {
            Some(Ok(record)) => {
                log_line(self.log, &format!("base {name} reused from the cache"))?;
                fs::File::options()
                    .write(true)
                    .open(&record_path)?
                    .set_modified(SystemTime::now())?;
                let image = publish
                    .map(|output| self.publish_base(&dir, &record, output))
                    .transpose()?;
                return Ok(CachedBase {
                    dir,
                    record,
                    image,
                    _in_use: in_use,
                });
            }
            Some(Err(error)) => {
                log_line(self.log, &format!("base {name} cache refused: {error:#}"))?;
            }
            None => log_line(self.log, &format!("base {name} not cached; building it"))?,
        }
        let _ = fs::remove_file(&record_path);
        // Built beside the cache, so the files move in by rename; what a
        // crashed build left is removed first.
        for entry in fs::read_dir(cache)? {
            let path = entry?.path();
            if path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(BUILDING_PREFIX))
            {
                fs::remove_dir_all(&path)?;
            }
        }
        let build = tempfile::Builder::new()
            .prefix(BUILDING_PREFIX)
            .tempdir_in(cache)?;
        let oci = build.path().join("oci");
        let built = self.base(&plan, build.path(), publish.unwrap_or(&oci))?;
        for file in ["disk.raw", "ram", "stub"] {
            fs::rename(build.path().join(file), dir.join(file))?;
        }
        fs::write(&record_path, serde_json::to_vec(&built.record)?)?;
        for removed in evict_bases(cache, &dir, self.wake.max_cached_bases)? {
            log_line(
                self.log,
                &format!("base cache evicted {}", removed.display()),
            )?;
        }
        Ok(CachedBase {
            dir,
            record: built.record,
            image: publish.map(|_| built.image),
            _in_use: in_use,
        })
    }

    /// What a base is reused for: the same image, CPU profile, VMM, VM
    /// config (paths aside), command line and guest scripts.
    fn recipe(&self, plan: &BuildPlan) -> Result<String> {
        let cmdline = wake_cmdline(fs::metadata(&self.base.initrd_path)?.len());
        let vm = build_vm_config(&ChildJob {
            cmdline,
            ..ChildJob::default()
        })?;
        Ok(crate::sha256::sha256_bytes_hex(
            format!(
                "{}\n{}\n{}\n{}\n{BARS_SCRIPT}\n{SUSPEND_SCRIPT}",
                plan.build_key.as_str(),
                sha256_file_hex(&self.wake.cpu_profile)?,
                self.wake.vmm_sha256,
                serde_json::to_string(&vm)?,
            )
            .as_bytes(),
        ))
    }

    /// The image of the cached base: the same bytes, so the same manifest.
    fn publish_base(&self, dir: &Path, record: &BaseRecord, output: &Path) -> Result<MachineImage> {
        let mut writer = ImageWriter::new(output)?;
        writer.file(&self.base.kernel_path, KERNEL_MEDIA_TYPE)?;
        writer.file(&self.base.initrd_path, INITRD_MEDIA_TYPE)?;
        writer.chunks(&dir.join("disk.raw"), DISK_CHUNK_MEDIA_TYPE)?;
        writer.chunks(&dir.join("ram"), WAKE_RAM_CHUNK_MEDIA_TYPE)?;
        writer.file(&dir.join("stub"), WAKE_STUB_MEDIA_TYPE)?;
        writer.file(&self.wake.cpu_profile, WAKE_CPU_PROFILE_MEDIA_TYPE)?;
        let image = writer.finish(record.config.clone())?;
        ensure!(
            image.manifest_digest == record.manifest,
            "the cached base publishes as {}, not {}",
            image.manifest_digest.as_str(),
            record.manifest.as_str()
        );
        Ok(image)
    }

    fn verify_cached(&self, dir: &Path, record: &BaseRecord) -> Result<()> {
        let ram = record.config.wake.as_ref().context("no wake")?;
        ensure!(
            !expired(ram.booted_at_unix_ms, unix_ms()),
            "the base was booted over {} days ago",
            MAX_CACHED_BASE_AGE_DAYS
        );
        for (file, expected) in [
            (dir.join("disk.raw"), record.disk_sha256.as_str()),
            (dir.join("ram"), ram.ram.sha256.as_str()),
            (dir.join("stub"), record.stub_sha256.as_str()),
            (self.base.kernel_path.clone(), record.kernel_sha256.as_str()),
            (self.base.initrd_path.clone(), record.initrd_sha256.as_str()),
        ] {
            ensure!(
                sha256_file_hex(&file)? == expected,
                "{} changed",
                file.display()
            );
        }
        Ok(())
    }

    /// Wake the cached base, run the machine's own stages, suspend, and
    /// publish the RAM as a delta to the base's.
    fn pack(
        &self,
        plan: &BuildPlan,
        (base_dir, base): &(PathBuf, BaseRecord),
        dir: &Path,
        output: &Path,
    ) -> Result<MachineImage> {
        fs::create_dir_all(dir)?;
        let base_wake = base.config.wake.as_ref().context("the base has no wake")?;
        let (disk, ram) = (dir.join("disk.raw"), dir.join("ram"));
        crate::wake::clone_or_sparse_copy(&base_dir.join("disk.raw"), &disk)?;
        crate::wake::clone_or_sparse_copy(&base_dir.join("ram"), &ram)?;
        let mut steps = vec![GuestStep::Run {
            label: "record boot files".to_owned(),
            command: record_boot_files(),
        }];
        for (index, stage) in plan.stages.iter().enumerate() {
            if stage.node_key != plan.build_key {
                continue;
            }
            let local = dir.join(format!("stage-{index}.sh"));
            fs::write(&local, &stage.script)?;
            steps.push(GuestStep::Upload { local });
            steps.push(GuestStep::Run {
                label: format!("stage {index} {}", stage.name),
                command: stage_command(&stage_file(index, &stage.name), &stage.env),
            });
        }
        steps.push(GuestStep::Run {
            label: "finalize".to_owned(),
            command: as_root(&finalize_script(&plan.defer, true)),
        });
        let stub = base_dir.join("stub").display().to_string();
        let result = self.run_guest(
            dir,
            GuestRun {
                kernel: &stub,
                cmdline: &base.config.boot.cmdline,
                disk: &disk,
                ram: &ram,
                steps,
                expected_bars: Some(&base.bars),
            },
        )?;
        let mut low = vec![0_u8; 1024 * 1024];
        fs::File::open(&ram)?.read_exact(&mut low)?;
        ensure!(
            find_wake_vector(&low)? == base.vector,
            "the pack's wake vector is not its base's"
        );

        let started = Instant::now();
        let threads = std::thread::available_parallelism().map_or(1, usize::from);
        let delta = dir.join("delta");
        let stats =
            intar_snapdelta::diff(&base_dir.join("ram"), &ram, &delta, DELTA_LEVEL, threads)
                .context("diff the pack's RAM")?;
        ensure!(
            stats.delta_bytes <= MAX_WAKE_DELTA_BYTES,
            "the pack's RAM delta is {} bytes, over the {MAX_WAKE_DELTA_BYTES} byte limit",
            stats.delta_bytes
        );
        let diffed = started.elapsed();
        let check = dir.join("check");
        intar_snapdelta::apply(&base_dir.join("ram"), &delta, &check, threads)
            .context("apply the pack's delta")?;
        ensure!(
            same_bytes(&check, &ram)?,
            "the delta does not rebuild the pack's RAM"
        );
        fs::remove_file(&check)?;
        let ram_sha256 = sha256_file_hex(&ram)?;
        log_line(
            self.log,
            &format!(
                "pack delta_bytes={} diff_ms={} apply_and_compare_ms={}",
                stats.delta_bytes,
                diffed.as_millis(),
                (started.elapsed() - diffed).as_millis()
            ),
        )?;

        let started = Instant::now();
        let mut writer = ImageWriter::new(output)?;
        writer.file(&self.base.kernel_path, KERNEL_MEDIA_TYPE)?;
        writer.file(&self.base.initrd_path, INITRD_MEDIA_TYPE)?;
        let disk_chunks = writer.chunks(&disk, DISK_CHUNK_MEDIA_TYPE)?;
        let ram_chunks = writer.chunks(&base_dir.join("ram"), WAKE_RAM_CHUNK_MEDIA_TYPE)?;
        let raw = |chunks: &[(u64, u32, Sha256Hex)]| -> Vec<(u64, Sha256Hex)> {
            chunks
                .iter()
                .map(|(index, _, sha)| (*index, sha.clone()))
                .collect()
        };
        ensure!(
            raw(&ram_chunks.disk.chunks) == raw(&base_wake.ram.chunks),
            "the cached base RAM is not the base's"
        );
        writer.file(&base_dir.join("stub"), WAKE_STUB_MEDIA_TYPE)?;
        let profile = writer.file(&self.wake.cpu_profile, WAKE_CPU_PROFILE_MEDIA_TYPE)?;
        ensure!(
            profile.digest == base_wake.cpu_profile,
            "the CPU profile is not the base's"
        );
        let parts = write_delta_parts(&mut writer, &delta, MAX_WAKE_DELTA_BYTES)?;
        let config = MachineConfigV1 {
            guest_contract: GUEST_CONTRACT,
            image_format: IMAGE_FORMAT.to_owned(),
            build_key: plan.build_key.clone(),
            boot: base.config.boot.clone(),
            disk: disk_chunks.disk,
            wake: Some(WakeV1 {
                ram: WakeRamV1 {
                    chunks: ram_chunks.disk.chunks,
                    ..base_wake.ram.clone()
                },
                pack: Some(WakePackV1 {
                    base: base.manifest.clone(),
                    ram_sha256: Sha256Hex::try_from(ram_sha256).map_err(anyhow::Error::msg)?,
                }),
                shape: base_wake.shape.clone(),
                cpu_profile: base_wake.cpu_profile.clone(),
                vmm: base_wake.vmm.clone(),
                booted_at_unix_ms: base_wake.booted_at_unix_ms,
            }),
        };
        let image = writer.finish(config)?;
        log_line(
            self.log,
            &format!(
                "pack image manifest={} delta_parts={} quiet={} quiet_ms={} elapsed_ms={}",
                image.manifest_digest.as_str(),
                parts,
                result.quiet,
                result.quiet_ms,
                started.elapsed().as_millis()
            ),
        )?;
        Ok(image)
    }

    /// Boot `disk` and `ram` with `kernel` in the namespace child, run
    /// `steps` in the guest and suspend it.
    fn run_guest(&self, dir: &Path, run: GuestRun<'_>) -> Result<ChildResult> {
        let GuestRun {
            kernel,
            cmdline,
            disk,
            ram,
            steps,
            expected_bars,
        } = run;
        check_vmm(self.wake)?;
        let key = generate_build_ssh_key()?;
        let boot = GuestBootV3 {
            contract: GUEST_CONTRACT,
            hostname: "intar-build".to_owned(),
            network: GuestNetworkV3 {
                ip_cidr: GUEST_CIDR.to_owned(),
                gateway: GATEWAY.to_owned(),
                dns: Vec::new(),
            },
            peers: BTreeMap::new(),
            ssh: GuestSshV3 {
                enabled: true,
                authorized_keys: vec![key.public_key_openssh.clone()],
            },
            root_resize: false,
            mode: SpecMode::Learn,
            spec: MachineSpecV1::default(),
        };
        let boot_json = serde_json::to_vec(&boot)?;
        let boot_sha256 = crate::sha256::sha256_bytes_hex(&boot_json);
        let kino = fs::read(&self.wake.kino)
            .with_context(|| format!("read Kino {}", self.wake.kino.display()))?;
        let (run_disk, recording_disk) = (dir.join("run.img"), dir.join("rec.img"));
        write_fat(
            &run_disk,
            RUN_DISK_BYTES,
            RUNTIME_DISK_LABEL,
            None,
            &[(BOOT_JSON_FILENAME, &boot_json), (KINO_FILENAME, &kino)],
        )?;
        write_fat(
            &recording_disk,
            RECORDING_DISK_BYTES,
            RECORDING_DISK_LABEL,
            Some(RECORDING_VOLUME_ID),
            &[],
        )?;
        let text = |path: PathBuf| path.display().to_string();
        let job = ChildJob {
            vmm: self.wake.vmm_binary.clone(),
            kernel: kernel.to_owned(),
            initramfs: text(self.base.initrd_path.clone()),
            cmdline: cmdline.to_owned(),
            disk: text(disk.to_path_buf()),
            run_disk: text(run_disk.clone()),
            recording_disk: text(recording_disk.clone()),
            serial: text(dir.join("serial.log")),
            console: text(dir.join("console.log")),
            vsock: text(dir.join("v.sock")),
            api: text(dir.join("api.sock")),
            ram: text(ram.to_path_buf()),
            cpu_profile: text(self.wake.cpu_profile.clone()),
            boot_sha256,
            ssh_key: private_key_to_openssh(&key.private_key)?,
            log: self.log.to_path_buf(),
            steps,
            expected_bars: expected_bars.map(str::to_owned),
            result: dir.join("result.json"),
            timeout_seconds: self.config.provision_timeout_seconds.max(60),
        };
        let job_path = dir.join("job.json");
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&job_path)?;
        file.write_all(&serde_json::to_vec(&job)?)?;
        drop(file);

        let started = Instant::now();
        let output = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log)?;
        let mut child = Command::new("unshare")
            .args(["--user", "--map-root-user", "--net", "--"])
            .arg(std::env::current_exe()?)
            .arg(WAKE_CHILD_ARG)
            .arg(&job_path)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(output.try_clone()?)
            .stderr(output)
            .spawn()
            .context("start the wake VM's namespace")?;
        let deadline = started + Duration::from_secs(job.timeout_seconds + 600);
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if Instant::now() > deadline {
                let pid = rustix::process::Pid::from_child(&child);
                let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
                let _ = child.wait();
                bail!(
                    "the wake VM did not finish in time; see {}",
                    self.log.display()
                );
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        for file in [&job_path, &run_disk, &recording_disk] {
            let _ = fs::remove_file(file);
        }
        ensure!(
            status.success(),
            "the wake VM failed ({status}); see {} and {}",
            self.log.display(),
            dir.join("serial.log").display()
        );
        let result: ChildResult = serde_json::from_slice(&fs::read(&job.result)?)
            .context("the wake VM left no result")?;
        log_line(
            self.log,
            &format!(
                "guest first_report_ms={} ready_ms={} steps_ms={} quiet={} quiet_ms={} suspend_ms={} total_ms={}",
                result.first_report_ms,
                result.ready_ms,
                result.steps_ms,
                result.quiet,
                result.quiet_ms,
                result.suspend_ms,
                started.elapsed().as_millis()
            ),
        )?;
        Ok(result)
    }
}

/// The delta as [`DELTA_PART_BYTES`] layers, read a part at a time; a delta
/// over `limit` (what a run host accepts) fails the build.
fn write_delta_parts(writer: &mut ImageWriter, delta: &Path, limit: u64) -> Result<usize> {
    let mut file = fs::File::open(delta)?;
    let size = file.metadata()?.len();
    ensure!(
        size <= limit,
        "the pack's RAM delta is {size} bytes, over the {limit} byte limit"
    );
    let mut part = vec![0_u8; DELTA_PART_BYTES];
    let mut parts = 0;
    loop {
        let mut filled = 0;
        while filled < part.len() {
            let read = file.read(&mut part[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        if filled == 0 {
            return Ok(parts);
        }
        writer.bytes(&part[..filled], WAKE_DELTA_MEDIA_TYPE)?;
        parts += 1;
    }
}

fn write_fat(
    path: &Path,
    bytes: u64,
    label: [u8; 11],
    volume_id: Option<u32>,
    files: &[(&str, &[u8])],
) -> Result<()> {
    use std::io::{Seek as _, SeekFrom};
    let mut image = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    image.set_len(bytes)?;
    let mut options = fatfs::FormatVolumeOptions::new().volume_label(label);
    if let Some(id) = volume_id {
        options = options.volume_id(id);
    }
    fatfs::format_volume(&mut image, options).context("format a FAT disk")?;
    image.seek(SeekFrom::Start(0))?;
    let fs = fatfs::FileSystem::new(image, fatfs::FsOptions::new())?;
    for (name, content) in files {
        fs.root_dir().create_file(name)?.write_all(content)?;
    }
    Ok(())
}

/// The kernel build's stub templates, out of the base's ext4.
fn stub_templates(base_ext4: &Path) -> Result<Vec<u8>> {
    let output = Command::new("debugfs")
        .arg("-R")
        .arg(format!("cat {}", crate::kernel::WAKE_STUB_TEMPLATES_PATH))
        .arg(base_ext4)
        .stderr(Stdio::null())
        .output()
        .context("run debugfs")?;
    ensure!(
        output.status.success() && !output.stdout.is_empty(),
        "the platform base has no wake stub templates"
    );
    Ok(output.stdout)
}

fn same_bytes(one: &Path, other: &Path) -> Result<bool> {
    let (mut one, mut other) = (fs::File::open(one)?, fs::File::open(other)?);
    if one.metadata()?.len() != other.metadata()?.len() {
        return Ok(false);
    }
    let (mut left, mut right) = (vec![0_u8; 4 << 20], vec![0_u8; 4 << 20]);
    loop {
        let read = one.read(&mut left)?;
        if read == 0 {
            return Ok(true);
        }
        other.read_exact(&mut right[..read])?;
        if left[..read] != right[..read] {
            return Ok(false);
        }
    }
}

/// The namespace child: `<builder> __intar-wake-child <job.json>`.
///
/// # Errors
/// Returns an error when any step of the wake VM fails.
pub fn run_wake_child(job: &Path) -> Result<()> {
    let job: ChildJob = serde_json::from_slice(&fs::read(job)?)?;
    #[cfg(target_os = "linux")]
    rustix::process::set_parent_process_death_signal(Some(rustix::process::Signal::KILL))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        tokio::select! {
            result = child(&job) => result,
            error = logs_over_limit(&job) => Err(error),
        }
    });
    if let Err(error) = &result {
        let _ = log_line(&job.log, &format!("error: {error:#}"));
    }
    fs::write(&job.result, serde_json::to_vec(&result?)?)?;
    Ok(())
}

/// The VM's serial, console and VMM logs are capped as the QEMU build's
/// serial log is: past the limit the run fails, and the VMM goes with it.
async fn logs_over_limit(job: &ChildJob) -> anyhow::Error {
    let logs = [
        PathBuf::from(&job.serial),
        PathBuf::from(&job.console),
        Path::new(&job.serial).with_file_name("vmm.log"),
    ];
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Some(error) = logs
            .iter()
            .find_map(|log| log_over_limit(log, BUILD_LOG_LIMIT_BYTES))
        {
            return error;
        }
    }
}

fn log_over_limit(log: &Path, limit: u64) -> Option<anyhow::Error> {
    let size = fs::metadata(log).map_or(0, |metadata| metadata.len());
    (size > limit).then(|| {
        anyhow::anyhow!(
            "the wake VM wrote {size} bytes to {}, over the {limit} byte limit",
            log.display()
        )
    })
}

fn ip(args: &[&str]) -> Result<()> {
    let status = Command::new("ip").args(args).status().context("run ip")?;
    ensure!(status.success(), "ip {} failed", args.join(" "));
    Ok(())
}

/// The VM the base and pack steps boot: the agent's cold config in the wake
/// shape, the RAM shared so the file is the guest's memory.
fn build_vm_config(job: &ChildJob) -> Result<cloud_hypervisor_client::VmConfig> {
    let cold = machine_vm_config(&MachineVmInput {
        name: "intar-build",
        cpu_millis: WAKE_BOOT_VCPUS * 1000,
        memory_mib: u32::try_from(WAKE_MEMORY_BYTES >> 20)?,
        kernel: &job.kernel,
        initramfs: Some(&job.initramfs),
        cmdline: &job.cmdline,
        root_disk: &job.disk,
        runtime_disk: &job.run_disk,
        recording_disk: &job.recording_disk,
        serial_log: &job.serial,
        console_log: &job.console,
        tap: TAP,
        mac: WAKE_BUILD_MAC,
        vsock_socket: &job.vsock,
        vsock_cid: WAKE_BUILD_VSOCK_CID,
    });
    Ok(wake_vm_config(
        cold,
        &WakeShape {
            memory_bytes: WAKE_MEMORY_BYTES,
            boot_vcpus: WAKE_BOOT_VCPUS,
            max_vcpus: WAKE_MAX_VCPUS,
            balloon: WAKE_BALLOON,
            max_phys_bits: WAKE_MAX_PHYS_BITS,
        },
        &job.cpu_profile,
        &job.ram,
        true,
        u32::try_from(WAKE_MEMORY_BYTES >> 20)?,
    )?)
}

async fn child(job: &ChildJob) -> Result<ChildResult> {
    use tokio::time::timeout;
    let log = &job.log;
    let deadline = Instant::now() + Duration::from_secs(job.timeout_seconds);
    ip(&["link", "set", "lo", "up"])?;
    ip(&["tuntap", "add", "dev", TAP, "mode", "tap"])?;
    ip(&["addr", "add", HOST_CIDR, "dev", TAP])?;
    ip(&["link", "set", TAP, "up"])?;
    let listener = tokio::net::UnixListener::bind(format!("{}_{REPORT_PORT}", job.vsock))?;
    let vmm_log = fs::File::create(Path::new(&job.serial).with_file_name("vmm.log"))?;
    let mut vmm = tokio::process::Command::new(&job.vmm)
        .args([
            "--api-socket",
            &format!("path={}", job.api),
            "--seccomp",
            "true",
        ])
        .stdin(Stdio::null())
        .stdout(vmm_log.try_clone()?)
        .stderr(vmm_log)
        .kill_on_drop(true)
        .spawn()
        .context("start the VMM")?;
    let pid = vmm.id().context("the VMM has no pid")?;
    let mut waited = 0;
    while !Path::new(&job.api).exists() && waited < 100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        waited += 1;
    }
    let ch = cloud_hypervisor_client::Client::new(job.api.clone())?;
    ch.ping().await.context("the VMM does not answer")?;
    let config = build_vm_config(job)?;
    ch.vm_create(&config).await.context("vm.create")?;
    let booted_at_unix_ms = unix_ms();
    let booted = Instant::now();
    ch.vm_boot().await.context("vm.boot")?;

    let (sender, mut reports) = tokio::sync::mpsc::channel(64);
    let boot_sha256 = job.boot_sha256.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(read_reports(stream, boot_sha256.clone(), sender.clone()));
        }
    });
    let mut first_report_ms = None;
    let ready_ms = loop {
        tokio::select! {
            report = reports.recv() => {
                let report: intar_kino_proto::host::GuestReport = match report {
                    Some(Ok(report)) => report,
                    Some(Err(error)) => bail!("a guest report is broken: {error}"),
                    None => bail!("the report listener stopped"),
                };
                let at = u64::try_from(booted.elapsed().as_millis())?;
                first_report_ms.get_or_insert(at);
                if let Some(failure) = report.failed {
                    bail!("the guest failed: {failure}");
                }
                if report.lab.state == intar_contracts::bridge_v9::LabState::Ready {
                    break at;
                }
            }
            status = vmm.wait() => bail!("the VMM exited before READY: {status:?}"),
            () = tokio::time::sleep(READY_TIMEOUT.saturating_sub(booted.elapsed())) => {
                bail!("the guest was not READY within {READY_TIMEOUT:?}")
            }
        }
    };
    log_line(log, &format!("ready_ms={ready_ms}"))?;

    let key = russh::keys::PrivateKey::from_openssh(&job.ssh_key)?;
    let mut ssh = loop {
        let attempt = timeout(Duration::from_secs(10), async {
            let mut ssh = BuildSshSession::connect(GUEST_ADDRESS, 22, GUEST_USERNAME, &key).await?;
            ssh.run("true").await?;
            anyhow::Ok(ssh)
        })
        .await;
        match attempt {
            Ok(Ok(ssh)) => break ssh,
            _ if Instant::now() > deadline => bail!("no SSH to the guest"),
            _ => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    };
    let started = Instant::now();
    for step in &job.steps {
        let left = deadline.saturating_duration_since(Instant::now());
        match step {
            GuestStep::Upload { local } => {
                timeout(left, ssh.upload_file(local, UPLOAD_PATH, 0o600))
                    .await
                    .context("upload timed out")??;
            }
            GuestStep::Run { label, command } => {
                let step_started = Instant::now();
                timeout(left, ssh.run_logged(command, log))
                    .await
                    .with_context(|| format!("{label} timed out"))?
                    .with_context(|| format!("{label} failed"))?;
                log_line(
                    log,
                    &format!("{label} elapsed_ms={}", step_started.elapsed().as_millis()),
                )?;
            }
        }
    }
    let steps_ms = u64::try_from(started.elapsed().as_millis())?;

    let started = Instant::now();
    let quiet = quiet(pid).await?;
    let quiet_ms = u64::try_from(started.elapsed().as_millis())?;
    log_line(log, &format!("quiet={quiet} quiet_ms={quiet_ms}"))?;
    let bars = String::from_utf8(ssh.run_output(&as_root(BARS_SCRIPT)).await?)?;
    if let Some(expected) = &job.expected_bars {
        ensure!(
            bars == *expected,
            "the guest's BAR table is not its base's:\n{bars}"
        );
    }
    let started = Instant::now();
    ssh.run(&as_root(&format!(
        "systemd-run --quiet --collect --unit=intar-suspend sh -c {}",
        super::host::shell_quote(SUSPEND_SCRIPT)
    )))
    .await
    .context("start the suspend")?;
    let _ = timeout(Duration::from_secs(5), ssh.disconnect()).await;
    let status = timeout(SUSPEND_TIMEOUT, vmm.wait())
        .await
        .context("the guest did not suspend")??;
    let suspend_ms = u64::try_from(started.elapsed().as_millis())?;
    log_line(log, &format!("vmm exited {status} suspend_ms={suspend_ms}"))?;
    Ok(ChildResult {
        booted_at_unix_ms,
        first_report_ms: first_report_ms.unwrap_or_default(),
        ready_ms,
        steps_ms,
        quiet_ms,
        quiet,
        bars,
        suspend_ms,
    })
}

async fn read_reports(
    mut stream: tokio::net::UnixStream,
    boot_sha256: String,
    sender: tokio::sync::mpsc::Sender<
        std::result::Result<intar_kino_proto::host::GuestReport, String>,
    >,
) {
    use tokio::io::AsyncReadExt as _;
    loop {
        let mut length = [0_u8; 4];
        if stream.read_exact(&mut length).await.is_err() {
            return;
        }
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 || length > intar_kino_proto::kino_v2::MAX_FRAME_BYTES {
            let _ = sender.send(Err(format!("a frame of {length} bytes"))).await;
            return;
        }
        let mut body = vec![0_u8; length];
        if stream.read_exact(&mut body).await.is_err() {
            return;
        }
        let event = match intar_kino_proto::host::decode(&body, &boot_sha256) {
            Ok(intar_kino_proto::host::Decoded::Stale) => continue,
            Ok(intar_kino_proto::host::Decoded::Report(report)) => Ok(*report),
            Err(error) => Err(error.to_string()),
        };
        if sender.send(event).await.is_err() {
            return;
        }
    }
}

/// CPU ticks the VMM's vCPU threads have used.
fn vcpu_ticks(pid: u32) -> Result<u64> {
    let mut total = 0;
    for task in fs::read_dir(format!("/proc/{pid}/task"))? {
        let task = task?.path();
        let Ok(name) = fs::read_to_string(task.join("comm")) else {
            continue;
        };
        if !name.starts_with("vcpu") {
            continue;
        }
        let stat = fs::read_to_string(task.join("stat"))?;
        let fields: Vec<&str> = stat
            .rsplit_once(')')
            .map(|(_, rest)| rest.split_whitespace().collect())
            .unwrap_or_default();
        // utime and stime, fields 14 and 15 of stat(5).
        for at in [11, 12] {
            total += fields
                .get(at)
                .and_then(|field| field.parse::<u64>().ok())
                .context("a vCPU thread's stat is short")?;
        }
    }
    Ok(total)
}

/// Wait until the vCPUs used at most one CPU in each of the last
/// [`QUIET_SECONDS`] seconds; `false` when [`QUIET_BOUND`] passed first.
async fn quiet(pid: u32) -> Result<bool> {
    let started = Instant::now();
    let mut seconds = VecDeque::with_capacity(QUIET_SECONDS);
    let mut last = vcpu_ticks(pid)?;
    while started.elapsed() < QUIET_BOUND {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let now = vcpu_ticks(pid)?;
        if seconds.len() == QUIET_SECONDS {
            seconds.pop_front();
        }
        seconds.push_back(now.saturating_sub(last));
        last = now;
        if seconds.len() == QUIET_SECONDS && seconds.iter().all(|ticks| *ticks <= TICKS_PER_SECOND)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_delta_is_written_in_parts_and_capped() {
        let dir = tempfile::tempdir().expect("dir");
        let delta = dir.path().join("delta");
        fs::write(&delta, vec![7_u8; DELTA_PART_BYTES + 5]).expect("delta");
        let mut writer = ImageWriter::new(&dir.path().join("out")).expect("writer");
        assert_eq!(
            write_delta_parts(&mut writer, &delta, u64::MAX).expect("parts"),
            2
        );
        let limit = u64::try_from(DELTA_PART_BYTES).expect("size");
        assert!(write_delta_parts(&mut writer, &delta, limit).is_err());
    }

    #[test]
    fn old_bases_expire() {
        let day = 24 * 3_600_000;
        assert!(!expired(0, 30 * day));
        assert!(expired(0, 30 * day + 1));
    }

    #[test]
    fn the_cache_evicts_the_least_recently_used_bases_not_held_ones() {
        let cache = tempfile::tempdir().expect("cache");
        let entry = |name: &str, age_s: u64| {
            let dir = cache.path().join(name);
            fs::create_dir_all(&dir).expect("entry");
            let record = fs::File::create(dir.join("base.json")).expect("record");
            record
                .set_modified(SystemTime::now() - Duration::from_secs(age_s))
                .expect("mtime");
            fs::File::create(dir.join(".lock")).expect("lock");
            dir
        };
        let (old, held, recent, keep) = (
            entry("old", 400),
            entry("held", 300),
            entry("recent", 100),
            entry("keep", 1_000),
        );
        fs::create_dir_all(cache.path().join(".building-x")).expect("leftover");
        let lock = fs::File::open(held.join(".lock")).expect("lock");
        fs2::FileExt::lock_shared(&lock).expect("hold");
        assert_eq!(
            evict_bases(cache.path(), &keep, 3).expect("evict"),
            vec![old.clone()]
        );
        assert_eq!(
            evict_bases(cache.path(), &keep, 2).expect("evict"),
            vec![recent.clone()]
        );
        assert!(held.exists() && keep.exists() && !old.exists() && !recent.exists());
    }

    #[test]
    fn a_log_over_the_limit_fails_the_run() {
        let dir = tempfile::tempdir().expect("dir");
        let log = dir.path().join("serial.log");
        assert!(log_over_limit(&log, 4).is_none());
        fs::write(&log, b"12345").expect("log");
        assert!(log_over_limit(&log, 5).is_none());
        assert!(log_over_limit(&log, 4).is_some());
    }

    use super::*;

    #[test]
    fn the_same_bytes_are_the_same() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (one, other) = (dir.path().join("one"), dir.path().join("other"));
        fs::write(&one, vec![7_u8; 5 << 20]).expect("one");
        fs::write(&other, vec![7_u8; 5 << 20]).expect("other");
        assert!(same_bytes(&one, &other).expect("compare"));
        let mut changed = vec![7_u8; 5 << 20];
        changed[(5 << 20) - 1] = 8;
        fs::write(&other, changed).expect("other");
        assert!(!same_bytes(&one, &other).expect("compare"));
    }

    #[test]
    fn a_fat_disk_holds_its_files_under_its_label() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("run.img");
        write_fat(
            &path,
            RUN_DISK_BYTES,
            RUNTIME_DISK_LABEL,
            None,
            &[("boot.json", b"{}")],
        )
        .expect("fat");
        let fs = fatfs::FileSystem::new(
            fs::File::open(&path).expect("open"),
            fatfs::FsOptions::new(),
        )
        .expect("fs");
        assert_eq!(fs.volume_label(), "INTARRUN");
        let mut content = String::new();
        fs.root_dir()
            .open_file("boot.json")
            .expect("file")
            .read_to_string(&mut content)
            .expect("read");
        assert_eq!(content, "{}");
    }
}
