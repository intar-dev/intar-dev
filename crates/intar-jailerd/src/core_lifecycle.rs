use super::*;

impl<B: HostBackend, P: JailPreparer> JailerdCore<B, P> {
    pub(super) fn launch_vm_v2(&mut self, request: LaunchVmV2Request) -> Result<VmLaunchResult> {
        let quota = request
            .validate()
            .context("validate template-backed VM launch request")?;
        self.preparer
            .validate_prepared_launch(&self.config, &request)
            .context("validate root-owned prepared image template")?;
        self.launch_vm_validated(request.launch, quota, false)
    }

    pub(super) fn launch_vm_v3(&mut self, request: LaunchVmV3Request) -> Result<VmLaunchResult> {
        let quota = request
            .validate()
            .context("validate v3 template-backed VM launch request")?;
        self.preparer
            .validate_prepared_launch_v3(&self.config, &request)
            .context("validate root-owned chunked image template")?;
        self.launch_vm_validated(request.launch, quota, true)
    }

    pub(super) fn launch_vm_validated(
        &mut self,
        request: VmLaunchRequest,
        quota: CpuQuota,
        use_v3: bool,
    ) -> Result<VmLaunchResult> {
        let effective_quota =
            CpuQuota::from_millis(request.cpu_millis.max(self.config.boot_cpu_millis))
                .context("derive root-owned boot CPU quota")?;
        self.config
            .validate_ssh_public_port(request.ssh_public_port)
            .context("validate root-owned SSH public port policy")?;
        let fingerprint = request_fingerprint(&request)?;
        if let Some(existing) = self.records.values().find(|record| {
            record.request.run_id == request.run_id && record.request.vm_id == request.vm_id
        }) {
            if existing.request_fingerprint != fingerprint {
                bail!("logical VM already exists with a different launch request")
            }
            return self.launch_result(existing.clone());
        }
        let run_network = self
            .run_networks
            .get(&request.run_id)
            .context("run network must be ensured before launching a VM")?
            .clone();
        let generation =
            ValidatedId::parse(Uuid::new_v4().to_string()).expect("UUID is a valid generation");
        if self.records.contains_key(&generation) {
            bail!("generation {generation} already exists")
        }
        let schedulable = self
            .total_cpu_millis
            .saturating_sub(self.config.cpu_reserved_millis);
        let after_launch = self
            .committed_cpu_millis()
            .checked_add(u64::from(effective_quota.cpu_millis))
            .context("CPU admission arithmetic overflow")?;
        if after_launch > schedulable {
            return Err(BootCapacityPendingError {
                committed: self.committed_cpu_millis(),
                requested: effective_quota.cpu_millis,
                steady: request.cpu_millis,
                schedulable,
            }
            .into());
        }

        let admitted_at_monotonic = Instant::now();
        let boot_deadline_monotonic = admitted_at_monotonic
            .checked_add(Duration::from_millis(self.config.boot_cpu_lease_ms))
            .context("monotonic boot CPU lease deadline overflow")?;
        let boot_deadline_unix_ms = Some(
            unix_time_millis()?
                .checked_add(self.config.boot_cpu_lease_ms)
                .context("boot CPU lease deadline overflow")?,
        );

        let identity = self.allocate_identity()?;
        self.preparer
            .reserve_identity(&self.config, &generation, identity, identity)?;
        let prepare_result = if use_v3 {
            self.preparer.prepare_v3(
                &self.config,
                &request,
                &run_network.result,
                &generation,
                identity,
                identity,
            )
        } else {
            self.preparer.prepare_v2(
                &self.config,
                &request,
                &run_network.result,
                &generation,
                identity,
                identity,
            )
        };
        let prepared = match prepare_result {
            Ok(prepared) => prepared,
            Err(error) => {
                return Err(error).context("prepare jail filesystem");
            }
        };
        if let Err(error) = self.backend.ensure_vm_network(
            &run_network.request,
            &request,
            &generation,
            identity,
            identity,
        ) {
            let _ = self
                .backend
                .destroy_vm_network(&request.run_id, &generation);
            let _ = self.preparer.quarantine(&self.config, &generation);
            return Err(error).context("prepare VM TAP and forwarding policy");
        }
        let unit_name = vm_unit_name(&generation);
        let mut unit_spec = UnitLaunchSpec {
            generation: generation.clone(),
            unit_name: unit_name.clone(),
            description: format!("Intar jailed VM {} / {}", request.run_id, request.vm_id),
            jailer_binary: self.config.jailer_binary.clone(),
            jail_spec_path: prepared.spec_path.clone(),
            api_socket_path: prepared.paths.host_api_socket.clone(),
            cpu_quota: effective_quota,
            steady_cpu_quota: quota,
            boot_cpu_lease_ms: Some(self.config.boot_cpu_lease_ms),
            vmm_executable_identity: prepared.vmm_executable_identity,
            uid: identity,
            gid: identity,
            // The jailer creates these four device nodes after pivot_root, so
            // systemd's closed device policy must grant its distinct `m`
            // permission as well as the VMM's runtime access. Cloud
            // Hypervisor cannot create devices after the jailer clears every
            // capability set.
            device_allow: JAIL_DEVICE_ALLOW.to_vec(),
        };
        let mut record = VmRecord {
            schema_version: VM_RECORD_METADATA_VERSION,
            generation: generation.clone(),
            request: request.clone(),
            request_fingerprint: fingerprint,
            run_network: run_network.clone(),
            unit_name: unit_name.clone(),
            uid: identity,
            gid: identity,
            quota,
            effective_quota,
            cpu_phase: VmCpuPhase::BootBurst,
            boot_deadline_unix_ms,
            boot_deadline_monotonic: Some(boot_deadline_monotonic),
            quota_attestation: None,
            ssh_forward_active: false,
            vcpu_count: request.vcpu_count,
            paths: prepared.paths.clone(),
            cgroup_path: None,
            netns_name: run_network.result.namespace_name.clone(),
            host_boot_id: current_host_boot_id(),
            pid_start_time_ticks: None,
            jail_root_inode: prepared.jail_root_inode,
            cloud_hypervisor_sha256: self.config.cloud_hypervisor_sha256.as_str().to_owned(),
        };
        if let Err(error) = self.preparer.persist(&self.config, &record) {
            let _ = self
                .backend
                .destroy_vm_network(&request.run_id, &generation);
            let _ = self.preparer.quarantine(&self.config, &generation);
            return Err(error).context("persist pre-launch VM intent");
        }
        unit_spec.boot_cpu_lease_ms =
            match remaining_boot_cpu_lease_ms(boot_deadline_monotonic, Instant::now()) {
                Ok(remaining_ms) => Some(remaining_ms),
                Err(error) => {
                    let _ = self
                        .backend
                        .destroy_vm_network(&request.run_id, &generation);
                    let _ = self.preparer.quarantine(&self.config, &generation);
                    return Err(error).context("start VM within admitted boot CPU lease");
                }
            };
        // Charge the full boot allocation before the first operation that can
        // create a live cgroup. From this point every failure must either
        // prove cgroup drain or retain this conservative reservation.
        self.pending_cpu_reservations
            .insert(generation.clone(), effective_quota);
        self.unresolved_recoveries.insert(
            generation.clone(),
            UnresolvedRecovery {
                run_id: request.run_id.clone(),
                generation: generation.clone(),
                unit_name: unit_name.clone(),
                uid: identity,
                gid: identity,
            },
        );
        let started = match self.backend.start_unit(&unit_spec) {
            Ok(started) => started,
            Err(error) => {
                return self.fail_launch(
                    &request.run_id,
                    &generation,
                    &unit_name,
                    error.context("start sandbox transient unit"),
                );
            }
        };
        if started.unit_name != unit_name {
            return self.fail_launch(
                &request.run_id,
                &generation,
                &unit_name,
                anyhow::anyhow!("backend returned mismatched transient unit name"),
            );
        }
        if let Err(error) =
            self.preparer
                .grant_agent_runtime_access(&self.config, &generation, identity, identity)
        {
            return self.fail_launch(
                &request.run_id,
                &generation,
                &unit_name,
                error.context("grant agent access to Cloud Hypervisor API socket"),
            );
        }
        record.cgroup_path.clone_from(&started.cgroup_path);
        record.host_boot_id.clone_from(&started.host_boot_id);
        record.pid_start_time_ticks = started.pid_start_time_ticks;
        record.quota_attestation = match quota_attestation(effective_quota) {
            Ok(attestation) => Some(attestation),
            Err(error) => {
                return self.fail_launch(
                    &request.run_id,
                    &generation,
                    &unit_name,
                    error.context("attest boot CPU quota"),
                );
            }
        };
        if let Err(error) = self.preparer.persist(&self.config, &record) {
            return self.fail_launch(
                &request.run_id,
                &generation,
                &unit_name,
                error.context("persist VM sandbox identity"),
            );
        }
        let cpu_runtime = record.cpu_runtime();
        self.records.insert(generation.clone(), record);
        self.pending_cpu_reservations.remove(&generation);
        self.unresolved_recoveries.remove(&generation);
        Ok(VmLaunchResult {
            generation,
            unit_name,
            pid: started.pid,
            cgroup_path: started.cgroup_path,
            uid: identity,
            gid: identity,
            netns_name: run_network.result.namespace_name,
            netns_inode: run_network.result.namespace_inode,
            host_boot_id: started.host_boot_id,
            pid_start_time_ticks: started.pid_start_time_ticks,
            jail_root_inode: prepared.jail_root_inode,
            cloud_hypervisor_sha256: self.config.cloud_hypervisor_sha256.as_str().to_owned(),
            cpu_runtime,
            paths: prepared.paths,
        })
    }

    pub(super) fn fail_launch<T>(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
        unit_name: &str,
        failure: anyhow::Error,
    ) -> Result<T> {
        let mut cgroup_drain_proven = false;
        match self.rollback_failed_launch(run_id, generation, unit_name, &mut cgroup_drain_proven) {
            Ok(()) => {
                self.pending_cpu_reservations.remove(generation);
                self.unresolved_recoveries.remove(generation);
                Err(failure)
            }
            Err(rollback_error) => {
                if cgroup_drain_proven {
                    self.pending_cpu_reservations.remove(generation);
                }
                // An unproven drain is both an accounting and isolation
                // failure. Keep the boot charge and revoke launch readiness
                // until recovery can conclusively seal or remove the unit.
                self.readiness.privileged_self_test_passed = false;
                self.readiness.kvm_accounting_proven = false;
                Err(failure.context(format!(
                    "failed-launch rollback was incomplete; retained conservative boot CPU reservation: {rollback_error:#}"
                )))
            }
        }
    }

    pub(super) fn rollback_failed_launch(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
        unit_name: &str,
        cgroup_drain_proven: &mut bool,
    ) -> Result<()> {
        let mut failures = Vec::new();
        let stop_proved_drain = match self.backend.stop_unit(unit_name) {
            Ok(_) => true,
            Err(error) => {
                failures.push(format!("stop transient unit {unit_name}: {error:#}"));
                false
            }
        };
        let destroy_proved_drain = match self.backend.destroy_unit(unit_name) {
            Ok(_) => true,
            Err(error) => {
                failures.push(format!("destroy transient unit {unit_name}: {error:#}"));
                false
            }
        };
        *cgroup_drain_proven = stop_proved_drain || destroy_proved_drain;
        if *cgroup_drain_proven {
            if let Err(error) = self.backend.destroy_vm_network(run_id, generation) {
                failures.push(format!(
                    "destroy VM network for generation {generation}: {error:#}"
                ));
            }
            if let Err(error) = self.preparer.quarantine(&self.config, generation) {
                failures.push(format!("quarantine generation {generation}: {error:#}"));
            }
        } else {
            failures.push(format!(
                "preserved VM network and generation {generation} because cgroup drain was not proven"
            ));
        }
        if failures.is_empty() {
            Ok(())
        } else {
            bail!(failures.join("; "))
        }
    }

    pub(super) fn launch_result(&mut self, record: VmRecord) -> Result<VmLaunchResult> {
        // This is a same-daemon retry of a launch whose `start_unit` handshake
        // already verified the API socket before the record was persisted and
        // inserted. Re-pinging here turns a transient API stall into destructive
        // quarantine and makes the idempotency response race VMM API readiness.
        // Recovery and InspectVm remain the liveness authorities and still
        // require a successful API ping for a healthy process.
        let outcome =
            execute_existing_launch(&self.config, &mut self.backend, &mut self.preparer, record);
        self.complete_detached_existing_launch(outcome)
    }

    pub(super) fn finalize_vm_boot(
        &mut self,
        request: FinalizeVmBootRequest,
    ) -> Result<FinalizeVmBootResult> {
        let generation = request.generation;
        let phase_changed = self.seal_vm_cpu(&generation)?;
        let mut record = self
            .records
            .get(&generation)
            .context("unknown jail generation")?
            .clone();
        let forwarding_changed =
            self.backend
                .set_vm_ssh_forwarding(&record.request.run_id, &record.generation, true)?;
        let forward_active = record.request.ssh_public_port.is_some();
        if record.ssh_forward_active != forward_active {
            record.ssh_forward_active = forward_active;
            if let Err(error) = self.preparer.persist(&self.config, &record) {
                let rollback = self.backend.set_vm_ssh_forwarding(
                    &record.request.run_id,
                    &record.generation,
                    false,
                );
                return match rollback {
                    Ok(_) => Err(error).context("persist activated SSH forwarding state"),
                    Err(rollback_error) => self.contain_failed_boot_seal(
                        &record,
                        error.context(format!(
                            "persist activated SSH forwarding state; ingress rollback also failed: {rollback_error:#}"
                        )),
                    ),
                };
            }
            self.records.insert(generation.clone(), record.clone());
        }
        Ok(FinalizeVmBootResult {
            generation,
            changed: phase_changed || forwarding_changed,
            ssh_forward_active: record.ssh_forward_active,
            cpu_runtime: record.cpu_runtime(),
        })
    }

    /// Seal every expired boot lease without publishing SSH ingress. The
    /// daemon watchdog calls this even when the agent is disconnected.
    pub fn enforce_boot_deadlines(&mut self) -> Result<usize> {
        let monotonic_now = Instant::now();
        let unix_now_ms = unix_time_millis()?;
        let mut failures = self.retry_unresolved_recoveries();
        let expired = self
            .records
            .values()
            .filter(|record| {
                record.cpu_phase == VmCpuPhase::BootBurst
                    && boot_cpu_lease_expired(
                        record.boot_deadline_monotonic,
                        record.boot_deadline_unix_ms,
                        monotonic_now,
                        unix_now_ms,
                    )
            })
            .map(|record| record.generation.clone())
            .collect::<Vec<_>>();
        let mut sealed = 0;
        for generation in expired {
            match self.seal_vm_cpu(&generation) {
                Ok(true) => sealed += 1,
                Ok(false) => {}
                Err(error) => failures.push(format!("{generation}: {error:#}")),
            }
        }
        if failures.is_empty() {
            Ok(sealed)
        } else {
            bail!(
                "boot CPU lease watchdog sealed {sealed} VM(s) but failed for: {}",
                failures.join("; ")
            )
        }
    }

    pub(super) fn retry_unresolved_recoveries(&mut self) -> Vec<String> {
        let generations = self
            .unresolved_recoveries
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut failures = Vec::new();
        for generation in generations {
            let Some(recovery) = self.unresolved_recoveries.get(&generation).cloned() else {
                continue;
            };
            let outcome = attempt_recovered_containment(
                &self.config,
                &mut self.backend,
                &mut self.preparer,
                &recovery,
            );
            if outcome.cgroup_drain_proven {
                self.pending_cpu_reservations.remove(&generation);
            }
            if outcome.failures.is_empty() {
                self.unresolved_recoveries.remove(&generation);
            } else {
                failures.push(format!(
                    "{} recovery containment: {}",
                    generation,
                    outcome.failures.join("; ")
                ));
            }
        }
        failures
    }

    pub(super) fn seal_vm_cpu(&mut self, generation: &ValidatedId) -> Result<bool> {
        let mut record = self
            .records
            .get(generation)
            .context("unknown jail generation")?
            .clone();
        let phase_changed = record.cpu_phase == VmCpuPhase::BootBurst;
        let cgroup_path = record
            .cgroup_path
            .as_deref()
            .context("VM cgroup identity is not persisted")?;
        if let Err(error) =
            self.backend
                .update_unit_cpu_quota(&record.unit_name, cgroup_path, record.quota)
        {
            return self.contain_failed_boot_seal(&record, error);
        }
        record.cpu_phase = VmCpuPhase::Steady;
        record.effective_quota = record.quota;
        record.boot_deadline_unix_ms = None;
        record.boot_deadline_monotonic = None;
        record.quota_attestation = Some(quota_attestation(record.quota)?);
        if let Err(error) = self.preparer.persist(&self.config, &record) {
            return self.contain_failed_boot_seal(
                &record,
                error.context("persist sealed CPU quota state"),
            );
        }
        self.records.insert(generation.clone(), record);
        Ok(phase_changed)
    }

    pub(super) fn contain_failed_boot_seal<T>(
        &mut self,
        record: &VmRecord,
        failure: anyhow::Error,
    ) -> Result<T> {
        self.readiness.privileged_self_test_passed = false;
        self.readiness.kvm_accounting_proven = false;
        let mut cgroup_drain_proven = false;
        match self.rollback_failed_launch(
            &record.request.run_id,
            &record.generation,
            &record.unit_name,
            &mut cgroup_drain_proven,
        ) {
            Ok(()) => {
                self.records.remove(&record.generation);
                Err(failure).context("boot CPU seal failed; VM was stopped and quarantined")
            }
            Err(containment_error) => Err(failure).context(format!(
                "boot CPU seal failed; containment was incomplete: {containment_error:#}"
            )),
        }
    }

    pub(super) fn inspect_vm(&mut self, request: VmIdentityRequest) -> Result<VmInspection> {
        let generation = self.resolve_generation(&request)?;
        let record = self
            .records
            .get(&generation)
            .context("unknown jail generation")?
            .clone();
        let inspection = self.backend.inspect_unit(&record.unit_name)?;
        if !backend_identity_matches(&record, &inspection)
            || (inspection.health == SandboxHealth::Healthy
                && !live_api_ping(&record.paths.host_api_socket))
        {
            self.backend.stop_unit(&record.unit_name)?;
            self.backend.destroy_unit(&record.unit_name)?;
            let _ = self
                .backend
                .destroy_vm_network(&record.request.run_id, &record.generation);
            self.preparer.quarantine(&self.config, &record.generation)?;
            bail!("live VM identity does not match persisted sandbox metadata")
        }
        let cpu_runtime = record.cpu_runtime();
        Ok(VmInspection {
            generation: record.generation,
            unit_name: record.unit_name,
            pid: inspection.pid,
            cgroup_path: inspection.cgroup_path,
            uid: record.uid,
            gid: record.gid,
            netns_name: record.netns_name,
            netns_inode: record.run_network.result.namespace_inode,
            host_boot_id: inspection.host_boot_id,
            pid_start_time_ticks: inspection.pid_start_time_ticks,
            jail_root_inode: record.jail_root_inode,
            cloud_hypervisor_sha256: inspection
                .executable_sha256
                .unwrap_or(record.cloud_hypervisor_sha256),
            cpu_quota: record.quota,
            cpu_runtime,
            vcpu_count: record.vcpu_count,
            health: inspection.health,
            cpu_stat: inspection.cpu_stat,
            seccomp_enabled: inspection.seccomp_enabled,
            landlock_enabled: inspection.landlock_enabled,
            no_new_privs: inspection.no_new_privs,
            capabilities_empty: inspection.capabilities_empty,
            paths: record.paths,
        })
    }

    pub(super) fn stop_vm(&mut self, request: VmIdentityRequest) -> Result<bool> {
        let generation = self.resolve_generation(&request)?;
        let record = self
            .records
            .get(&generation)
            .context("unknown jail generation")?;
        let changed = self.backend.stop_unit(&record.unit_name)?;
        self.preparer.export_recording(&self.config, record)?;
        Ok(changed)
    }

    pub(super) fn destroy_vm(&mut self, request: VmIdentityRequest) -> Result<bool> {
        let generation = self.resolve_generation(&request)?;
        let Some(record) = self.records.get(&generation).cloned() else {
            let unit_name = format!("intar-vm-{generation}.service");
            let backend_changed = self.backend.destroy_unit(&unit_name)?;
            let files_changed = self.preparer.destroy(&self.config, &generation)?;
            return Ok(backend_changed || files_changed);
        };
        self.preparer
            .reserve_identity(&self.config, &generation, record.uid, record.gid)?;
        // The inactive transient unit may already have been garbage-collected
        // while the agent archived VM artifacts. The backend is the final
        // authority here: it must refuse a live unit, remove a drained unit,
        // and return `false` when systemd has already removed it.
        let backend_changed = self.backend.destroy_unit(&record.unit_name)?;
        let network_changed = self
            .backend
            .destroy_vm_network(&record.request.run_id, &generation)?;
        let files_changed = self.preparer.destroy(&self.config, &generation)?;
        self.records.remove(&generation);
        self.preparer
            .release_identity_reservation(&self.config, &generation)?;
        self.allocated_identities.remove(&record.uid);
        debug_assert_eq!(record.uid, record.gid);
        Ok(backend_changed || network_changed || files_changed)
    }

    pub(super) fn committed_cpu_millis(&self) -> u64 {
        let committed: u64 = self
            .records
            .values()
            .map(|record| u64::from(record.effective_quota().cpu_millis))
            .sum();
        committed.saturating_add(
            self.pending_cpu_reservations
                .values()
                .map(|quota| u64::from(quota.cpu_millis))
                .sum(),
        )
    }

    pub(super) fn allocate_identity(&mut self) -> Result<u32> {
        for candidate in self.config.uid_gid_start..=self.config.uid_gid_end {
            if self.allocated_identities.insert(candidate) {
                return Ok(candidate);
            }
        }
        bail!("VM UID/GID allocation range is exhausted")
    }

    pub(super) fn resolve_generation(&self, request: &VmIdentityRequest) -> Result<ValidatedId> {
        request.validate().context("validate VM selector")?;
        if let Some(generation) = &request.generation {
            return Ok(generation.clone());
        }
        let run_id = request.run_id.as_ref().expect("validated logical run ID");
        let vm_id = request.vm_id.as_ref().expect("validated logical VM ID");
        self.records
            .values()
            .find(|record| record.request.run_id == *run_id && record.request.vm_id == *vm_id)
            .map(|record| record.generation.clone())
            .context("unknown jail generation")
    }
}
