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
use qmp::Qmp;

const PROVISIONING_ABI: &str = "intar-qemu-stages-v1";
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResumeMetadata {
    bootstrap_private_key: String,
    memory_encoding: String,
}

pub(super) fn build(rendered: RenderedDirectBuild) -> Result<RenderedDirectBuild> {
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
                let snapshot = capture(&rendered, &runtime, &mut guest, deadline)?;
                // The snapshot is self-contained and QEMU has exited. Release
                // its old backing entry before replacing the retained slot.
                drop(guest._lease.take());
                let metadata = serde_json::to_value(ResumeMetadata {
                    bootstrap_private_key: private_key_to_openssh(&guest.key.private_key)?,
                    memory_encoding: "zstd".to_string(),
                })?;
                let publish_started = Instant::now();
                let publication = writer.publish_moving(
                    &snapshot.disk,
                    &snapshot.memory,
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
                let cached_guest = match publication {
                    Ok(CheckpointPublish::Stored(lease)) => match restore(
                        &rendered,
                        &runtime,
                        lease,
                        index,
                        checkpoint_deadline(&rendered, deadline),
                    ) {
                        Ok(guest) => Some(guest),
                        Err(error) => {
                            log(
                                &rendered,
                                &format!(
                                    "checkpoint_cache_restore_failed error={error:#}; rebuilding cold without cache"
                                ),
                            )?;
                            if let Err(invalidation) = cache.invalidate(&identities[index]) {
                                log(
                                    &rendered,
                                    &format!(
                                        "checkpoint_cache_invalidation_failed error={invalidation:#}"
                                    ),
                                )?;
                            }
                            drop(snapshot);
                            drop(guest);
                            return rebuild_without_cache(rendered, error);
                        }
                    },
                    Ok(CheckpointPublish::Skipped) => None,
                    Ok(CheckpointPublish::RetentionUncertain) => {
                        drop(snapshot);
                        drop(guest);
                        return rebuild_without_cache(
                            rendered,
                            anyhow!("checkpoint retention index is uncertain"),
                        );
                    }
                    Err(error) => {
                        log(
                            &rendered,
                            &format!(
                                "checkpoint_cache_publish_failed error={error:#}; using local snapshot"
                            ),
                        )?;
                        None
                    }
                };
                let persisted = cached_guest.is_some();
                if let Some(resumed) = cached_guest {
                    guest = resumed;
                } else {
                    // Space can change after reservation. The captured state
                    // still lets this build continue without storing a cache.
                    let key = generate_key_copy(&guest.key);
                    let mut resumed = restore_files(
                        &rendered,
                        &runtime,
                        &snapshot.disk,
                        &snapshot.memory,
                        key,
                        None,
                        checkpoint_deadline(&rendered, deadline),
                    )?;
                    resumed._temporary_snapshot = Some(snapshot);
                    guest = resumed;
                }
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
    let raw_started = Instant::now();
    run_img_until(
        &rendered,
        &["convert", "-f", "qcow2", "-O", "raw", "-S", "4k"],
        &[&guest.disk, &rendered.paths.root_disk_path],
        deadline_after(rendered.config.qemu_exit_timeout_seconds),
    )?;
    fs::File::open(&rendered.paths.root_disk_path)?.sync_all()?;
    log(
        &rendered,
        &format!(
            "raw_conversion elapsed_ms={}",
            raw_started.elapsed().as_millis()
        ),
    )?;
    log(&rendered, "layered_raw_complete")?;
    Ok(rendered)
}

fn rebuild_without_cache(
    mut rendered: RenderedDirectBuild,
    restore_error: anyhow::Error,
) -> Result<RenderedDirectBuild> {
    let reason = format!("{restore_error:#}");
    eprintln!(
        "[intar-layered] scenario={} vm={} retrying cold build after fresh checkpoint restore failure: {reason}",
        rendered.scenario_name, rendered.vm.name
    );
    rendered.config.layered.use_cache = false;
    build(rendered).with_context(|| {
        format!("cold build after fresh checkpoint restore failure also failed: {reason}")
    })
}

struct Guest {
    child: Child,
    disk: PathBuf,
    key: BuildSshKey,
    ssh: Option<BuildSshSession>,
    // The work disk has this checkpoint as its read-only backing file.
    _lease: Option<CheckpointLease>,
    _temporary_snapshot: Option<Snapshot>,
    finished: bool,
}

impl Drop for Guest {
    fn drop(&mut self) {
        if !self.finished {
            let _ = terminate_qemu(&mut self.child);
        }
    }
}

struct Snapshot {
    _directory: tempfile::TempDir,
    disk: PathBuf,
    memory: PathBuf,
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
    if let Some(lease) = &guest._lease {
        disk_bytes = disk_bytes.saturating_add(allocated(&lease.entry.qcow2_path)?);
    } else if let Some(snapshot) = &guest._temporary_snapshot {
        disk_bytes = disk_bytes.saturating_add(allocated(&snapshot.disk)?);
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
        key,
        ssh: None,
        _lease: None,
        _temporary_snapshot: None,
        finished: false,
    };
    guest.ssh = Some(wait_for_ssh(
        rendered,
        &mut guest.child,
        &guest.key.private_key,
        runtime,
    )?);
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
        Some(lease),
        deadline,
    )
}

fn generate_key_copy(key: &BuildSshKey) -> BuildSshKey {
    BuildSshKey {
        private_key: key.private_key.clone(),
        public_key_openssh: key.public_key_openssh.clone(),
    }
}

fn restore_files(
    rendered: &RenderedDirectBuild,
    runtime: &tokio::runtime::Runtime,
    checkpoint_disk: &Path,
    state_path: &Path,
    key: BuildSshKey,
    lease: Option<CheckpointLease>,
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
        key,
        ssh: None,
        _lease: lease,
        _temporary_snapshot: None,
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
) -> Result<Snapshot> {
    let zstd = resolve_binary(Path::new("zstd"))?;
    let mut ssh = guest.ssh.take().context("build guest has no SSH session")?;
    let sync_started = Instant::now();
    let remaining = provision_deadline
        .checked_duration_since(Instant::now())
        .context("provision deadline expired before checkpoint")?;
    runtime.block_on(async {
        tokio::time::timeout(remaining, async {
            // Drop discarded filesystem blocks from qcow2 before freezing it.
            // This changes no live files and avoids caching deleted package data.
            ssh.run("sync && (sudo fstrim / || true)", true).await?;
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
    let disk = directory.path().join("checkpoint.qcow2");
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
    qmp.execute("migrate", json!({"channels": [{"channel-type": "main", "addr": {"transport": "exec", "args": [zstd, "-1", "-q", "-o", memory]}}]}), deadline)?;
    qmp.wait_migration(deadline)?;
    log(
        rendered,
        &format!(
            "checkpoint_capture_migration elapsed_ms={}",
            migration_started.elapsed().as_millis()
        ),
    )?;
    qmp.execute("quit", json!({}), deadline)?;
    drop(qmp);
    while Instant::now() < deadline {
        if let Some(status) = guest.child.try_wait()? {
            ensure!(status.success(), "checkpoint QEMU exited unsuccessfully");
            guest.finished = true;
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    ensure!(
        guest.finished,
        "QEMU did not stop after checkpoint migration"
    );
    log(
        rendered,
        &format!(
            "checkpoint_capture_freeze elapsed_ms={}",
            freeze_started.elapsed().as_millis()
        ),
    )?;
    // Reaping QEMU also waits for its migration encoder. Flush only after
    // that writer has closed the complete compressed stream.
    let flush_started = Instant::now();
    fs::File::open(&memory)?.sync_all()?;
    log(
        rendered,
        &format!(
            "checkpoint_capture_flush elapsed_ms={}",
            flush_started.elapsed().as_millis()
        ),
    )?;
    // QEMU remained paused until it exited. Its closed disk and migration
    // stream therefore describe the same guest state. Compact only offline.
    let disk_started = Instant::now();
    let info = run_img_output_until(
        rendered,
        &["info", "--output=json", "-f", "qcow2"],
        &[&guest.disk],
        deadline,
    )?;
    ensure!(info.status.success(), "failed to inspect frozen build disk");
    let info: serde_json::Value = serde_json::from_slice(&info.stdout)?;
    if info.get("backing-filename").is_none() {
        // The first work disk is already self-contained. Moving it avoids
        // rewriting the complete filesystem just to publish a checkpoint.
        fs::rename(&guest.disk, &disk)?;
    } else {
        run_img_until(
            rendered,
            &["convert", "-f", "qcow2", "-O", "qcow2"],
            &[&guest.disk, &disk],
            deadline,
        )?;
    }
    fs::File::open(&disk)?.sync_all()?;
    log(
        rendered,
        &format!(
            "checkpoint_capture_disk elapsed_ms={}",
            disk_started.elapsed().as_millis()
        ),
    )?;
    Ok(Snapshot {
        _directory: directory,
        disk,
        memory,
    })
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
    args.extend(["-device".to_string(), "vmgenid,guid=auto".to_string()]);
    args
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

fn checkpoint_deadline(rendered: &RenderedDirectBuild, provision_deadline: Instant) -> Instant {
    deadline_after(rendered.config.ssh_wait_timeout_seconds).min(provision_deadline)
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
