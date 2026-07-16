use super::*;

impl<B: HostBackend, P: JailPreparer> JailerdCore<B, P> {
    pub fn new(
        config: JailerdConfig,
        backend: B,
        preparer: P,
        total_cpu_millis: u64,
    ) -> Result<Self> {
        Self::new_with_readiness(
            config,
            backend,
            preparer,
            total_cpu_millis,
            HostReadiness::default(),
        )
    }

    pub fn new_with_readiness(
        config: JailerdConfig,
        mut backend: B,
        mut preparer: P,
        total_cpu_millis: u64,
        mut readiness: HostReadiness,
    ) -> Result<Self> {
        config.validate().context("validate jailerd config")?;
        if total_cpu_millis == 0 {
            bail!("host CPU capacity must be positive")
        }
        let fast_template_store = preparer.fast_template_store(&config);
        let current_boot_id = current_host_boot_id();
        let mut records = BTreeMap::new();
        let mut allocated_identities = preparer.recover_reserved_identities(&config)?;
        let mut active_identities = BTreeSet::new();
        let mut run_networks = BTreeMap::<ValidatedId, RunNetworkRecord>::new();
        let mut pending_cpu_reservations = BTreeMap::new();
        let mut unresolved_recoveries = BTreeMap::new();
        let mut recovery_clean = true;
        for mut record in preparer.recover(&config)? {
            if validate_recovered_record(&config, &record).is_err() {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            if record.host_boot_id.as_deref() != current_boot_id.as_deref() {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            let inspection = match backend.inspect_unit(&record.unit_name) {
                Ok(inspection) => inspection,
                Err(_) => {
                    contain_or_retain_recovered_record(
                        &config,
                        &mut backend,
                        &mut preparer,
                        &record,
                        &mut pending_cpu_reservations,
                        &mut unresolved_recoveries,
                    );
                    allocated_identities.insert(record.uid);
                    recovery_clean = false;
                    continue;
                }
            };
            if !matches!(
                inspection.health,
                SandboxHealth::Healthy | SandboxHealth::Exited
            ) || !backend_identity_matches(&record, &inspection)
                || (inspection.health == SandboxHealth::Healthy
                    && !live_api_ping(&record.paths.host_api_socket))
            {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            match run_networks.get(&record.request.run_id) {
                Some(existing) if existing != &record.run_network => {
                    contain_or_retain_recovered_record(
                        &config,
                        &mut backend,
                        &mut preparer,
                        &record,
                        &mut pending_cpu_reservations,
                        &mut unresolved_recoveries,
                    );
                    allocated_identities.insert(record.uid);
                    recovery_clean = false;
                    continue;
                }
                Some(_) => {}
                None => {
                    let actual = match backend.ensure_run_network(&record.run_network.request) {
                        Ok(actual) => actual,
                        Err(_) => {
                            contain_or_retain_recovered_record(
                                &config,
                                &mut backend,
                                &mut preparer,
                                &record,
                                &mut pending_cpu_reservations,
                                &mut unresolved_recoveries,
                            );
                            allocated_identities.insert(record.uid);
                            recovery_clean = false;
                            continue;
                        }
                    };
                    if actual != record.run_network.result {
                        contain_or_retain_recovered_record(
                            &config,
                            &mut backend,
                            &mut preparer,
                            &record,
                            &mut pending_cpu_reservations,
                            &mut unresolved_recoveries,
                        );
                        allocated_identities.insert(record.uid);
                        recovery_clean = false;
                        continue;
                    }
                    run_networks.insert(record.request.run_id.clone(), record.run_network.clone());
                }
            }
            let Some(cgroup_path) = record.cgroup_path.as_deref() else {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            };
            // Daemon restart ends every boot lease conservatively. Ingress is
            // still absent at this point, and is restored only for a record
            // that had durably completed finalization before the restart.
            if backend
                .update_unit_cpu_quota(&record.unit_name, cgroup_path, record.quota)
                .is_err()
            {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            record.cpu_phase = VmCpuPhase::Steady;
            record.effective_quota = record.quota;
            record.boot_deadline_unix_ms = None;
            record.quota_attestation = Some(quota_attestation(record.quota)?);
            if preparer.persist(&config, &record).is_err() {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            if backend
                .recover_vm_network(
                    &record.run_network.request,
                    &record.request,
                    &record.generation,
                    record.uid,
                    record.gid,
                )
                .is_err()
            {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            if record.ssh_forward_active
                && backend
                    .set_vm_ssh_forwarding(&record.request.run_id, &record.generation, true)
                    .is_err()
            {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            if !active_identities.insert(record.uid) {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            allocated_identities.insert(record.uid);
            records.insert(record.generation.clone(), record);
        }
        if !recovery_clean {
            readiness.privileged_self_test_passed = false;
            readiness.kvm_accounting_proven = false;
        }
        Ok(Self {
            config,
            backend,
            preparer,
            total_cpu_millis,
            records,
            pending_cpu_reservations,
            inflight_launches: BTreeMap::new(),
            unresolved_recoveries,
            allocated_identities,
            run_networks,
            readiness,
            fast_template_store,
        })
    }

    pub fn handle(&mut self, request: Request) -> Response {
        if let Err(error) = validate_protocol_request(&request) {
            return Response::Error(ProtocolError::new("invalid_request", format!("{error:#}")));
        }
        let policy_validation = match &request {
            Request::EnsureRunNetwork(request) | Request::RepairRunNetwork(request) => {
                self.config.validate_run_network_request(request)
            }
            Request::LaunchVmV2(request) => self
                .config
                .validate_ssh_public_port(request.launch.ssh_public_port),
            _ => Ok(()),
        };
        if let Err(error) = policy_validation {
            return Response::Error(ProtocolError::new("invalid_request", error.to_string()));
        }
        if matches!(request, Request::LaunchVmV2(_)) {
            let capabilities = self.capabilities();
            if !(capabilities.supports_jailer_v2
                && capabilities.supports_template_backed_launch
                && capabilities.fast_template_store)
            {
                return Response::Error(ProtocolError::new(
                    "host_not_ready",
                    "host readiness attestation does not permit template-backed VM launches",
                ));
            }
        }
        if matches!(request, Request::PrepareImageV2(_)) && !self.capabilities().supports_jailer_v2
        {
            return Response::Error(ProtocolError::new(
                "host_not_ready",
                "host readiness attestation does not permit template-backed image preparation",
            ));
        }
        match self.try_handle(request) {
            Ok(response) => response,
            Err(error) => {
                let message = format!("{error:#}");
                Response::Error(ProtocolError::new(
                    classify_protocol_error(&error, &message),
                    message,
                ))
            }
        }
    }

    pub(super) fn try_handle(&mut self, request: Request) -> Result<Response> {
        match request {
            Request::Capabilities => Ok(Response::Capabilities(self.capabilities())),
            Request::PrepareImageV2(request) => Ok(Response::PrepareImageV2(
                self.preparer.prepare_image_v2(&self.config, &request)?,
            )),
            Request::EnsureRunNetwork(request) => {
                request.validate().context("validate run network request")?;
                let result = self.backend.ensure_run_network(&request)?;
                let record = RunNetworkRecord {
                    request: request.clone(),
                    result: result.clone(),
                };
                match self.run_networks.get(&request.run_id) {
                    Some(existing) if existing != &record => {
                        bail!("run network already exists with different topology")
                    }
                    Some(_) => {}
                    None => {
                        self.run_networks.insert(request.run_id.clone(), record);
                    }
                }
                Ok(Response::EnsureRunNetwork(result))
            }
            Request::RepairRunNetwork(request) => {
                request
                    .validate()
                    .context("validate run network repair request")?;
                let record = self
                    .run_networks
                    .get(&request.run_id)
                    .cloned()
                    .context("cannot repair an untracked run network")?;
                if record.request != request {
                    bail!("run network repair topology differs from durable state")
                }
                let result = self.backend.repair_run_network(&request)?;
                if result != record.result {
                    bail!("repaired run network identity differs from durable state")
                }
                Ok(Response::RepairRunNetwork(result))
            }
            Request::LaunchVmV2(request) => Ok(Response::LaunchVmV2(self.launch_vm_v2(*request)?)),
            Request::FinalizeVmBoot(request) => {
                Ok(Response::FinalizeVmBoot(self.finalize_vm_boot(request)?))
            }
            Request::InspectVm(request) => Ok(Response::InspectVm(self.inspect_vm(request)?)),
            Request::StopVm(request) => Ok(Response::StopVm(OperationResult {
                changed: self.stop_vm(request)?,
            })),
            Request::DestroyVm(request) => Ok(Response::DestroyVm(OperationResult {
                changed: self.destroy_vm(request)?,
            })),
            Request::DestroyRunNetwork(request) => {
                if self
                    .records
                    .values()
                    .any(|record| record.request.run_id == request.run_id)
                {
                    bail!("run network still has VM generations")
                }
                let changed = self.backend.destroy_run_network(&request)?;
                self.run_networks.remove(&request.run_id);
                Ok(Response::DestroyRunNetwork(OperationResult { changed }))
            }
        }
    }

    pub fn capabilities(&self) -> JailerCapabilities {
        let committed_cpu_millis = self.committed_cpu_millis();
        let schedulable_cpu_millis = self
            .total_cpu_millis
            .saturating_sub(self.config.cpu_reserved_millis);
        let fast_template_store =
            self.fast_template_store && self.preparer.fast_template_store_ready(&self.config);
        let ready = self.backend.production_ready()
            && (self.readiness.uid_gid_range_collision_free
                || self.config.allow_uid_gid_collisions)
            && self.readiness.config_trusted
            && self.readiness.source_roots_trusted
            && self.readiness.jailer_binary_trusted
            && self.readiness.runtime_hash_verified
            && self.readiness.runtime_statically_linked
            && self.readiness.supports_systemd_transient_units
            && self.readiness.supports_cgroup_v2
            && self.readiness.seccomp_supported
            && self.readiness.posix_acl_supported
            && self.readiness.landlock_abi.is_some_and(|abi| abi >= 3)
            && self.readiness.privileged_self_test_passed
            && self.readiness.kvm_accounting_proven;
        JailerCapabilities {
            protocol_version: PROTOCOL_VERSION,
            cloud_hypervisor_version: CLOUD_HYPERVISOR_VERSION.to_owned(),
            cloud_hypervisor_sha256: CLOUD_HYPERVISOR_SHA256.to_owned(),
            total_cpu_millis: self.total_cpu_millis,
            reserved_cpu_millis: self.config.cpu_reserved_millis,
            schedulable_cpu_millis,
            committed_cpu_millis,
            supports_jailer_v2: ready && fast_template_store,
            supports_template_backed_launch: ready && fast_template_store,
            fast_template_store,
            supports_hard_cpu_quota: ready,
            supports_boot_cpu_lease: ready,
            boot_cpu_millis: self.config.boot_cpu_millis,
            boot_cpu_lease_ms: self.config.boot_cpu_lease_ms,
            supports_landlock: ready,
            supports_cgroup_v2: self.readiness.supports_cgroup_v2,
            uid_gid_start: self.config.uid_gid_start,
            uid_gid_end: self.config.uid_gid_end,
            uid_gid_range_collision_free: self.readiness.uid_gid_range_collision_free,
            config_trusted: self.readiness.config_trusted,
            source_roots_trusted: self.readiness.source_roots_trusted,
            jailer_binary_trusted: self.readiness.jailer_binary_trusted,
            runtime_hash_verified: self.readiness.runtime_hash_verified,
            runtime_statically_linked: self.readiness.runtime_statically_linked,
            systemd_version: self.readiness.systemd_version.clone(),
            supports_systemd_transient_units: self.readiness.supports_systemd_transient_units,
            seccomp_supported: self.readiness.seccomp_supported,
            landlock_abi: self.readiness.landlock_abi,
            privileged_self_test_passed: self.readiness.privileged_self_test_passed,
            kvm_accounting_proven: self.readiness.kvm_accounting_proven,
            allow_uid_gid_collisions: self.config.allow_uid_gid_collisions,
            allowed_source_roots: self.config.allowed_source_roots.clone(),
            posix_acl_supported: self.readiness.posix_acl_supported,
            guest_network_pool: self.config.guest_network_pool.clone(),
            run_guest_network_prefix: intar_jailer_protocol::RUN_GUEST_NETWORK_PREFIX,
            ssh_public_port_start: self.config.ssh_public_port_start,
            ssh_public_port_end: self.config.ssh_public_port_end,
        }
    }

    /// Snapshot the root-owned configuration needed for stateless image
    /// preparation. Production dispatch drops the core mutex before doing any
    /// source hashing or filesystem import so boot-lease enforcement cannot be
    /// delayed by a multi-GiB image.
    pub fn template_prepare_config(&self) -> Option<JailerdConfig> {
        self.capabilities()
            .supports_jailer_v2
            .then(|| self.config.clone())
    }

    pub(super) fn begin_detached_launch_vm_v2(
        &mut self,
        request: LaunchVmV2Request,
    ) -> Result<DetachedLaunchAdmission<B, P>>
    where
        B: Clone,
        P: Clone,
    {
        let quota = request
            .validate()
            .context("validate template-backed VM launch request")?;
        self.config
            .validate_ssh_public_port(request.launch.ssh_public_port)
            .context("validate root-owned SSH public port policy")?;
        let effective_quota =
            CpuQuota::from_millis(request.launch.cpu_millis.max(self.config.boot_cpu_millis))
                .context("derive root-owned boot CPU quota")?;
        let fingerprint = request_fingerprint(&request.launch)?;

        if let Some(existing) = self.records.values().find(|record| {
            record.request.run_id == request.launch.run_id
                && record.request.vm_id == request.launch.vm_id
        }) {
            if existing.request_fingerprint != fingerprint {
                bail!("logical VM already exists with a different launch request")
            }
            return Ok(DetachedLaunchAdmission::Existing(Box::new(
                DetachedExistingLaunchTask {
                    config: self.config.clone(),
                    backend: self.backend.clone(),
                    preparer: self.preparer.clone(),
                    record: existing.clone(),
                },
            )));
        }
        if let Some(existing) = self.inflight_launches.values().find(|reservation| {
            reservation.request.run_id == request.launch.run_id
                && reservation.request.vm_id == request.launch.vm_id
        }) {
            if existing.request_fingerprint != fingerprint {
                bail!("logical VM launch already exists with a different launch request")
            }
            return Err(BootCapacityPendingError {
                committed: self.committed_cpu_millis(),
                requested: existing.effective_quota.cpu_millis,
                steady: existing.quota.cpu_millis,
                schedulable: self
                    .total_cpu_millis
                    .saturating_sub(self.config.cpu_reserved_millis),
            }
            .into());
        }

        let run_network = self
            .run_networks
            .get(&request.launch.run_id)
            .context("run network must be ensured before launching a VM")?
            .clone();
        let schedulable = self
            .total_cpu_millis
            .saturating_sub(self.config.cpu_reserved_millis);
        let committed = self.committed_cpu_millis();
        let after_launch = committed
            .checked_add(u64::from(effective_quota.cpu_millis))
            .context("CPU admission arithmetic overflow")?;
        if after_launch > schedulable {
            return Err(BootCapacityPendingError {
                committed,
                requested: effective_quota.cpu_millis,
                steady: request.launch.cpu_millis,
                schedulable,
            }
            .into());
        }

        let generation = loop {
            let candidate =
                ValidatedId::parse(Uuid::new_v4().to_string()).expect("UUID is a valid generation");
            if !self.records.contains_key(&candidate)
                && !self.inflight_launches.contains_key(&candidate)
                && !self.pending_cpu_reservations.contains_key(&candidate)
            {
                break candidate;
            }
        };
        let admitted_at_monotonic = Instant::now();
        let boot_deadline_monotonic = admitted_at_monotonic
            .checked_add(Duration::from_millis(self.config.boot_cpu_lease_ms))
            .context("monotonic boot CPU lease deadline overflow")?;
        let boot_deadline_unix_ms = unix_time_millis()?
            .checked_add(self.config.boot_cpu_lease_ms)
            .context("boot CPU lease deadline overflow")?;
        let identity = self.allocate_identity()?;
        let reservation = LaunchReservation {
            generation: generation.clone(),
            request: request.launch.clone(),
            request_fingerprint: fingerprint,
            run_network,
            uid: identity,
            gid: identity,
            quota,
            effective_quota,
            boot_deadline_unix_ms,
            boot_deadline_monotonic,
        };

        // The reservation and its charge enter the lifecycle state in the same
        // critical section. Every concurrent admission therefore observes the
        // boot quota even though the expensive work runs after this lock drops.
        self.pending_cpu_reservations
            .insert(generation.clone(), effective_quota);
        self.inflight_launches
            .insert(generation, reservation.clone());

        Ok(DetachedLaunchAdmission::Reserved(Box::new(
            DetachedLaunchTask {
                config: self.config.clone(),
                backend: self.backend.clone(),
                preparer: self.preparer.clone(),
                reservation,
                prepared_request: request,
            },
        )))
    }

    pub(super) fn complete_detached_launch_vm_v2(
        &mut self,
        outcome: DetachedLaunchOutcome,
    ) -> Result<VmLaunchResult> {
        let reservation = match &outcome {
            DetachedLaunchOutcome::Success(success) => &success.reservation,
            DetachedLaunchOutcome::Failure(failure) => &failure.reservation,
        };
        if self.inflight_launches.get(&reservation.generation) != Some(reservation)
            || self.pending_cpu_reservations.get(&reservation.generation)
                != Some(&reservation.effective_quota)
        {
            self.readiness.privileged_self_test_passed = false;
            self.readiness.kvm_accounting_proven = false;
            bail!(
                "generation-fenced V2 launch commit rejected for {}",
                reservation.generation
            )
        }

        match outcome {
            DetachedLaunchOutcome::Success(success) => {
                ensure!(
                    success.record.generation == success.reservation.generation
                        && success.result.generation == success.reservation.generation,
                    "detached V2 launch returned a mismatched generation"
                );
                ensure!(
                    !self.records.values().any(|record| {
                        record.request.run_id == success.reservation.request.run_id
                            && record.request.vm_id == success.reservation.request.vm_id
                    }),
                    "logical VM was committed while its fenced launch was in flight"
                );
                let generation = success.reservation.generation.clone();
                self.records.insert(generation.clone(), success.record);
                self.pending_cpu_reservations.remove(&generation);
                self.inflight_launches.remove(&generation);
                self.unresolved_recoveries.remove(&generation);
                Ok(success.result)
            }
            DetachedLaunchOutcome::Failure(failure) => {
                let generation = failure.reservation.generation.clone();
                self.inflight_launches.remove(&generation);
                if failure.cgroup_drain_proven {
                    self.pending_cpu_reservations.remove(&generation);
                }
                if failure.identity_released {
                    self.allocated_identities.remove(&failure.reservation.uid);
                }
                if failure.cleanup_failures.is_empty() {
                    self.unresolved_recoveries.remove(&generation);
                    Err(failure.error)
                } else {
                    self.unresolved_recoveries.insert(
                        generation.clone(),
                        UnresolvedRecovery {
                            run_id: failure.reservation.request.run_id,
                            generation: generation.clone(),
                            unit_name: vm_unit_name(&generation),
                            uid: failure.reservation.uid,
                            gid: failure.reservation.gid,
                        },
                    );
                    self.readiness.privileged_self_test_passed = false;
                    self.readiness.kvm_accounting_proven = false;
                    Err(failure.error.context(format!(
                        "detached launch containment was incomplete: {}",
                        failure.cleanup_failures.join("; ")
                    )))
                }
            }
        }
    }

    pub(super) fn complete_detached_existing_launch(
        &mut self,
        outcome: DetachedExistingLaunchOutcome,
    ) -> Result<VmLaunchResult> {
        match outcome {
            DetachedExistingLaunchOutcome::Success { record, inspection } => {
                let generation = record.generation.clone();
                let current = self
                    .records
                    .get(&generation)
                    .cloned()
                    .context("VM generation was removed during detached idempotency check")?;
                if !detached_existing_identity_matches(&record, &current) {
                    self.readiness.privileged_self_test_passed = false;
                    self.readiness.kvm_accounting_proven = false;
                    bail!("generation-fenced idempotent launch commit rejected for {generation}")
                }
                ensure!(
                    backend_identity_matches(&current, &inspection),
                    "detached idempotent launch returned a stale backend identity"
                );
                Ok(existing_launch_result(current, inspection))
            }
            DetachedExistingLaunchOutcome::InspectionFailed { record, error } => {
                match self.records.get(&record.generation) {
                    Some(current) if detached_existing_identity_matches(&record, current) => {
                        Err(error)
                    }
                    Some(_) => {
                        self.readiness.privileged_self_test_passed = false;
                        self.readiness.kvm_accounting_proven = false;
                        Err(error.context(format!(
                            "generation-fenced idempotent inspection commit rejected for {}",
                            record.generation
                        )))
                    }
                    None => Err(error.context(format!(
                        "VM generation {} was removed during detached idempotency inspection",
                        record.generation
                    ))),
                }
            }
            DetachedExistingLaunchOutcome::IdentityMismatch {
                record,
                error,
                mut containment,
            } => {
                let generation = record.generation.clone();
                self.readiness.privileged_self_test_passed = false;
                self.readiness.kvm_accounting_proven = false;

                let Some(current) = self.records.get(&generation).cloned() else {
                    // A concurrent destroy removes the authoritative record only
                    // after the backend has proven the unit drained.
                    return Err(error.context(format!(
                        "VM generation {generation} was concurrently removed after identity mismatch"
                    )));
                };
                // Repeat the ingress revocation while holding the lifecycle
                // lock. A concurrent finalizer may have installed DNAT after
                // the detached containment task's first revocation, but it
                // cannot race this final state transition.
                if let Err(error) =
                    self.backend
                        .set_vm_ssh_forwarding(&record.request.run_id, &generation, false)
                {
                    containment.failures.push(format!(
                        "commit SSH ingress revocation for mismatched generation {generation}: {error:#}"
                    ));
                }
                let fence_matches = detached_existing_identity_matches(&record, &current);
                let conservative_quota = CpuQuota::from_millis(
                    self.config.boot_cpu_millis.max(record.request.cpu_millis),
                )
                .context("derive conservative CPU charge for mismatched generation")?;
                let recovery = unresolved_recovery_for_record(&record);

                if fence_matches {
                    // The addressable record must disappear in the same locked
                    // transition that installs any conservative capacity hold.
                    self.records.remove(&generation);
                }
                if containment.cgroup_drain_proven {
                    self.pending_cpu_reservations.remove(&generation);
                } else {
                    self.pending_cpu_reservations
                        .insert(generation.clone(), conservative_quota);
                }
                if containment.failures.is_empty() {
                    self.unresolved_recoveries.remove(&generation);
                } else {
                    self.unresolved_recoveries
                        .insert(generation.clone(), recovery);
                }

                let mut context = if fence_matches {
                    String::new()
                } else {
                    format!(
                        "generation-fenced mismatch commit rejected for {generation}; authoritative record retained"
                    )
                };
                if !containment.failures.is_empty() {
                    if !context.is_empty() {
                        context.push_str("; ");
                    }
                    context.push_str("identity-mismatch containment was incomplete: ");
                    context.push_str(&containment.failures.join("; "));
                }
                if context.is_empty() {
                    Err(error)
                } else {
                    Err(error.context(context))
                }
            }
        }
    }
}
