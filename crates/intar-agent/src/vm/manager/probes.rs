use super::*;

#[cfg(any(test, target_os = "linux"))]
use intar_kino_proto::host::{DecodeError, Decoded, decode};
#[cfg(target_os = "linux")]
use intar_kino_proto::kino_v2::MAX_FRAME_BYTES;

#[cfg(not(target_os = "linux"))]
pub(super) async fn run_probe_worker_task(inner: Arc<Inner>, target: ReportTarget) {
    let ReportTarget {
        vm_name,
        run_id,
        jail_generation,
        ..
    } = target;
    warn!(
        vm = vm_name,
        "the guest report listener is only available on Linux"
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

/// The VM error of a guest that failed before SSH was up; the guest's own
/// text is admin-only and stays in `lab.failure`.
#[cfg(any(test, target_os = "linux"))]
pub(super) const GUEST_FAILED_BEFORE_SSH: &str = "the guest failed before SSH was up";

/// The identity a report listener is for.
#[derive(Clone, Debug)]
pub(super) struct ReportTarget {
    pub(super) vm_name: String,
    pub(super) run_id: String,
    pub(super) jail_generation: String,
    /// SHA-256 (hex) of this run's `boot.json`.
    #[cfg(any(test, target_os = "linux"))]
    pub(super) boot_sha256: String,
}

/// One kino.v2 frame body, read for `target`. `None` is a stale report (a
/// woken guest's build-time Kino), which is dropped. A Kino of another
/// guest contract is a failure the VM never recovers from.
#[cfg(any(test, target_os = "linux"))]
pub(super) fn read_guest_frame(
    target: &ReportTarget,
    body: &[u8],
    first_report_ms: Option<u64>,
) -> Result<Option<GuestUpdate>> {
    let received_at_ms = now_unix_ms();
    let update = |ssh_ready, failed, ssh_host_keys_openssh, lab| GuestUpdate {
        vm_name: target.vm_name.clone(),
        run_id: target.run_id.clone(),
        jail_generation: target.jail_generation.clone(),
        ssh_ready,
        failed,
        ssh_host_keys_openssh,
        lab,
        first_report_ms,
        received_at_ms,
    };
    match decode(body, &target.boot_sha256) {
        Ok(Decoded::Stale) => Ok(None),
        Ok(Decoded::Report(report)) => {
            let report = *report;
            // Host keys count only once SSH is up.
            let keys = if report.ssh_ready {
                report.ssh_host_keys_openssh
            } else {
                Vec::new()
            };
            // The guest's failure text is admin-only: it stays in the lab.
            Ok(Some(update(
                report.ssh_ready,
                report.failed.map(|_| GUEST_FAILED_BEFORE_SSH.to_owned()),
                keys,
                report.lab,
            )))
        }
        Err(error @ DecodeError::ContractMismatch(_)) => Ok(Some(update(
            false,
            Some(error.to_string()),
            Vec::new(),
            contract_mismatch_lab(&error),
        ))),
        Err(error) => Err(error.into()),
    }
}

#[cfg(any(test, target_os = "linux"))]
fn contract_mismatch_lab(error: &DecodeError) -> VmLabV1 {
    VmLabV1 {
        state: intar_contracts::bridge_v9::LabState::Failed,
        kino_version: String::new(),
        ready: Vec::new(),
        tasks: Vec::new(),
        verify: None,
        timings_ms: BTreeMap::new(),
        failure: Some(error.to_string()),
    }
}

#[cfg(target_os = "linux")]
pub(super) async fn handle_guest_report_stream(
    inner: Arc<Inner>,
    target: &ReportTarget,
    first_report_ms: &std::sync::Mutex<Option<u64>>,
    mut stream: tokio::net::UnixStream,
) -> Result<()> {
    use std::io::ErrorKind;
    use tokio::io::AsyncReadExt as _;

    loop {
        let mut len_buf = [0_u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error).context("failed to read a guest report length"),
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        anyhow::ensure!(len > 0, "guest report frame was empty");
        anyhow::ensure!(
            len <= MAX_FRAME_BYTES,
            "guest report frame too large: {len} bytes"
        );
        let mut frame = vec![0_u8; len];
        stream
            .read_exact(&mut frame)
            .await
            .context("failed to read a guest report frame")?;
        let first = first_report_ms.lock().map(|value| *value).unwrap_or(None);
        let Some(mut update) = read_guest_frame(target, &frame, first)? else {
            debug!(vm = target.vm_name, "dropped a stale guest report");
            continue;
        };
        if update.first_report_ms.is_none() {
            update.first_report_ms = ms_since_vmm_start(&inner, &target.vm_name);
            if let Ok(mut value) = first_report_ms.lock() {
                *value = update.first_report_ms;
            }
        }
        apply_guest_update(&inner, update).await?;
    }
}

/// Record when the VMM was asked to boot, for `first_report_ms`.
pub(super) fn mark_vmm_started(inner: &Inner, vm_name: &str) {
    if let Ok(mut started) = inner.vmm_started_at.lock() {
        started.insert(vm_name.to_owned(), Instant::now());
    }
}

#[cfg(target_os = "linux")]
fn ms_since_vmm_start(inner: &Inner, vm_name: &str) -> Option<u64> {
    let started = inner.vmm_started_at.lock().ok()?.get(vm_name).copied()?;
    u64::try_from(started.elapsed().as_millis()).ok()
}

/// Hand one report to the boot waiter, keep its lab, and project it once the
/// VM is past its ready boundary.
#[cfg(target_os = "linux")]
pub(super) async fn apply_guest_update(inner: &Arc<Inner>, update: GuestUpdate) -> Result<()> {
    let vm_name = update.vm_name.as_str();
    let is_current = |states: &BTreeMap<String, VmStatusResponse>| {
        states.get(vm_name).is_some_and(|vm| {
            vm.details.as_ref().is_some_and(|details| {
                details.run_id.as_deref() == Some(update.run_id.as_str())
                    && details.jail_generation.as_deref() == Some(update.jail_generation.as_str())
            })
        })
    };
    anyhow::ensure!(
        is_current(&*inner.states.read().await),
        "dropping a guest report for stale run/generation {}/{} of vm {vm_name}",
        update.run_id,
        update.jail_generation
    );
    if update.ssh_ready {
        stage_vm_ssh_host_keys(
            inner,
            vm_name,
            &update.jail_generation,
            update.ssh_host_keys_openssh.clone(),
        )
        .await;
    }
    // Always wake the generation-fenced launch waiter internally. Projection
    // is permitted only for an already committed steady VM; the first ready
    // report is published through the atomic ready transaction instead.
    let _ = inner.guest_reports_tx.send(update.clone());
    let committed = {
        let states = inner.states.read().await;
        anyhow::ensure!(
            is_current(&states),
            "dropping a guest report after the generation changed"
        );
        let Some(vm) = states.get(vm_name) else {
            return Ok(());
        };
        let committed = vm.state == VmLifecycleState::Running
            && vm.details.as_ref().is_some_and(|details| {
                details.cpu_runtime.as_ref().is_some_and(|runtime| {
                    Some(runtime.quota.cpu_millis) == details.cpu_millis
                        && runtime.attestation.as_ref().is_some_and(|proof| {
                            proof.quota == runtime.quota
                                && proof.cpu_max == runtime.quota.cpu_max()
                                && proof.cpu_max_burst == 0
                                && proof.verified_at_unix_ms > 0
                        })
                })
            });
        // Hold the read fence while persisting, so a concurrent generation
        // replacement cannot be overwritten by this lab. A pre-ready lab is
        // persisted by the ready transaction itself.
        if committed {
            inner
                .db
                .upsert_vm_and_lab(vm.to_db_row(), lab_row(&update)?)
                .await
                .context("atomically persist a post-ready lab")?;
        }
        committed
    };
    record_vm_check_passes(inner, vm_name, &update).await;
    if committed {
        let _ = inner.lab_updates_tx.send(update);
    }
    Ok(())
}

/// Keeps each task's first pass beside the VM's artifacts, where the replay
/// renderer turns it into a marker. A failure costs only the markers.
#[cfg(target_os = "linux")]
async fn record_vm_check_passes(inner: &Inner, vm_name: &str, update: &GuestUpdate) {
    let artifacts_dir = {
        let states = inner.states.read().await;
        states
            .get(vm_name)
            .and_then(|vm| vm.details.as_ref())
            .and_then(|details| details.spool_dir.as_deref())
            .map(|spool_dir| Path::new(spool_dir).join("artifacts"))
    };
    let Some(artifacts_dir) = artifacts_dir else {
        return;
    };
    if let Err(error) =
        crate::vm::check_passes::record_check_passes(&artifacts_dir, &update.lab.tasks).await
    {
        warn!(error = %error, vm = vm_name, "failed to record check passes");
    }
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
    let target = ReportTarget {
        vm_name: vm_name.to_owned(),
        run_id,
        jail_generation,
        #[cfg(any(test, target_os = "linux"))]
        boot_sha256: details
            .boot_sha256
            .clone()
            .context("vm details missing the boot.json digest")?,
    };
    #[cfg(target_os = "linux")]
    let replay = details.ssh_host_keys_openssh.clone();
    let jail_uid = details
        .jail_uid
        .ok_or_else(|| anyhow::anyhow!("vm details missing jail_uid"))?;

    stop_probe_worker(inner, vm_name).await;

    #[cfg(target_os = "linux")]
    let (ready_listener, ready_socket_path) =
        prepare_kino_ready_listener(&kino_vsock_path, jail_uid).await?;

    let inner_for_task = Arc::clone(inner);
    #[cfg(target_os = "linux")]
    let join = tokio::spawn(async move {
        run_probe_worker_task(
            inner_for_task,
            target,
            replay,
            jail_uid,
            ready_listener,
            ready_socket_path,
        )
        .await;
    });
    #[cfg(not(target_os = "linux"))]
    let join = tokio::spawn(async move {
        let _ = (kino_vsock_path, jail_uid);
        run_probe_worker_task(inner_for_task, target).await;
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
/// connections to the guest contract's `REPORT_PORT`. Cloud Hypervisor implements the
/// Firecracker-style hybrid vsock scheme: a guest connect to host CID 2 port
/// P is forwarded to the unix socket `<vsock-socket>_P` on the host, so the
/// agent must listen there — a host AF_VSOCK listener never sees it.
pub(super) fn kino_ready_socket_path(kino_vsock_path: &Path) -> PathBuf {
    let mut os = kino_vsock_path.as_os_str().to_owned();
    os.push(format!("_{}", intar_contracts::guest::REPORT_PORT));
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
    target: ReportTarget,
    replay_host_keys: Vec<String>,
    jail_uid: u32,
    listener: tokio::net::UnixListener,
    ready_socket_path: PathBuf,
) {
    let first_report_ms = Arc::new(std::sync::Mutex::new(None));
    match inner.db.load_vm_lab(target.vm_name.clone()).await {
        Ok(Some(row))
            if row.run_id == target.run_id && row.jail_generation == target.jail_generation =>
        {
            let first = row
                .first_report_ms
                .and_then(|value| u64::try_from(value).ok());
            if let Ok(mut value) = first_report_ms.lock() {
                *value = first;
            }
            // A VM whose host keys were staged had SSH up before the restart.
            // The persisted lab is only an internal readiness input: recovery
            // reseals and re-authenticates SSH before anything is projected.
            if !replay_host_keys.is_empty()
                && let Ok(lab) = serde_json::from_str::<VmLabV1>(&row.lab_json)
            {
                let _ = inner.guest_reports_tx.send(GuestUpdate {
                    vm_name: target.vm_name.clone(),
                    run_id: target.run_id.clone(),
                    jail_generation: target.jail_generation.clone(),
                    ssh_ready: true,
                    failed: None,
                    ssh_host_keys_openssh: replay_host_keys,
                    lab,
                    first_report_ms: first,
                    received_at_ms: now_unix_ms(),
                });
            }
        }
        Ok(_) => {}
        Err(error) => {
            warn!(error = %error, vm = target.vm_name, "failed to load the persisted lab");
        }
    }

    info!(
        vm = target.vm_name,
        vm_uid = jail_uid,
        path = %ready_socket_path.display(),
        "listening for guest-initiated Kino reports"
    );

    let mut interval = tokio::time::interval(Duration::from_secs(PROBE_POLL_INTERVAL_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut connection_task: Option<JoinHandle<()>> = None;

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        // Kino keeps a single persistent report connection; a
                        // new connection supersedes the previous one.
                        if let Some(task) = connection_task.take() {
                            task.abort();
                        }
                        let inner_for_task = Arc::clone(&inner);
                        let target_for_task = target.clone();
                        let first_for_task = Arc::clone(&first_report_ms);
                        connection_task = Some(tokio::spawn(async move {
                            if let Err(error) = handle_guest_report_stream(
                                inner_for_task,
                                &target_for_task,
                                &first_for_task,
                                stream,
                            )
                            .await
                            {
                                warn!(
                                    error = %error,
                                    vm = target_for_task.vm_name,
                                    "guest report connection failed"
                                );
                            }
                        }));
                    }
                    Err(error) => {
                        warn!(
                            error = %error,
                            vm = target.vm_name,
                            "failed to accept a guest report connection"
                        );
                    }
                }
            }
            _ = interval.tick() => {
                let should_continue = {
                    let states = inner.states.read().await;
                    match states.get(&target.vm_name) {
                        Some(vm) => {
                            matches!(
                                vm.state,
                                VmLifecycleState::CreatingVm
                                    | VmLifecycleState::BootingVm
                                    | VmLifecycleState::Running
                            ) && vm.details.as_ref().is_some_and(|details| {
                                details.run_id.as_deref() == Some(target.run_id.as_str())
                                    && details.jail_generation.as_deref()
                                        == Some(target.jail_generation.as_str())
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

pub(super) fn lab_row(update: &GuestUpdate) -> Result<VmLabRow> {
    Ok(VmLabRow {
        vm_name: update.vm_name.clone(),
        run_id: update.run_id.clone(),
        jail_generation: update.jail_generation.clone(),
        lab_json: serde_json::to_string(&update.lab).context("serialize the VM's lab")?,
        first_report_ms: update
            .first_report_ms
            .and_then(|value| i64::try_from(value).ok()),
        updated_at_ms: now_unix_ms(),
    })
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
