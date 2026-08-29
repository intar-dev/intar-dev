use super::*;

pub(super) async fn rollback_persisted_queued_vm(
    inner: &Inner,
    vm: &VmStatusResponse,
    vm_dir: &Path,
    spool_dir: &Path,
) -> Result<()> {
    remove_vm_staging_paths(&vm.name, vm_dir, spool_dir).await?;
    inner
        .db
        .delete_vm(vm.name.clone())
        .await
        .context("delete queued VM row during staging rollback")?;
    if !remove_matching_tracked_vm_state(inner, vm).await {
        anyhow::bail!("queued VM state changed during staging rollback")
    }
    clear_delete_request(inner, &vm.name).await;
    Ok(())
}

pub(super) async fn remove_matching_tracked_vm_state(
    inner: &Inner,
    expected: &VmStatusResponse,
) -> bool {
    let removed = {
        let mut states = inner.states.write().await;
        remove_matching_vm_state(&mut states, expected)
    };
    if removed {
        publish_inventory_update(inner);
    }
    removed
}

pub(super) fn remove_matching_vm_state(
    states: &mut BTreeMap<String, VmStatusResponse>,
    expected: &VmStatusResponse,
) -> bool {
    let expected_run_id = expected
        .details
        .as_ref()
        .and_then(|details| details.run_id.as_deref());
    let matches = states.get(&expected.name).is_some_and(|current| {
        current.created_at_s == expected.created_at_s
            && current
                .details
                .as_ref()
                .and_then(|details| details.run_id.as_deref())
                == expected_run_id
    });
    if matches {
        states.remove(&expected.name);
    }
    matches
}

pub(super) fn reserve_vm_state(
    states: &mut BTreeMap<String, VmStatusResponse>,
    status: VmStatusResponse,
) -> bool {
    if states.contains_key(&status.name) {
        return false;
    }
    states.insert(status.name.clone(), status);
    true
}

pub(super) async fn local_cleanup_tracked_vm(
    inner: &Inner,
    vm: &VmStatusResponse,
    remove_spool_dir: bool,
) -> Result<()> {
    clear_delete_request(inner, &vm.name).await;
    stop_terminal_worker(inner, &vm.name).await;

    let mut filesystem_failures = Vec::new();

    if let Some(vm_dir) = agent_owned_vm_dir_for_status(vm) {
        match tokio::fs::remove_dir_all(&vm_dir).await {
            Ok(_) => {
                info!(vm = vm.name, path = %vm_dir.display(), "deleted vm dir");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                filesystem_failures
                    .push(format!("failed to delete vm dir {}: {e}", vm_dir.display()));
            }
        }
    }

    if let Some(details) = vm.details.as_ref() {
        if details.jail_generation.is_none()
            && let Some(recording_disk_path) = details.recording_disk_path.as_deref()
            && let Err(e) = tokio::fs::remove_file(recording_disk_path).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            filesystem_failures.push(format!(
                "failed to delete recording disk {recording_disk_path}: {e}"
            ));
        }
        if remove_spool_dir
            && let Some(spool_dir) = details.spool_dir.as_deref()
            && let Err(e) = tokio::fs::remove_dir_all(spool_dir).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            filesystem_failures.push(format!("failed to delete run spool dir {spool_dir}: {e}"));
        }
    }

    if !filesystem_failures.is_empty() {
        anyhow::bail!(filesystem_failures.join("; "))
    }

    // Keep the in-memory row (and therefore sibling/network protection) until
    // SQLite has durably removed this VM. Db::delete_vm acknowledges the
    // actual SQL statement rather than merely queueing it to the DB thread.
    inner
        .db
        .delete_vm(vm.name.clone())
        .await
        .with_context(|| format!("delete VM {} from sqlite", vm.name))?;

    if !remove_matching_tracked_vm_state(inner, vm).await {
        warn!(
            vm = vm.name,
            "VM state changed after durable sqlite removal"
        );
    }
    {
        let mut fingerprints = inner.terminal_state_fingerprints.lock().await;
        fingerprints.remove(&vm.name);
    }
    {
        let mut terminal_states = inner.terminal_states.write().await;
        terminal_states.remove(&vm.name);
    }

    info!(vm = vm.name, "cleaned up tracked vm");
    Ok(())
}

pub(super) fn is_create_in_progress_state(state: VmLifecycleState) -> bool {
    matches!(
        state,
        VmLifecycleState::Queued
            | VmLifecycleState::CachingImage
            | VmLifecycleState::PreparingDisks
            | VmLifecycleState::CreatingVm
            | VmLifecycleState::BootingVm
    )
}

pub(super) async fn request_delete(inner: &Inner, name: &str) {
    let mut delete_requests = inner.delete_requests.lock().await;
    delete_requests.insert(name.to_string());
}

pub(super) async fn take_delete_request(inner: &Inner, name: &str) -> bool {
    let mut delete_requests = inner.delete_requests.lock().await;
    delete_requests.remove(name)
}

pub(super) async fn clear_delete_request(inner: &Inner, name: &str) {
    let mut delete_requests = inner.delete_requests.lock().await;
    delete_requests.remove(name);
}

pub(super) async fn acquire_vm_cleanup_lock(inner: &Inner, name: &str) -> OwnedMutexGuard<()> {
    acquire_cleanup_lock(&inner.cleanup_locks, name).await
}

pub(super) async fn acquire_vm_run_cleanup_lock(
    inner: &Inner,
    vm: &VmStatusResponse,
) -> Option<OwnedMutexGuard<()>> {
    let run_id = vm
        .details
        .as_ref()
        .and_then(|details| details.run_id.as_deref())
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())?;
    Some(acquire_run_cleanup_lock(&inner.run_cleanup_locks, run_id).await)
}

pub(super) async fn acquire_run_cleanup_lock(
    run_cleanup_locks: &Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    run_id: &str,
) -> OwnedMutexGuard<()> {
    acquire_cleanup_lock(run_cleanup_locks, run_id).await
}

pub(super) async fn acquire_cleanup_lock(
    locks: &Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    key: &str,
) -> OwnedMutexGuard<()> {
    let lock = {
        let mut locks = locks.lock().await;
        Arc::clone(
            locks
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    };

    lock.lock_owned().await
}

pub(super) async fn is_delete_requested(inner: &Inner, name: &str) -> bool {
    let delete_requests = inner.delete_requests.lock().await;
    delete_requests.contains(name)
}

pub(super) async fn ensure_create_not_deleted(inner: &Inner, name: &str) -> Result<()> {
    if is_delete_requested(inner, name).await {
        anyhow::bail!("vm create cancelled by delete request");
    }
    Ok(())
}

pub(super) async fn stop_cloud_hypervisor(inner: &Inner, details: &VmDetails, vm_name: &str) {
    if let Some(ch_socket_path) = details.ch_socket_path.as_deref()
        && Path::new(ch_socket_path).exists()
    {
        match ChClient::new(ch_socket_path.to_string()) {
            Ok(client) => {
                match timeout(
                    Duration::from_secs(DELETE_SHUTDOWN_GRACE_SECONDS),
                    client.vm_shutdown(),
                )
                .await
                {
                    Ok(Ok(())) => {
                        // Pinned Cloud Hypervisor v53 returns from vm.shutdown
                        // only after it has dropped the running VM and retained
                        // the reusable configuration. vm.info=Created is the
                        // proof for that exact state. A missing VM is also
                        // definitive; every other result is fail-closed.
                        //
                        // This deadline starts after the shutdown response, so
                        // an inconclusive probe preserves the existing full
                        // grace period before StopVm drains the complete
                        // cgroup and exports the recording disk.
                        let grace_deadline = tokio::time::Instant::now()
                            + Duration::from_secs(DELETE_SHUTDOWN_GRACE_SECONDS);
                        let probe_result = wait_for_post_shutdown_probe_grace(
                            grace_deadline,
                            client.vm_info(),
                            |probe_result| {
                                let shutdown_proven =
                                    post_shutdown_vm_info_proves_stopped(probe_result);
                                match probe_result {
                                    Ok(info) if v53_post_shutdown_state_is_proven(info) => {
                                        info!(
                                            vm = vm_name,
                                            socket = ch_socket_path,
                                            "cloud-hypervisor shutdown was proven by pinned-v53 vm.info"
                                        );
                                    }
                                    Err(error) if vm_info_confirms_vm_absent(error) => {
                                        info!(
                                            vm = vm_name,
                                            socket = ch_socket_path,
                                            "cloud-hypervisor shutdown was proven by absent vm.info"
                                        );
                                    }
                                    Ok(info) => {
                                        warn!(
                                            vm = vm_name,
                                            socket = ch_socket_path,
                                            state = ?info.state,
                                            "cloud-hypervisor vm.info did not prove pinned-v53 shutdown; preserving grace period"
                                        );
                                    }
                                    Err(error) => {
                                        warn!(
                                            error = %error,
                                            vm = vm_name,
                                            socket = ch_socket_path,
                                            "cloud-hypervisor vm.info was inconclusive after shutdown; preserving grace period"
                                        );
                                    }
                                }
                                shutdown_proven
                            },
                        )
                        .await;

                        if probe_result.is_err() {
                            warn!(
                                vm = vm_name,
                                socket = ch_socket_path,
                                timeout_seconds = DELETE_SHUTDOWN_GRACE_SECONDS,
                                "cloud-hypervisor vm.info timed out after shutdown; preserving grace period"
                            );
                        }
                    }
                    Ok(Err(e)) => {
                        warn!(
                            error = %e,
                            vm = vm_name,
                            socket = ch_socket_path,
                            "failed to request cloud-hypervisor shutdown"
                        );
                    }
                    Err(_) => {
                        warn!(
                            vm = vm_name,
                            socket = ch_socket_path,
                            timeout_seconds = DELETE_SHUTDOWN_GRACE_SECONDS,
                            "timed out requesting cloud-hypervisor shutdown"
                        );
                    }
                }
            }
            Err(e) => {
                warn!(
                    error = %e,
                    vm = vm_name,
                    socket = ch_socket_path,
                    "failed to create cloud-hypervisor client for shutdown"
                );
            }
        }
    }

    if let Some(generation) = details.jail_generation.as_deref() {
        match jailer_identity_request(inner, generation, JailerIdentityOperation::Stop).await {
            Ok(_) => {}
            Err(error) => warn!(
                error = %error,
                vm = vm_name,
                generation,
                "failed to stop jailed cloud-hypervisor cgroup"
            ),
        }
    }
}

/// Wait until the supplied post-response deadline unless the `vm.info`
/// response proves that pinned Cloud Hypervisor v53 has stopped the VM. The
/// deadline is a Tokio instant so the timer and its timeout use the same clock.
pub(super) async fn wait_for_post_shutdown_probe_grace<Probe, IsProven>(
    grace_deadline: tokio::time::Instant,
    probe: Probe,
    is_proven: IsProven,
) -> std::result::Result<Probe::Output, tokio::time::error::Elapsed>
where
    Probe: Future,
    IsProven: FnOnce(&Probe::Output) -> bool,
{
    let probe_result = tokio::time::timeout_at(grace_deadline, probe).await;
    let shutdown_proven = probe_result.as_ref().is_ok_and(is_proven);

    if !shutdown_proven {
        tokio::time::sleep_until(grace_deadline).await;
    }

    probe_result
}

/// Only these two `vm.info` responses can bypass the post-response shutdown
/// barrier. Every other response is inconclusive and must retain it.
pub(super) fn post_shutdown_vm_info_proves_stopped(
    probe_result: &std::result::Result<
        cloud_hypervisor_client::VmInfo,
        cloud_hypervisor_client::Error,
    >,
) -> bool {
    match probe_result {
        Ok(info) => v53_post_shutdown_state_is_proven(info),
        Err(error) => vm_info_confirms_vm_absent(error),
    }
}

/// Pinned Cloud Hypervisor v53 returns `Created` after a successful
/// `vm.shutdown`: it has synchronously dropped the running VM while retaining
/// only the reusable configuration. Do not accept other states here; they do
/// not prove that the VM has stopped.
pub(super) fn v53_post_shutdown_state_is_proven(info: &cloud_hypervisor_client::VmInfo) -> bool {
    matches!(info.state, cloud_hypervisor_client::VmState::Created)
}

/// A 404 from `vm.info` is the pinned runtime's definitive post-delete
/// response. It proves that no VM configuration remains, while other HTTP and
/// transport failures must retain the grace period.
pub(super) fn vm_info_confirms_vm_absent(error: &cloud_hypervisor_client::Error) -> bool {
    matches!(
        error,
        cloud_hypervisor_client::Error::HttpStatus { status: 404, .. }
    )
}

pub(super) async fn copy_vm_log_to_spool(
    vm: &VmStatusResponse,
    source_name: &str,
    destination: &Path,
) -> Result<()> {
    // A final artifact is only made visible after its contents and directory
    // entry have been synced. This is intentionally checked before touching
    // the jailed source: a cleanup retry can run after jailerd has destroyed
    // the source tree.
    if artifact_final_is_published(destination)? {
        return Ok(());
    }

    let Some(details) = vm.details.as_ref() else {
        return Ok(());
    };
    // A process crash can leave only one of our private temporary files. Clean
    // it before opening the source so retries do not accumulate stale partial
    // artifacts when the source has since been removed.
    remove_stale_artifact_temps(destination)?;
    let (source, ownership) = if let Some(jail_root) = details.jail_root_path.as_deref() {
        (
            PathBuf::from(jail_root).join("logs").join(source_name),
            VmLogSourceOwnership::JailOwned,
        )
    } else if let Some(vm_dir) = agent_owned_vm_dir_for_status(vm) {
        (vm_dir.join(source_name), VmLogSourceOwnership::AgentOwned)
    } else {
        return Ok(());
    };

    // Open the source separately so a jail traversal denial can be treated as
    // best-effort without accidentally swallowing an agent-owned spool error.
    // Once the jailed file is open, all destination creation and copy errors
    // remain actionable and continue to fail artifact preparation.
    let source_file = match tokio::fs::File::open(&source).await {
        Ok(source_file) => source_file,
        Err(error) => {
            return handle_vm_log_source_open_error(ownership, &source, destination, error);
        }
    };
    let source_file = source_file.into_std().await;
    let source_for_copy = source.clone();
    let destination_for_copy = destination.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut source_file = source_file;
        copy_reader_to_artifact_atomically(
            &mut source_file,
            &source_for_copy,
            &destination_for_copy,
        )
    })
    .await
    .context("VM log copy task panicked")?
}

const ARTIFACT_TEMP_MARKER: &str = ".part.";

/// A final artifact exists only after [`copy_reader_to_artifact_atomically`]
/// has synced the completed file and atomically renamed it into place. Keep
/// this idempotent path for cleanup retries: their jail-owned sources may have
/// been removed after a prior successful publication.
pub(super) fn artifact_final_is_published(destination: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_file() => {
            sync_artifact_parent(destination)?;
            Ok(true)
        }
        Ok(_) => anyhow::bail!(
            "artifact destination {} exists but is not a regular file",
            destination.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(anyhow::anyhow!(
            "failed to inspect artifact destination {}: {error}",
            destination.display()
        )),
    }
}

fn artifact_parent(destination: &Path) -> Result<&Path> {
    destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "artifact destination has no parent directory: {}",
                destination.display()
            )
        })
}

fn artifact_temp_prefix(destination: &Path) -> Result<String> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "artifact destination filename is not UTF-8: {}",
                destination.display()
            )
        })?;
    Ok(format!(".{file_name}{ARTIFACT_TEMP_MARKER}"))
}

/// Linux is the supported agent host and requires a directory fsync to make
/// the post-rename name durable. Other platforms do not provide a portable
/// directory-sync contract, so retain the atomic rename without pretending to
/// provide a stronger guarantee there.
#[cfg(target_os = "linux")]
fn sync_artifact_parent(destination: &Path) -> Result<()> {
    let parent = artifact_parent(destination)?;
    std::fs::File::open(parent)
        .with_context(|| {
            format!(
                "failed to open artifact directory {} for sync",
                parent.display()
            )
        })?
        .sync_all()
        .with_context(|| format!("failed to sync artifact directory {}", parent.display()))
}

#[cfg(not(target_os = "linux"))]
fn sync_artifact_parent(_destination: &Path) -> Result<()> {
    Ok(())
}

/// Remove only abandoned temporary files for this exact destination. The run
/// cleanup lock serializes same-run cleanup, so a matching temp cannot belong
/// to a concurrent publisher.
pub(super) fn remove_stale_artifact_temps(destination: &Path) -> Result<()> {
    let parent = artifact_parent(destination)?;
    let prefix = artifact_temp_prefix(destination)?;
    let entries = std::fs::read_dir(parent).with_context(|| {
        format!(
            "failed to create temporary artifact for {}",
            destination.display()
        )
    })?;
    let mut removed_any = false;

    for entry in entries {
        let entry = entry.with_context(|| {
            format!(
                "failed to inspect temporary artifacts for {}",
                destination.display()
            )
        })?;
        let file_name = entry.file_name();
        if !file_name
            .to_str()
            .is_some_and(|file_name| file_name.starts_with(&prefix))
        {
            continue;
        }

        let temporary = entry.path();
        let file_type = entry.file_type().with_context(|| {
            format!(
                "failed to inspect temporary artifact {}",
                temporary.display()
            )
        })?;
        if !file_type.is_file() {
            anyhow::bail!(
                "stale temporary artifact is not a regular file: {}",
                temporary.display()
            );
        }
        std::fs::remove_file(&temporary).with_context(|| {
            format!(
                "failed to remove stale temporary artifact {}",
                temporary.display()
            )
        })?;
        removed_any = true;
    }

    if removed_any {
        sync_artifact_parent(destination)
            .context("failed to sync artifact directory after stale temporary cleanup")?;
    }
    Ok(())
}

fn create_unique_artifact_temp(destination: &Path) -> Result<(PathBuf, std::fs::File)> {
    let parent = artifact_parent(destination)?;
    remove_stale_artifact_temps(destination)?;
    let prefix = artifact_temp_prefix(destination)?;

    for _ in 0..8 {
        let mut suffix = [0_u8; 16];
        getrandom_fill(&mut suffix).context("generate unique artifact temporary suffix")?;
        let temporary = parent.join(format!("{prefix}{:032x}", u128::from_be_bytes(suffix)));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(anyhow::anyhow!(
                    "failed to create temporary artifact {} for {}: {error}",
                    temporary.display(),
                    destination.display()
                ));
            }
        }
    }

    anyhow::bail!(
        "failed to reserve a unique temporary artifact for {}",
        destination.display()
    )
}

fn remove_artifact_temp_after_error(temporary: &Path, destination: &Path) -> Result<()> {
    match std::fs::remove_file(temporary) {
        Ok(()) => sync_artifact_parent(destination).with_context(|| {
            format!(
                "failed to sync artifact directory after removing temporary {}",
                temporary.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::anyhow!(
            "failed to remove temporary artifact {}: {error}",
            temporary.display()
        )),
    }
}

/// Copy one artifact through a private file in the artifact directory. A
/// failed copy can leave only a removable `.part` file; the final path is not
/// visible until the complete file has been synced and atomically renamed.
pub(super) fn copy_reader_to_artifact_atomically<R>(
    source: &mut R,
    source_path: &Path,
    destination: &Path,
) -> Result<()>
where
    R: std::io::Read,
{
    if artifact_final_is_published(destination)? {
        return Ok(());
    }

    let (temporary, mut output) = create_unique_artifact_temp(destination)?;
    let write_result = (|| -> Result<()> {
        std::io::copy(source, &mut output).with_context(|| {
            format!(
                "failed to copy {} to {}",
                source_path.display(),
                destination.display()
            )
        })?;
        output.sync_all().with_context(|| {
            format!("failed to sync temporary artifact {}", temporary.display())
        })?;
        Ok(())
    })();
    drop(output);

    let result = write_result.and_then(|()| {
        std::fs::rename(&temporary, destination).with_context(|| {
            format!(
                "failed to atomically publish artifact {}",
                destination.display()
            )
        })?;
        sync_artifact_parent(destination).with_context(|| {
            format!(
                "failed to sync artifact directory after publishing {}",
                destination.display()
            )
        })
    });

    match result {
        Ok(()) => Ok(()),
        Err(error) => match remove_artifact_temp_after_error(&temporary, destination) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(anyhow::anyhow!(
                "{error:#}; temporary artifact cleanup also failed: {cleanup_error:#}"
            )),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum VmLogSourceOwnership {
    JailOwned,
    AgentOwned,
}

pub(super) fn handle_vm_log_source_open_error(
    ownership: VmLogSourceOwnership,
    source: &Path,
    destination: &Path,
    error: std::io::Error,
) -> Result<()> {
    if error.kind() == std::io::ErrorKind::NotFound {
        return Ok(());
    }
    if ownership == VmLogSourceOwnership::JailOwned
        && error.kind() == std::io::ErrorKind::PermissionDenied
    {
        warn!(
            error = %error,
            source = %source.display(),
            destination = %destination.display(),
            "skipping inaccessible jail-owned VM log during cleanup"
        );
        return Ok(());
    }
    Err(anyhow::anyhow!(
        "failed to copy {} to {}: {error}",
        source.display(),
        destination.display()
    ))
}

pub(super) fn recording_export_path_for_cleanup(details: &VmDetails) -> Result<Option<&Path>> {
    let Some(recording_disk_path) = details.recording_disk_path.as_deref() else {
        return Ok(None);
    };
    let recording_disk_path = Path::new(recording_disk_path);
    if details.jail_generation.is_some() && !recording_disk_path.is_file() {
        anyhow::bail!(
            "jailerd did not publish the drained recording export at {}",
            recording_disk_path.display()
        );
    }
    Ok(Some(recording_disk_path))
}

pub(super) async fn extract_recordings_to_spool(
    recording_disk_path: &Path,
    artifacts_dir: &Path,
) -> Result<()> {
    if !recording_disk_path.exists() {
        return Ok(());
    }

    let recording_disk_path = recording_disk_path.to_path_buf();
    let artifacts_dir = artifacts_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        extract_recordings_to_spool_blocking(&recording_disk_path, &artifacts_dir)
    })
    .await
    .context("recording extraction task panicked")?
}

pub(super) fn extract_recordings_to_spool_blocking(
    recording_disk_path: &Path,
    artifacts_dir: &Path,
) -> Result<()> {
    std::fs::create_dir_all(artifacts_dir)
        .with_context(|| format!("failed to create artifact dir {}", artifacts_dir.display()))?;
    let image = std::fs::OpenOptions::new()
        .read(true)
        .open(recording_disk_path)
        .with_context(|| {
            format!(
                "failed to open recording disk {}",
                recording_disk_path.display()
            )
        })?;
    let fs = fatfs::FileSystem::new(image, fatfs::FsOptions::new())
        .context("failed to open recording filesystem")?;
    let root = fs.root_dir();
    for entry in root.iter() {
        let entry = entry.context("failed to read recording directory entry")?;
        if !entry.is_file() {
            continue;
        }

        let file_name = entry.file_name();
        if file_name.ends_with(".krec") {
            let raw_destination = artifacts_dir.join(&file_name);
            let mut source = entry.to_file();
            copy_reader_to_artifact_atomically(&mut source, recording_disk_path, &raw_destination)
                .with_context(|| {
                    format!(
                        "failed to extract recording {} to {}",
                        file_name,
                        raw_destination.display()
                    )
                })?;
        }
    }

    Ok(())
}

/// Collects everything except the rendered session casts, which are
/// rendered and registered separately after these artifacts are already
/// uploaded.
pub(super) async fn collect_local_artifacts(artifacts_dir: &Path) -> Result<Vec<LocalArtifact>> {
    let mut artifacts = Vec::new();
    let mut ordinal = 1_u32;

    for (kind, path, content_type) in [
        (
            "console_log",
            artifacts_dir.join("console.log"),
            "text/plain; charset=utf-8",
        ),
        (
            "serial_log",
            artifacts_dir.join("serial.log"),
            "text/plain; charset=utf-8",
        ),
        (
            "cloud_hypervisor_stderr_log",
            artifacts_dir.join(CLOUD_HYPERVISOR_STDERR_LOG_NAME),
            "text/plain; charset=utf-8",
        ),
    ] {
        if !path.exists() {
            continue;
        }
        artifacts.push(describe_local_artifact(ordinal, kind, &path, content_type).await?);
        ordinal = ordinal.saturating_add(1);
    }

    let mut recording_paths = Vec::new();
    let mut dir = match tokio::fs::read_dir(artifacts_dir).await {
        Ok(dir) => dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(artifacts),
        Err(e) => {
            return Err(anyhow::anyhow!(
                "failed to read artifact directory {}: {e}",
                artifacts_dir.display()
            ));
        }
    };
    while let Some(entry) = dir
        .next_entry()
        .await
        .context("failed to iterate artifact dir")?
    {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("krec") {
            recording_paths.push(path);
        }
    }
    // Session files are named ssh-session-<start-ms>-<pid>.krec, so the
    // lexicographic order is the chronological order.
    recording_paths.sort();

    for path in recording_paths {
        artifacts.push(
            describe_local_artifact(
                ordinal,
                "ssh_recording_raw",
                &path,
                "application/x-kino-raw-event-log; charset=utf-8",
            )
            .await?,
        );
        ordinal = ordinal.saturating_add(1);
    }

    Ok(artifacts)
}

pub(super) async fn describe_local_artifact(
    ordinal: u32,
    kind: &str,
    path: &Path,
    content_type: &str,
) -> Result<LocalArtifact> {
    let metadata = tokio::fs::metadata(path)
        .await
        .with_context(|| format!("failed to stat artifact {}", path.display()))?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow::anyhow!("artifact path has no utf-8 filename: {}", path.display()))?
        .to_string();
    let sha256 = sha256_file(path).await?;

    Ok(LocalArtifact {
        ordinal,
        kind: kind.to_string(),
        filename,
        content_type: content_type.to_string(),
        size_bytes: metadata.len(),
        sha256,
        path: path.to_path_buf(),
    })
}

pub(super) async fn sha256_file(path: &Path) -> Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = std::io::Read::read(&mut file, &mut buffer)
                .with_context(|| format!("failed to read {}", path.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok::<_, anyhow::Error>(base16ct::lower::encode_string(&hasher.finalize()))
    })
    .await
    .context("sha256 file task panicked")?
}

pub(super) async fn bootstrap_agent_access_token(
    cfg: &BridgeConfig,
    http: &HttpClient,
) -> Result<String> {
    if !cfg.enabled {
        anyhow::bail!("bridge uploads require bridge.enabled = true");
    }
    let url = format!("{}/agent/bootstrap", cfg.base_url);
    let display_url = crate::config::redact_url_userinfo(&url);
    let request = AgentBootstrapRequest {
        host_id: &cfg.host_id,
        bootstrap_token: &cfg.bootstrap_token,
    };

    let response = http
        .post(&url)
        .json(&request)
        .send()
        .await
        .with_context(|| format!("failed to call bootstrap endpoint at {display_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        // The bootstrap response carries a bearer credential on success. Do
        // not copy an untrusted error body into task errors, because callers
        // may log their complete error chain.
        anyhow::bail!("bootstrap request failed with status {status}");
    }

    let payload = response
        .json::<AgentBootstrapResponse>()
        .await
        .context("failed to parse bootstrap response")?;
    Ok(payload.access_token)
}

pub(super) fn agent_owned_vm_dir_for_status(vm: &VmStatusResponse) -> Option<PathBuf> {
    vm.details
        .as_ref()
        .filter(|details| details.jail_generation.is_none())
        .map(|details| PathBuf::from(&details.root_disk_path))
        .and_then(|root_disk_path| root_disk_path.parent().map(Path::to_path_buf))
}

pub(super) fn is_run_purged_remote_response(status: StatusCode, body: &str) -> bool {
    if !status.is_client_error() {
        return false;
    }

    #[derive(Deserialize)]
    struct ErrorBody {
        code: Option<String>,
    }

    serde_json::from_str::<ErrorBody>(body)
        .ok()
        .and_then(|body| body.code)
        .is_some_and(|code| code == "run_purged")
}
