//! The build VM of a plan: restore the latest checkpoint of the chain or
//! cold-boot the base, run the remaining stages with a checkpoint after
//! each, finalize, and repack the root onto the third drive.

use std::fs;
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};
use intar_contracts::guest::GUEST_USERNAME;
use russh::keys::PrivateKey;
use serde_json::json;

use super::host::{
    CHECKPOINT_MEMORY_RELEASE_COMMAND, ResumeMetadata, VIRTIO_BALLOON_VERIFY_COMMAND,
    append_layered_devices, link_frozen_checkpoint_scratch, migration_writer_command,
    qemu_host_identity, remaining_until, remove_work_file, render_clock_set_command,
    replace_serial_log_with_append, resolve_binary, run_command_output_until, shell_quote,
    snapshot_sync_arguments, timeout_in_runtime, wait_for_checkpoint_output,
};
use super::plan::{BuildPlan, CheckpointHost, checkpoint_identities};
use super::qmp::Qmp;
use super::script::{
    REPACK_DEVICE, UPLOAD_PATH, as_root, finalize_script, record_boot_files, repack_script,
    stage_command, stage_file,
};
use super::shutdown::{
    DirectQemuShutdownInput, SSH_HOST, SSH_POLL_INTERVAL, acknowledged_qmp_shutdown,
    allocate_ssh_host_port, terminate_qemu,
};
use crate::checkpoint::{
    CheckpointCache, CheckpointCacheConfig, CheckpointIdentity, CheckpointLease, CheckpointPublish,
    CheckpointSlot,
};
use crate::config::QemuBuildConfig;
use crate::disk::{prepare_scenario_disk, render_scenario_disk_plan};
use crate::qemu::{BUILD_BOOT_CMDLINE, DirectBootQemuInput, render_direct_boot_qemu_command};
use crate::rootfs::BaseRootfsArtifact;
use crate::seed::{BuildSeedInput, write_build_seed};
use crate::sha256::sha256_file_hex;
use crate::ssh::{BuildSshKey, BuildSshSession, generate_build_ssh_key, private_key_to_openssh};

/// The files a spawn names; [`Files::canonical`] for checkpoint identities.
struct Files {
    seed: PathBuf,
    serial: PathBuf,
    kernel: PathBuf,
    initrd: PathBuf,
    repack: PathBuf,
}

impl Files {
    fn canonical() -> Self {
        Self {
            seed: "/intar/seed.img".into(),
            serial: "/intar/serial.log".into(),
            kernel: "/intar/kernel".into(),
            initrd: "/intar/initrd".into(),
            repack: "/intar/repack.raw".into(),
        }
    }
}

struct Vm<'a> {
    plan: &'a BuildPlan,
    config: &'a QemuBuildConfig,
    work: &'a Path,
    files: Files,
    qmp: PathBuf,
    log: PathBuf,
    port: u16,
    runtime: tokio::runtime::Runtime,
    deadline: Instant,
}

struct Guest {
    child: Child,
    disk: PathBuf,
    parent_disks: Vec<PathBuf>,
    key: BuildSshKey,
    ssh: Option<BuildSshSession>,
    // The overlay's backing file while restored.
    lease: Option<CheckpointLease>,
    finished: bool,
}

impl Drop for Guest {
    fn drop(&mut self) {
        if !self.finished {
            let _ = terminate_qemu(&mut self.child);
        }
    }
}

/// Build the plan's disk in `work` and return the repacked raw disk. Logs go
/// to `log` and the serial console next to it.
pub(crate) fn build_disk(
    plan: &BuildPlan,
    config: &QemuBuildConfig,
    base: &BaseRootfsArtifact,
    work: &Path,
    log: &Path,
) -> Result<PathBuf> {
    fs::set_permissions(work, fs::Permissions::from_mode(0o700))?;
    let vm = Vm {
        plan,
        config,
        work,
        files: Files {
            seed: work.join("seed.img"),
            serial: log.with_extension("serial.log"),
            kernel: base.kernel_path.clone(),
            initrd: base.initrd_path.clone(),
            repack: work.join("repack.raw"),
        },
        qmp: work.join("qmp.sock"),
        log: log.to_path_buf(),
        port: allocate_ssh_host_port()?,
        runtime: tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?,
        deadline: Instant::now() + Duration::from_secs(config.provision_timeout_seconds.max(1)),
    };
    fs::write(
        &vm.log,
        format!("== build {} ==\n", plan.build_key.as_str()),
    )?;
    fs::write(&vm.files.serial, "")?;
    let (qemu_version, qemu_cpu) =
        qemu_host_identity(&config.qemu_binary, work, config.qemu_exit_timeout_seconds)?;
    let host = CheckpointHost {
        base_sha256: sha256_file_hex(&base.base_ext4_path)?,
        kernel_sha256: sha256_file_hex(&base.kernel_path)?,
        initrd_sha256: sha256_file_hex(&base.initrd_path)?,
        qemu_version,
        qemu_cpu,
        qemu_devices: vm.args(Path::new("/intar/root.qcow2"), &Files::canonical(), 0),
    };
    let identities = checkpoint_identities(plan, &host)?;
    let settings = &config.layered;
    let cache = CheckpointCache::new(CheckpointCacheConfig {
        root: settings
            .checkpoint_cache_root
            .clone()
            .unwrap_or_else(|| config.work_root.join("checkpoint-cache")),
        use_cache: settings.use_cache,
        budget_bytes: settings.checkpoint_cache_bytes,
        minimum_free_bytes: settings.minimum_free_bytes,
    })?;

    let mut restored = None;
    for (index, identity) in identities.iter().enumerate().rev() {
        let Some(lease) = cache.restore(identity)? else {
            continue;
        };
        let key = lease.entry.key.clone();
        match vm.restore(lease, index) {
            Ok(guest) => {
                vm.log(&format!(
                    "checkpoint_restored stage={} key={key}",
                    plan.stages[index].name
                ))?;
                restored = Some((guest, index + 1));
            }
            Err(error) => {
                vm.log(&format!(
                    "checkpoint_restore_failed error={error:#}; cold boot"
                ))?;
                cache.invalidate(identity)?;
            }
        }
        break;
    }
    let (mut guest, first) = match restored {
        Some(restored) => restored,
        None => (vm.cold(base)?, 0),
    };
    for (index, stage) in plan.stages.iter().enumerate().skip(first) {
        let started = Instant::now();
        vm.run_stage(&mut guest, index)?;
        vm.log(&format!(
            "stage={index} name={} elapsed_ms={}",
            stage.name,
            started.elapsed().as_millis()
        ))?;
        if settings.use_cache {
            vm.checkpoint(&cache, &mut guest, &identities[index], index)?;
        }
    }

    let started = Instant::now();
    let finalize = finalize_script(&plan.defer);
    vm.guest_run(&mut guest, &as_root(&finalize), "finalize")?;
    vm.log(&format!(
        "finalize elapsed_ms={}",
        started.elapsed().as_millis()
    ))?;
    let started = Instant::now();
    vm.guest_run(&mut guest, &as_root(&repack_script()), "repack")?;
    vm.log(&format!(
        "repack device={REPACK_DEVICE} elapsed_ms={}",
        started.elapsed().as_millis()
    ))?;
    if let Some(ssh) = guest.ssh.take() {
        vm.runtime.block_on(ssh.disconnect())?;
    }
    acknowledged_qmp_shutdown(
        &mut guest.child,
        &DirectQemuShutdownInput {
            qmp_socket_path: &vm.qmp,
            serial_log_path: &vm.files.serial,
            build_log_path: &vm.log,
            timeout_seconds: config.qemu_exit_timeout_seconds,
        },
    )?;
    guest.finished = true;
    drop(guest);
    vm.log("shutdown")?;
    Ok(vm.files.repack)
}

impl Vm<'_> {
    fn args(&self, disk: &Path, files: &Files, port: u16) -> Vec<String> {
        let mut args = render_direct_boot_qemu_command(&DirectBootQemuInput {
            config: self.config,
            root_disk_path: disk,
            seed_disk_path: &files.seed,
            kernel_path: &files.kernel,
            initrd_path: &files.initrd,
            serial_log_path: &files.serial,
            qmp_socket_path: Path::new("qmp.sock"),
            ssh_host_port: port,
            memory_mib: self.config.build_memory_mb,
            cpu_count: self.config.build_cpus,
            boot_cmdline: BUILD_BOOT_CMDLINE,
        })
        .args;
        for arg in &mut args {
            if arg.starts_with("if=virtio,format=raw,discard=") {
                *arg = format!(
                    "if=virtio,format=qcow2,id=intar-root,discard=unmap,detect-zeroes=unmap,file={}",
                    disk.display()
                );
            }
        }
        // vdc, after the seed at vdb.
        let seed = args
            .iter()
            .position(|arg| arg.contains("readonly=on"))
            .map_or(args.len(), |at| at + 1);
        args.splice(
            seed..seed,
            [
                "-drive".to_owned(),
                format!(
                    "if=virtio,format=raw,discard=unmap,file={}",
                    files.repack.display()
                ),
            ],
        );
        replace_serial_log_with_append(&mut args, &files.serial);
        append_layered_devices(&mut args);
        args
    }

    fn spawn(&self, disk: &Path, incoming: bool) -> Result<Child> {
        remove_work_file(&self.qmp)?;
        // A fresh sparse target at every spawn: nothing reads it before the
        // repack writes it.
        fs::File::create(&self.files.repack)?.set_len(self.plan.disk_bytes)?;
        let mut args = self.args(disk, &self.files, self.port);
        if incoming {
            args.extend(["-incoming".to_owned(), "defer".to_owned()]);
        }
        fs::write(self.work.join("qemu.args"), args.join("\n"))?;
        Command::new(&self.config.qemu_binary)
            .args(args)
            .current_dir(self.work)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .context("failed to start the build VM")
    }

    fn cold(&self, base: &BaseRootfsArtifact) -> Result<Guest> {
        let started = Instant::now();
        let raw = self.work.join("root.raw");
        prepare_scenario_disk(&render_scenario_disk_plan(
            &base.base_ext4_path,
            &raw,
            self.plan.disk_bytes,
            self.config,
        ))?;
        let key = generate_build_ssh_key()?;
        write_build_seed(&BuildSeedInput {
            path: &self.files.seed,
            ssh_authorized_keys_openssh: std::slice::from_ref(&key.public_key_openssh),
            guest_ip_cidr: "10.0.2.15/24",
            gateway: "10.0.2.2",
            dns: "10.0.2.3",
            iface: None,
        })?;
        let disk = self.work.join("active.qcow2");
        self.img(&["convert", "-f", "raw", "-O", "qcow2"], &[&raw, &disk])?;
        fs::remove_file(&raw)?;
        let mut guest = Guest {
            child: self.spawn(&disk, false)?,
            disk,
            parent_disks: Vec::new(),
            key,
            ssh: None,
            lease: None,
            finished: false,
        };
        self.connect(&mut guest)?;
        self.guest_run(
            &mut guest,
            &as_root(VIRTIO_BALLOON_VERIFY_COMMAND),
            "balloon",
        )?;
        self.guest_run(&mut guest, &record_boot_files(), "boot files")?;
        self.log(&format!(
            "cold_boot elapsed_ms={}",
            started.elapsed().as_millis()
        ))?;
        Ok(guest)
    }

    fn restore(&self, lease: CheckpointLease, index: usize) -> Result<Guest> {
        ensure!(
            lease.entry.stage_index == index,
            "checkpoint stage index does not match its prefix"
        );
        let metadata: ResumeMetadata = serde_json::from_value(lease.entry.metadata.clone())
            .context("invalid checkpoint metadata")?;
        ensure!(
            metadata.memory_encoding == "zstd",
            "unsupported checkpoint memory encoding"
        );
        let private_key = PrivateKey::from_openssh(&metadata.bootstrap_private_key)
            .context("invalid checkpoint build key")?;
        let key = BuildSshKey {
            public_key_openssh: private_key.public_key().to_openssh()?,
            private_key,
        };
        fs::copy(&lease.entry.seed_disk_path, &self.files.seed)?;
        let backing = lease.entry.qcow2_path.clone();
        let state = lease.entry.memory_state_path.clone();
        self.img(&["check", "-f", "qcow2"], &[&backing])?;
        let disk = self.work.join("active.qcow2");
        remove_work_file(&disk)?;
        let backing_name = backing.to_str().context("checkpoint path is not UTF-8")?;
        self.img(
            &["create", "-f", "qcow2", "-F", "qcow2", "-b", backing_name],
            &[&disk],
        )?;
        let mut guest = Guest {
            child: self.spawn(&disk, true)?,
            disk,
            parent_disks: Vec::new(),
            key,
            ssh: None,
            lease: Some(lease),
            finished: false,
        };
        let zstd = resolve_binary(Path::new("zstd"))?;
        let mut qmp = Qmp::connect(&self.qmp, self.deadline)?;
        qmp.execute(
            "migrate-incoming",
            json!({"channels": [{"channel-type": "main", "addr": {"transport": "exec", "args": [zstd, "-d", "-q", "-c", state]}}]}),
            self.deadline,
        )?;
        qmp.wait_migration(self.deadline)?;
        qmp.execute("cont", json!({}), self.deadline)?;
        drop(qmp);
        self.connect(&mut guest)?;
        self.rotate_credentials(&mut guest)?;
        Ok(guest)
    }

    /// A restored guest gets the host's clock, a new build key and fresh
    /// entropy, then a new session with that key.
    fn rotate_credentials(&self, guest: &mut Guest) -> Result<()> {
        let new_key = generate_build_ssh_key()?;
        let unix_seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("host clock is before the Unix epoch")?
            .as_secs();
        let mut entropy = [0_u8; 32];
        fs::File::open("/dev/urandom")?.read_exact(&mut entropy)?;
        let entropy: String = entropy
            .iter()
            .map(|byte| format!("\\x{byte:02x}"))
            .collect();
        let command = format!(
            r#"set -eu
install -d -m 0700 /run/intar-build-state
printf '%s\n' {key} > /run/intar-build-state/authorized_keys
chmod 0600 /run/intar-build-state/authorized_keys
if mountpoint -q /run/intar-build/authorized_keys; then umount /run/intar-build/authorized_keys; fi
mount --bind /run/intar-build-state/authorized_keys /run/intar-build/authorized_keys
install -m 0600 -o {GUEST_USERNAME} -g {GUEST_USERNAME} /run/intar-build-state/authorized_keys /home/{GUEST_USERNAME}/.ssh/authorized_keys
printf '%b' {entropy} > /dev/urandom
rm -f {UPLOAD_PATH}
"#,
            key = shell_quote(&new_key.public_key_openssh),
            entropy = shell_quote(&entropy),
        );
        self.guest_run(guest, &render_clock_set_command(unix_seconds), "clock")?;
        self.guest_run(guest, &as_root(&command), "credential rotation")?;
        if let Some(ssh) = guest.ssh.take() {
            self.runtime.block_on(ssh.disconnect())?;
        }
        guest.key = new_key;
        self.connect(guest)
    }

    fn run_stage(&self, guest: &mut Guest, index: usize) -> Result<()> {
        let stage = &self.plan.stages[index];
        let local = self.work.join("stage.sh");
        fs::write(&local, &stage.script)?;
        fs::set_permissions(&local, fs::Permissions::from_mode(0o600))?;
        let command = stage_command(&stage_file(index, &stage.name), &stage.env);
        let ssh = guest.ssh.as_mut().context("the build VM has no session")?;
        timeout_in_runtime(
            &self.runtime,
            remaining_until(self.deadline, "provision")?,
            "stage",
            async {
                ssh.upload_file(&local, UPLOAD_PATH, 0o600).await?;
                ssh.run_logged(&command, true, &self.log).await
            },
        )
        .with_context(|| format!("stage {index} `{}` failed", stage.name))
    }

    fn guest_run(&self, guest: &mut Guest, command: &str, phase: &str) -> Result<()> {
        let ssh = guest.ssh.as_mut().context("the build VM has no session")?;
        timeout_in_runtime(
            &self.runtime,
            remaining_until(self.deadline, phase)?,
            phase,
            ssh.run_logged(command, true, &self.log),
        )
        .with_context(|| format!("{phase} failed"))
    }

    fn connect(&self, guest: &mut Guest) -> Result<()> {
        let mut last_error = None;
        loop {
            if let Some(status) = guest.child.try_wait()? {
                bail!(
                    "the build VM exited with {status}; serial log: {}",
                    self.files.serial.display()
                );
            }
            let Ok(remaining) = remaining_until(self.deadline, "SSH") else {
                break;
            };
            let attempt = timeout_in_runtime(&self.runtime, remaining, "SSH", async {
                let mut ssh = BuildSshSession::connect(
                    SSH_HOST,
                    self.port,
                    GUEST_USERNAME,
                    &guest.key.private_key,
                )
                .await?;
                ssh.run("true", false).await?;
                Ok(ssh)
            });
            match attempt {
                Ok(ssh) => {
                    guest.ssh = Some(ssh);
                    return Ok(());
                }
                Err(error) => last_error = Some(error),
            }
            std::thread::sleep(SSH_POLL_INTERVAL);
        }
        bail!(
            "no SSH to the build VM: {last_error:?}; serial log: {}",
            self.files.serial.display()
        )
    }

    /// Pause, save memory and freeze the disk, publish both, and continue.
    fn checkpoint(
        &self,
        cache: &CheckpointCache,
        guest: &mut Guest,
        identity: &CheckpointIdentity,
        index: usize,
    ) -> Result<()> {
        let started = Instant::now();
        let allocated =
            |path: &Path| -> Result<u64> { Ok(fs::metadata(path)?.blocks().saturating_mul(512)) };
        let mut reservation = allocated(&guest.disk)?;
        for disk in &guest.parent_disks {
            reservation = reservation.saturating_add(allocated(disk)?);
        }
        if let Some(lease) = &guest.lease {
            reservation = reservation.saturating_add(allocated(&lease.entry.qcow2_path)?);
        }
        let reservation = reservation
            .saturating_add(u64::from(self.config.build_memory_mb) * 1024 * 1024)
            .saturating_add(256 * 1024 * 1024);
        let Some(writer) = cache.reserve(identity, CheckpointSlot::BeforeLastStep, reservation)?
        else {
            return self.log(&format!("checkpoint_skipped stage={index} reason=cache"));
        };
        if !writer.has_work_space(self.work)? {
            return self.log(&format!("checkpoint_skipped stage={index} reason=space"));
        }
        let zstd = resolve_binary(Path::new("zstd"))?;
        self.guest_run(
            guest,
            &as_root(CHECKPOINT_MEMORY_RELEASE_COMMAND),
            "memory release",
        )?;
        if let Some(ssh) = guest.ssh.take() {
            self.runtime.block_on(ssh.disconnect())?;
        }
        let directory = tempfile::Builder::new()
            .prefix("checkpoint-")
            .tempdir_in(self.work)?;
        let memory = directory.path().join("memory.state.zst");
        let partial = directory.path().join("memory.state.zst.partial");
        let complete = directory.path().join("memory.state.complete");
        let snapshot = directory.path().join("checkpoint.qcow2");
        let continuation = fs::canonicalize(self.work)?.join(format!("active-{index}.qcow2"));
        let deadline = (Instant::now()
            + Duration::from_secs(self.config.qemu_exit_timeout_seconds.max(1)))
        .min(self.deadline);
        let mut qmp = Qmp::connect(&self.qmp, deadline)?;
        qmp.execute("stop", json!({}), deadline)?;
        qmp.execute(
            "migrate-set-parameters",
            json!({"max-bandwidth": 0}),
            deadline,
        )?;
        qmp.execute(
            "migrate",
            json!({"channels": [{"channel-type": "main", "addr": {"transport": "exec", "args": ["/bin/sh", "-c", migration_writer_command(&zstd, &partial, &memory, &complete)?]}}]}),
            deadline,
        )?;
        qmp.wait_migration(deadline)?;
        wait_for_checkpoint_output(&memory, &complete, deadline)?;
        fs::File::open(&memory)?.sync_all()?;
        let status = qmp.execute("query-status", json!({}), deadline)?;
        ensure!(
            status.get("status").and_then(serde_json::Value::as_str) == Some("postmigrate"),
            "QEMU did not enter postmigrate: {status}"
        );
        qmp.execute(
            "blockdev-snapshot-sync",
            snapshot_sync_arguments(&continuation)?,
            deadline,
        )?;
        let frozen = std::mem::replace(&mut guest.disk, continuation);
        guest.parent_disks.push(frozen.clone());
        let info = run_command_output_until(
            {
                let mut command = Command::new(&self.config.layered.qemu_img_binary);
                command
                    .args(["info", "--output=json", "-f", "qcow2"])
                    .arg(&frozen);
                command
            },
            self.work,
            deadline,
            "qemu-img info",
        )?;
        ensure!(info.status.success(), "failed to inspect the frozen disk");
        let info: serde_json::Value = serde_json::from_slice(&info.stdout)?;
        if info.get("backing-filename").is_none() {
            link_frozen_checkpoint_scratch(&frozen, &snapshot)?;
        } else {
            self.img(
                &["convert", "-f", "qcow2", "-O", "qcow2"],
                &[&frozen, &snapshot],
            )?;
        }
        fs::File::open(&snapshot)?.sync_all()?;
        let metadata = serde_json::to_value(ResumeMetadata {
            bootstrap_private_key: private_key_to_openssh(&guest.key.private_key)?,
            memory_encoding: "zstd".to_owned(),
        })?;
        let outcome =
            match writer.publish_moving(&snapshot, &memory, &self.files.seed, index, metadata) {
                Ok(CheckpointPublish::Stored(lease)) => {
                    format!("stored bytes={}", lease.entry.stored_bytes)
                }
                Ok(CheckpointPublish::Skipped) => "skipped".to_owned(),
                Ok(CheckpointPublish::RetentionUncertain) => "retention_uncertain".to_owned(),
                Err(error) => format!("failed error={error:#}"),
            };
        qmp.execute("cont", json!({}), self.deadline)?;
        drop(qmp);
        self.connect(guest)?;
        self.log(&format!(
            "checkpoint stage={index} outcome={outcome} elapsed_ms={}",
            started.elapsed().as_millis()
        ))
    }

    fn img(&self, arguments: &[&str], paths: &[&Path]) -> Result<()> {
        let mut command = Command::new(&self.config.layered.qemu_img_binary);
        command.args(arguments).args(paths);
        let label = format!("qemu-img {}", arguments.first().unwrap_or(&""));
        let output = run_command_output_until(command, self.work, self.deadline, &label)?;
        ensure!(
            output.status.success(),
            "{label} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }

    fn log(&self, message: &str) -> Result<()> {
        let mut file = fs::OpenOptions::new().append(true).open(&self.log)?;
        writeln!(file, "[intar-machine] {message}")?;
        eprintln!("[intar-machine] {message}");
        Ok(())
    }
}
