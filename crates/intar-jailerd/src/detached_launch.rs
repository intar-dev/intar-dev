use super::*;

impl<B: HostBackend, P: JailPreparer> DetachedLaunchTask<B, P> {
    pub(super) fn execute(mut self) -> DetachedLaunchOutcome {
        let mut progress = DetachedLaunchProgress::default();
        let operation = (|| -> Result<(VmRecord, VmLaunchResult)> {
            self.preparer
                .validate_prepared_launch(&self.config, &self.prepared_request)
                .context("validate root-owned prepared image template")?;

            progress.identity_reserved = true;
            self.preparer
                .reserve_identity(
                    &self.config,
                    &self.reservation.generation,
                    self.reservation.uid,
                    self.reservation.gid,
                )
                .context("persist generation identity reservation")?;

            progress.jail_prepare_attempted = true;
            let prepared = self
                .preparer
                .prepare_v2(
                    &self.config,
                    &self.reservation.request,
                    &self.reservation.run_network.result,
                    &self.reservation.generation,
                    self.reservation.uid,
                    self.reservation.gid,
                )
                .context("prepare jail filesystem")?;

            progress.network_prepare_attempted = true;
            self.backend
                .ensure_vm_network(
                    &self.reservation.run_network.request,
                    &self.reservation.request,
                    &self.reservation.generation,
                    self.reservation.uid,
                    self.reservation.gid,
                )
                .context("prepare VM TAP and forwarding policy")?;

            let unit_name = vm_unit_name(&self.reservation.generation);
            let mut unit_spec = UnitLaunchSpec {
                generation: self.reservation.generation.clone(),
                unit_name: unit_name.clone(),
                description: format!(
                    "Intar jailed VM {} / {}",
                    self.reservation.request.run_id, self.reservation.request.vm_id
                ),
                jailer_binary: self.config.jailer_binary.clone(),
                jail_spec_path: prepared.spec_path.clone(),
                api_socket_path: prepared.paths.host_api_socket.clone(),
                cpu_quota: self.reservation.effective_quota,
                steady_cpu_quota: self.reservation.quota,
                boot_cpu_lease_ms: Some(self.config.boot_cpu_lease_ms),
                vmm_executable_identity: prepared.vmm_executable_identity,
                uid: self.reservation.uid,
                gid: self.reservation.gid,
                device_allow: JAIL_DEVICE_ALLOW.to_vec(),
            };
            let mut record = VmRecord {
                schema_version: VM_RECORD_METADATA_VERSION,
                generation: self.reservation.generation.clone(),
                request: self.reservation.request.clone(),
                request_fingerprint: self.reservation.request_fingerprint.clone(),
                run_network: self.reservation.run_network.clone(),
                unit_name: unit_name.clone(),
                uid: self.reservation.uid,
                gid: self.reservation.gid,
                quota: self.reservation.quota,
                effective_quota: self.reservation.effective_quota,
                cpu_phase: VmCpuPhase::BootBurst,
                boot_deadline_unix_ms: Some(self.reservation.boot_deadline_unix_ms),
                boot_deadline_monotonic: Some(self.reservation.boot_deadline_monotonic),
                quota_attestation: None,
                ssh_forward_active: false,
                vcpu_count: self.reservation.request.vcpu_count,
                paths: prepared.paths.clone(),
                cgroup_path: None,
                netns_name: self.reservation.run_network.result.namespace_name.clone(),
                host_boot_id: current_host_boot_id(),
                pid_start_time_ticks: None,
                jail_root_inode: prepared.jail_root_inode,
                cloud_hypervisor_sha256: self.config.cloud_hypervisor_sha256.as_str().to_owned(),
            };
            self.preparer
                .persist(&self.config, &record)
                .context("persist pre-launch VM intent")?;

            // Admission owns the lease start. Every operation before the unit
            // exists consumes part of the same 45-second budget rather than
            // granting a fresh lease when StartTransientUnit finally runs.
            unit_spec.boot_cpu_lease_ms = Some(remaining_boot_cpu_lease_ms(
                self.reservation.boot_deadline_monotonic,
                Instant::now(),
            )?);

            progress.unit_start_attempted = true;
            let started = self
                .backend
                .start_unit(&unit_spec)
                .context("start sandbox transient unit")?;
            ensure!(
                started.unit_name == unit_name,
                "backend returned mismatched transient unit name"
            );
            self.preparer
                .grant_agent_runtime_access(
                    &self.config,
                    &self.reservation.generation,
                    self.reservation.uid,
                    self.reservation.gid,
                )
                .context("grant agent access to Cloud Hypervisor API socket")?;

            record.cgroup_path.clone_from(&started.cgroup_path);
            record.host_boot_id.clone_from(&started.host_boot_id);
            record.pid_start_time_ticks = started.pid_start_time_ticks;
            record.quota_attestation = Some(
                quota_attestation(self.reservation.effective_quota)
                    .context("attest boot CPU quota")?,
            );
            self.preparer
                .persist(&self.config, &record)
                .context("persist VM sandbox identity")?;
            let cpu_runtime = record.cpu_runtime();
            let result = VmLaunchResult {
                generation: self.reservation.generation.clone(),
                unit_name,
                pid: started.pid,
                cgroup_path: started.cgroup_path,
                uid: self.reservation.uid,
                gid: self.reservation.gid,
                netns_name: self.reservation.run_network.result.namespace_name.clone(),
                netns_inode: self.reservation.run_network.result.namespace_inode,
                host_boot_id: started.host_boot_id,
                pid_start_time_ticks: started.pid_start_time_ticks,
                jail_root_inode: prepared.jail_root_inode,
                cloud_hypervisor_sha256: self.config.cloud_hypervisor_sha256.as_str().to_owned(),
                cpu_runtime,
                paths: prepared.paths,
            };
            Ok((record, result))
        })();

        match operation {
            Ok((record, result)) => {
                DetachedLaunchOutcome::Success(Box::new(DetachedLaunchSuccess {
                    reservation: self.reservation,
                    record,
                    result,
                }))
            }
            Err(error) => {
                let (cgroup_drain_proven, cleanup_failures, identity_released) =
                    cleanup_detached_launch(
                        &self.config,
                        &mut self.backend,
                        &mut self.preparer,
                        &self.reservation,
                        progress,
                    );
                DetachedLaunchOutcome::Failure(Box::new(DetachedLaunchFailure {
                    reservation: self.reservation,
                    error,
                    cgroup_drain_proven,
                    cleanup_failures,
                    identity_released,
                }))
            }
        }
    }
}

pub(super) fn cleanup_detached_launch<B: HostBackend, P: JailPreparer>(
    config: &JailerdConfig,
    backend: &mut B,
    preparer: &mut P,
    reservation: &LaunchReservation,
    progress: DetachedLaunchProgress,
) -> (bool, Vec<String>, bool) {
    let mut failures = Vec::new();
    let unit_name = vm_unit_name(&reservation.generation);
    let cgroup_drain_proven = if progress.unit_start_attempted {
        let stopped = match backend.stop_unit(&unit_name) {
            Ok(_) => true,
            Err(error) => {
                failures.push(format!("stop transient unit {unit_name}: {error:#}"));
                false
            }
        };
        let destroyed = match backend.destroy_unit(&unit_name) {
            Ok(_) => true,
            Err(error) => {
                failures.push(format!("destroy transient unit {unit_name}: {error:#}"));
                false
            }
        };
        stopped || destroyed
    } else {
        true
    };

    if cgroup_drain_proven {
        if progress.network_prepare_attempted
            && let Err(error) =
                backend.destroy_vm_network(&reservation.request.run_id, &reservation.generation)
        {
            failures.push(format!(
                "destroy VM network for generation {}: {error:#}",
                reservation.generation
            ));
        }
        if progress.jail_prepare_attempted
            && let Err(error) = preparer.quarantine(config, &reservation.generation)
        {
            failures.push(format!(
                "quarantine generation {}: {error:#}",
                reservation.generation
            ));
        }
    } else {
        failures.push(format!(
            "preserved VM network and generation {} because cgroup drain was not proven",
            reservation.generation
        ));
    }

    let identity_released = if !progress.identity_reserved {
        true
    } else if progress.identity_reserved && !progress.jail_prepare_attempted && cgroup_drain_proven
    {
        match preparer.release_identity_reservation(config, &reservation.generation) {
            Ok(()) => true,
            Err(error) => {
                failures.push(format!(
                    "release unused identity reservation for {}: {error:#}",
                    reservation.generation
                ));
                false
            }
        }
    } else {
        false
    };
    (cgroup_drain_proven, failures, identity_released)
}

pub(super) fn execute_existing_launch<B: HostBackend, P: JailPreparer>(
    config: &JailerdConfig,
    backend: &mut B,
    preparer: &mut P,
    record: VmRecord,
) -> DetachedExistingLaunchOutcome {
    let inspection = match backend.inspect_unit(&record.unit_name) {
        Ok(inspection) => inspection,
        Err(error) => {
            return DetachedExistingLaunchOutcome::InspectionFailed { record, error };
        }
    };
    if backend_identity_matches(&record, &inspection) {
        return DetachedExistingLaunchOutcome::Success { record, inspection };
    }

    let recovery = unresolved_recovery_for_record(&record);
    let mut containment = RecoveryContainmentOutcome::default();
    if let Err(error) =
        backend.set_vm_ssh_forwarding(&record.request.run_id, &record.generation, false)
    {
        containment.failures.push(format!(
            "close SSH ingress for mismatched generation {}: {error:#}",
            record.generation
        ));
    }
    let recovery_containment = attempt_recovered_containment(config, backend, preparer, &recovery);
    containment.cgroup_drain_proven = recovery_containment.cgroup_drain_proven;
    containment.failures.extend(recovery_containment.failures);
    DetachedExistingLaunchOutcome::IdentityMismatch {
        record,
        error: anyhow::anyhow!("idempotent launch found mismatched live VM identity"),
        containment,
    }
}

pub(super) fn existing_launch_result(
    record: VmRecord,
    inspection: BackendInspection,
) -> VmLaunchResult {
    let cpu_runtime = record.cpu_runtime();
    VmLaunchResult {
        generation: record.generation,
        unit_name: record.unit_name,
        pid: inspection.pid,
        cgroup_path: record.cgroup_path,
        uid: record.uid,
        gid: record.gid,
        netns_name: record.netns_name,
        netns_inode: record.run_network.result.namespace_inode,
        host_boot_id: record.host_boot_id,
        pid_start_time_ticks: record.pid_start_time_ticks,
        jail_root_inode: record.jail_root_inode,
        cloud_hypervisor_sha256: record.cloud_hypervisor_sha256,
        cpu_runtime,
        paths: record.paths,
    }
}

/// Fence the immutable identity captured before a detached idempotency check.
/// Finalization may legitimately change only the CPU lease, attestation, and
/// ingress fields while the lifecycle lock is dropped.
pub(super) fn detached_existing_identity_matches(expected: &VmRecord, current: &VmRecord) -> bool {
    expected.schema_version == current.schema_version
        && expected.generation == current.generation
        && expected.request == current.request
        && expected.request_fingerprint == current.request_fingerprint
        && expected.run_network == current.run_network
        && expected.unit_name == current.unit_name
        && expected.uid == current.uid
        && expected.gid == current.gid
        && expected.quota == current.quota
        && expected.vcpu_count == current.vcpu_count
        && expected.paths == current.paths
        && expected.cgroup_path == current.cgroup_path
        && expected.netns_name == current.netns_name
        && expected.host_boot_id == current.host_boot_id
        && expected.pid_start_time_ticks == current.pid_start_time_ticks
        && expected.jail_root_inode == current.jail_root_inode
        && expected.cloud_hypervisor_sha256 == current.cloud_hypervisor_sha256
}

pub(super) fn unresolved_recovery_for_record(record: &VmRecord) -> UnresolvedRecovery {
    UnresolvedRecovery {
        run_id: record.request.run_id.clone(),
        generation: record.generation.clone(),
        // Never trust a mutable or persisted unit name for containment.
        unit_name: vm_unit_name(&record.generation),
        uid: record.uid,
        gid: record.gid,
    }
}
