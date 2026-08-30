use super::*;

pub(super) async fn run_bridge_writer<W>(
    mut write: W,
    mut urgent: mpsc::Receiver<BridgeMessageV7>,
    mut inventory: mpsc::Receiver<BridgeMessageV7>,
    mut normal: mpsc::Receiver<BridgeMessageV7>,
) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    while let Some(message) = next_outbound_message(&mut urgent, &mut inventory, &mut normal).await
    {
        timeout(
            Duration::from_millis(OUTBOUND_SEND_BUDGET_MS),
            send_bridge_message(&mut write, &message),
        )
        .await
        .context("bridge websocket send exceeded bounded writer budget")??;
    }
    Ok(())
}

pub(super) async fn next_outbound_message(
    urgent: &mut mpsc::Receiver<BridgeMessageV7>,
    inventory: &mut mpsc::Receiver<BridgeMessageV7>,
    normal: &mut mpsc::Receiver<BridgeMessageV7>,
) -> Option<BridgeMessageV7> {
    tokio::select! {
        biased;
        message = urgent.recv() => message,
        message = inventory.recv() => message,
        message = normal.recv() => message,
    }
}

pub(super) async fn run_inventory_reporter(
    sources: BridgeReportSources,
    mut inventory_updates: watch::Receiver<u64>,
    mut desired_state: watch::Receiver<Option<HostDesiredStateV2>>,
    outbound: mpsc::Sender<BridgeMessageV7>,
) -> Result<()> {
    loop {
        tokio::select! {
            update = inventory_updates.changed() => {
                update.context("VM inventory update channel closed")?;
            }
            update = desired_state.changed() => {
                update.context("desired-state report channel closed")?;
            }
        }
        let desired = desired_state.borrow().clone();
        send_inventory_state_report(&outbound, &sources, desired.as_ref()).await?;
    }
}

pub(super) async fn enqueue_bridge_message(
    outbound: &mpsc::Sender<BridgeMessageV7>,
    message: BridgeMessageV7,
) -> Result<()> {
    outbound
        .send(message)
        .await
        .map_err(|_| anyhow::anyhow!("bridge writer channel closed"))
}

pub(super) async fn send_state_report(
    outbound: &mpsc::Sender<BridgeMessageV7>,
    sources: &BridgeReportSources,
    desired: Option<&HostDesiredStateV2>,
) -> Result<()> {
    let report = build_host_state_report(
        &sources.cfg.host_id,
        &sources.vm,
        &sources.db,
        &sources.disk_probe_path,
        desired,
        true,
        &sources.cache,
    )
    .await;
    enqueue_bridge_message(
        outbound,
        BridgeMessageV7::StateReport(StateReportV7 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: sources.cfg.host_id.clone(),
            report,
        }),
    )
    .await
}

pub(super) async fn send_inventory_state_report(
    outbound: &mpsc::Sender<BridgeMessageV7>,
    sources: &BridgeReportSources,
    desired: Option<&HostDesiredStateV2>,
) -> Result<()> {
    // Lifecycle-triggered snapshots use the generation-fenced state already
    // committed by VmManager. Full process/cgroup inspection is deliberately
    // left to the periodic report so readiness publication never inherits an
    // InspectVm round trip.
    let report = build_host_state_report(
        &sources.cfg.host_id,
        &sources.vm,
        &sources.db,
        &sources.disk_probe_path,
        desired,
        false,
        &sources.cache,
    )
    .await;
    enqueue_bridge_message(
        outbound,
        BridgeMessageV7::StateReport(StateReportV7 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: sources.cfg.host_id.clone(),
            report,
        }),
    )
    .await
}

pub(super) async fn send_vm_report(
    outbound: &mpsc::Sender<BridgeMessageV7>,
    host_id: &str,
    report: VmReportV2,
) -> Result<()> {
    enqueue_bridge_message(
        outbound,
        BridgeMessageV7::VmReport(VmReportV7 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: host_id.to_string(),
            report,
        }),
    )
    .await
}

pub(super) async fn send_sync_request<W>(
    write: &mut W,
    host_id: &str,
    reason: SyncRequestReason,
) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    send_bridge_message(
        write,
        &BridgeMessageV7::SyncRequest(SyncRequestV7 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: host_id.to_string(),
            reason,
        }),
    )
    .await
}

pub(super) async fn build_host_state_report(
    host_id: &str,
    vm: &VmManager,
    db: &Db,
    disk_probe_path: &Path,
    desired: Option<&HostDesiredStateV2>,
    inspect_runtime: bool,
    report_cache: &BridgeReportCache,
) -> HostStateReportV2 {
    let now = now_ms();
    let profile = if inspect_runtime {
        let profile = host_profile::collect(disk_probe_path);
        *report_cache.host_profile.write().await = profile.clone();
        profile
    } else {
        // statfs and route discovery are synchronous host probes. Reuse the
        // last periodic snapshot so they cannot consume inventory latency.
        report_cache.host_profile.read().await.clone()
    };
    let probe_rows = if inspect_runtime {
        match db.load_all_vm_probe_states().await {
            Ok(rows) => rows,
            Err(error) => {
                warn!(error = %error, "failed to load persisted probe state for bridge report");
                Vec::new()
            }
        }
    } else {
        // Probe transitions already have their own targeted VM report. Avoid
        // putting SQLite actor latency in the inventory freshness path.
        Vec::new()
    };
    let probes_by_vm = probe_snapshots_by_vm(probe_rows);
    let ssh_host = vm.ssh_advertised_host();
    let statuses = vm.list_vms().await;
    let profile_total_cpu_millis = u32::try_from(profile.cpu_cores)
        .unwrap_or(u32::MAX / 1_000)
        .saturating_mul(1_000);
    let local_committed_cpu_millis = statuses
        .iter()
        .filter_map(|status| status.details.as_ref()?.cpu_millis)
        .fold(0_u32, u32::saturating_add);
    let live_jailer = if inspect_runtime {
        vm.jailer_capabilities().await.ok()
    } else {
        match timeout(
            Duration::from_millis(INVENTORY_REPORT_JAILER_BUDGET_MS),
            vm.jailer_capabilities(),
        )
        .await
        {
            Ok(Ok(capabilities)) => Some(capabilities),
            Ok(Err(error)) => {
                warn!(error = %error, "failed to refresh jailer capacity for inventory report");
                None
            }
            Err(_) => {
                warn!(
                    budget_ms = INVENTORY_REPORT_JAILER_BUDGET_MS,
                    "timed out refreshing jailer capacity for inventory report"
                );
                None
            }
        }
    };
    if let Some(capabilities) = live_jailer.as_ref() {
        *report_cache.jailer_capabilities.write().await = Some(capabilities.clone());
    }
    // Feature and template-store attestations are immutable for a jailerd
    // process lifetime. A short capacity refresh timeout must not make a
    // performance-ready host flap, while mutable capacity below still fails
    // closed by using only the live response.
    let cached_jailer = report_cache.jailer_capabilities.read().await.clone();
    let attested_jailer = preserve_last_attestation(live_jailer.as_ref(), cached_jailer.as_ref());
    let (total_cpu_millis, reserved_cpu_millis, schedulable_cpu_millis, committed_cpu_millis) =
        live_jailer.as_ref().map_or_else(
            || {
                // Helper unavailability is fail-closed: advertise no
                // schedulable CPU even when the host profile is otherwise
                // healthy.
                (
                    profile_total_cpu_millis,
                    profile_total_cpu_millis,
                    0,
                    local_committed_cpu_millis,
                )
            },
            |capabilities| {
                (
                    saturating_u64_to_u32(capabilities.total_cpu_millis),
                    saturating_u64_to_u32(capabilities.reserved_cpu_millis),
                    saturating_u64_to_u32(capabilities.schedulable_cpu_millis),
                    saturating_u64_to_u32(capabilities.committed_cpu_millis),
                )
            },
        );
    let observations = join_all(statuses.iter().map(|status| async {
        let generation = status
            .details
            .as_ref()
            .and_then(|details| details.jail_generation.as_deref());
        let inspection = match (inspect_runtime, generation) {
            (true, Some(generation)) => match vm.inspect_jailed_vm(generation).await {
                Ok(inspection) => inspection,
                Err(error) => {
                    warn!(vm = status.name, generation, error = %error, "failed to inspect jailed VM for host report");
                    None
                }
            },
            (false, _) | (true, None) => None,
        };
        // Never recreate terminal readiness from a direct TCP probe. The event
        // cache is empty after restart until resumed Kino readiness and
        // FinalizeVmBoot publish a fresh generation-matched terminal event.
        let terminal = vm.committed_terminal_state(&status.name).await;
        (inspection, terminal)
    }))
    .await;
    let (reported_capabilities, reported_cached_images, reported_cached_guest_tools) =
        if inspect_runtime {
            let capabilities = collect_host_capabilities(attested_jailer.as_ref());
            let (cached_images, cached_guest_tools) = desired
                .map(|state| {
                    let cache_root = crate::image_cache::default_cache_root().ok();
                    let images = cached_image_states(
                        state,
                        now,
                        attested_jailer.as_ref().is_some_and(|capabilities| {
                            capabilities.supports_template_backed_launch
                                && capabilities.fast_template_store
                        }),
                    );
                    let tools = cached_guest_tools_states_with_cache_root(
                        state,
                        now,
                        cache_root.as_deref(),
                    );
                    (images, tools)
                })
                .unwrap_or_default();
            *report_cache.host_capabilities.write().await = capabilities.clone();
            *report_cache.cached_images.write().await = cached_images.clone();
            *report_cache.cached_guest_tools.write().await = cached_guest_tools.clone();
            (capabilities, cached_images, cached_guest_tools)
        } else {
            (
                report_cache.host_capabilities.read().await.clone(),
                report_cache.cached_images.read().await.clone(),
                report_cache.cached_guest_tools.read().await.clone(),
            )
        };

    HostStateReportV2 {
        schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        observed_at_unix_ms: now,
        applied_desired_version: desired.map(|state| state.version).unwrap_or(0),
        capacity: HostCapacityV2 {
            total_cpu_millis,
            reserved_cpu_millis,
            schedulable_cpu_millis,
            committed_cpu_millis,
            memory_total_mib: mib_from_u64(profile.memory_total_mib.unwrap_or(0)),
            memory_available_mib: mib_from_u64(profile.memory_available_mib.unwrap_or(0)),
            disk_probe_path: profile.disk_probe_path,
            disk_total_mib: mib_from_u64(profile.disk_total_mib.unwrap_or(0)),
            disk_available_mib: mib_from_u64(profile.disk_available_mib.unwrap_or(0)),
            load_avg_1m: profile.load_avg1m,
            load_avg_5m: profile.load_avg5m,
            load_avg_15m: profile.load_avg15m,
            primary_ipv4: profile.primary_ipv4,
            primary_ipv6: profile.primary_ipv6,
        },
        capabilities: reported_capabilities,
        cached_images: reported_cached_images,
        cached_guest_tools: reported_cached_guest_tools,
        vms: statuses
            .into_iter()
            .zip(observations)
            .map(|(status, (inspection, terminal))| {
                let run_id = local_run_id(&status).unwrap_or_default();
                let current_generation = status
                    .details
                    .as_ref()
                    .and_then(|details| details.jail_generation.as_deref());
                let probes = probes_by_vm
                    .get(&(run_id.clone(), status.name.clone()))
                    .filter(|(generation, _)| generation.as_deref() == current_generation)
                    .map(|(_, probes)| probes.clone())
                    .unwrap_or_default();
                actual_state_from_status(
                    host_id,
                    ssh_host.as_deref(),
                    desired,
                    status,
                    probes,
                    inspection.as_ref(),
                    terminal.as_ref(),
                )
            })
            .collect(),
        builds: Vec::new(),
    }
}

pub(super) async fn build_vm_report_from_probe_update(
    host_id: &str,
    vm: &VmManager,
    desired: Option<&HostDesiredStateV2>,
    update: &ProbeUpdateEnvelope,
) -> Option<VmReportV2> {
    let status = vm.get_vm(&update.vm_name).await?;
    let current_generation = status
        .details
        .as_ref()
        .and_then(|details| details.jail_generation.as_deref());
    if Some(update.jail_generation.as_str()) != current_generation {
        warn!(
            vm = update.vm_name,
            run_id = update.run_id,
            update_generation = ?update.jail_generation,
            current_generation = ?current_generation,
            "dropping stale-generation Kino projection"
        );
        return None;
    }
    let terminal = vm.committed_terminal_state(&status.name).await;
    Some(build_vm_report_from_status(
        host_id,
        vm.ssh_advertised_host().as_deref(),
        desired,
        status,
        probe_snapshots_from_update(update),
        None,
        terminal.as_ref(),
    ))
}

pub(super) fn build_vm_report_from_status(
    host_id: &str,
    ssh_host: Option<&str>,
    desired: Option<&HostDesiredStateV2>,
    status: VmStatusResponse,
    probes: Vec<VmProbeSnapshotV1>,
    inspection: Option<&VmInspection>,
    terminal: Option<&VmTerminalState>,
) -> VmReportV2 {
    let actual = actual_state_from_status(
        host_id, ssh_host, desired, status, probes, inspection, terminal,
    );
    VmReportV2 {
        schema_version: VM_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        run_id: actual.run_id,
        vm_name: actual.vm_name,
        desired_version: actual.desired_version,
        observed_at_unix_ms: actual.updated_at_unix_ms,
        phase: actual.phase,
        guest_tools: actual.guest_tools,
        network: actual.network,
        terminal: actual.terminal,
        runtime_constraints: actual.runtime_constraints,
        resource_state: actual.resource_state,
        sandbox: actual.sandbox,
        ssh_host_keys_openssh: actual.ssh_host_keys_openssh,
        probes: actual.probes,
        archive: actual.archive,
        error: actual.error,
    }
}

pub(super) fn actual_state_from_status(
    _host_id: &str,
    ssh_host: Option<&str>,
    desired: Option<&HostDesiredStateV2>,
    status: VmStatusResponse,
    probes: Vec<VmProbeSnapshotV1>,
    inspection: Option<&VmInspection>,
    terminal: Option<&VmTerminalState>,
) -> VmActualStateV2 {
    let run_id = local_run_id(&status).unwrap_or_default();
    let desired_vm = desired.and_then(|state| {
        state
            .vms
            .iter()
            .find(|vm| vm.run_id == run_id && vm.vm_name == status.name)
    });

    let status_updated_at = parse_rfc3339_ms(&status.updated_at).unwrap_or_else(now_ms);
    let terminal_state = terminal.map_or_else(
        || terminal_state_from_status_fallback(&status, status_updated_at),
        terminal_state_from_manager,
    );
    let runtime_constraints = terminal
        .and_then(|state| state.runtime_constraints.clone())
        .or_else(|| runtime_constraints_from_status(&status));
    let updated_at_unix_ms = terminal.map_or(status_updated_at, |state| {
        state.observed_at.max(status_updated_at)
    });

    let phase = vm_phase_from_status(&status, &probes);
    let actual_guest_tools = status
        .details
        .as_ref()
        .and_then(|details| details.guest_tools.as_ref())
        .or_else(|| desired_vm.map(|vm| &vm.guest_tools));
    let guest_tools = actual_guest_tools.map(|pin| VmGuestToolsStateV1 {
        tools_disk_sha256: pin.tools_disk_sha256.clone(),
        kino_sha256: pin.kino_sha256.clone(),
        bootstrap_abi: pin.bootstrap_abi,
        verified: matches!(phase, VmPhase::Ready | VmPhase::Solved),
    });
    VmActualStateV2 {
        run_id,
        vm_name: status.name.clone(),
        desired_version: desired_vm.and_then(|_| desired.map(|state| state.version)),
        phase,
        image_key: desired_vm.map(|vm| vm.image_key.clone()),
        image_id: desired_vm.map(|vm| vm.image_id.clone()),
        guest_tools,
        network: network_state_from_status(&status, ssh_host),
        terminal: terminal_state,
        runtime_constraints,
        resource_state: resource_state_from_status(&status, inspection),
        sandbox: sandbox_state_from_status(&status, inspection),
        ssh_host_keys_openssh: status
            .details
            .as_ref()
            .map(|details| details.ssh_host_keys_openssh.clone())
            .unwrap_or_default(),
        probes,
        archive: archive_state_from_status(&status),
        error: status.error.clone(),
        updated_at_unix_ms,
    }
}

pub(super) fn failed_vm_report(
    host_id: &str,
    desired: &HostDesiredStateV2,
    vm: &DesiredVmV2,
    observed_at_unix_ms: i64,
    error: String,
) -> VmReportV2 {
    VmReportV2 {
        schema_version: VM_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        run_id: vm.run_id.clone(),
        vm_name: vm.vm_name.clone(),
        desired_version: Some(desired.version),
        observed_at_unix_ms,
        phase: VmPhase::Failed,
        guest_tools: Some(VmGuestToolsStateV1 {
            tools_disk_sha256: vm.guest_tools.tools_disk_sha256.clone(),
            kino_sha256: vm.guest_tools.kino_sha256.clone(),
            bootstrap_abi: vm.guest_tools.bootstrap_abi,
            verified: false,
        }),
        network: None,
        terminal: VmTerminalStateV1 {
            state: VmTerminalStateKindV1::Failed,
            target: None,
            reason: Some(error.clone()),
            observed_at_unix_ms,
        },
        runtime_constraints: None,
        resource_state: None,
        sandbox: None,
        ssh_host_keys_openssh: Vec::new(),
        probes: Vec::new(),
        archive: None,
        error: Some(error),
    }
}

pub(super) fn terminal_state_from_status_fallback(
    status: &VmStatusResponse,
    observed_at_unix_ms: i64,
) -> VmTerminalStateV1 {
    let (state, reason) = match status.state {
        VmLifecycleState::Failed | VmLifecycleState::DeleteFailed => (
            VmTerminalStateKindV1::Failed,
            Some(
                status
                    .error
                    .clone()
                    .unwrap_or_else(|| "vm failed".to_string()),
            ),
        ),
        VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts => (
            VmTerminalStateKindV1::Pending,
            Some("destroying".to_string()),
        ),
        _ => (
            VmTerminalStateKindV1::Pending,
            Some("terminal readiness pending".to_string()),
        ),
    };
    VmTerminalStateV1 {
        state,
        target: None,
        reason,
        observed_at_unix_ms,
    }
}

pub(super) fn runtime_constraints_from_status(
    status: &VmStatusResponse,
) -> Option<VmRuntimeConstraintsV1> {
    let details = status.details.as_ref()?;
    let generation = details.jail_generation.clone()?;
    let runtime = details.cpu_runtime.as_ref()?;
    Some(VmRuntimeConstraintsV1 {
        generation,
        phase: match runtime.phase {
            VmCpuPhase::BootBurst => VmRuntimeConstraintPhaseV1::BootBurst,
            VmCpuPhase::Steady => VmRuntimeConstraintPhaseV1::Steady,
        },
        steady_cpu_millis: runtime.steady_quota.cpu_millis,
        effective_cpu_millis: runtime.effective_quota.cpu_millis,
        quota_verified_at_unix_ms: runtime
            .attestation
            .as_ref()
            .and_then(|attestation| i64::try_from(attestation.verified_at_unix_ms).ok()),
        lease_expires_at_unix_ms: runtime
            .boot_deadline_unix_ms
            .and_then(|deadline| i64::try_from(deadline).ok()),
    })
}

pub(super) fn terminal_state_from_manager(state: &VmTerminalState) -> VmTerminalStateV1 {
    let target = state.terminal_target.as_ref().and_then(|target| {
        let host = target
            .host
            .as_deref()
            .map(str::trim)
            .filter(|host| !host.is_empty())?;
        (state.state == VmTerminalStateKind::Ready).then(|| VmTerminalTargetV1 {
            host: host.to_string(),
            port: target.port,
            username: target.username.clone(),
            checked_at_unix_ms: target.checked_at,
        })
    });
    let (kind, reason) = match state.state {
        VmTerminalStateKind::Ready if target.is_some() => (VmTerminalStateKindV1::Ready, None),
        VmTerminalStateKind::Ready => (
            VmTerminalStateKindV1::Pending,
            Some("advertised ssh host unavailable".to_string()),
        ),
        VmTerminalStateKind::Pending => (VmTerminalStateKindV1::Pending, state.reason.clone()),
        VmTerminalStateKind::Failed => (VmTerminalStateKindV1::Failed, state.reason.clone()),
    };
    VmTerminalStateV1 {
        state: kind,
        target,
        reason,
        observed_at_unix_ms: state.observed_at,
    }
}

pub(super) fn vm_phase_from_status(
    status: &VmStatusResponse,
    probes: &[VmProbeSnapshotV1],
) -> VmPhase {
    match status.state {
        VmLifecycleState::Queued => VmPhase::Pending,
        VmLifecycleState::CachingImage => VmPhase::PullingImage,
        VmLifecycleState::PreparingDisks => VmPhase::CreatingDisks,
        VmLifecycleState::CreatingVm => {
            creating_vm_report_phase(runtime_constraints_from_status(status).is_some())
        }
        VmLifecycleState::BootingVm => VmPhase::Booting,
        VmLifecycleState::Running => {
            if !probes.is_empty()
                && probes
                    .iter()
                    .all(|probe| probe.status == VmProbeStatus::Pass)
            {
                VmPhase::Solved
            } else if status
                .details
                .as_ref()
                .and_then(|details| details.ssh_public_port)
                .is_some()
            {
                VmPhase::Ready
            } else {
                VmPhase::Running
            }
        }
        VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts => VmPhase::Stopping,
        VmLifecycleState::Failed | VmLifecycleState::DeleteFailed => VmPhase::Failed,
    }
}

pub(super) fn creating_vm_report_phase(has_runtime_constraints: bool) -> VmPhase {
    if has_runtime_constraints {
        VmPhase::Booting
    } else {
        // The external Booting phase requires a generation and live CPU
        // contract. Keep the pre-jailer launch window in disk/staging state;
        // persist_jail_launch emits another inventory revision as soon as the
        // boot quota is available.
        VmPhase::CreatingDisks
    }
}

pub(super) fn network_state_from_status(
    status: &VmStatusResponse,
    ssh_host: Option<&str>,
) -> Option<VmNetworkStateV1> {
    let details = status.details.as_ref()?;
    let guest_ip = details.guest_ip.as_ref()?.trim();
    if guest_ip.is_empty() {
        return None;
    }
    let guest_cidr = details.guest_ip_cidr.as_ref()?.trim();
    let gateway = details.gateway.as_ref()?.trim();
    let bridge_name = details.bridge_name.as_ref()?.trim();
    if guest_cidr.is_empty() || gateway.is_empty() || bridge_name.is_empty() {
        return None;
    }
    Some(VmNetworkStateV1 {
        bridge_name: bridge_name.to_string(),
        guest_ip: guest_ip.to_string(),
        guest_cidr: guest_cidr.to_string(),
        gateway: gateway.to_string(),
        ssh_host: ssh_host
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        ssh_host_port: details.ssh_public_port,
    })
}

pub(super) fn archive_state_from_status(status: &VmStatusResponse) -> Option<VmArchiveStateV1> {
    match status.state {
        VmLifecycleState::ArchivingArtifacts => Some(VmArchiveStateV1 {
            phase: VmArchivePhase::Uploading,
            artifact_count: 0,
            error: None,
        }),
        VmLifecycleState::DeletingVm => Some(VmArchiveStateV1 {
            phase: VmArchivePhase::Pending,
            artifact_count: 0,
            error: None,
        }),
        VmLifecycleState::DeleteFailed => Some(VmArchiveStateV1 {
            phase: VmArchivePhase::Failed,
            artifact_count: 0,
            error: status.error.clone(),
        }),
        _ => None,
    }
}

pub(super) async fn load_probe_snapshots_for_vm(
    db: &Db,
    run_id: &str,
    vm_name: &str,
    generation: Option<&str>,
) -> Vec<VmProbeSnapshotV1> {
    match db.load_vm_probe_state(vm_name.to_string()).await {
        Ok(Some(row))
            if row.run_id == run_id
                && probe_generation_from_state_row(&row).as_deref() == generation =>
        {
            probe_snapshots_from_state_row(&row)
        }
        Ok(_) => Vec::new(),
        Err(error) => {
            warn!(error = %error, run_id, vm = vm_name, "failed to load vm probe state");
            Vec::new()
        }
    }
}

pub(super) fn probe_snapshots_by_vm(
    rows: Vec<VmProbeStateRow>,
) -> BTreeMap<(String, String), (Option<String>, Vec<VmProbeSnapshotV1>)> {
    rows.into_iter()
        .map(|row| {
            (
                (row.run_id.clone(), row.vm_name.clone()),
                (
                    probe_generation_from_state_row(&row),
                    probe_snapshots_from_state_row(&row),
                ),
            )
        })
        .collect()
}

pub(super) fn probe_generation_from_state_row(row: &VmProbeStateRow) -> Option<String> {
    serde_json::from_str::<ProbeUpdateEnvelope>(&row.snapshot_json)
        .ok()
        .map(|update| update.jail_generation)
}

pub(super) fn probe_snapshots_from_state_row(row: &VmProbeStateRow) -> Vec<VmProbeSnapshotV1> {
    serde_json::from_str::<ProbeUpdateEnvelope>(&row.snapshot_json)
        .map(|update| probe_snapshots_from_update(&update))
        .unwrap_or_default()
}

pub(super) fn probe_snapshots_from_update(update: &ProbeUpdateEnvelope) -> Vec<VmProbeSnapshotV1> {
    probe_snapshots_from_probes(update.generated_at_ms, &update.probes)
}

pub(super) fn probe_snapshots_from_probes(
    observed_at_unix_ms: i64,
    probes: &[ProbeView],
) -> Vec<VmProbeSnapshotV1> {
    probes
        .iter()
        .filter(|probe| !probe.id.trim().is_empty())
        .map(|probe| VmProbeSnapshotV1 {
            id: probe.id.clone(),
            phase: ProbePhase::Scenario,
            status: probe_status(&probe.status),
            checked_at_unix_ms: probe.last_attempt_at_ms.unwrap_or(observed_at_unix_ms),
            message: probe.error.clone(),
            value: if probe.value.is_null() {
                None
            } else {
                Some(probe.value.clone())
            },
        })
        .collect()
}

pub(super) fn probe_status(status: &str) -> VmProbeStatus {
    match status.trim().to_ascii_lowercase().as_str() {
        "pass" | "passed" | "ready" | "ok" | "succeeded" | "success" => VmProbeStatus::Pass,
        "fail" | "failed" | "error" | "errored" => VmProbeStatus::Fail,
        _ => VmProbeStatus::Unknown,
    }
}

pub(super) fn cached_image_states(
    desired: &HostDesiredStateV2,
    now: i64,
    require_template: bool,
) -> Vec<CachedImageStateV1> {
    let cache_root = crate::image_cache::default_cache_root().ok();
    cached_image_states_with_cache_root(desired, now, cache_root.as_deref(), require_template)
}

pub(super) fn cached_image_states_with_cache_root(
    desired: &HostDesiredStateV2,
    now: i64,
    cache_root: Option<&Path>,
    require_template: bool,
) -> Vec<CachedImageStateV1> {
    desired
        .cached_images
        .iter()
        .map(|desired_image| {
            let key = image_cache_key(&desired_image.image_key);
            let metadata = cache_root.and_then(|root| {
                crate::image_cache::verified_cached_image_metadata(
                    root,
                    &key,
                    &desired_image.image_id,
                    require_template,
                )
            });
            CachedImageStateV1 {
                image_key: desired_image.image_key.clone(),
                image_id: desired_image.image_id.clone(),
                phase: if metadata.is_some() {
                    ImageCachePhase::Ready
                } else {
                    ImageCachePhase::Missing
                },
                bytes_on_disk: metadata.map(|meta| meta.len()),
                error: None,
                updated_at_unix_ms: now,
            }
        })
        .collect()
}

pub(super) fn cached_guest_tools_states_with_cache_root(
    desired: &HostDesiredStateV2,
    now: i64,
    cache_root: Option<&Path>,
) -> Vec<CachedGuestToolsStateV1> {
    desired
        .cached_guest_tools
        .iter()
        .map(|pin| {
            let path = cache_root.map(|root| {
                root.join("tools")
                    .join(format!("{}.ext4", pin.tools_disk_sha256))
            });
            let metadata = path.as_deref().and_then(|path| {
                let metadata = fs::metadata(path).ok()?;
                (metadata.is_file()
                    && metadata.len() == pin.tools_disk_size_bytes
                    && sha256_file_for_report(path).as_deref()
                        == Some(pin.tools_disk_sha256.as_str()))
                .then_some(metadata)
            });
            CachedGuestToolsStateV1 {
                guest_tools: pin.clone(),
                phase: if metadata.is_some() {
                    ImageCachePhase::Ready
                } else {
                    ImageCachePhase::Missing
                },
                bytes_on_disk: metadata.map(|value| value.len()),
                error: None,
                updated_at_unix_ms: now,
            }
        })
        .collect()
}

fn sha256_file_for_report(path: &Path) -> Option<String> {
    use sha2::{Digest as _, Sha256};
    use std::io::Read as _;

    let mut file = fs::File::open(path).ok()?;
    let mut buffer = [0_u8; 1024 * 1024];
    let mut hasher = Sha256::new();
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(base16ct::lower::encode_string(&hasher.finalize()))
}

pub(super) fn collect_host_capabilities(jailer: Option<&JailerCapabilities>) -> HostCapabilitiesV2 {
    let supports_cgroup_v2 = fs::read_to_string("/sys/fs/cgroup/cgroup.controllers")
        .is_ok_and(|value| value.split_whitespace().any(|item| item == "cpu"));
    let supports_jailer_v2 = jailer.is_some_and(|capabilities| capabilities.supports_jailer_v2);
    let supports_jailer_v3 = jailer.is_some_and(|capabilities| capabilities.supports_jailer_v3);
    let supports_run_cli_v1 = cfg!(target_os = "linux") && supports_jailer_v3;
    HostCapabilitiesV2 {
        arch: host_architecture(),
        cloud_hypervisor_sha256: jailer
            .map(|capabilities| capabilities.cloud_hypervisor_sha256.clone()),
        boot_cpu_millis: jailer.map(|capabilities| capabilities.boot_cpu_millis),
        boot_cpu_lease_ms: jailer.map(|capabilities| capabilities.boot_cpu_lease_ms),
        // The service deliberately runs with PrivateDevices=true. A successful
        // jailerd readiness attestation, not agent-visible device access, is
        // the authority for KVM availability and complete helper accounting.
        supports_kvm: supports_jailer_v2,
        supports_vsock: true,
        // The broker relies on the jailer-attested Cloud Hypervisor vsock
        // device and only exists in the Linux host implementation.
        supports_run_cli_v1,
        // Completion uses the same Linux-only, jailer-attested broker as the
        // learner CLI. Advertise it separately so the control plane can keep
        // old agents out of the final rollout.
        supports_run_cli_completion_v1: supports_run_cli_v1,
        supports_reflink: supports_reflink_for_image_cache(),
        supports_nftables: command_exists("nft"),
        supports_jailer_v2,
        supports_jailer_v3,
        supports_raw_chunks_v1: supports_jailer_v3,
        supports_scenario_guest_tools_v1: supports_jailer_v3,
        supports_boot_cpu_lease: jailer
            .is_some_and(|capabilities| capabilities.supports_boot_cpu_lease),
        supports_template_backed_launch: jailer
            .is_some_and(|capabilities| capabilities.supports_template_backed_launch),
        fast_template_store: jailer.is_some_and(|capabilities| capabilities.fast_template_store),
        supports_hard_cpu_quota: jailer
            .is_some_and(|capabilities| capabilities.supports_hard_cpu_quota),
        supports_landlock: jailer.is_some_and(|capabilities| capabilities.supports_landlock),
        supports_cgroup_v2: jailer.map_or(supports_cgroup_v2, |capabilities| {
            capabilities.supports_cgroup_v2
        }),
    }
}

pub(super) fn resource_state_from_status(
    status: &VmStatusResponse,
    inspection: Option<&VmInspection>,
) -> Option<VmResourceStateV2> {
    let details = status.details.as_ref()?;
    let inspection = inspection?;
    if details.jail_generation.as_deref() != Some(inspection.generation.as_str()) {
        return None;
    }
    let cpu_stat = inspection.cpu_stat.as_ref();
    Some(VmResourceStateV2 {
        cpu_millis: inspection.cpu_quota.cpu_millis,
        vcpu_count: inspection.vcpu_count,
        cpu_quota_us: inspection.cpu_quota.quota_micros,
        cpu_period_us: inspection.cpu_quota.period_micros,
        cpu_usage_usec: cpu_stat.map_or(0, |stat| stat.usage_usec),
        cpu_user_usec: cpu_stat.map_or(0, |stat| stat.user_usec),
        cpu_system_usec: cpu_stat.map_or(0, |stat| stat.system_usec),
        cpu_nr_periods: cpu_stat.map_or(0, |stat| stat.nr_periods),
        cpu_nr_throttled: cpu_stat.map_or(0, |stat| stat.nr_throttled),
        cpu_throttled_usec: cpu_stat.map_or(0, |stat| stat.throttled_usec),
    })
}

pub(super) fn sandbox_state_from_status(
    status: &VmStatusResponse,
    inspection: Option<&VmInspection>,
) -> Option<VmSandboxStateV1> {
    let details = status.details.as_ref()?;
    let inspection_matches = inspection.is_some_and(|inspection| {
        details.jail_generation.as_deref() == Some(inspection.generation.as_str())
            && details.jail_unit_name.as_deref() == Some(inspection.unit_name.as_str())
            && details.jail_cgroup_path.as_deref()
                == inspection.cgroup_path.as_deref().and_then(Path::to_str)
    });
    Some(VmSandboxStateV1 {
        healthy: inspection_matches
            && inspection.is_some_and(|inspection| {
                inspection.health == SandboxHealth::Healthy
                    && inspection.seccomp_enabled
                    && inspection.landlock_enabled
                    && inspection.no_new_privs
                    && inspection.capabilities_empty
            }),
        generation: details.jail_generation.clone()?,
        systemd_unit: details.jail_unit_name.clone()?,
        cgroup_path: details.jail_cgroup_path.clone()?,
        seccomp_enabled: inspection_matches
            && inspection.is_some_and(|inspection| inspection.seccomp_enabled),
        landlock_enabled: inspection_matches
            && inspection.is_some_and(|inspection| inspection.landlock_enabled),
        no_new_privs: inspection_matches
            && inspection.is_some_and(|inspection| inspection.no_new_privs),
    })
}

#[cfg(all(test, unix))]
pub(super) fn can_open_char_device(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_char_device() {
        return false;
    }
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .is_ok()
}

#[cfg(all(test, not(unix)))]
pub(super) fn can_open_char_device(_path: &Path) -> bool {
    false
}

pub(super) fn supports_reflink_for_image_cache() -> bool {
    static SUPPORTS_REFLINK: OnceLock<bool> = OnceLock::new();
    *SUPPORTS_REFLINK.get_or_init(probe_reflink_for_image_cache)
}

pub(super) fn probe_reflink_for_image_cache() -> bool {
    let Ok(cache_root) = crate::image_cache::default_cache_root() else {
        return false;
    };
    let probe_dir = cache_root.join(".capabilities");
    if std::fs::create_dir_all(&probe_dir).is_err() {
        return false;
    }

    let src = probe_dir.join("reflink-src");
    let dst = probe_dir.join("reflink-dst");
    let _ = std::fs::remove_file(&dst);
    if std::fs::write(&src, b"intar reflink probe\n").is_err() {
        return false;
    }

    let supported = Command::new("cp")
        // coreutils >= 9.2 rejects --reflink=always combined with
        // --sparse=always; reflink clones share extents, so sparseness is
        // preserved without an explicit sparse mode.
        .arg("--reflink=always")
        .arg("--sparse=auto")
        .arg(&src)
        .arg(&dst)
        .status()
        .is_ok_and(|status| status.success());

    let _ = std::fs::remove_file(&src);
    let _ = std::fs::remove_file(&dst);
    supported
}

pub(super) fn host_architecture() -> ImageArchitecture {
    if cfg!(target_arch = "aarch64") {
        ImageArchitecture::Aarch64
    } else {
        ImageArchitecture::X86_64
    }
}
