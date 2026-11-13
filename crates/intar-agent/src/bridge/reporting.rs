use super::*;

pub(super) async fn run_bridge_writer<W>(
    mut write: W,
    mut urgent: mpsc::Receiver<BridgeMessageV9>,
    mut inventory: mpsc::Receiver<BridgeMessageV9>,
    mut normal: mpsc::Receiver<BridgeMessageV9>,
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
    urgent: &mut mpsc::Receiver<BridgeMessageV9>,
    inventory: &mut mpsc::Receiver<BridgeMessageV9>,
    normal: &mut mpsc::Receiver<BridgeMessageV9>,
) -> Option<BridgeMessageV9> {
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
    mut desired_state: watch::Receiver<Option<HostDesiredStateV3>>,
    outbound: mpsc::Sender<BridgeMessageV9>,
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
    outbound: &mpsc::Sender<BridgeMessageV9>,
    message: BridgeMessageV9,
) -> Result<()> {
    outbound
        .send(message)
        .await
        .map_err(|_| anyhow::anyhow!("bridge writer channel closed"))
}

pub(super) async fn send_state_report(
    outbound: &mpsc::Sender<BridgeMessageV9>,
    sources: &BridgeReportSources,
    desired: Option<&HostDesiredStateV3>,
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
        BridgeMessageV9::StateReport(StateReportV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: sources.cfg.host_id.clone(),
            report,
        }),
    )
    .await
}

pub(super) async fn send_inventory_state_report(
    outbound: &mpsc::Sender<BridgeMessageV9>,
    sources: &BridgeReportSources,
    desired: Option<&HostDesiredStateV3>,
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
        BridgeMessageV9::StateReport(StateReportV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: sources.cfg.host_id.clone(),
            report,
        }),
    )
    .await
}

pub(super) async fn send_vm_report(
    outbound: &mpsc::Sender<BridgeMessageV9>,
    host_id: &str,
    report: VmReportV3,
) -> Result<()> {
    enqueue_bridge_message(
        outbound,
        BridgeMessageV9::VmReport(VmReportV9 {
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
        &BridgeMessageV9::SyncRequest(SyncRequestV9 {
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
    desired: Option<&HostDesiredStateV3>,
    inspect_runtime: bool,
    report_cache: &BridgeReportCache,
) -> HostStateReportV3 {
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
    let lab_rows = if inspect_runtime {
        match db.load_all_vm_labs().await {
            Ok(rows) => rows,
            Err(error) => {
                warn!(error = %error, "failed to load persisted labs for bridge report");
                Vec::new()
            }
        }
    } else {
        // Lab transitions already have their own targeted VM report. Avoid
        // putting SQLite actor latency in the inventory freshness path.
        Vec::new()
    };
    let labs_by_vm = lab_rows
        .into_iter()
        .map(|row| ((row.run_id.clone(), row.vm_name.clone()), row))
        .collect::<BTreeMap<_, _>>();
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
    let (reported_hardware, reported_cached_images) = if inspect_runtime {
        let hardware = collect_host_hardware(attested_jailer.as_ref());
        let cached_images = match (desired, crate::image_cache::default_cache_root()) {
            (Some(state), Ok(cache_root)) => crate::image_cache::cached_image_states(
                &cache_root,
                &RequiredPins::from_desired_state(state),
            ),
            _ => Vec::new(),
        };
        *report_cache.hardware.write().await = hardware.clone();
        *report_cache.cached_images.write().await = cached_images.clone();
        (hardware, cached_images)
    } else {
        (
            report_cache.hardware.read().await.clone(),
            report_cache.cached_images.read().await.clone(),
        )
    };

    HostStateReportV3 {
        relay_connected: vm.relay_connected(),
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
        guest_contract: GUEST_CONTRACT,
        hardware: reported_hardware,
        cached_images: reported_cached_images,
        vms: statuses
            .into_iter()
            .zip(observations)
            .map(|(status, (inspection, terminal))| {
                let run_id = local_run_id(&status).unwrap_or_default();
                let current_generation = status
                    .details
                    .as_ref()
                    .and_then(|details| details.jail_generation.as_deref());
                let lab = labs_by_vm
                    .get(&(run_id, status.name.clone()))
                    .filter(|row| Some(row.jail_generation.as_str()) == current_generation)
                    .and_then(ReportedLab::from_row);
                vm_state_from_status(
                    ssh_host.as_deref(),
                    desired,
                    status,
                    lab,
                    inspection.as_ref(),
                    terminal.as_ref(),
                )
            })
            .collect(),
    }
}

/// A VM's latest lab and when its first report came, as reported.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ReportedLab {
    pub(super) lab: VmLabV1,
    pub(super) first_report_ms: Option<u64>,
}

impl ReportedLab {
    pub(super) fn from_row(row: &VmLabRow) -> Option<Self> {
        match serde_json::from_str::<VmLabV1>(&row.lab_json) {
            Ok(lab) => Some(Self {
                lab,
                first_report_ms: row.first_report_ms.and_then(|ms| u64::try_from(ms).ok()),
            }),
            Err(error) => {
                warn!(error = %error, vm = row.vm_name, "ignoring an unreadable persisted lab");
                None
            }
        }
    }
}

pub(super) async fn build_vm_report_from_lab_update(
    host_id: &str,
    vm: &VmManager,
    desired: Option<&HostDesiredStateV3>,
    update: &GuestUpdate,
) -> Option<VmReportV3> {
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
            "dropping stale-generation lab projection"
        );
        return None;
    }
    let terminal = vm.committed_terminal_state(&status.name).await;
    Some(build_vm_report_from_status(
        host_id,
        vm.ssh_advertised_host().as_deref(),
        desired,
        status,
        Some(ReportedLab {
            lab: update.lab.clone(),
            first_report_ms: update.first_report_ms,
        }),
        None,
        terminal.as_ref(),
    ))
}

pub(super) fn build_vm_report_from_status(
    host_id: &str,
    ssh_host: Option<&str>,
    desired: Option<&HostDesiredStateV3>,
    status: VmStatusResponse,
    lab: Option<ReportedLab>,
    inspection: Option<&VmInspection>,
    terminal: Option<&VmTerminalState>,
) -> VmReportV3 {
    let vm = vm_state_from_status(ssh_host, desired, status, lab, inspection, terminal);
    VmReportV3 {
        schema_version: VM_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        observed_at_unix_ms: vm.updated_at_unix_ms,
        vm,
    }
}

/// Every VM starts cold until the wake path lands.
pub(super) fn cold_start(first_report_ms: Option<u64>) -> VmStartV1 {
    VmStartV1 {
        path: VmStartPath::Cold,
        reason: None,
        first_report_ms,
    }
}

pub(super) fn vm_state_from_status(
    ssh_host: Option<&str>,
    desired: Option<&HostDesiredStateV3>,
    status: VmStatusResponse,
    lab: Option<ReportedLab>,
    inspection: Option<&VmInspection>,
    terminal: Option<&VmTerminalState>,
) -> VmStateV3 {
    let run_id = local_run_id(&status).unwrap_or_default();
    let desired_vm = desired.and_then(|state| {
        state.vms.iter().find(|vm| {
            vm.run_id == run_id
                && vm.vm_id == status.name
                && status.details.as_ref().is_some_and(|d| {
                    d.owner_user_id == vm.owner_user_id
                        && d.runtime_execution_id == vm.runtime_execution_id
                        && d.generation == vm.generation
                })
        })
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
    let details = status.details.as_ref();
    let (lab, first_report_ms) = match lab {
        Some(reported) => (Some(reported.lab), reported.first_report_ms),
        None => (None, None),
    };
    VmStateV3 {
        owner_user_id: details.map(|d| d.owner_user_id.clone()).unwrap_or_default(),
        runtime_execution_id: details
            .map(|d| d.runtime_execution_id.clone())
            .unwrap_or_default(),
        generation: details.map(|d| d.generation).unwrap_or_default(),
        phase: vm_phase_from_status(&status),
        run_id,
        // The local key is `vm_id`; the report names the machine.
        name: details
            .and_then(|d| d.machine_name.clone())
            .or_else(|| desired_vm.map(|vm| vm.name.clone()))
            .unwrap_or_else(|| status.name.clone()),
        desired_version: desired_vm.and_then(|_| desired.map(|state| state.version)),
        image: details
            .and_then(|d| d.image.clone())
            .or_else(|| desired_vm.map(|vm| vm.image.clone())),
        kino: details
            .and_then(|d| d.kino.clone())
            .or_else(|| desired_vm.map(|vm| vm.kino.clone())),
        start: Some(cold_start(first_report_ms)),
        network: network_state_from_status(&status, ssh_host),
        terminal: terminal_state,
        runtime_constraints,
        resource_state: resource_state_from_status(&status, inspection),
        sandbox: sandbox_state_from_status(&status, inspection),
        ssh_host_keys_openssh: details
            .map(|details| details.ssh_host_keys_openssh.clone())
            .unwrap_or_default(),
        lab,
        archive: archive_state_from_status(&status),
        error: status.error.clone(),
        updated_at_unix_ms,
    }
}

pub(super) fn failed_vm_report(
    host_id: &str,
    desired: &HostDesiredStateV3,
    vm: &DesiredVmV3,
    observed_at_unix_ms: i64,
    error: String,
) -> VmReportV3 {
    VmReportV3 {
        schema_version: VM_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        observed_at_unix_ms,
        vm: VmStateV3 {
            owner_user_id: vm.owner_user_id.clone(),
            runtime_execution_id: vm.runtime_execution_id.clone(),
            generation: vm.generation,
            run_id: vm.run_id.clone(),
            name: vm.name.clone(),
            desired_version: Some(desired.version),
            phase: VmPhaseV2::Failed,
            image: Some(vm.image.clone()),
            kino: Some(vm.kino.clone()),
            start: Some(cold_start(None)),
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
            lab: None,
            archive: None,
            error: Some(error),
            updated_at_unix_ms: observed_at_unix_ms,
        },
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
) -> Option<VmRuntimeConstraintsV2> {
    let details = status.details.as_ref()?;
    let generation = details.jail_generation.clone()?;
    let runtime = details.cpu_runtime.as_ref()?;
    Some(VmRuntimeConstraintsV2 {
        generation,
        cpu_millis: runtime.quota.cpu_millis,
        quota_verified_at_unix_ms: runtime
            .attestation
            .as_ref()
            .and_then(|attestation| i64::try_from(attestation.verified_at_unix_ms).ok()),
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

/// Ready means SSH is up in the guest (the readiness gate committed the VM
/// only after Kino said so) and the SSH forward is published.
pub(super) fn vm_phase_from_status(status: &VmStatusResponse) -> VmPhaseV2 {
    match status.state {
        VmLifecycleState::Queued => VmPhaseV2::Pending,
        VmLifecycleState::CachingImage => VmPhaseV2::PullingImage,
        VmLifecycleState::PreparingDisks => VmPhaseV2::CreatingDisks,
        VmLifecycleState::CreatingVm => {
            creating_vm_report_phase(runtime_constraints_from_status(status).is_some())
        }
        VmLifecycleState::BootingVm => VmPhaseV2::Booting,
        VmLifecycleState::Running => {
            if status
                .details
                .as_ref()
                .and_then(|details| details.ssh_public_port)
                .is_some()
            {
                VmPhaseV2::Ready
            } else {
                VmPhaseV2::Running
            }
        }
        VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts => VmPhaseV2::Stopping,
        VmLifecycleState::Failed | VmLifecycleState::DeleteFailed => VmPhaseV2::Failed,
    }
}

pub(super) fn creating_vm_report_phase(has_runtime_constraints: bool) -> VmPhaseV2 {
    if has_runtime_constraints {
        VmPhaseV2::Booting
    } else {
        // The external Booting phase requires a generation and live CPU
        // contract. Keep the pre-jailer launch window in disk/staging state;
        // persist_jail_launch emits another inventory revision as soon as the
        // boot quota is available.
        VmPhaseV2::CreatingDisks
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

pub(super) async fn load_lab_for_vm(
    db: &Db,
    run_id: &str,
    vm_name: &str,
    generation: Option<&str>,
) -> Option<ReportedLab> {
    match db.load_vm_lab(vm_name.to_string()).await {
        Ok(Some(row))
            if row.run_id == run_id && Some(row.jail_generation.as_str()) == generation =>
        {
            ReportedLab::from_row(&row)
        }
        Ok(_) => None,
        Err(error) => {
            warn!(error = %error, run_id, vm = vm_name, "failed to load the VM's lab");
            None
        }
    }
}

pub(super) fn collect_host_hardware(jailer: Option<&JailerCapabilities>) -> HostHardwareV1 {
    let cgroup_v2 = fs::read_to_string("/sys/fs/cgroup/cgroup.controllers")
        .is_ok_and(|value| value.split_whitespace().any(|item| item == "cpu"));
    HostHardwareV1 {
        cloud_hypervisor_sha256: jailer
            .map(|capabilities| capabilities.cloud_hypervisor_sha256.clone()),
        // The service deliberately runs with PrivateDevices=true. A successful
        // jailerd readiness attestation, not agent-visible device access, is
        // the authority for KVM availability and complete helper accounting.
        kvm: jailer.is_some_and(|capabilities| capabilities.supports_jailer_v2),
        vsock: true,
        reflink: supports_reflink_for_image_cache(),
        landlock: jailer.is_some_and(|capabilities| capabilities.supports_landlock),
        cgroup_v2: jailer.map_or(cgroup_v2, |capabilities| capabilities.supports_cgroup_v2),
        hard_cpu_quota: jailer.is_some_and(|capabilities| capabilities.supports_hard_cpu_quota),
    }
}

pub(super) fn resource_state_from_status(
    status: &VmStatusResponse,
    inspection: Option<&VmInspection>,
) -> Option<VmResourceStateV3> {
    let details = status.details.as_ref()?;
    let inspection = inspection?;
    if details.jail_generation.as_deref() != Some(inspection.generation.as_str()) {
        return None;
    }
    let cpu_stat = inspection.cpu_stat.as_ref();
    Some(VmResourceStateV3 {
        cpu_millis: inspection.cpu_quota.cpu_millis,
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
