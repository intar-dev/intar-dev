//! Build-only VM checkpoints. Published images remain cold-bootable raw disks.
use super::*;
use std::future::Future;
use std::io::{Seek as _, SeekFrom};
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::checkpoint::{
    CheckpointCache, CheckpointCacheConfig, CheckpointIdentity, CheckpointLease, CheckpointPublish,
    CheckpointSlot,
};
use crate::provision::{ProvisionStage, ProvisionStageKind, render_scenario_build_stages};
use crate::qemu::{DirectBootQemuInput, render_direct_boot_qemu_command};
use crate::ssh::{BuildSshKey, private_key_to_openssh};

mod qmp;
use super::raw_view::RawViewGuard;
use qmp::Qmp;

const PROVISIONING_ABI: &str = "intar-qemu-stages-v1";
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(30);
const ROOT_BLOCK_DEVICE: &str = "intar-root";
const VIRTIO_BALLOON_DEVICE: &str = "virtio-balloon-pci,id=intar-balloon,free-page-reporting=on";
const VIRTIO_BALLOON_VERIFY_COMMAND: &str = r#"set -eu
modprobe virtio_balloon
driver=/sys/bus/virtio/drivers/virtio_balloon
test -d "$driver"
page_reporting_order=/sys/module/page_reporting/parameters/page_reporting_order
test -r "$page_reporting_order"
test -w "$page_reporting_order"
for device in /sys/bus/virtio/devices/virtio*; do
  test -e "$device/device" || continue
  test -L "$device/driver" || continue
  if test "$(readlink -f "$device/driver")" = "$driver"; then
    exit 0
  fi
done
exit 1
"#;
const CHECKPOINT_MEMORY_RELEASE_COMMAND: &str = r#"set -eu
sync
fstrim / || true
page_reporting_order=/sys/module/page_reporting/parameters/page_reporting_order
test -r "$page_reporting_order"
test -w "$page_reporting_order"
previous_order=$(cat "$page_reporting_order")
restore_order() {
  printf '%s\n' "$previous_order" > "$page_reporting_order"
}
trap restore_order EXIT
printf 0 > "$page_reporting_order"
test "$(cat "$page_reporting_order")" = 0
sync
printf 3 > /proc/sys/vm/drop_caches
sleep 3
test "$(cat "$page_reporting_order")" = 0
restore_order
trap - EXIT
test "$(cat "$page_reporting_order")" = "$previous_order"
sync
"#;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResumeMetadata {
    bootstrap_private_key: String,
    memory_encoding: String,
}

pub(super) fn build(rendered: RenderedDirectBuild) -> Result<RawDirectBuild> {
    ensure!(
        cfg!(target_os = "linux"),
        "layered VM builds require Linux/KVM"
    );
    ensure!(
        rendered.config.accelerator == "kvm",
        "layered VM builds require KVM"
    );
    let stages = render_scenario_build_stages(&rendered.scenario, &rendered.vm)?;
    let identities = identities(&rendered, &stages)?;
    let settings = &rendered.config.layered;
    let cache_config = CheckpointCacheConfig {
        root: settings
            .checkpoint_cache_root
            .clone()
            .unwrap_or_else(|| rendered.config.work_root.join("checkpoint-cache")),
        use_cache: settings.use_cache,
        budget_bytes: settings.checkpoint_cache_bytes,
        minimum_free_bytes: settings.minimum_free_bytes,
    };
    let (cache, cache_init_error) = match CheckpointCache::new(cache_config.clone()) {
        Ok(cache) => (cache, None),
        Err(error) if settings.use_cache => {
            let disabled = CheckpointCache::new(CheckpointCacheConfig {
                use_cache: false,
                ..cache_config
            })?;
            (disabled, Some(format!("{error:#}")))
        }
        Err(error) => return Err(error),
    };
    fs::set_permissions(&rendered.paths.work_root, fs::Permissions::from_mode(0o700))?;
    truncate_serial_log(&rendered.paths.serial_log_path)?;
    fs::write(
        &rendered.paths.build_log_path,
        format!(
            "== {}:{} layered provision log ==\n",
            rendered.scenario_name, rendered.vm.name
        ),
    )?;
    if let Some(error) = cache_init_error {
        log(
            &rendered,
            &format!("cache_init_failed error={error}; continuing without cache"),
        )?;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let last_authored = stages
        .iter()
        .rposition(|stage| matches!(stage.kind, ProvisionStageKind::AuthoredStep { .. }));
    let before_last = last_authored.and_then(|index| index.checked_sub(1));

    let mut restored = None;
    if settings.use_cache {
        for (index, identity) in identities.iter().enumerate().rev() {
            if !cacheable_stage(&stages[index]) {
                continue;
            }
            let lease = match cache.restore(identity) {
                Ok(lease) => lease,
                Err(error) => {
                    log(
                        &rendered,
                        &format!("cache_read_failed error={error:#}; rebuilding from base"),
                    )?;
                    break;
                }
            };
            if let Some(lease) = lease {
                let cache_key = lease.entry.key.clone();
                let stored_bytes = lease.entry.stored_bytes;
                match restore(
                    &rendered,
                    &runtime,
                    lease,
                    index,
                    deadline_after(rendered.config.ssh_wait_timeout_seconds),
                ) {
                    Ok(guest) => {
                        log(
                            &rendered,
                            &format!(
                                "cache_hit stage={} next_stage={} key={cache_key} stored_bytes={stored_bytes}",
                                stages[index].id,
                                index + 1
                            ),
                        )?;
                        restored = Some((guest, index + 1, index));
                        break;
                    }
                    Err(error) => {
                        log(
                            &rendered,
                            &format!(
                                "cache_restore_failed stage={} error={error:#}; rebuilding from base",
                                stages[index].id
                            ),
                        )?;
                        if let Err(error) = cache.invalidate(identity) {
                            log(
                                &rendered,
                                &format!("cache_invalidation_failed error={error:#}"),
                            )?;
                        }
                        // A failed restore must never execute a suffix or try another
                        // checkpoint in the same partially restored guest.
                        break;
                    }
                }
            }
        }
    }
    let (mut guest, first_stage, restored_stage) = match restored {
        Some(restored) => restored,
        None => (cold_guest(&rendered, &runtime)?, 0, usize::MAX),
    };
    let mut work_since_before_last = before_last
        .is_some_and(|index| index == restored_stage)
        .then_some(Duration::ZERO);
    let deadline =
        Instant::now() + Duration::from_secs(rendered.config.provision_timeout_seconds.max(1));

    for (index, stage) in stages.iter().enumerate().skip(first_stage) {
        let started = Instant::now();
        run_stage(&rendered, &runtime, &mut guest, stage, deadline)?;
        let elapsed = started.elapsed();
        log(
            &rendered,
            &format!(
                "stage={} elapsed_ms={} cached=false",
                stage.id,
                elapsed.as_millis()
            ),
        )?;
        if let Some(work) = &mut work_since_before_last
            && before_last != Some(index)
        {
            *work += elapsed;
        }
        let slot = checkpoint_slot(index, before_last, last_authored, work_since_before_last);
        if before_last == Some(index) {
            work_since_before_last = Some(Duration::ZERO);
        }
        if let Some(slot) = slot.filter(|_| settings.use_cache) {
            // Reserve a complete disk and uncompressed VM memory before pausing.
            // Compression can reduce actual occupancy, but cannot be assumed.
            let reservation = checkpoint_reservation(&guest, rendered.config.build_memory_mb)?;
            let writer = match cache.reserve(&identities[index], slot, reservation) {
                Ok(writer) => writer,
                Err(error) => {
                    log(
                        &rendered,
                        &format!("checkpoint_skipped stage={} error={error:#}", stage.id),
                    )?;
                    None
                }
            };
            if let Some(writer) = writer {
                if !writer
                    .has_work_space(&rendered.paths.work_root)
                    .unwrap_or(false)
                {
                    log(
                        &rendered,
                        &format!(
                            "checkpoint_skipped stage={} reason=work_disk_space",
                            stage.id
                        ),
                    )?;
                    continue;
                }
                let checkpoint_started = Instant::now();
                let mut paused = capture(&rendered, &runtime, &mut guest, deadline, index)?;
                let metadata = serde_json::to_value(ResumeMetadata {
                    bootstrap_private_key: private_key_to_openssh(&guest.key.private_key)?,
                    memory_encoding: "zstd".to_string(),
                })?;
                let publish_started = Instant::now();
                let publication = writer.publish_moving(
                    &paused.snapshot.disk,
                    &paused.snapshot.memory,
                    &rendered.paths.seed_disk_path,
                    index,
                    metadata,
                );
                log(
                    &rendered,
                    &format!(
                        "checkpoint_publish elapsed_ms={} outcome={}",
                        publish_started.elapsed().as_millis(),
                        match &publication {
                            Ok(CheckpointPublish::Stored(_)) => "stored",
                            Ok(CheckpointPublish::Skipped) => "skipped",
                            Ok(CheckpointPublish::RetentionUncertain) => "retention_uncertain",
                            Err(_) => "failed",
                        }
                    ),
                )?;
                let persisted = match publication {
                    Ok(CheckpointPublish::Stored(lease)) => {
                        // The source continuation still uses its prior backing
                        // chain. The new self-contained cache entry is not a
                        // parent of that chain, so its lease can be released.
                        drop(lease);
                        true
                    }
                    Ok(CheckpointPublish::Skipped) => false,
                    Ok(CheckpointPublish::RetentionUncertain) => {
                        // The source continuation uses its own overlay and the
                        // pre-existing backing lease. An uncertain new index
                        // can disable reuse without invalidating that source.
                        log(
                            &rendered,
                            "checkpoint_retention_uncertain continuing source without cache",
                        )?;
                        false
                    }
                    Err(error) => {
                        log(
                            &rendered,
                            &format!(
                                "checkpoint_cache_publish_failed error={error:#}; using local snapshot"
                            ),
                        )?;
                        false
                    }
                };
                resume_source_checkpoint(&rendered, &runtime, &mut guest, &mut paused, deadline)?;
                log(
                    &rendered,
                    &format!(
                        "checkpoint_complete stage={} elapsed_ms={} persisted={persisted}",
                        stage.id,
                        checkpoint_started.elapsed().as_millis()
                    ),
                )?;
            } else {
                log(
                    &rendered,
                    &format!("checkpoint_skipped stage={} reason=cache_budget", stage.id),
                )?;
            }
        }
    }
    if let Some(ssh) = guest.ssh.take() {
        runtime.block_on(ssh.disconnect())?;
    }
    let shutdown_started = Instant::now();
    wait_for_qemu_shutdown(&mut guest.child, &rendered)?;
    log(
        &rendered,
        &format!(
            "shutdown elapsed_ms={}",
            shutdown_started.elapsed().as_millis()
        ),
    )?;
    guest.finished = true;
    let raw_sync_started = Instant::now();
    if let Err(error) = fs::File::open(&guest.disk).and_then(|disk| disk.sync_all()) {
        let cleanup = (|| {
            remove_work_file(&guest.disk)?;
            for disk in &guest.parent_disks {
                remove_work_file(disk)?;
            }
            Ok::<(), anyhow::Error>(())
        })();
        return match cleanup {
            Ok(()) => Err(error).context("failed to flush final raw view source"),
            Err(cleanup_error) => Err(error).context(format!(
                "failed to flush final raw view source; also failed to remove '{}': {cleanup_error:#}",
                guest.disk.display()
            )),
        };
    }
    log(
        &rendered,
        &format!(
            "raw_view_source_sync elapsed_ms={}",
            raw_sync_started.elapsed().as_millis()
        ),
    )?;
    let raw_view_started = Instant::now();
    let raw_view = RawViewGuard::start(
        &rendered.config,
        &rendered.paths.work_root,
        guest.disk.clone(),
        std::mem::take(&mut guest.parent_disks),
        rendered.paths.root_disk_path.clone(),
        guest._lease.take(),
        Duration::from_secs(rendered.config.raw_view_read_timeout_seconds.max(1)),
    )?;
    log(
        &rendered,
        &format!(
            "raw_view_setup elapsed_ms={}",
            raw_view_started.elapsed().as_millis()
        ),
    )?;
    log(&rendered, "layered_raw_view_ready")?;
    Ok(RawDirectBuild { raw_view, rendered })
}

struct Guest {
    child: Child,
    disk: PathBuf,
    parent_disks: Vec<PathBuf>,
    key: BuildSshKey,
    ssh: Option<BuildSshSession>,
    // The work disk has this checkpoint as its read-only backing file.
    _lease: Option<CheckpointLease>,
    finished: bool,
}

impl Drop for Guest {
    fn drop(&mut self) {
        if !self.finished && terminate_qemu(&mut self.child).is_ok() {
            let _ = remove_work_file(&self.disk);
            for disk in &self.parent_disks {
                let _ = remove_work_file(disk);
            }
        }
    }
}

struct Snapshot {
    _directory: tempfile::TempDir,
    disk: PathBuf,
    memory: PathBuf,
}

struct PausedCheckpoint {
    snapshot: Snapshot,
    source_pid: u32,
    qmp: Qmp,
}

fn cacheable_stage(stage: &ProvisionStage) -> bool {
    matches!(
        stage.kind,
        ProvisionStageKind::Packages | ProvisionStageKind::AuthoredStep { .. }
    )
}

fn checkpoint_slot(
    index: usize,
    before_last: Option<usize>,
    last_authored: Option<usize>,
    work_since_before_last: Option<Duration>,
) -> Option<CheckpointSlot> {
    if before_last == Some(index) {
        return Some(CheckpointSlot::BeforeLastStep);
    }
    if last_authored == Some(index)
        && work_since_before_last.is_some_and(|work| work >= CHECKPOINT_INTERVAL)
    {
        return Some(CheckpointSlot::ExpensivePrefix);
    }
    None
}

fn checkpoint_reservation(guest: &Guest, memory_mib: u32) -> Result<u64> {
    let allocated =
        |path: &Path| -> Result<u64> { Ok(fs::metadata(path)?.blocks().saturating_mul(512)) };
    let mut disk_bytes = allocated(&guest.disk)?;
    for disk in &guest.parent_disks {
        disk_bytes = disk_bytes.saturating_add(allocated(disk)?);
    }
    if let Some(lease) = &guest._lease {
        disk_bytes = disk_bytes.saturating_add(allocated(&lease.entry.qcow2_path)?);
    }
    Ok(disk_bytes
        .saturating_add(u64::from(memory_mib) * 1024 * 1024)
        .saturating_add(256 * 1024 * 1024))
}

fn cold_guest(rendered: &RenderedDirectBuild, runtime: &tokio::runtime::Runtime) -> Result<Guest> {
    let deadline = deadline_after(rendered.config.ssh_wait_timeout_seconds);
    let key = generate_build_ssh_key()?;
    prepare_direct_build_inputs(&DirectBuildPrepareInput {
        rendered,
        build_public_key_openssh: &key.public_key_openssh,
    })?;
    let disk = rendered.paths.work_root.join("active.qcow2");
    remove_work_file(&disk)?;
    run_img_until(
        rendered,
        &["convert", "-f", "raw", "-O", "qcow2"],
        &[&rendered.paths.root_disk_path, &disk],
        deadline,
    )?;
    fs::remove_file(&rendered.paths.root_disk_path)?;
    let mut guest = Guest {
        child: spawn(rendered, &disk, false)?,
        disk,
        parent_disks: Vec::new(),
        key,
        ssh: None,
        _lease: None,
        finished: false,
    };
    guest.ssh = Some(wait_for_ssh(
        rendered,
        &mut guest.child,
        &guest.key.private_key,
        runtime,
    )?);
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .context("virtio balloon driver setup deadline expired")?;
    let ssh = guest
        .ssh
        .as_mut()
        .context("cold build guest has no SSH session")?;
    timeout_in_runtime(
        runtime,
        remaining,
        "virtio balloon driver setup",
        ssh.run(
            &format!(
                "sudo bash -c {}",
                shell_quote(VIRTIO_BALLOON_VERIFY_COMMAND)
            ),
            true,
        ),
    )?;
    Ok(guest)
}

fn restore(
    rendered: &RenderedDirectBuild,
    runtime: &tokio::runtime::Runtime,
    lease: CheckpointLease,
    expected_index: usize,
    deadline: Instant,
) -> Result<Guest> {
    ensure!(
        lease.entry.stage_index == expected_index,
        "checkpoint stage index does not match its prefix"
    );
    let metadata: ResumeMetadata = serde_json::from_value(lease.entry.metadata.clone())
        .context("invalid private checkpoint metadata")?;
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
    fs::copy(&lease.entry.seed_disk_path, &rendered.paths.seed_disk_path)?;
    let checkpoint_disk = lease.entry.qcow2_path.clone();
    let state_path = lease.entry.memory_state_path.clone();
    restore_files(
        rendered,
        runtime,
        &checkpoint_disk,
        &state_path,
        key,
        lease,
        deadline,
    )
}

fn restore_files(
    rendered: &RenderedDirectBuild,
    runtime: &tokio::runtime::Runtime,
    checkpoint_disk: &Path,
    state_path: &Path,
    key: BuildSshKey,
    lease: CheckpointLease,
    deadline: Instant,
) -> Result<Guest> {
    let zstd = resolve_binary(Path::new("zstd"))?;
    let disk = rendered.paths.work_root.join("active.qcow2");
    remove_work_file(&disk)?;
    let check_started = Instant::now();
    run_img_until(
        rendered,
        &["check", "-f", "qcow2"],
        &[checkpoint_disk],
        deadline,
    )?;
    log(
        rendered,
        &format!(
            "checkpoint_restore_qcow_check elapsed_ms={}",
            check_started.elapsed().as_millis()
        ),
    )?;
    let backing = checkpoint_disk
        .to_str()
        .context("checkpoint path is not UTF-8")?;
    let overlay_started = Instant::now();
    run_img_until(
        rendered,
        &["create", "-f", "qcow2", "-F", "qcow2", "-b", backing],
        &[&disk],
        deadline,
    )?;
    log(
        rendered,
        &format!(
            "checkpoint_restore_overlay elapsed_ms={}",
            overlay_started.elapsed().as_millis()
        ),
    )?;
    let spawn_started = Instant::now();
    let mut guest = Guest {
        child: spawn(rendered, &disk, true)?,
        disk,
        parent_disks: Vec::new(),
        key,
        ssh: None,
        _lease: Some(lease),
        finished: false,
    };
    log(
        rendered,
        &format!(
            "checkpoint_restore_spawn elapsed_ms={}",
            spawn_started.elapsed().as_millis()
        ),
    )?;
    let migration_started = Instant::now();
    let mut qmp = Qmp::connect(&rendered.paths.qmp_socket_path, deadline)?;
    qmp.execute("migrate-incoming", json!({"channels": [{"channel-type": "main", "addr": {"transport": "exec", "args": [zstd, "-d", "-q", "-c", state_path]}}]}), deadline)?;
    qmp.wait_migration(deadline)?;
    qmp.execute("cont", json!({}), deadline)?;
    drop(qmp);
    log(
        rendered,
        &format!(
            "checkpoint_restore_migration elapsed_ms={}",
            migration_started.elapsed().as_millis()
        ),
    )?;
    let ssh_started = Instant::now();
    guest.ssh = Some(wait_for_ssh_until(
        rendered,
        &mut guest.child,
        &guest.key.private_key,
        runtime,
        deadline,
    )?);
    log(
        rendered,
        &format!(
            "checkpoint_restore_ssh elapsed_ms={}",
            ssh_started.elapsed().as_millis()
        ),
    )?;
    rotate_credentials(rendered, runtime, &mut guest, deadline)?;
    Ok(guest)
}

fn rotate_credentials(
    rendered: &RenderedDirectBuild,
    runtime: &tokio::runtime::Runtime,
    guest: &mut Guest,
    deadline: Instant,
) -> Result<()> {
    let new_key = generate_build_ssh_key()?;
    let unix_seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("host clock is before the Unix epoch")?
        .as_secs();
    let mut entropy = [0_u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut entropy)?;
    let entropy = entropy
        .iter()
        .map(|byte| format!("\\x{byte:02x}"))
        .collect::<String>();
    let command = format!(
        r#"set -eu
install -d -m 0700 /run/intar-build-state
printf '%s\n' {} > /run/intar-build-state/authorized_keys
chmod 0600 /run/intar-build-state/authorized_keys
if mountpoint -q /run/intar-build/authorized_keys; then umount /run/intar-build/authorized_keys; fi
mount --bind /run/intar-build-state/authorized_keys /run/intar-build/authorized_keys
install -m 0600 -o ubuntu -g ubuntu /run/intar-build-state/authorized_keys /home/ubuntu/.ssh/authorized_keys
printf '%b' {} > /dev/urandom
rm -f /tmp/intar-stage.sh
"#,
        shell_quote(&new_key.public_key_openssh),
        shell_quote(&entropy)
    );
    let mut ssh = guest
        .ssh
        .take()
        .context("restored guest has no SSH session")?;
    let clock_started = Instant::now();
    let remaining = remaining_until(deadline, "checkpoint clock refresh")?;
    runtime.block_on(async {
        tokio::time::timeout(
            remaining,
            ssh.run(&render_clock_set_command(unix_seconds), false),
        )
        .await
        .context("checkpoint clock refresh timed out")?
    })?;
    log(
        rendered,
        &format!(
            "checkpoint_restore_clock elapsed_ms={}",
            clock_started.elapsed().as_millis()
        ),
    )?;
    let rotation_started = Instant::now();
    let remaining = remaining_until(deadline, "checkpoint credential rotation")?;
    runtime.block_on(async {
        tokio::time::timeout(remaining, async {
            ssh.run(&format!("sudo bash -c {}", shell_quote(&command)), false)
                .await?;
            ssh.disconnect().await
        })
        .await
        .context("checkpoint credential rotation timed out")?
    })?;
    log(
        rendered,
        &format!(
            "checkpoint_restore_credentials elapsed_ms={}",
            rotation_started.elapsed().as_millis()
        ),
    )?;
    guest.key = new_key;
    let reconnect_started = Instant::now();
    guest.ssh = Some(wait_for_ssh_until(
        rendered,
        &mut guest.child,
        &guest.key.private_key,
        runtime,
        deadline,
    )?);
    log(
        rendered,
        &format!(
            "checkpoint_restore_reconnect elapsed_ms={}",
            reconnect_started.elapsed().as_millis()
        ),
    )?;
    Ok(())
}

fn run_stage(
    rendered: &RenderedDirectBuild,
    runtime: &tokio::runtime::Runtime,
    guest: &mut Guest,
    stage: &ProvisionStage,
    deadline: Instant,
) -> Result<()> {
    let script_path = rendered.paths.work_root.join("current-stage.sh");
    fs::write(&script_path, &stage.script)?;
    fs::set_permissions(&script_path, fs::Permissions::from_mode(0o600))?;
    let ssh = guest
        .ssh
        .as_mut()
        .context("build guest has no SSH session")?;
    let timeout = deadline
        .checked_duration_since(Instant::now())
        .context("layered provision timeout expired")?;
    runtime
        .block_on(async {
            tokio::time::timeout(timeout, async {
                ssh.upload_file(&script_path, "/tmp/intar-stage.sh", 0o700)
                    .await?;
                ssh.run_logged(
                    "sudo bash /tmp/intar-stage.sh",
                    true,
                    &rendered.paths.build_log_path,
                )
                .await
            })
            .await
            .context("layered provision stage timed out")?
        })
        .with_context(|| format!("layered stage '{}' failed", stage.id))
}

fn wait_for_ssh_until(
    rendered: &RenderedDirectBuild,
    qemu: &mut Child,
    private_key: &PrivateKey,
    runtime: &tokio::runtime::Runtime,
    deadline: Instant,
) -> Result<BuildSshSession> {
    let mut last_error = None;
    loop {
        if let Some(status) = qemu
            .try_wait()
            .context("failed to poll QEMU while waiting for SSH")?
        {
            bail!(
                "QEMU exited before SSH became ready with status {status}; serial log: {}; build log: {}",
                rendered.paths.serial_log_path.display(),
                rendered.paths.build_log_path.display()
            );
        }
        let remaining = match deadline.checked_duration_since(Instant::now()) {
            Some(remaining) if !remaining.is_zero() => remaining,
            _ => break,
        };
        let connection = timeout_in_runtime(
            runtime,
            remaining,
            "layered SSH connection",
            BuildSshSession::connect(SSH_HOST, rendered.ssh_host_port, SSH_USERNAME, private_key),
        );
        match connection {
            Ok(mut ssh) => {
                let remaining = match deadline.checked_duration_since(Instant::now()) {
                    Some(remaining) if !remaining.is_zero() => remaining,
                    _ => {
                        last_error = Some(anyhow!(
                            "SSH became connected after the layered SSH deadline"
                        ));
                        break;
                    }
                };
                match timeout_in_runtime(
                    runtime,
                    remaining,
                    "layered SSH readiness command",
                    ssh.run("true", false),
                ) {
                    Ok(()) => return Ok(ssh),
                    Err(error) => last_error = Some(error),
                }
            }
            Err(error) => last_error = Some(error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(SSH_POLL_INTERVAL.min(remaining));
    }

    if let Some(error) = last_error {
        bail!(
            "timed out waiting for layered build SSH on {SSH_HOST}:{}: {error:#}; serial log: {}; build log: {}",
            rendered.ssh_host_port,
            rendered.paths.serial_log_path.display(),
            rendered.paths.build_log_path.display()
        );
    }
    bail!(
        "timed out waiting for layered build SSH on {SSH_HOST}:{}; serial log: {}; build log: {}",
        rendered.ssh_host_port,
        rendered.paths.serial_log_path.display(),
        rendered.paths.build_log_path.display()
    )
}

fn capture(
    rendered: &RenderedDirectBuild,
    runtime: &tokio::runtime::Runtime,
    guest: &mut Guest,
    provision_deadline: Instant,
    stage_index: usize,
) -> Result<PausedCheckpoint> {
    let zstd = resolve_binary(Path::new("zstd"))?;
    let mut ssh = guest.ssh.take().context("build guest has no SSH session")?;
    let sync_started = Instant::now();
    let remaining = provision_deadline
        .checked_duration_since(Instant::now())
        .context("provision deadline expired before checkpoint")?;
    runtime.block_on(async {
        tokio::time::timeout(remaining, async {
            // Release only clean guest cache pages before QMP freezes RAM.
            // The script restores the reporting order before this control
            // session closes, even when an earlier command fails.
            ssh.run(
                &format!(
                    "sudo bash -c {}",
                    shell_quote(CHECKPOINT_MEMORY_RELEASE_COMMAND)
                ),
                true,
            )
            .await?;
            ssh.disconnect().await
        })
        .await
        .context("checkpoint guest sync timed out")?
    })?;
    log(
        rendered,
        &format!(
            "checkpoint_capture_sync elapsed_ms={}",
            sync_started.elapsed().as_millis()
        ),
    )?;
    let directory = tempfile::Builder::new()
        .prefix("checkpoint-")
        .tempdir_in(&rendered.paths.work_root)?;
    let memory = directory.path().join("memory.state.zst");
    let memory_partial = directory.path().join("memory.state.zst.partial");
    let memory_complete = directory.path().join("memory.state.complete");
    let disk = directory.path().join("checkpoint.qcow2");
    let continuation_disk = fs::canonicalize(&rendered.paths.work_root)
        .context("failed to canonicalize checkpoint work directory")?
        .join(format!("active-checkpoint-{stage_index}.qcow2"));
    remove_work_file(&continuation_disk)?;
    let deadline = (Instant::now()
        + Duration::from_secs(rendered.config.qemu_exit_timeout_seconds.max(1)))
    .min(provision_deadline);
    let freeze_started = Instant::now();
    let mut qmp = Qmp::connect(&rendered.paths.qmp_socket_path, deadline)?;
    qmp.execute("stop", json!({}), deadline)?;
    qmp.execute(
        "migrate-set-parameters",
        json!({"max-bandwidth": 0}),
        deadline,
    )?;
    let migration_started = Instant::now();
    qmp.execute(
        "migrate",
        json!({"channels": [{"channel-type": "main", "addr": {"transport": "exec", "args": ["/bin/sh", "-c", migration_writer_command(&zstd, &memory_partial, &memory, &memory_complete)?]}}]}),
        deadline,
    )?;
    qmp.wait_migration(deadline)?;
    wait_for_checkpoint_output(&memory, &memory_complete, deadline)?;
    fs::File::open(&memory)?.sync_all()?;
    log(
        rendered,
        &format!(
            "checkpoint_capture_migration elapsed_ms={}",
            migration_started.elapsed().as_millis()
        ),
    )?;
    let status = qmp.execute("query-status", json!({}), deadline)?;
    ensure!(
        status.get("status").and_then(serde_json::Value::as_str) == Some("postmigrate"),
        "QEMU did not enter postmigrate after checkpoint migration: {status}"
    );
    qmp.execute(
        "blockdev-snapshot-sync",
        snapshot_sync_arguments(&continuation_disk)?,
        deadline,
    )?;
    let frozen_disk = guest.disk.clone();
    guest.parent_disks.push(frozen_disk.clone());
    guest.disk = continuation_disk.clone();
    log(
        rendered,
        &format!(
            "checkpoint_capture_freeze elapsed_ms={}",
            freeze_started.elapsed().as_millis()
        ),
    )?;
    let flush_started = Instant::now();
    fs::File::open(&memory)?.sync_all()?;
    log(
        rendered,
        &format!(
            "checkpoint_capture_flush elapsed_ms={}",
            flush_started.elapsed().as_millis()
        ),
    )?;
    // Snapshot-sync redirected all future writes into continuation_disk while
    // the guest remained paused, so frozen_disk is now immutable.
    let disk_started = Instant::now();
    let info = run_img_output_until(
        rendered,
        &["info", "--output=json", "-f", "qcow2"],
        &[&frozen_disk],
        deadline,
    )?;
    ensure!(info.status.success(), "failed to inspect frozen build disk");
    let info: serde_json::Value = serde_json::from_slice(&info.stdout)?;
    if info.get("backing-filename").is_none() {
        // The distinct hard link is what publication moves. Keep frozen_disk
        // at its original path because continuation_disk uses it as backing.
        link_frozen_checkpoint_scratch(&frozen_disk, &disk)?;
    } else {
        run_img_until(
            rendered,
            &["convert", "-f", "qcow2", "-O", "qcow2"],
            &[&frozen_disk, &disk],
            deadline,
        )?;
    }
    fs::File::open(&disk)?.sync_all()?;
    let check_started = Instant::now();
    run_img_until(rendered, &["check", "-f", "qcow2"], &[&disk], deadline)?;
    log(
        rendered,
        &format!(
            "checkpoint_capture_disk elapsed_ms={} qcow_check_ms={}",
            disk_started.elapsed().as_millis(),
            check_started.elapsed().as_millis()
        ),
    )?;
    Ok(PausedCheckpoint {
        snapshot: Snapshot {
            _directory: directory,
            disk,
            memory,
        },
        source_pid: guest.child.id(),
        qmp,
    })
}

fn migration_writer_command(
    zstd: &Path,
    partial: &Path,
    output: &Path,
    complete: &Path,
) -> Result<String> {
    let zstd = zstd.to_str().context("checkpoint zstd path is not UTF-8")?;
    Ok(format!(
        "set -eu\nrm -f {partial} {output} {complete}\n{zstd} -1 -q -o {partial}\nmv {partial} {output}\n: > {complete}\n",
        partial = shell_quote(&partial.display().to_string()),
        output = shell_quote(&output.display().to_string()),
        complete = shell_quote(&complete.display().to_string()),
        zstd = shell_quote(zstd),
    ))
}

fn link_frozen_checkpoint_scratch(source: &Path, scratch: &Path) -> Result<()> {
    ensure!(
        source != scratch,
        "checkpoint scratch must differ from source"
    );
    fs::hard_link(source, scratch).with_context(|| {
        format!(
            "failed to hard-link frozen checkpoint '{}' into scratch '{}'",
            source.display(),
            scratch.display()
        )
    })
}

fn wait_for_checkpoint_output(output: &Path, complete: &Path, deadline: Instant) -> Result<()> {
    loop {
        if output.is_file() && complete.is_file() {
            return Ok(());
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .context("checkpoint migration writer did not finish")?;
        thread::sleep(Duration::from_millis(50).min(remaining));
    }
}

fn snapshot_sync_arguments(continuation_disk: &Path) -> Result<serde_json::Value> {
    let snapshot_file = continuation_disk
        .to_str()
        .context("checkpoint continuation path is not UTF-8")?;
    Ok(json!({
        "device": ROOT_BLOCK_DEVICE,
        "snapshot-file": snapshot_file,
        "format": "qcow2",
    }))
}

fn resume_source_checkpoint(
    rendered: &RenderedDirectBuild,
    runtime: &tokio::runtime::Runtime,
    guest: &mut Guest,
    paused: &mut PausedCheckpoint,
    deadline: Instant,
) -> Result<()> {
    ensure!(
        guest.child.id() == paused.source_pid,
        "checkpoint source PID changed before continuation"
    );
    paused.qmp.execute("cont", json!({}), deadline)?;
    let ssh_started = Instant::now();
    guest.ssh = Some(wait_for_ssh_until(
        rendered,
        &mut guest.child,
        &guest.key.private_key,
        runtime,
        deadline,
    )?);
    log(
        rendered,
        &format!(
            "checkpoint_source_resume elapsed_ms={} continuation={}",
            ssh_started.elapsed().as_millis(),
            guest.disk.display()
        ),
    )
}

fn spawn(rendered: &RenderedDirectBuild, disk: &Path, incoming: bool) -> Result<Child> {
    remove_work_file(&rendered.paths.qmp_socket_path)?;
    let mut args = layered_args(rendered, disk, rendered.ssh_host_port);
    if incoming {
        args.extend(["-incoming".to_string(), "defer".to_string()]);
    }
    fs::write(&rendered.paths.qemu_args_path, args.join("\n"))?;
    Command::new(&rendered.config.qemu_binary)
        .args(args)
        .current_dir(&rendered.paths.work_root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .context("failed to start layered QEMU")
}

fn layered_args(rendered: &RenderedDirectBuild, disk: &Path, ssh_port: u16) -> Vec<String> {
    let mut args = render_direct_boot_qemu_command(&DirectBootQemuInput {
        config: &rendered.config,
        root_disk_path: disk,
        seed_disk_path: &rendered.paths.seed_disk_path,
        kernel_path: &rendered.base_rootfs.paths.kernel_path,
        initrd_path: &rendered.base_rootfs.paths.initrd_path,
        serial_log_path: &rendered.paths.serial_log_path,
        qmp_socket_path: Path::new("qmp.sock"),
        ssh_host_port: ssh_port,
        memory_mib: rendered.config.build_memory_mb,
        cpu_count: rendered.config.build_cpus,
        boot_cmdline: crate::qemu::BUILD_BOOT_CMDLINE,
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
    replace_serial_log_with_append(&mut args, &rendered.paths.serial_log_path);
    append_layered_devices(&mut args);
    args
}

fn append_layered_devices(args: &mut Vec<String>) {
    args.extend([
        "-device".to_string(),
        "vmgenid,guid=auto".to_string(),
        "-device".to_string(),
        VIRTIO_BALLOON_DEVICE.to_string(),
    ]);
}

fn replace_serial_log_with_append(args: &mut Vec<String>, serial_log_path: &Path) {
    let Some(index) = args.iter().position(|argument| argument == "-serial") else {
        return;
    };
    if index + 1 >= args.len() {
        return;
    }
    args.splice(
        index..=index + 1,
        [
            "-chardev".to_string(),
            format!(
                "file,id=intar-build-serial,path={},append=on",
                serial_log_path.display()
            ),
            "-serial".to_string(),
            "chardev:intar-build-serial".to_string(),
        ],
    );
}

fn identities(
    rendered: &RenderedDirectBuild,
    stages: &[ProvisionStage],
) -> Result<Vec<CheckpointIdentity>> {
    let executable = resolve_binary(&rendered.config.qemu_binary)?;
    let mut version_command = Command::new(&executable);
    version_command.arg("--version");
    let version = run_command_output_until(
        version_command,
        &rendered.paths.work_root,
        deadline_after(rendered.config.qemu_exit_timeout_seconds),
        "QEMU version query",
    )?;
    ensure!(version.status.success(), "failed to read QEMU version");
    let qemu_version = format!(
        "{}\nsha256={}",
        String::from_utf8(version.stdout)?,
        sha256_file_hex(&executable)?
    );
    let cpu = fs::read_to_string("/proc/cpuinfo")?
        .lines()
        .filter(|line| {
            [
                "vendor_id",
                "cpu family",
                "model\t",
                "model name",
                "stepping",
                "flags",
            ]
            .iter()
            .any(|key| line.starts_with(key))
        })
        .take(6)
        .collect::<Vec<_>>()
        .join("\n");
    let mut canonical = rendered.clone();
    canonical.paths.seed_disk_path = "/intar/seed.img".into();
    canonical.paths.serial_log_path = "/intar/serial.log".into();
    canonical.base_rootfs.paths.kernel_path = "/intar/kernel".into();
    canonical.base_rootfs.paths.initrd_path = "/intar/initrd".into();
    let devices = layered_args(&canonical, Path::new("/intar/root.qcow2"), 0);
    let mut identity = CheckpointIdentity {
        scenario_id: rendered.scenario_name.clone(),
        vm_name: rendered.vm.name.clone(),
        parent_prefix: "base".to_string(),
        stage_bytes: Vec::new(),
        base_sha256: sha256_file_hex(&rendered.base_rootfs.paths.base_ext4_path)?,
        kernel_sha256: sha256_file_hex(&rendered.base_rootfs.paths.kernel_path)?,
        initrd_sha256: sha256_file_hex(&rendered.base_rootfs.paths.initrd_path)?,
        disk_geometry_bytes: rendered.disk.virtual_size_bytes,
        qemu_version,
        qemu_cpu: cpu,
        qemu_devices: devices,
        provisioning_abi: PROVISIONING_ABI.to_string(),
    };
    let mut result = Vec::with_capacity(stages.len());
    for stage in stages {
        identity.stage_bytes = stage.script.as_bytes().to_vec();
        result.push(identity.clone());
        identity.parent_prefix = identity.cache_key()?;
    }
    Ok(result)
}

fn resolve_binary(binary: &Path) -> Result<PathBuf> {
    if binary.is_absolute() || binary.components().count() > 1 {
        return fs::canonicalize(binary).context("build executable is unavailable");
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|path| path.join(binary))
        .find(|path| path.is_file())
        .context("build executable is not on PATH")
        .and_then(|path| fs::canonicalize(path).map_err(Into::into))
}

fn run_img_until(
    rendered: &RenderedDirectBuild,
    arguments: &[&str],
    paths: &[&Path],
    deadline: Instant,
) -> Result<()> {
    let output = run_img_output_until(rendered, arguments, paths, deadline)?;
    ensure!(
        output.status.success(),
        "qemu-img {} failed: {}",
        arguments.first().unwrap_or(&""),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

fn run_img_output_until(
    rendered: &RenderedDirectBuild,
    arguments: &[&str],
    paths: &[&Path],
    deadline: Instant,
) -> Result<std::process::Output> {
    let mut command = Command::new(&rendered.config.layered.qemu_img_binary);
    command.args(arguments).args(paths);
    run_command_output_until(
        command,
        &rendered.paths.work_root,
        deadline,
        &format!("qemu-img {}", arguments.first().unwrap_or(&"")),
    )
}

fn run_command_output_until(
    mut command: Command,
    work_root: &Path,
    deadline: Instant,
    label: &str,
) -> Result<std::process::Output> {
    let mut stdout = tempfile::tempfile_in(work_root)
        .with_context(|| format!("failed to create {label} stdout capture"))?;
    let mut stderr = tempfile::tempfile_in(work_root)
        .with_context(|| format!("failed to create {label} stderr capture"))?;
    let stdout_child = stdout
        .try_clone()
        .with_context(|| format!("failed to clone {label} stdout capture"))?;
    let stderr_child = stderr
        .try_clone()
        .with_context(|| format!("failed to clone {label} stderr capture"))?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_child))
        .stderr(Stdio::from(stderr_child))
        .spawn()
        .with_context(|| format!("failed to start {label}"))?;
    let status = wait_for_command_until(&mut child, deadline, label)?;
    let stdout = read_command_capture(&mut stdout, label, "stdout")?;
    let stderr = read_command_capture(&mut stderr, label, "stderr")?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn read_command_capture(file: &mut fs::File, label: &str, stream: &str) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))
        .with_context(|| format!("failed to seek {label} {stream} capture"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {label} {stream} capture"))?;
    Ok(bytes)
}

fn wait_for_command_until(child: &mut Child, deadline: Instant, label: &str) -> Result<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(error) => {
                return Err(command_failure_after_cleanup(
                    child,
                    label,
                    format!("failed to poll {label}: {error}"),
                ));
            }
        }
        let remaining = match deadline.checked_duration_since(Instant::now()) {
            Some(remaining) if !remaining.is_zero() => remaining,
            _ => {
                return Err(command_failure_after_cleanup(
                    child,
                    label,
                    format!("{label} timed out"),
                ));
            }
        };
        thread::sleep(Duration::from_millis(50).min(remaining));
    }
}

fn command_failure_after_cleanup(child: &mut Child, label: &str, failure: String) -> anyhow::Error {
    match terminate_command(child, label) {
        Ok(status) => anyhow!("{failure}; {label} was terminated and reaped with status {status}"),
        Err(cleanup_error) => anyhow!(
            "{failure}; additionally failed to terminate and reap {label}: {cleanup_error:#}"
        ),
    }
}

fn terminate_command(child: &mut Child, label: &str) -> Result<ExitStatus> {
    let pid = child.id();
    if let Err(kill_error) = child.kill() {
        return match child.try_wait() {
            Ok(Some(status)) => Ok(status),
            Ok(None) => Err(anyhow!(
                "failed to kill still-running {label} pid {pid}: {kill_error}"
            )),
            Err(poll_error) => Err(anyhow!(
                "failed to kill {label} pid {pid}: {kill_error}; failed to determine whether it exited: {poll_error}"
            )),
        };
    }
    child
        .wait()
        .with_context(|| format!("failed to reap {label} pid {pid} after killing it"))
}

fn deadline_after(timeout_seconds: u64) -> Instant {
    Instant::now() + Duration::from_secs(timeout_seconds.max(1))
}

fn timeout_in_runtime<T>(
    runtime: &tokio::runtime::Runtime,
    timeout: Duration,
    phase: &str,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    runtime.block_on(async move {
        tokio::time::timeout(timeout, future)
            .await
            .with_context(|| format!("{phase} timed out"))?
    })
}

fn remaining_until(deadline: Instant, phase: &str) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .with_context(|| format!("{phase} deadline expired"))
}

fn truncate_serial_log(path: &Path) -> Result<()> {
    fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .with_context(|| format!("failed to initialize serial log '{}'", path.display()))?;
    Ok(())
}

fn remove_work_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn log(rendered: &RenderedDirectBuild, message: &str) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&rendered.paths.build_log_path)?;
    writeln!(file, "[intar-layered] {message}")?;
    eprintln!(
        "[intar-layered] scenario={} vm={} {message}",
        rendered.scenario_name, rendered.vm.name
    );
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn render_clock_set_command(unix_seconds: u64) -> String {
    format!("sudo date -u -s @{unix_seconds}")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn checkpoint_policy_keeps_the_one_step_prefix() {
        assert_eq!(
            checkpoint_slot(0, Some(0), Some(1), None),
            Some(CheckpointSlot::BeforeLastStep)
        );
    }

    #[test]
    fn checkpoint_policy_skips_vms_without_authored_steps() {
        assert_eq!(checkpoint_slot(0, None, None, None), None);
    }

    #[test]
    fn checkpoint_policy_skips_a_cheap_final_authored_step() {
        assert_eq!(
            checkpoint_slot(
                2,
                Some(1),
                Some(2),
                Some(CHECKPOINT_INTERVAL.saturating_sub(Duration::from_millis(1)))
            ),
            None
        );
    }

    #[test]
    fn checkpoint_policy_keeps_an_expensive_final_authored_step() {
        assert_eq!(
            checkpoint_slot(2, Some(1), Some(2), Some(CHECKPOINT_INTERVAL)),
            Some(CheckpointSlot::ExpensivePrefix)
        );
    }

    #[test]
    fn checkpoint_source_commands_freeze_then_continue_with_a_private_overlay() {
        let output = Path::new("/work/memory.state.zst");
        let partial = Path::new("/work/memory.state.zst.partial");
        let marker = Path::new("/work/memory.state.complete");
        let command =
            migration_writer_command(Path::new("/usr/bin/zstd"), partial, output, marker).unwrap();
        let snapshot =
            snapshot_sync_arguments(Path::new("/work/active-checkpoint-2.qcow2")).unwrap();

        assert!(command.contains("-o '/work/memory.state.zst.partial'"));
        assert!(command.contains("mv '/work/memory.state.zst.partial' '/work/memory.state.zst'"));
        assert!(command.contains(": > '/work/memory.state.complete'"));
        assert_eq!(snapshot["device"], ROOT_BLOCK_DEVICE);
        assert_eq!(snapshot["snapshot-file"], "/work/active-checkpoint-2.qcow2");
        assert_eq!(snapshot["format"], "qcow2");
    }

    #[test]
    fn checkpoint_output_wait_requires_the_writer_completion_marker() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("memory.state.zst");
        let marker = directory.path().join("memory.state.complete");
        std::fs::write(&output, b"state").unwrap();

        assert!(wait_for_checkpoint_output(&output, &marker, Instant::now()).is_err());
        std::fs::write(&marker, b"").unwrap();
        wait_for_checkpoint_output(&output, &marker, Instant::now() + Duration::from_secs(1))
            .unwrap();
    }

    #[test]
    fn self_contained_checkpoint_uses_a_distinct_publish_scratch_hardlink() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let scratch = directory.path().join("checkpoint.qcow2");
        std::fs::write(&source, b"frozen checkpoint").unwrap();

        link_frozen_checkpoint_scratch(&source, &scratch).unwrap();

        assert_ne!(source, scratch);
        assert_eq!(
            std::fs::metadata(&source).unwrap().ino(),
            std::fs::metadata(&scratch).unwrap().ino()
        );
    }

    #[test]
    fn layered_serial_device_appends_to_the_single_build_log() {
        let mut args = vec![
            "-display".to_string(),
            "none".to_string(),
            "-serial".to_string(),
            "file:/work/serial.log".to_string(),
        ];

        replace_serial_log_with_append(&mut args, Path::new("/work/serial.log"));

        assert!(args.windows(2).any(|pair| {
            pair == [
                "-chardev",
                "file,id=intar-build-serial,path=/work/serial.log,append=on",
            ]
        }));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-serial", "chardev:intar-build-serial"])
        );
        assert!(
            !args
                .iter()
                .any(|argument| argument == "file:/work/serial.log")
        );
    }

    #[test]
    fn balloon_device_is_stable_and_invalidates_checkpoint_identity() {
        let mut devices = Vec::new();
        append_layered_devices(&mut devices);
        assert_eq!(
            devices
                .windows(2)
                .filter(|pair| pair[0] == "-device" && pair[1] == VIRTIO_BALLOON_DEVICE)
                .count(),
            1
        );
        assert!(
            devices
                .windows(2)
                .any(|pair| pair == ["-device", "vmgenid,guid=auto"])
        );

        let identity = |qemu_devices: Vec<String>| CheckpointIdentity {
            scenario_id: "scenario".to_string(),
            vm_name: "vm".to_string(),
            parent_prefix: "base".to_string(),
            stage_bytes: b"stage".to_vec(),
            base_sha256: "a".repeat(64),
            kernel_sha256: "b".repeat(64),
            initrd_sha256: "c".repeat(64),
            disk_geometry_bytes: 1,
            qemu_version: "qemu".to_string(),
            qemu_cpu: "host".to_string(),
            qemu_devices,
            provisioning_abi: PROVISIONING_ABI.to_string(),
        };
        let without_balloon = vec!["-device".to_string(), "vmgenid,guid=auto".to_string()];
        assert_ne!(
            identity(devices).cache_key().unwrap(),
            identity(without_balloon).cache_key().unwrap()
        );
    }

    #[test]
    fn balloon_guest_commands_keep_reporting_treatment_bounded() {
        assert!(VIRTIO_BALLOON_VERIFY_COMMAND.contains("modprobe virtio_balloon"));
        assert!(VIRTIO_BALLOON_VERIFY_COMMAND.contains("/sys/bus/virtio/drivers/virtio_balloon"));
        assert!(VIRTIO_BALLOON_VERIFY_COMMAND.contains(
            "page_reporting_order=/sys/module/page_reporting/parameters/page_reporting_order"
        ));
        assert!(VIRTIO_BALLOON_VERIFY_COMMAND.contains("test -w \"$page_reporting_order\""));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("fstrim / || true"));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("drop_caches"));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains(
            "page_reporting_order=/sys/module/page_reporting/parameters/page_reporting_order"
        ));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("trap restore_order EXIT"));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("sleep 3"));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("trap - EXIT"));
    }

    #[test]
    fn restore_clock_command_uses_the_trusted_host_epoch() {
        assert_eq!(
            render_clock_set_command(1_789_000_123),
            "sudo date -u -s @1789000123"
        );
    }

    #[test]
    fn timeout_helper_constructs_the_timer_inside_the_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        timeout_in_runtime(&runtime, Duration::from_millis(10), "test timer", async {
            Ok::<_, anyhow::Error>(())
        })
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_kills_and_reaps_the_child() {
        let work_root = tempfile::tempdir().unwrap();
        let command = {
            let mut command = Command::new("/bin/sleep");
            command.arg("60");
            command
        };

        let error = run_command_output_until(
            command,
            work_root.path(),
            Instant::now() + Duration::from_millis(10),
            "test command",
        )
        .unwrap_err();

        assert!(error.to_string().contains("test command timed out"));
    }
}
