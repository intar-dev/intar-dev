use super::*;

#[cfg(not(target_os = "linux"))]
pub(super) async fn run_probe_worker_task(
    inner: Arc<Inner>,
    vm_name: String,
    run_id: String,
    jail_generation: String,
    _kino_vsock_path: PathBuf,
    _kino_vsock_port: u32,
    _jail_uid: u32,
) {
    warn!(
        vm = vm_name,
        "Kino readiness push listener is only available on Linux"
    );
    let mut interval = tokio::time::interval(Duration::from_secs(PROBE_POLL_INTERVAL_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let should_continue = {
            let states = inner.states.read().await;
            match states.get(&vm_name) {
                Some(vm) => {
                    vm.state == VmLifecycleState::Running
                        && vm.details.as_ref().is_some_and(|details| {
                            details.run_id.as_deref() == Some(run_id.as_str())
                                && details.jail_generation.as_deref()
                                    == Some(jail_generation.as_str())
                        })
                }
                None => false,
            }
        };
        if !should_continue {
            break;
        }
    }
}

#[cfg(target_os = "linux")]
pub(super) async fn handle_kino_ready_stream(
    inner: Arc<Inner>,
    vm_name: &str,
    run_id: &str,
    jail_generation: &str,
    mut stream: tokio::net::UnixStream,
) -> Result<()> {
    use std::io::ErrorKind;
    use tokio::io::AsyncReadExt as _;

    loop {
        let mut len_buf = [0_u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error).context("failed to read Kino readiness frame length"),
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        anyhow::ensure!(len > 0, "Kino readiness frame was empty");
        anyhow::ensure!(
            len <= MAX_KINO_READY_FRAME_BYTES,
            "Kino readiness frame too large: {len} bytes"
        );

        let mut frame = vec![0_u8; len];
        stream
            .read_exact(&mut frame)
            .await
            .context("failed to read Kino readiness frame body")?;

        let result = decode_probe_snapshot(&frame)?;
        apply_kino_ready_snapshot(&inner, vm_name, run_id, jail_generation, result).await?;
    }
}

#[cfg(target_os = "linux")]
pub(super) async fn apply_kino_ready_snapshot(
    inner: &Arc<Inner>,
    vm_name: &str,
    run_id: &str,
    jail_generation: &str,
    result: ProbePollResult,
) -> Result<()> {
    let current_run_matches = {
        let states = inner.states.read().await;
        states.get(vm_name).is_some_and(|vm| {
            vm.details.as_ref().is_some_and(|details| {
                details.run_id.as_deref() == Some(run_id)
                    && details.jail_generation.as_deref() == Some(jail_generation)
            })
        })
    };
    anyhow::ensure!(
        current_run_matches,
        "dropping Kino readiness snapshot for stale run/generation {run_id}/{jail_generation} of vm {vm_name}"
    );

    stage_vm_ssh_host_keys(
        inner,
        vm_name,
        jail_generation,
        result.ssh_host_keys_openssh.clone(),
    )
    .await;
    let still_current = {
        let states = inner.states.read().await;
        states.get(vm_name).is_some_and(|vm| {
            vm.details.as_ref().is_some_and(|details| {
                details.run_id.as_deref() == Some(run_id)
                    && details.jail_generation.as_deref() == Some(jail_generation)
            })
        })
    };
    anyhow::ensure!(
        still_current,
        "dropping Kino readiness snapshot after generation changed"
    );
    let update = ProbeUpdateEnvelope::from_poll_result(vm_name, run_id, jail_generation, result);
    // Always wake the generation-fenced launch waiter internally. Projection
    // is permitted only for an already committed steady VM; the first ready
    // snapshot is published through the atomic ready transaction instead.
    let _ = inner.kino_readiness_tx.send(update.clone());
    let may_project = {
        let states = inner.states.read().await;
        let Some(vm) = states.get(vm_name) else {
            return Ok(());
        };
        let committed = vm.state == VmLifecycleState::Running
            && vm.details.as_ref().is_some_and(|details| {
                details.run_id.as_deref() == Some(run_id)
                    && details.jail_generation.as_deref() == Some(jail_generation)
                    && details.cpu_runtime.as_ref().is_some_and(|runtime| {
                        runtime.phase == VmCpuPhase::Steady
                            && runtime.effective_quota == runtime.steady_quota
                            && runtime.attestation.is_some()
                    })
            });
        if committed {
            // Persist host-key changes and their Kino snapshot in the same
            // transaction used by the initial ready boundary. Holding the
            // read fence prevents a concurrent generation replacement.
            inner
                .db
                .upsert_ready_vm_and_probe_state(vm.to_db_row(), probe_state_row(&update)?)
                .await
                .context("atomically persist post-ready Kino snapshot")?;
        }
        committed
    };
    if may_project {
        let _ = inner.probe_updates_tx.send(update);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) async fn stage_vm_ssh_host_keys(
    inner: &Inner,
    vm_name: &str,
    jail_generation: &str,
    keys: Vec<String>,
) {
    let keys = normalize_ssh_host_keys(keys);
    if keys.is_empty() {
        return;
    }

    let now_s = now_unix_s();
    let updated_at = format_rfc3339_s(now_s);
    {
        let mut states = inner.states.write().await;
        let Some(vm) = states.get_mut(vm_name) else {
            return;
        };
        let Some(details) = vm.details.as_mut() else {
            return;
        };
        if details.jail_generation.as_deref() != Some(jail_generation) {
            return;
        }
        if details.ssh_host_keys_openssh == keys {
            return;
        }
        details.ssh_host_keys_openssh = keys;
        vm.updated_at_s = now_s;
        vm.updated_at = updated_at;
        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);
    }
}

pub(super) async fn start_probe_worker(
    inner: &Arc<Inner>,
    vm_name: &str,
    details: &VmDetails,
) -> Result<()> {
    let run_id = details
        .run_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("vm details missing run_id"))?;
    let jail_generation = details
        .jail_generation
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("vm details missing jail_generation"))?;
    let kino_vsock_path = details
        .kino_vsock_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("vm details missing kino_vsock_path"))?;
    #[cfg(not(target_os = "linux"))]
    let kino_vsock_port = details.kino_vsock_port.unwrap_or(KINO_VSOCK_PORT);
    let jail_uid = details
        .jail_uid
        .ok_or_else(|| anyhow::anyhow!("vm details missing jail_uid"))?;

    stop_probe_worker(inner, vm_name).await;

    #[cfg(target_os = "linux")]
    let (ready_listener, ready_socket_path) =
        prepare_kino_ready_listener(&kino_vsock_path, jail_uid).await?;

    let vm_name_owned = vm_name.to_string();
    let inner_for_task = Arc::clone(inner);
    #[cfg(target_os = "linux")]
    let join = tokio::spawn(async move {
        run_probe_worker_task(
            inner_for_task,
            vm_name_owned,
            run_id,
            jail_generation,
            jail_uid,
            ready_listener,
            ready_socket_path,
        )
        .await;
    });
    #[cfg(not(target_os = "linux"))]
    let join = tokio::spawn(async move {
        run_probe_worker_task(
            inner_for_task,
            vm_name_owned,
            run_id,
            jail_generation,
            kino_vsock_path,
            kino_vsock_port,
            jail_uid,
        )
        .await;
    });

    let mut tasks = inner.probe_tasks.lock().await;
    tasks.insert(vm_name.to_string(), VmProbeTask { join });
    Ok(())
}

pub(super) async fn stop_probe_worker(inner: &Inner, vm_name: &str) {
    let existing = {
        let mut tasks = inner.probe_tasks.lock().await;
        tasks.remove(vm_name)
    };

    if let Some(task) = existing {
        task.join.abort();
    }
}

pub(super) async fn start_terminal_worker(inner: &Arc<Inner>, vm_name: &str) -> Result<()> {
    let vm = {
        let states = inner.states.read().await;
        states.get(vm_name).cloned()
    }
    .ok_or_else(|| anyhow::anyhow!("vm {vm_name} not found for terminal worker"))?;
    let run_id = vm
        .details
        .as_ref()
        .and_then(|details| details.run_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("vm details missing run_id"))?;

    stop_terminal_worker(inner, vm_name).await;

    let vm_name_owned = vm_name.to_string();
    let inner_for_task = Arc::clone(inner);
    let join = tokio::spawn(async move {
        run_terminal_worker_task(inner_for_task, vm_name_owned, run_id).await;
    });

    let mut tasks = inner.terminal_tasks.lock().await;
    tasks.insert(vm_name.to_string(), VmTerminalTask { join });
    Ok(())
}

pub(super) async fn stop_terminal_worker(inner: &Inner, vm_name: &str) {
    let existing = {
        let mut tasks = inner.terminal_tasks.lock().await;
        tasks.remove(vm_name)
    };

    if let Some(task) = existing {
        task.join.abort();
    }
}

pub(super) async fn run_terminal_worker_task(inner: Arc<Inner>, vm_name: String, run_id: String) {
    let mut ready_seen = false;

    loop {
        let state = match current_terminal_state_for_vm(&inner, &vm_name, Some(&run_id)).await {
            Ok(Some(state)) => state,
            Ok(None) => break,
            Err(error) => {
                warn!(
                    error = %error,
                    vm = vm_name,
                    "failed to compute current terminal state"
                );
                break;
            }
        };

        if state.state == VmTerminalStateKind::Ready {
            ready_seen = true;
        }
        emit_terminal_state_update(&inner, state, false).await;

        let sleep_duration = if ready_seen {
            Duration::from_secs(TERMINAL_READY_POLL_INTERVAL_SECONDS)
        } else {
            Duration::from_millis(TERMINAL_PENDING_POLL_INTERVAL_MILLIS)
        };
        tokio::time::sleep(sleep_duration).await;
    }
}

pub(super) async fn publish_terminal_state_update(inner: &Inner, vm_name: &str, force: bool) {
    match current_terminal_state_for_vm(inner, vm_name, None).await {
        Ok(Some(state)) => emit_terminal_state_update(inner, state, force).await,
        Ok(None) => {}
        Err(error) => {
            warn!(error = %error, vm = vm_name, "failed to publish terminal state update");
        }
    }
}

pub(super) async fn emit_terminal_state_update(inner: &Inner, state: VmTerminalState, force: bool) {
    emit_terminal_state_update_to_channels(
        &inner.terminal_states,
        &inner.terminal_state_fingerprints,
        &inner.terminal_updates_tx,
        state,
        force,
    )
    .await;
}

pub(super) async fn emit_terminal_state_update_to_channels(
    terminal_states: &RwLock<BTreeMap<String, VmTerminalState>>,
    terminal_state_fingerprints: &Mutex<BTreeMap<String, String>>,
    terminal_updates: &broadcast::Sender<VmTerminalState>,
    state: VmTerminalState,
    force: bool,
) {
    let fingerprint = state.fingerprint();
    {
        let mut terminal_states = terminal_states.write().await;
        terminal_states.insert(state.vm_name.clone(), state.clone());
    }
    let should_send = {
        let mut fingerprints = terminal_state_fingerprints.lock().await;
        let changed = fingerprints
            .get(&state.vm_name)
            .map(|current| current != &fingerprint)
            .unwrap_or(true);
        if force || changed {
            fingerprints.insert(state.vm_name.clone(), fingerprint);
            true
        } else {
            false
        }
    };

    if should_send {
        // Cache first, then publish the targeted transition. The bridge wakes
        // inventory only after this report has entered its priority queue, so
        // the independent inventory builder cannot overtake it.
        let _ = terminal_updates.send(state);
    }
}

/// Filesystem path where cloud-hypervisor surfaces guest-initiated vsock
/// connections to `KINO_HOST_READY_PORT`. Cloud Hypervisor implements the
/// Firecracker-style hybrid vsock scheme: a guest connect to host CID 2 port
/// P is forwarded to the unix socket `<vsock-socket>_P` on the host, so the
/// agent must listen there — a host AF_VSOCK listener never sees it.
pub(super) fn kino_ready_socket_path(kino_vsock_path: &Path) -> PathBuf {
    let mut os = kino_vsock_path.as_os_str().to_owned();
    os.push(format!("_{KINO_HOST_READY_PORT}"));
    PathBuf::from(os)
}

#[cfg(target_os = "linux")]
pub(super) async fn prepare_kino_ready_listener(
    kino_vsock_path: &Path,
    jail_uid: u32,
) -> Result<(tokio::net::UnixListener, PathBuf)> {
    let ready_socket_path = kino_ready_socket_path(kino_vsock_path);
    let _ = tokio::fs::remove_file(&ready_socket_path).await;
    let listener = tokio::net::UnixListener::bind(&ready_socket_path).with_context(|| {
        format!(
            "bind Kino readiness listener at {}",
            ready_socket_path.display()
        )
    })?;
    if let Err(error) = activate_kino_ready_socket(&ready_socket_path, jail_uid).await {
        let _ = tokio::fs::remove_file(&ready_socket_path).await;
        return Err(error).context("activate Kino readiness socket ACL mask");
    }
    Ok((listener, ready_socket_path))
}

#[cfg(target_os = "linux")]
pub(super) async fn run_probe_worker_task(
    inner: Arc<Inner>,
    vm_name: String,
    run_id: String,
    jail_generation: String,
    jail_uid: u32,
    listener: tokio::net::UnixListener,
    ready_socket_path: PathBuf,
) {
    match inner.db.load_vm_probe_state(vm_name.clone()).await {
        Ok(Some(row)) if row.run_id == run_id => {
            if let Some(update) = probe_update_from_state_row(&row)
                && update.jail_generation == jail_generation
            {
                // A recovered durable snapshot is an internal readiness input.
                // Recovery must reseal and re-attest SSH before any external
                // projection is emitted.
                let _ = inner.kino_readiness_tx.send(update);
            }
        }
        Ok(_) => {}
        Err(error) => {
            warn!(error = %error, vm = vm_name, "failed to load persisted probe state");
        }
    }

    info!(
        vm = vm_name,
        vm_uid = jail_uid,
        path = %ready_socket_path.display(),
        "listening for guest-initiated Kino readiness pushes"
    );

    let mut interval = tokio::time::interval(Duration::from_secs(PROBE_POLL_INTERVAL_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut connection_task: Option<JoinHandle<()>> = None;

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        // Kino keeps a single persistent push connection; a
                        // new connection supersedes the previous one.
                        if let Some(task) = connection_task.take() {
                            task.abort();
                        }
                        let inner_for_task = Arc::clone(&inner);
                        let vm_name_for_task = vm_name.clone();
                        let run_id_for_task = run_id.clone();
                        let generation_for_task = jail_generation.clone();
                        connection_task = Some(tokio::spawn(async move {
                            if let Err(error) = handle_kino_ready_stream(
                                inner_for_task,
                                &vm_name_for_task,
                                &run_id_for_task,
                                &generation_for_task,
                                stream,
                            )
                            .await
                            {
                                warn!(
                                    error = %error,
                                    vm = vm_name_for_task,
                                    "Kino readiness push connection failed"
                                );
                            }
                        }));
                    }
                    Err(error) => {
                        warn!(
                            error = %error,
                            vm = vm_name,
                            "failed to accept Kino readiness push connection"
                        );
                    }
                }
            }
            _ = interval.tick() => {
                let should_continue = {
                    let states = inner.states.read().await;
                    match states.get(&vm_name) {
                        Some(vm) => {
                            matches!(
                                vm.state,
                                VmLifecycleState::CreatingVm
                                    | VmLifecycleState::BootingVm
                                    | VmLifecycleState::Running
                            ) && vm.details.as_ref().is_some_and(|details| {
                                details.run_id.as_deref() == Some(run_id.as_str())
                                    && details.jail_generation.as_deref()
                                        == Some(jail_generation.as_str())
                            })
                        }
                        None => false,
                    }
                };
                if !should_continue {
                    break;
                }
            }
        }
    }

    if let Some(task) = connection_task.take() {
        task.abort();
    }
    let _ = tokio::fs::remove_file(&ready_socket_path).await;
}

#[cfg(target_os = "linux")]
pub(super) async fn activate_kino_ready_socket(path: &Path, jail_uid: u32) -> Result<()> {
    use rustix::fs::{Mode, OFlags, ResolveFlags, openat2};
    use std::os::fd::AsRawFd as _;
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};

    // The run directory's default ACL names the unique VM UID. UnixListener
    // creation can collapse that ACL's mask under the service's 0077 umask, so
    // reactivate only the group-class mask. No permission is granted to other.
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .context("Kino readiness socket path has no file name")?;
    let parent_path = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .context("Kino readiness socket path has no parent")?;
    let parent = openat2(
        rustix::fs::CWD,
        parent_path,
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::NO_MAGICLINKS | ResolveFlags::NO_SYMLINKS,
    )
    .context("pin Kino readiness socket parent")?;
    let parent_stat = rustix::fs::fstat(&parent)?;
    anyhow::ensure!(
        rustix::fs::FileType::from_raw_mode(parent_stat.st_mode) == rustix::fs::FileType::Directory
            && parent_stat.st_uid == jail_uid
            && parent_stat.st_gid == jail_uid,
        "Kino readiness socket parent identity changed"
    );
    let socket = openat2(
        &parent,
        file_name,
        OFlags::PATH | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_XDEV,
    )
    .context("pin Kino readiness socket")?;
    let before = rustix::fs::fstat(&socket)?;
    anyhow::ensure!(
        rustix::fs::FileType::from_raw_mode(before.st_mode) == rustix::fs::FileType::Socket
            && before.st_uid != 0
            && before.st_uid != jail_uid
            && before.st_nlink == 1,
        "Kino readiness socket identity is unsafe"
    );
    let pinned_path = PathBuf::from(format!("/proc/self/fd/{}", socket.as_raw_fd()));
    tokio::fs::set_permissions(&pinned_path, std::fs::Permissions::from_mode(0o760))
        .await
        .with_context(|| format!("set permissions on {}", path.display()))?;
    let after = rustix::fs::fstat(&socket)?;
    anyhow::ensure!(
        before.st_dev == after.st_dev
            && before.st_ino == after.st_ino
            && before.st_uid == after.st_uid
            && before.st_gid == after.st_gid
            && after.st_nlink == 1,
        "pinned Kino readiness socket identity changed"
    );
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .with_context(|| format!("inspect {} after permission update", path.display()))?;
    anyhow::ensure!(
        metadata.file_type().is_socket(),
        "Kino readiness path is not a Unix socket"
    );
    anyhow::ensure!(
        metadata.dev() == after.st_dev
            && metadata.ino() == after.st_ino
            && metadata.uid() == after.st_uid
            && metadata.gid() == after.st_gid,
        "Kino readiness socket path was replaced"
    );
    anyhow::ensure!(
        metadata.nlink() == 1,
        "Kino readiness socket must have exactly one link"
    );
    anyhow::ensure!(
        metadata.mode() & 0o077 == 0o060,
        "Kino readiness socket ACL mask or other-user permissions are unsafe"
    );
    Ok(())
}

pub(super) fn probe_state_row(update: &ProbeUpdateEnvelope) -> Result<VmProbeStateRow> {
    let summary_json = serde_json::to_string(&update.summary).context("serialize probe summary")?;
    let snapshot_json =
        serde_json::to_string(update).context("serialize current probe snapshot")?;
    Ok(VmProbeStateRow {
        vm_name: update.vm_name.clone(),
        run_id: update.run_id.clone(),
        fingerprint: update.fingerprint.clone(),
        collection_state: match &update.collection_state {
            ProbeCollectionState::Ok => "ok".to_string(),
            ProbeCollectionState::Error => "error".to_string(),
        },
        collection_error: update.collection_error.clone(),
        summary_json,
        snapshot_json,
        generated_at_ms: update.generated_at_ms,
        updated_at_ms: now_unix_ms(),
    })
}

#[cfg(target_os = "linux")]
pub(super) fn probe_update_from_state_row(row: &VmProbeStateRow) -> Option<ProbeUpdateEnvelope> {
    serde_json::from_str::<ProbeUpdateEnvelope>(&row.snapshot_json).ok()
}

pub(super) async fn request_jailerd(
    inner: &Inner,
    request: JailerRequest,
) -> Result<JailerResponse> {
    let timeout_duration = Duration::from_secs(inner.jailer_request_timeout_seconds);
    request_jailerd_with_timeout(inner, request, timeout_duration).await
}

pub(super) async fn request_jailerd_with_timeout(
    inner: &Inner,
    request: JailerRequest,
    timeout_duration: Duration,
) -> Result<JailerResponse> {
    let socket = inner.jailer_socket.clone();
    timeout(timeout_duration, async move {
        let mut client = AsyncSeqpacketClient::connect(&socket)
            .with_context(|| format!("connect to intar-jailerd at {}", socket.display()))?;
        client
            .request(request)
            .await
            .context("send intar-jailerd request")
    })
    .await
    .with_context(|| {
        format!(
            "intar-jailerd request timed out after {} milliseconds",
            timeout_duration.as_millis()
        )
    })?
}
