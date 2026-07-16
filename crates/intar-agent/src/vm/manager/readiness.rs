use super::*;

pub(super) fn boot_capacity_retry_delay(attempt: u32) -> Duration {
    let exponent = attempt.min(3);
    let base_ms = 100_u64.saturating_mul(1_u64 << exponent);
    let mut jitter_bytes = [0_u8; 2];
    let _ = getrandom_fill(&mut jitter_bytes);
    let jitter_ms = u64::from(u16::from_le_bytes(jitter_bytes)) % 201;
    Duration::from_millis(base_ms.saturating_add(jitter_ms).min(1_000))
}

pub(super) async fn wait_for_scenario_runtime_ready(
    inner: &Arc<Inner>,
    vm_name: &str,
    ch: &ChClient,
    details: &VmDetails,
    mut updates: broadcast::Receiver<ProbeUpdateEnvelope>,
) -> Result<ProbeUpdateEnvelope> {
    let run_id = details
        .run_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("vm details missing run_id"))?;
    let jail_generation = details
        .jail_generation
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("vm details missing jail_generation"))?;
    let kino_vsock_path = details
        .kino_vsock_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("vm details missing kino_vsock_path"))?;
    let cpu_millis = details
        .cpu_millis
        .ok_or_else(|| anyhow::anyhow!("vm details missing cpu_millis"))?;
    let ready_timeout = scenario_runtime_ready_timeout(cpu_millis)?;
    let mut saw_kino_vsock_socket = false;
    let mut process_interval = tokio::time::interval(Duration::from_millis(
        SCENARIO_READY_PROCESS_POLL_INTERVAL_MILLIS,
    ));
    process_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Consume Tokio's immediate first tick: vm.boot has just succeeded and the
    // readiness push is the primary signal, so neither liveness path needs to
    // steal quota from the VMM at t=0.
    process_interval.tick().await;
    let mut ch_interval = tokio::time::interval(Duration::from_secs(
        SCENARIO_READY_API_POLL_INTERVAL_SECONDS,
    ));
    ch_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ch_interval.tick().await;
    let mut last_error = None;

    let wait_result = timeout(ready_timeout, async {
        loop {
            ensure_create_not_deleted(inner, vm_name).await?;

            tokio::select! {
                update = updates.recv() => {
                    match update {
                        Ok(update)
                            if update.vm_name == vm_name
                                && update.run_id == run_id
                                && update.jail_generation == jail_generation => {
                            if update.collection_state == ProbeCollectionState::Ok {
                                ensure_scenario_runtime_process_live(vm_name, details).await?;
                                return Ok(update);
                            }
                            last_error = Some(anyhow::anyhow!(
                                update.collection_error.unwrap_or_else(|| "Kino readiness push reported an error".to_string())
                            ));
                        }
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            debug!(vm = vm_name, skipped, "lagged while waiting for Kino readiness push");
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            anyhow::bail!("Kino readiness update channel closed");
                        }
                    }
                }
                _ = process_interval.tick() => {
                    ensure_scenario_runtime_process_live(vm_name, details).await?;

                    let socket_exists = kino_vsock_path.exists();
                    if socket_exists && !saw_kino_vsock_socket {
                        info!(
                            vm = vm_name,
                            path = %kino_vsock_path.display(),
                            "cloud-hypervisor created Kino vsock socket"
                        );
                        saw_kino_vsock_socket = true;
                    }

                }
                _ = ch_interval.tick() => {
                    match timeout(
                        Duration::from_secs(SCENARIO_READY_API_PROBE_TIMEOUT_SECONDS),
                        ch.vm_info(),
                    )
                    .await
                    {
                        Ok(Ok(info)) => {
                            if matches!(info.state, cloud_hypervisor_client::VmState::Shutdown) {
                                anyhow::bail!("scenario vm shut down before runtime became ready");
                            }
                        }
                        Ok(Err(cloud_hypervisor_client::Error::HttpStatus { status: 404, .. })) => {
                            anyhow::bail!("scenario vm disappeared before runtime became ready");
                        }
                        Ok(Err(error)) => {
                            debug!(
                                vm = vm_name,
                                error = %error,
                                "cloud-hypervisor vm_info failed while waiting for scenario readiness"
                            );
                        }
                        Err(_) => {
                            debug!(
                                vm = vm_name,
                                timeout_seconds = SCENARIO_READY_API_PROBE_TIMEOUT_SECONDS,
                                "cloud-hypervisor vm_info timed out while waiting for scenario readiness"
                            );
                        }
                    }
                }
            }
        }
    })
    .await;

    match wait_result {
        Ok(result) => result,
        Err(_) => {
            let error = last_error.unwrap_or_else(|| {
                anyhow::anyhow!(
                    "timed out waiting for Kino readiness push on {}",
                    kino_ready_socket_path(&kino_vsock_path).display()
                )
            });
            Err(error).context(scenario_runtime_timeout_context(
                &kino_vsock_path,
                saw_kino_vsock_socket,
                ready_timeout,
            ))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ScenarioRuntimeProcessLiveness {
    Alive,
    Dead(String),
    Inconclusive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ScenarioRuntimeProcessObservation {
    Present { state: char, start_time_ticks: u64 },
    Missing,
    Unavailable,
}

// `InspectVm` is an adoption authority, not a health-poll endpoint: jailerd
// deliberately quarantines a healthy unit when its API ping cannot prove the
// persisted identity. Poll the already-persisted process identity here so a
// transient API stall stays retryable while an exited/reused VMM fails fast.
// The caller's existing typed StopVm/DestroyVm path still owns all cleanup;
// this check never signals a persisted numeric PID.
pub(super) async fn ensure_scenario_runtime_process_live(
    vm_name: &str,
    details: &VmDetails,
) -> Result<()> {
    match observe_scenario_runtime_process_liveness(vm_name, details).await {
        ScenarioRuntimeProcessLiveness::Alive | ScenarioRuntimeProcessLiveness::Inconclusive => {
            Ok(())
        }
        ScenarioRuntimeProcessLiveness::Dead(reason) => {
            anyhow::bail!("scenario VMM became unavailable before runtime readiness: {reason}")
        }
    }
}

pub(super) async fn observe_scenario_runtime_process_liveness(
    vm_name: &str,
    details: &VmDetails,
) -> ScenarioRuntimeProcessLiveness {
    let Some(pid) = details.ch_pid else {
        return ScenarioRuntimeProcessLiveness::Inconclusive;
    };

    let proc_stat_path = PathBuf::from(format!("/proc/{pid}/stat"));
    let observation = match tokio::fs::read_to_string(&proc_stat_path).await {
        Ok(value) => match parse_linux_proc_stat(&value) {
            Some((state, start_time_ticks)) => ScenarioRuntimeProcessObservation::Present {
                state,
                start_time_ticks,
            },
            None => {
                debug!(
                    vm = vm_name,
                    pid,
                    path = %proc_stat_path.display(),
                    "could not parse scenario VMM process identity"
                );
                ScenarioRuntimeProcessObservation::Unavailable
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A cross-UID process can be hidden from /proc by hidepid=2 or
            // ProtectProc=invisible. `kill(pid, 0)` does not send a signal;
            // it only distinguishes an absent PID (ESRCH) from a process
            // which exists but is either visible or permission-protected.
            let existence = i32::try_from(pid)
                .ok()
                .and_then(rustix::process::Pid::from_raw)
                .map(rustix::process::test_kill_process);
            if let Some(Err(error)) = existence.as_ref()
                && !matches!(*error, rustix::io::Errno::SRCH | rustix::io::Errno::PERM)
            {
                debug!(
                    vm = vm_name,
                    pid,
                    error = %error,
                    "could not disambiguate hidden scenario VMM process identity"
                );
            }
            classify_missing_proc_entry(existence)
        }
        Err(error) => {
            debug!(
                vm = vm_name,
                pid,
                error = %error,
                "could not read scenario VMM process identity"
            );
            ScenarioRuntimeProcessObservation::Unavailable
        }
    };

    classify_scenario_runtime_process_liveness(pid, details.ch_start_time_ticks, observation)
}

pub(super) fn classify_missing_proc_entry(
    existence: Option<rustix::io::Result<()>>,
) -> ScenarioRuntimeProcessObservation {
    match existence {
        Some(Err(rustix::io::Errno::SRCH)) => ScenarioRuntimeProcessObservation::Missing,
        Some(Ok(())) | Some(Err(_)) | None => ScenarioRuntimeProcessObservation::Unavailable,
    }
}

pub(super) fn classify_scenario_runtime_process_liveness(
    pid: u32,
    expected_start_time_ticks: Option<u64>,
    observation: ScenarioRuntimeProcessObservation,
) -> ScenarioRuntimeProcessLiveness {
    let ScenarioRuntimeProcessObservation::Present {
        state,
        start_time_ticks,
    } = observation
    else {
        return match observation {
            ScenarioRuntimeProcessObservation::Missing => {
                ScenarioRuntimeProcessLiveness::Dead(format!("VMM pid {pid} exited"))
            }
            ScenarioRuntimeProcessObservation::Unavailable => {
                ScenarioRuntimeProcessLiveness::Inconclusive
            }
            ScenarioRuntimeProcessObservation::Present { .. } => unreachable!(),
        };
    };

    if matches!(state, 'Z' | 'X' | 'x') {
        return ScenarioRuntimeProcessLiveness::Dead(format!(
            "VMM pid {pid} is no longer executable (process state {state})"
        ));
    }
    let Some(expected) = expected_start_time_ticks else {
        return ScenarioRuntimeProcessLiveness::Inconclusive;
    };
    if expected != start_time_ticks {
        return ScenarioRuntimeProcessLiveness::Dead(format!(
            "VMM pid {pid} was reused (expected start time {expected}, observed {start_time_ticks})"
        ));
    }
    ScenarioRuntimeProcessLiveness::Alive
}

pub(super) fn parse_linux_proc_stat(value: &str) -> Option<(char, u64)> {
    let (_, fields) = value.rsplit_once(") ")?;
    let mut fields = fields.split_ascii_whitespace();
    let state = fields.next()?.chars().next()?;
    let start_time_ticks = fields.nth(18)?.parse().ok()?;
    Some((state, start_time_ticks))
}

pub(super) async fn stop_booting_vm(inner: &Arc<Inner>, vm_name: &str) {
    let details = {
        let states = inner.states.read().await;
        states
            .get(vm_name)
            .and_then(|vm| vm.details.as_ref())
            .cloned()
    };

    if let Some(details) = details.as_ref() {
        stop_cloud_hypervisor(inner, details, vm_name).await;
    }
}

pub(super) async fn cleanup_jailed_vm_by_logical_id(
    inner: &Inner,
    run_id: &str,
    vm_name: &str,
) -> Result<()> {
    let selector = VmIdentityRequest::by_logical_id(
        ValidatedId::parse(run_id.to_owned()).context("validate logical cleanup run ID")?,
        ValidatedId::parse(vm_name.to_owned()).context("validate logical cleanup VM ID")?,
    );
    cleanup_jailed_vm_by_selector(inner, selector).await
}

pub(super) async fn cleanup_jailed_vm_by_selector(
    inner: &Inner,
    selector: VmIdentityRequest,
) -> Result<()> {
    let stop_error =
        jailer_vm_selector_request(inner, selector.clone(), JailerIdentityOperation::Stop)
            .await
            .err()
            .map(|error| format!("logical VM stop request failed: {error:#}"));

    // Always follow StopVm with DestroyVm, including after a not-found stop.
    // Both operations resolve the same typed (run_id, vm_id) selector, and a
    // not-found response is an idempotent success. Avoid InspectVm here:
    // inspection is an adoption/liveness operation whose API-ping checks may
    // quarantine a partially launched VM before cleanup can drain it.
    let destroy_error =
        jailer_vm_selector_request(inner, selector, JailerIdentityOperation::Destroy)
            .await
            .err()
            .map(|error| format!("logical VM destroy request failed: {error:#}"));

    match (stop_error, destroy_error) {
        (None, None) => Ok(()),
        (Some(stop), None) => anyhow::bail!("{stop}"),
        (None, Some(destroy)) => anyhow::bail!("{destroy}"),
        (Some(stop), Some(destroy)) => anyhow::bail!("{stop}; {destroy}"),
    }
}

pub(super) async fn cleanup_tracked_vm(
    inner: &Inner,
    name: &str,
    require_expired: bool,
) -> Result<CleanupOutcome> {
    cleanup_tracked_vm_with_mode(inner, name, require_expired, CleanupMode::ArchiveArtifacts).await
}

pub(super) async fn cleanup_tracked_vm_local_only(
    inner: &Inner,
    name: &str,
) -> Result<CleanupOutcome> {
    cleanup_tracked_vm_with_mode(inner, name, false, CleanupMode::LocalOnly).await
}

pub(super) fn spawn_vm_cleanup_task(inner: Arc<Inner>, name: String, require_expired: bool) {
    tokio::spawn(async move {
        match cleanup_tracked_vm(&inner, &name, require_expired).await {
            Ok(CleanupOutcome::Deleted | CleanupOutcome::Missing) => {}
            Ok(CleanupOutcome::SkippedNotExpired) => {
                warn!(
                    vm = name,
                    "skipped queued vm cleanup because the lease is still active"
                );
            }
            Err(error) => {
                warn!(error = %error, vm = name, "queued vm cleanup failed");
            }
        }
    });
}

pub(super) async fn cleanup_tracked_vm_with_mode(
    inner: &Inner,
    name: &str,
    require_expired: bool,
    cleanup_mode: CleanupMode,
) -> Result<CleanupOutcome> {
    let _cleanup_guard = acquire_vm_cleanup_lock(inner, name).await;
    let vm = {
        let states = inner.states.read().await;
        states.get(name).cloned()
    };
    let Some(vm) = vm else {
        return Ok(CleanupOutcome::Missing);
    };

    if require_expired && !vm.is_expired(now_unix_s()) {
        return Ok(CleanupOutcome::SkippedNotExpired);
    }

    if cleanup_mode == CleanupMode::ArchiveArtifacts {
        set_state(inner, &vm.name, VmLifecycleState::DeletingVm).await;
    }

    if cleanup_mode == CleanupMode::LocalOnly {
        teardown_vm_runtime(inner, &vm).await;
        // Serialize the privileged release and durable local removal for every
        // VM in a run. Without this guard, two concurrent cleanups can both
        // observe the other tracked VM and both skip the shared run-network
        // destroy. Holding it until the SQLite row is removed makes the next
        // cleanup observe the completed predecessor, while a queued sibling
        // that is not being deleted still keeps the network alive.
        let _run_cleanup_guard = acquire_vm_run_cleanup_lock(inner, &vm).await;
        if let Err(e) = release_jailed_runtime(inner, &vm)
            .await
            .context("release jailed VM runtime during local cleanup")
        {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
        if let Err(e) = local_cleanup_tracked_vm(inner, &vm, true).await {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
        return Ok(CleanupOutcome::Deleted);
    }

    let prepared = match prepare_vm_for_delete(inner, &vm).await {
        Ok(prepared) => prepared,
        Err(e) => {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
    };

    // Artifact capture and VMM shutdown can proceed concurrently, but the
    // generation/network release decision and local state removal must be one
    // ordered per-run operation. Failed release/archive work leaves the VM row
    // tracked, so a later retry still protects or removes the shared network.
    let _run_cleanup_guard = acquire_vm_run_cleanup_lock(inner, &vm).await;
    if let Err(e) = release_jailed_runtime(inner, &vm).await {
        let message = error_chain_to_string(&e);
        mark_vm_delete_failed(inner, &vm.name, message).await;
        return Err(e);
    }

    if inner.bridge.enabled {
        set_state(inner, &vm.name, VmLifecycleState::ArchivingArtifacts).await;
        if let Err(e) = queue_archive_job(inner, &prepared).await {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
        if let Err(e) = local_cleanup_tracked_vm(inner, &vm, false).await {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
        return Ok(CleanupOutcome::Deleted);
    }

    if let Err(e) = local_cleanup_tracked_vm(inner, &vm, true).await {
        let message = error_chain_to_string(&e);
        mark_vm_delete_failed(inner, &vm.name, message).await;
        return Err(e);
    }
    Ok(CleanupOutcome::Deleted)
}

pub(super) async fn reconcile_tracked_vm_on_startup(
    inner: &Arc<Inner>,
    name: &str,
) -> Result<StartupReconcileOutcome> {
    let vm = {
        let states = inner.states.read().await;
        states.get(name).cloned()
    };
    let Some(vm) = vm else {
        return Ok(StartupReconcileOutcome::DroppedStale);
    };

    match detect_tracked_vm_runtime(inner, &vm).await? {
        TrackedVmRuntimeStatus::Live(live_state) => {
            if should_resume_live_vm_on_startup(vm.state) {
                resume_tracked_vm_on_startup(inner, vm, live_state).await?;
                Ok(StartupReconcileOutcome::ResumingReadiness)
            } else {
                let cleanup_mode = startup_cleanup_mode(&vm);
                match cleanup_mode {
                    StartupCleanupMode::Archive => {
                        let _ = cleanup_tracked_vm(inner, &vm.name, false).await?;
                        Ok(StartupReconcileOutcome::ArchivedStale)
                    }
                    StartupCleanupMode::DropLocal => {
                        let _ = cleanup_tracked_vm_local_only(inner, &vm.name).await?;
                        Ok(StartupReconcileOutcome::DroppedStale)
                    }
                }
            }
        }
        TrackedVmRuntimeStatus::Dead => {
            let cleanup_mode = startup_cleanup_mode(&vm);
            match cleanup_mode {
                StartupCleanupMode::Archive => {
                    let _ = cleanup_tracked_vm(inner, &vm.name, false).await?;
                    Ok(StartupReconcileOutcome::ArchivedStale)
                }
                StartupCleanupMode::DropLocal => {
                    let _ = cleanup_tracked_vm_local_only(inner, &vm.name).await?;
                    Ok(StartupReconcileOutcome::DroppedStale)
                }
            }
        }
        TrackedVmRuntimeStatus::Inconclusive => {
            let details = vm.details.as_ref();
            let pid = details.and_then(|value| value.ch_pid);
            let socket = details.and_then(|value| value.ch_socket_path.as_deref());
            let message = if let Some(pid) = pid {
                format!("startup reconcile could not reattach to live cloud-hypervisor pid {pid}")
            } else if let Some(socket) = socket {
                format!("startup reconcile could not reattach to cloud-hypervisor at {socket}")
            } else {
                "startup reconcile could not determine vm runtime state".to_string()
            };
            mark_vm_failed(inner, &vm.name, message).await;
            Ok(StartupReconcileOutcome::KeptInconclusive)
        }
    }
}

pub(super) fn should_resume_live_vm_on_startup(state: VmLifecycleState) -> bool {
    matches!(
        state,
        VmLifecycleState::BootingVm | VmLifecycleState::Running
    )
}

pub(super) fn startup_resume_reenters_booting(state: VmLifecycleState) -> bool {
    matches!(state, VmLifecycleState::BootingVm)
}

pub(super) fn startup_cleanup_mode(vm: &VmStatusResponse) -> StartupCleanupMode {
    match vm.state {
        VmLifecycleState::Running
        | VmLifecycleState::DeletingVm
        | VmLifecycleState::ArchivingArtifacts
        | VmLifecycleState::DeleteFailed => StartupCleanupMode::Archive,
        VmLifecycleState::Queued
        | VmLifecycleState::CachingImage
        | VmLifecycleState::PreparingDisks
        | VmLifecycleState::CreatingVm
        | VmLifecycleState::BootingVm
        | VmLifecycleState::Failed => StartupCleanupMode::DropLocal,
    }
}

pub(super) async fn detect_tracked_vm_runtime(
    inner: &Arc<Inner>,
    vm: &VmStatusResponse,
) -> Result<TrackedVmRuntimeStatus> {
    let Some(details) = vm.details.as_ref() else {
        return Ok(TrackedVmRuntimeStatus::Dead);
    };

    let Some(generation) = details.jail_generation.as_deref() else {
        // A durable VM without a jail generation cannot be reattached. This
        // includes incomplete pre-launch rows, which are safe to clean as dead
        // state.
        return Ok(TrackedVmRuntimeStatus::Dead);
    };

    let Some(inspection) =
        jailer_identity_request(inner, generation, JailerIdentityOperation::Inspect).await?
    else {
        return Ok(TrackedVmRuntimeStatus::Dead);
    };

    if !inspection_matches_persisted(details, &inspection) {
        warn!(
            vm = vm.name,
            generation,
            "jailerd runtime identity does not match persisted VM identity; refusing reattach"
        );
        return Ok(TrackedVmRuntimeStatus::Inconclusive);
    }

    // Inspection is adoption evidence only. Never activate ingress merely
    // because SQLite says Running: the resumed worker must receive fresh Kino
    // readiness for this generation and execute the normal secure finalizer.
    let cpu_runtime = inspection.cpu_runtime.clone();
    {
        let mut states = inner.states.write().await;
        if let Some(current) = states.get_mut(&vm.name)
            && let Some(details) = current.details.as_mut()
        {
            details.cpu_runtime = Some(cpu_runtime);
        }
    }
    publish_inventory_update(inner);

    match inspection.health {
        SandboxHealth::Exited => return Ok(TrackedVmRuntimeStatus::Dead),
        SandboxHealth::Quarantined => return Ok(TrackedVmRuntimeStatus::Inconclusive),
        SandboxHealth::Preparing | SandboxHealth::Healthy | SandboxHealth::Stopping => {}
    }

    if let Some(ch_socket_path) = details.ch_socket_path.as_deref()
        && Path::new(ch_socket_path).exists()
    {
        match ChClient::new(ch_socket_path.to_string()) {
            Ok(client) => {
                if client.ping().await.is_ok() {
                    return match client.vm_info().await {
                        Ok(info) => match info.state {
                            cloud_hypervisor_client::VmState::Created => {
                                Ok(TrackedVmRuntimeStatus::Live(TrackedVmLiveState::Created))
                            }
                            cloud_hypervisor_client::VmState::Running => {
                                Ok(TrackedVmRuntimeStatus::Live(TrackedVmLiveState::Running))
                            }
                            cloud_hypervisor_client::VmState::Paused => {
                                Ok(TrackedVmRuntimeStatus::Live(TrackedVmLiveState::Paused))
                            }
                            cloud_hypervisor_client::VmState::Shutdown => {
                                Ok(TrackedVmRuntimeStatus::Dead)
                            }
                        },
                        Err(cloud_hypervisor_client::Error::HttpStatus { status: 404, .. }) => {
                            Ok(TrackedVmRuntimeStatus::Dead)
                        }
                        Err(error) => {
                            warn!(
                                vm = vm.name,
                                socket = ch_socket_path,
                                error = %error,
                                "cloud-hypervisor vm_info was inconclusive during startup reconcile"
                            );
                            Ok(TrackedVmRuntimeStatus::Inconclusive)
                        }
                    };
                }
            }
            Err(error) => {
                warn!(
                    vm = vm.name,
                    socket = ch_socket_path,
                    error = %error,
                    "failed to create cloud-hypervisor client during startup reconcile"
                );
            }
        }
    }

    // jailerd still owns a matching unit/cgroup, but its API did not prove VM
    // identity and health. Keep the generation for quarantine/retry instead of
    // inferring liveness from a reusable numeric PID.
    Ok(TrackedVmRuntimeStatus::Inconclusive)
}

pub(super) fn inspection_matches_persisted(details: &VmDetails, inspection: &VmInspection) -> bool {
    let same_optional_path = |persisted: Option<&str>, actual: Option<&Path>| match persisted {
        Some(persisted) => actual.is_some_and(|actual| actual == Path::new(persisted)),
        None => true,
    };

    details
        .jail_generation
        .as_deref()
        .is_some_and(|value| value == inspection.generation.as_str())
        && details
            .jail_unit_name
            .as_deref()
            .is_none_or(|value| value == inspection.unit_name)
        && same_optional_path(
            details.jail_cgroup_path.as_deref(),
            inspection.cgroup_path.as_deref(),
        )
        && details
            .ch_pid
            .is_none_or(|value| Some(value) == inspection.pid)
        && details
            .ch_start_time_ticks
            .is_none_or(|value| Some(value) == inspection.pid_start_time_ticks)
        && details
            .host_boot_id
            .as_deref()
            .is_none_or(|value| inspection.host_boot_id.as_deref() == Some(value))
        && details
            .ch_executable_sha256
            .as_deref()
            .is_some_and(|value| value == inspection.cloud_hypervisor_sha256)
        && details
            .jail_root_inode
            .is_none_or(|value| inspection.jail_root_inode == Some(value))
        && details.jail_uid.is_none_or(|value| value == inspection.uid)
        && details.jail_gid.is_none_or(|value| value == inspection.gid)
        && details
            .jail_netns_name
            .as_deref()
            .is_none_or(|value| value == inspection.netns_name)
        && details
            .jail_root_path
            .as_deref()
            .is_none_or(|value| Path::new(value) == inspection.paths.host_jail_root)
        && details
            .ch_socket_path
            .as_deref()
            .is_none_or(|value| Path::new(value) == inspection.paths.host_api_socket)
}

pub(super) async fn resume_tracked_vm_on_startup(
    inner: &Arc<Inner>,
    vm: VmStatusResponse,
    live_state: TrackedVmLiveState,
) -> Result<()> {
    let details = vm
        .details
        .clone()
        .ok_or_else(|| anyhow::anyhow!("vm {} has no details to resume", vm.name))?;
    let ch_socket_path = details
        .ch_socket_path
        .clone()
        .ok_or_else(|| anyhow::anyhow!("vm {} missing cloud-hypervisor socket", vm.name))?;

    if startup_resume_reenters_booting(vm.state) {
        set_state(inner, &vm.name, VmLifecycleState::BootingVm).await;
    }
    stop_probe_worker(inner, &vm.name).await;
    stop_terminal_worker(inner, &vm.name).await;

    let inner_for_task = Arc::clone(inner);
    let vm_name = vm.name.clone();
    tokio::spawn(async move {
        let result = async {
            let ch = wait_for_ch_ready(
                Path::new(&ch_socket_path),
                inner_for_task.ch_spawn_timeout_seconds,
            )
            .await
            .with_context(|| {
                format!(
                    "failed to reconnect to cloud-hypervisor at {}",
                    ch_socket_path
                )
            })?;

            let readiness_updates = inner_for_task.kino_readiness_tx.subscribe();
            start_probe_worker(&inner_for_task, &vm_name, &details)
                .await
                .context("failed to restart vm probe worker after startup resume")?;

            if live_state == TrackedVmLiveState::Created {
                debug!(vm = vm_name, "restarting boot for startup-recovered vm");
                ch.vm_boot()
                    .await
                    .context("cloud-hypervisor vm.boot failed during startup resume")?;
            }

            let ready = wait_for_scenario_runtime_ready(
                &inner_for_task,
                &vm_name,
                &ch,
                &details,
                readiness_updates,
            )
            .await?;
            let generation = ValidatedId::parse(
                details
                    .jail_generation
                    .clone()
                    .context("startup-recovered VM is missing its jail generation")?,
            )
            .context("validate startup-recovered jail generation")?;
            let expect_ssh_forward = details.ssh_public_port.is_some();
            seal_ready_vm_cpu(&inner_for_task, &vm_name, &generation, expect_ssh_forward)
                .await
                .context("securely finalize startup-recovered VM")?;
            if expect_ssh_forward {
                wait_for_guest_ssh_before_running(&inner_for_task, &vm_name, &generation).await?;
            }
            ensure_create_not_deleted(&inner_for_task, &vm_name).await?;
            commit_ready_vm_and_probe(&inner_for_task, &vm_name, &generation, &ready)
                .await
                .context("durably commit recovered VM readiness")?;
            let terminal =
                terminal_state_for_attested_ready(&inner_for_task, &vm_name, &generation)
                    .await
                    .context("build recovered terminal-ready projection")?;
            emit_terminal_state_update(&inner_for_task, terminal, false).await;
            start_terminal_worker(&inner_for_task, &vm_name)
                .await
                .context("failed to restart vm terminal worker after startup resume")?;
            Ok::<(), anyhow::Error>(())
        }
        .await;

        if take_delete_request(&inner_for_task, &vm_name).await {
            stop_booting_vm(&inner_for_task, &vm_name).await;
            match cleanup_tracked_vm(&inner_for_task, &vm_name, false).await {
                Ok(_) => {
                    info!(
                        vm = vm_name,
                        "cleaned up vm after delete request during startup resume"
                    );
                }
                Err(error) => {
                    let err = error_chain_to_string(&error);
                    error!(
                        error = %err,
                        error_debug = ?error,
                        vm = vm_name,
                        "failed to clean up vm after delete request during startup resume"
                    );
                    mark_vm_failed(&inner_for_task, &vm_name, err).await;
                }
            }
            return;
        }

        if let Err(error) = result {
            let err = error_chain_to_string(&error);
            stop_booting_vm(&inner_for_task, &vm_name).await;
            error!(
                error = %err,
                error_debug = ?error,
                vm = vm_name,
                "failed to resume vm readiness on startup"
            );
            mark_vm_failed(&inner_for_task, &vm_name, err).await;
        }
    });

    Ok(())
}
