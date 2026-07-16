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
                        tokio::time::sleep(Duration::from_secs(DELETE_SHUTDOWN_GRACE_SECONDS))
                            .await;
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

pub(super) async fn copy_vm_log_to_spool(
    vm: &VmStatusResponse,
    source_name: &str,
    destination: &Path,
) -> Result<()> {
    if destination.exists() {
        return Ok(());
    }

    let Some(details) = vm.details.as_ref() else {
        return Ok(());
    };
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
    let mut source_file = match tokio::fs::File::open(&source).await {
        Ok(source_file) => source_file,
        Err(error) => {
            return handle_vm_log_source_open_error(ownership, &source, destination, error);
        }
    };
    let mut destination_options = tokio::fs::OpenOptions::new();
    destination_options.write(true).create_new(true);
    #[cfg(unix)]
    destination_options.mode(0o600);
    let mut destination_file = match destination_options.open(destination).await {
        Ok(destination_file) => destination_file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => {
            return Err(anyhow::anyhow!(
                "failed to create {} while copying {}: {error}",
                destination.display(),
                source.display()
            ));
        }
    };

    if let Err(error) = tokio::io::copy(&mut source_file, &mut destination_file).await {
        drop(destination_file);
        let cleanup_error = match tokio::fs::remove_file(destination).await {
            Ok(()) => None,
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => None,
            Err(cleanup_error) => Some(cleanup_error),
        };
        return Err(match cleanup_error {
            Some(cleanup_error) => anyhow::anyhow!(
                "failed to copy {} to {}: {error}; failed to remove partial destination: {cleanup_error}",
                source.display(),
                destination.display()
            ),
            None => anyhow::anyhow!(
                "failed to copy {} to {}: {error}",
                source.display(),
                destination.display()
            ),
        });
    }

    Ok(())
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
            if !raw_destination.exists() {
                let mut source = entry.to_file();
                let mut destination_file = std::fs::File::create(&raw_destination)
                    .with_context(|| format!("failed to create {}", raw_destination.display()))?;
                std::io::copy(&mut source, &mut destination_file)
                    .with_context(|| format!("failed to extract {}", raw_destination.display()))?;
            }
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
    let request = AgentBootstrapRequest {
        host_id: &cfg.host_id,
        bootstrap_token: &cfg.bootstrap_token,
    };

    let response = http
        .post(&url)
        .json(&request)
        .send()
        .await
        .with_context(|| format!("failed to call bootstrap endpoint at {url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("bootstrap request failed with status {status}: {body}");
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
