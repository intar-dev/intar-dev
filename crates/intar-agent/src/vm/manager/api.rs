use super::*;

impl VmManager {
    pub fn new(cfg: &AgentConfig, db: Db, persisted: Vec<VmRow>) -> Result<Self> {
        let mut states = BTreeMap::new();
        for row in persisted {
            match vm_status_from_row(row) {
                Ok(vm) => {
                    states.insert(vm.name.clone(), vm);
                }
                Err(e) => {
                    warn!(error = %e, "skipping invalid vm row from sqlite");
                }
            }
        }

        let (kino_readiness_tx, _) = broadcast::channel(256);
        let (probe_updates_tx, _) = broadcast::channel(256);
        let (terminal_updates_tx, _) = broadcast::channel(256);
        let (inventory_updates_tx, _) = watch::channel(0);
        let inner = Inner {
            ch_spawn_timeout_seconds: cfg.cloud_hypervisor.spawn_timeout_seconds,
            jailer_socket: cfg.jailer.socket.clone(),
            jailer_request_timeout_seconds: cfg.jailer.request_timeout_seconds,
            jailer_launch_capabilities: OnceCell::new(),
            bridge: cfg.bridge.clone(),
            ssh_access: cfg.ssh_access.clone(),
            db,
            http: HttpClient::builder()
                .connect_timeout(ARCHIVE_HTTP_CONNECT_TIMEOUT)
                // Bound an idle response as well as the whole archive
                // request. Archive jobs are durable and retryable, so one
                // stuck control-plane request must not hold the archive lock
                // indefinitely.
                .read_timeout(ARCHIVE_HTTP_READ_TIMEOUT)
                .timeout(ARCHIVE_HTTP_TOTAL_TIMEOUT)
                .build()
                .context("failed to initialize archive HTTP client")?,
            defaults: cfg.vm_defaults.clone(),
            states: RwLock::new(states),
            lease_expiry_error_log: RwLock::new(BTreeMap::new()),
            probe_tasks: Mutex::new(BTreeMap::new()),
            kino_readiness_tx,
            probe_updates_tx,
            run_cli_access_token: Mutex::new(RunCliAccessTokenCache::default()),
            run_cli_access_token_refresh: Mutex::new(()),
            run_cli_broker_tasks: Mutex::new(BTreeMap::new()),
            terminal_tasks: Mutex::new(BTreeMap::new()),
            terminal_state_fingerprints: Mutex::new(BTreeMap::new()),
            terminal_states: RwLock::new(BTreeMap::new()),
            terminal_updates_tx,
            inventory_updates_tx,
            kino_vsock_cid_lock: Mutex::new(()),
            create_sem: Arc::new(Semaphore::new(8)),
            delete_requests: Mutex::new(BTreeSet::new()),
            cleanup_locks: Mutex::new(BTreeMap::new()),
            run_cleanup_locks: Mutex::new(BTreeMap::new()),
            archive_transfer_sem: Semaphore::new(ARCHIVE_HOST_TRANSFER_CONCURRENCY),
            archive_jobs_lock: Mutex::new(()),
            archive_jobs_notify: Notify::new(),
        };
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    /// Run the full jailerd-owned repair path for every persisted run.
    /// VM launch uses the separate O(1) `EnsureRunNetwork` exact-hit path.
    pub async fn repair_host_networking(&self) -> Result<()> {
        repair_vm_networks(&self.inner).await
    }

    pub fn subscribe_probe_updates(&self) -> broadcast::Receiver<ProbeUpdateEnvelope> {
        self.inner.probe_updates_tx.subscribe()
    }

    pub fn subscribe_terminal_updates(&self) -> broadcast::Receiver<VmTerminalState> {
        self.inner.terminal_updates_tx.subscribe()
    }

    /// Subscribe to coalesced VM inventory mutations.
    ///
    /// A watch channel is intentional here: a burst of adjacent boot phases
    /// needs one fresh host snapshot, while an update that arrives during that
    /// snapshot must remain observable for the next send.
    pub fn subscribe_inventory_updates(&self) -> watch::Receiver<u64> {
        self.inner.inventory_updates_tx.subscribe()
    }

    pub fn request_inventory_update(&self) {
        publish_inventory_update(&self.inner);
    }

    /// Reuse the already-minted bridge bearer for the private run CLI path.
    /// The token remains only in root-owned agent memory and is never sent to
    /// a guest, persisted, or included in a debug representation.
    pub(crate) async fn cache_run_cli_access_token(&self, access_token: &str) {
        if access_token.is_empty() {
            return;
        }
        self.inner
            .run_cli_access_token
            .lock()
            .await
            .replace(access_token.to_owned(), Instant::now());
    }

    pub(crate) async fn clear_run_cli_access_token(&self) {
        self.inner.run_cli_access_token.lock().await.clear();
    }

    /// Project terminal state from the generation-fenced inventory without a
    /// fresh guest TCP probe.
    ///
    /// `Running` is committed only after quota sealing, DNAT activation, SSH
    /// host-key authentication, and the Kino snapshot are durable, so it is a
    /// safe authority for every bridge report. Live TCP checks are performed
    /// only by the terminal worker, which starts after secure finalization.
    pub async fn committed_terminal_state(&self, vm_name: &str) -> Option<VmTerminalState> {
        let vm = {
            let states = self.inner.states.read().await;
            states.get(vm_name).cloned()
        }?;
        if vm.state == VmLifecycleState::Running {
            let run_id = vm
                .details
                .as_ref()
                .and_then(|details| details.run_id.as_deref());
            let generation = vm
                .details
                .as_ref()
                .and_then(|details| details.jail_generation.as_deref());
            let cached = {
                let terminal_states = self.inner.terminal_states.read().await;
                terminal_states.get(vm_name).cloned()
            };
            if cached
                .as_ref()
                .is_some_and(|state| terminal_state_matches_inventory(state, run_id, generation))
            {
                return cached;
            }
        }
        // A persisted Running row is not terminal-ready authority after an
        // agent restart. Until fresh readiness emits a generation-matched
        // terminal event, fail closed to Pending without probing the guest.
        terminal_state_from_vm(&vm, &self.inner.ssh_access, false, now_unix_ms())
    }

    /// Publicly routable address for this host's per-VM SSH forwards, from
    /// `[ssh_access] advertised_host`.
    #[must_use]
    pub fn ssh_advertised_host(&self) -> Option<String> {
        self.inner
            .ssh_access
            .advertised_host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    pub async fn jailer_capabilities(&self) -> Result<JailerCapabilities> {
        match request_jailerd(&self.inner, JailerRequest::Capabilities).await? {
            JailerResponse::Capabilities(capabilities) => Ok(capabilities),
            JailerResponse::Error(error) => {
                anyhow::bail!("jailerd {}: {}", error.code, error.message)
            }
            response => anyhow::bail!(
                "jailerd returned unexpected response to capabilities request: {response:?}"
            ),
        }
    }

    /// Ensure a cached boot bundle is also present in jailerd's root-owned
    /// clone-only template store. A missing v2 capability is a hard launch
    /// incompatibility; this breaking path never downgrades to v1.
    pub async fn ensure_cached_image_template(
        &self,
        image: &image_cache::CachedImage,
    ) -> Result<PreparedImageV2Result> {
        ensure_jailer_image_template(&self.inner, image).await
    }

    pub async fn inspect_jailed_vm(&self, generation: &str) -> Result<Option<VmInspection>> {
        jailer_identity_request(&self.inner, generation, JailerIdentityOperation::Inspect).await
    }

    pub async fn reconcile_tracked_vms(&self) -> Result<()> {
        let names = {
            let states = self.inner.states.read().await;
            states.keys().cloned().collect::<Vec<_>>()
        };

        let mut resuming_readiness = 0usize;
        let mut archived_stale = 0usize;
        let mut dropped_stale = 0usize;
        let mut kept_inconclusive = 0usize;

        for name in names {
            match reconcile_tracked_vm_on_startup(&self.inner, &name).await {
                Ok(StartupReconcileOutcome::ResumingReadiness) => {
                    resuming_readiness = resuming_readiness.saturating_add(1);
                }
                Ok(StartupReconcileOutcome::ArchivedStale) => {
                    archived_stale = archived_stale.saturating_add(1);
                }
                Ok(StartupReconcileOutcome::DroppedStale) => {
                    dropped_stale = dropped_stale.saturating_add(1);
                }
                Ok(StartupReconcileOutcome::KeptInconclusive) => {
                    kept_inconclusive = kept_inconclusive.saturating_add(1);
                }
                Err(error) => {
                    warn!(vm = name, error = %error, "failed to reconcile tracked vm on startup");
                }
            }
        }

        info!(
            resuming_readiness,
            archived_stale,
            dropped_stale,
            kept_inconclusive,
            "reconciled tracked vm state on startup"
        );

        Ok(())
    }

    pub async fn retry_archive_jobs(&self) -> Result<()> {
        retry_archive_jobs(&self.inner).await
    }

    /// Wait for a durable archive queue insertion. `Notify` keeps one permit
    /// if the worker is not currently waiting, while the periodic sweep in
    /// `main` remains the restart and missed-signal recovery path.
    pub async fn wait_for_archive_job_signal(&self) {
        wait_for_archive_worker_signal(&self.inner.archive_jobs_notify).await;
    }

    pub async fn create_scenario_vm(
        &self,
        req: CreateScenarioVmRequest,
    ) -> Result<CreateVmResponse, ApiError> {
        let ssh_authorized_keys_openssh = req
            .runtime
            .ssh_authorized_keys_openssh
            .into_iter()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .collect::<Vec<_>>();
        if ssh_authorized_keys_openssh.is_empty() {
            return Err(ApiError::bad_request(
                "runtime.ssh_authorized_keys_openssh must not be empty",
            ));
        }
        let (peer_vm_names, peer_vm_aliases) = normalize_peer_vm_topology(
            &req.name,
            req.runtime.peer_vm_names,
            req.runtime.peer_vm_aliases,
        )?;

        let runtime = CreateScenarioVmRuntime {
            ssh_authorized_keys_openssh,
            network: req.runtime.network,
            kino: req.runtime.kino,
            peer_vm_names,
            peer_vm_aliases,
        };

        self.queue_vm_create(QueueVmCreateRequest {
            requested_name: req.name,
            requested_run_id: req.run_id,
            requested_image: req.image,
            requested_image_sha256: req.image_sha256,
            requested_resources: req.resources,
            requested_hostname: req.hostname,
            lease_duration_seconds: req.lease_duration_seconds,
            runtime,
        })
        .await
    }

    pub(super) async fn queue_vm_create(
        &self,
        req: QueueVmCreateRequest,
    ) -> Result<CreateVmResponse, ApiError> {
        let QueueVmCreateRequest {
            requested_name,
            requested_run_id,
            requested_image,
            requested_image_sha256,
            requested_resources,
            requested_hostname,
            lease_duration_seconds,
            runtime,
        } = req;

        let name = requested_name.trim().to_string();
        if name.is_empty() {
            return Err(ApiError::bad_request("name must not be empty"));
        }
        if !is_safe_key(&name) {
            return Err(ApiError::bad_request("name must match [A-Za-z0-9_-]+"));
        }
        let run_id = requested_run_id.trim().to_string();
        if run_id.is_empty() {
            return Err(ApiError::bad_request("run_id must not be empty"));
        }
        if !is_safe_key(&run_id) {
            return Err(ApiError::bad_request("run_id must match [A-Za-z0-9_-]+"));
        }

        let image_key = requested_image.trim().to_string();
        if image_key.is_empty() {
            return Err(ApiError::bad_request("image must not be empty"));
        }
        if !is_safe_key(&image_key) {
            return Err(ApiError::bad_request("image must match [A-Za-z0-9_-]+"));
        }
        let image_sha256 = normalize_sha256(requested_image_sha256.trim())
            .ok_or_else(|| ApiError::bad_request("image_sha256 must be a SHA-256 digest"))?;

        {
            let states = self.inner.states.read().await;
            if states.contains_key(&name) {
                return Err(ApiError::conflict(format!("vm \"{name}\" already exists")));
            }
        }

        let permit = self
            .inner
            .create_sem
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::conflict("another vm create is already in progress"))?;

        let tap_prefix = self.inner.defaults.tap.trim().to_string();
        if tap_prefix.is_empty() {
            return Err(ApiError::internal("vm_defaults.tap is not configured"));
        }

        let resources = requested_resources.unwrap_or(CreateVmResources {
            cpu_millis: self.inner.defaults.resources.vcpus.saturating_mul(1_000),
            vcpus: self.inner.defaults.resources.vcpus,
            memory_mib: self.inner.defaults.resources.memory_mib,
            disk_mib: None,
        });
        if resources.vcpus == 0 {
            return Err(ApiError::bad_request("resources.vcpus must be >= 1"));
        }
        if resources.cpu_millis == 0 {
            return Err(ApiError::bad_request("resources.cpu_millis must be >= 1"));
        }
        if resources.cpu_millis > resources.vcpus.saturating_mul(1_000) {
            return Err(ApiError::bad_request(
                "resources.cpu_millis must not exceed resources.vcpus * 1000",
            ));
        }
        if resources.memory_mib == 0 {
            return Err(ApiError::bad_request("resources.memory_mib must be >= 1"));
        }
        if let Some(disk_mib) = resources.disk_mib
            && disk_mib == 0
        {
            return Err(ApiError::bad_request("resources.disk_mib must be >= 1"));
        }

        let scenario_runtime = &runtime;
        let (mut network, bridge_name, peer_guest_ips) = match scenario_runtime.network.as_ref() {
            Some(runtime_network) => {
                let guest_ip_cidr = runtime_network.guest_ip_cidr.clone();
                let gateway = match runtime_network.gateway.clone() {
                    Some(gateway) => gateway,
                    None => gateway_for_guest_cidr(&guest_ip_cidr).map_err(|e| {
                        ApiError::bad_request(format!("invalid scenario runtime network: {e}"))
                    })?,
                };
                (
                    CreateVmNetwork {
                        guest_ip_cidr,
                        gateway,
                        dns: runtime_network
                            .dns
                            .clone()
                            .unwrap_or_else(|| self.inner.defaults.network.dns.clone()),
                    },
                    run_bridge_name(&run_id),
                    BTreeMap::new(),
                )
            }
            None => {
                allocate_run_network(
                    &self.inner,
                    &run_id,
                    &name,
                    &scenario_runtime.peer_vm_names,
                    &scenario_runtime.peer_vm_aliases,
                )
                .await?
            }
        };
        let normalized_guest_cidr = validate_network(&network).map_err(|e| {
            if scenario_runtime.network.is_some() {
                ApiError::bad_request(format!("invalid scenario runtime network: {e}"))
            } else {
                ApiError::internal(format!("invalid vm_defaults.network: {e}"))
            }
        })?;
        network.guest_ip_cidr = normalized_guest_cidr;
        ensure_guest_ip_available(&self.inner, &network.guest_ip_cidr).await?;
        let guest_ip = extract_guest_ip(&network.guest_ip_cidr)
            .map_err(|e| ApiError::internal(format!("failed to derive guest ip: {e}")))?;
        let tap_name = allocate_tap_name(&self.inner, &name, &tap_prefix).await;

        const MAX_LEASE_DURATION_SECONDS: u64 = 30 * 24 * 60 * 60;
        if let Some(secs) = lease_duration_seconds {
            if secs == 0 {
                return Err(ApiError::bad_request("lease_duration_seconds must be >= 1"));
            }
            if secs > MAX_LEASE_DURATION_SECONDS {
                return Err(ApiError::bad_request(format!(
                    "lease_duration_seconds must be <= {MAX_LEASE_DURATION_SECONDS}"
                )));
            }
        }

        let hostname = requested_hostname
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&name)
            .to_string();

        let created_at_s = now_unix_s();
        let created_at = format_rfc3339_s(created_at_s);
        let updated_at_s = created_at_s;

        // Reserve every in-memory-only resource before creating staging
        // files. The CID guard stays held until the queued row is durable (or
        // its provisional state is rolled back), so a concurrent request
        // cannot reuse the same CID while persistence is in flight.
        let cid_guard = self.inner.kino_vsock_cid_lock.lock().await;
        let kino_vsock_cid = match scenario_runtime.kino.as_ref().map(|kino| kino.vsock_cid) {
            Some(vsock_cid) => {
                ensure_kino_vsock_cid_available(&self.inner, vsock_cid).await?;
                vsock_cid
            }
            None => allocate_kino_vsock_cid(&self.inner).await?,
        };
        let kino_vsock_port = scenario_runtime
            .kino
            .as_ref()
            .and_then(|kino| kino.vsock_port)
            .unwrap_or(KINO_VSOCK_PORT);
        if kino_vsock_port == 0 {
            return Err(ApiError::bad_request(
                "runtime.kino.vsock_port must be >= 1",
            ));
        }

        let mac = mac::generate_local_unicast_mac();
        let ssh_public_port = if self.inner.ssh_access.enabled {
            Some(allocate_ssh_public_port(&self.inner).await?)
        } else {
            None
        };

        let work_dir = resolve_work_dir(&self.inner.defaults)
            .map_err(|e| ApiError::internal(format!("failed to resolve vm work dir: {e}")))?;
        let vm_dir = work_dir.join("vms").join(&name);
        let spool_dir = vm_spool_dir(&work_dir, &run_id, &name);
        let recording_disk_path = spool_dir.join("recordings.vfat");

        for (kind, path) in [("vm dir", &vm_dir), ("vm spool", &spool_dir)] {
            match tokio::fs::metadata(path).await {
                Ok(_) => {
                    return Err(ApiError::conflict(format!(
                        "{kind} exists at {}",
                        path.display()
                    )));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(ApiError::internal(format!(
                        "failed to stat {kind} {}: {e}",
                        path.display()
                    )));
                }
            }
        }
        let root_disk_path = vm_dir.join("root.raw");
        let config_disk_path = vm_dir.join(RUNTIME_DISK_FILENAME);
        let ch_socket_path = vm_dir.join("cloud-hypervisor.sock");
        let kino_vsock_path = vm_dir.join("kino.vsock");

        let details = VmDetails {
            image_key: Some(image_key.clone()),
            image_sha256: Some(image_sha256.clone()),
            run_id: Some(run_id.clone()),
            root_disk_path: root_disk_path.display().to_string(),
            seed_disk_path: config_disk_path.display().to_string(),
            recording_disk_path: Some(recording_disk_path.display().to_string()),
            spool_dir: Some(spool_dir.display().to_string()),
            mac: mac.clone(),
            cpu_millis: Some(resources.cpu_millis),
            vcpu_count: u16::try_from(resources.vcpus).ok(),
            guest_ip: Some(guest_ip.clone()),
            guest_ip_cidr: Some(network.guest_ip_cidr.clone()),
            gateway: Some(network.gateway.clone()),
            bridge_name: Some(bridge_name.clone()),
            ssh_public_port,
            tap_name: Some(tap_name.clone()),
            ch_socket_path: Some(ch_socket_path.display().to_string()),
            ch_pid: None,
            ch_start_time_ticks: None,
            host_boot_id: None,
            ch_executable_sha256: None,
            jail_generation: None,
            jail_unit_name: None,
            jail_cgroup_path: None,
            jail_root_path: None,
            jail_root_inode: None,
            jail_uid: None,
            jail_gid: None,
            jail_netns_name: None,
            kino_vsock_cid: Some(kino_vsock_cid),
            kino_vsock_port: Some(kino_vsock_port),
            kino_vsock_path: Some(kino_vsock_path.display().to_string()),
            ssh_host_keys_openssh: Vec::new(),
            cpu_runtime: None,
        };

        let status = VmStatusResponse {
            name: name.clone(),
            state: VmLifecycleState::Queued,
            created_at: created_at.clone(),
            updated_at: created_at,
            details: Some(details.clone()),
            error: None,
            lease_duration_seconds,
            lease_expires_at: None,
            created_at_s,
            updated_at_s,
            running_at_s: None,
        };

        let reserved = {
            let mut states = self.inner.states.write().await;
            reserve_vm_state(&mut states, status.clone())
        };
        if !reserved {
            return Err(ApiError::conflict(format!("vm \"{name}\" already exists")));
        }

        if let Err(error) = self.inner.db.upsert_vm(status.to_db_row()).await {
            error!(error = %error, vm = name, "failed to persist vm status (queued); rolling back create");
            if remove_matching_tracked_vm_state(&self.inner, &status).await {
                clear_delete_request(&self.inner, &status.name).await;
            }
            let delete_error = self.inner.db.delete_vm(status.name.clone()).await.err();
            drop(cid_guard);
            return Err(ApiError::internal(match delete_error {
                Some(delete_error) => format!(
                    "failed to persist queued VM before launch: {error:#}; ambiguous-row delete also failed: {delete_error:#}"
                ),
                None => format!("failed to persist queued VM before launch: {error:#}"),
            }));
        }
        publish_inventory_update(&self.inner);
        drop(cid_guard);

        let staging_result = async {
            tokio::fs::create_dir_all(&vm_dir)
                .await
                .with_context(|| format!("failed to create vm dir at {}", vm_dir.display()))?;
            tokio::fs::create_dir_all(spool_dir.join("artifacts"))
                .await
                .with_context(|| {
                    format!("failed to create run spool at {}", spool_dir.display())
                })?;

            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = staging_result {
            let rollback_error =
                rollback_persisted_queued_vm(&self.inner, &status, &vm_dir, &spool_dir)
                    .await
                    .err();
            let rollback_failed = rollback_error.is_some();
            let message = match rollback_error {
                Some(rollback_error) => format!(
                    "failed to stage queued VM: {error:#}; rollback also failed: {rollback_error:#}"
                ),
                None => format!("failed to stage queued VM: {error:#}"),
            };
            if rollback_failed {
                mark_vm_failed(&self.inner, &status.name, message.clone()).await;
                if take_delete_request(&self.inner, &status.name).await {
                    spawn_vm_cleanup_task(Arc::clone(&self.inner), status.name.clone(), false);
                }
            }
            return Err(ApiError::internal(message));
        }
        let resp_name = name.clone();
        let inner = Arc::clone(&self.inner);
        let network_for_task = network.clone();
        let peer_guest_ips_for_task = peer_guest_ips.clone();
        let name_for_task = name.clone();
        let image_key_for_task = image_key.clone();
        let image_sha256_for_task = image_sha256.clone();
        let hostname_for_task = hostname.clone();
        let runtime_for_task = runtime.clone();
        let tap_for_task = tap_name.clone();

        tokio::spawn(async move {
            let _permit = permit;
            let span =
                tracing::info_span!("vm_create", vm = %name_for_task, image = %image_key_for_task);
            let _g = span.enter();

            let create_input = RunCreateInput {
                name: &name_for_task,
                run_id: &run_id,
                image_key: &image_key_for_task,
                expected_image_sha256: &image_sha256_for_task,
                runtime: &runtime_for_task,
                tap: &tap_for_task,
                ssh_public_port,
                kino_vsock_cid,
                kino_vsock_port,
                kino_host_ready_port: KINO_HOST_READY_PORT,
                cpu_millis: resources.cpu_millis,
                vcpus: resources.vcpus,
                memory_mib: resources.memory_mib,
                disk_mib: resources.disk_mib,
                hostname: &hostname_for_task,
                mac: &mac,
                root_disk_path: &root_disk_path,
                config_disk_path: &config_disk_path,
                recording_disk_path: &recording_disk_path,
                network: &network_for_task,
                peer_guest_ips: &peer_guest_ips_for_task,
            };

            let create_result = run_create(&inner, create_input).await;
            if take_delete_request(&inner, &name_for_task).await {
                stop_booting_vm(&inner, &name_for_task).await;
                match cleanup_tracked_vm(&inner, &name_for_task, false).await {
                    Ok(_) => {
                        info!(
                            vm = name_for_task,
                            "cleaned up vm after delete request during create"
                        );
                    }
                    Err(error) => {
                        let err = error_chain_to_string(&error);
                        error!(
                            error = %err,
                            error_debug = ?error,
                            vm = name_for_task,
                            "failed to clean up vm after delete request during create"
                        );
                        mark_vm_failed(&inner, &name_for_task, err).await;
                    }
                }
                return;
            }

            if let Err(e) = create_result {
                let err = error_chain_to_string(&e);
                stop_booting_vm(&inner, &name_for_task).await;
                let _run_cleanup_guard =
                    acquire_run_cleanup_lock(&inner.run_cleanup_locks, &run_id).await;
                if let Err(cleanup_error) =
                    cleanup_jailed_vm_by_logical_id(&inner, &run_id, &name_for_task).await
                {
                    error!(
                        error = %cleanup_error,
                        vm = name_for_task,
                        run_id,
                        "failed to destroy jailed runtime after VM create failure"
                    );
                }
                error!(error = %err, error_debug = ?e, "vm create failed");
                mark_vm_failed(&inner, &name_for_task, err).await;
            }
        });

        Ok(CreateVmResponse {
            name: resp_name,
            state: VmLifecycleState::Queued,
        })
    }

    pub async fn get_vm(&self, name: &str) -> Option<VmStatusResponse> {
        let states = self.inner.states.read().await;
        states.get(name).cloned()
    }

    pub async fn list_vms(&self) -> Vec<VmStatusResponse> {
        let states = self.inner.states.read().await;
        states.values().cloned().collect()
    }

    pub async fn delete_vm(&self, name: &str) -> Result<(), ApiError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(ApiError::bad_request("name must not be empty"));
        }

        let vm = {
            let states = self.inner.states.read().await;
            states.get(name).cloned()
        };
        let Some(vm) = vm else {
            return Err(ApiError::not_found("vm not found"));
        };

        if is_create_in_progress_state(vm.state) {
            request_delete(&self.inner, name).await;
            stop_booting_vm(&self.inner, name).await;
            return Ok(());
        }

        if matches!(
            vm.state,
            VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts
        ) {
            return Ok(());
        }

        set_state(&self.inner, name, VmLifecycleState::DeletingVm).await;
        stop_terminal_worker(&self.inner, name).await;
        publish_terminal_state_update(&self.inner, name, false).await;
        spawn_vm_cleanup_task(Arc::clone(&self.inner), name.to_string(), false);
        Ok(())
    }

    pub async fn delete_vm_by_run_id(&self, run_id: &str) -> Result<(), ApiError> {
        let run_id = run_id.trim();
        if run_id.is_empty() {
            return Err(ApiError::bad_request("run_id must not be empty"));
        }

        let names = {
            let states = self.inner.states.read().await;
            matching_vm_names_for_run_id(&states, run_id)
        };

        if names.is_empty() {
            return Err(ApiError::not_found("vm not found"));
        }

        let mut first_error = None;
        for name in names {
            match self.delete_vm(&name).await {
                Ok(()) => {}
                Err(err) if err.status == StatusCode::NOT_FOUND => {}
                Err(err) => {
                    if first_error.is_none() {
                        first_error = Some(err);
                    }
                }
            }
        }

        match first_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    pub async fn cleanup_expired_leases(&self) -> Result<()> {
        let now_s = now_unix_s();
        let expired: Vec<VmStatusResponse> = {
            let states = self.inner.states.read().await;
            states
                .values()
                .filter(|vm| vm.is_expired(now_s))
                .cloned()
                .collect()
        };

        for vm in expired {
            match cleanup_tracked_vm(&self.inner, &vm.name, true).await {
                Ok(_) => {
                    self.clear_lease_expiry_error_log(&vm.name).await;
                }
                Err(e) => {
                    self.log_lease_expiry_error(&vm.name, &e).await;
                }
            }
        }

        Ok(())
    }

    pub async fn prune_vms(&self) -> PruneVmsResponse {
        let names: Vec<String> = {
            let states = self.inner.states.read().await;
            states.keys().cloned().collect()
        };

        let requested = names.len();
        let mut deleted = 0usize;
        let mut failed = 0usize;

        for name in names {
            let vm = {
                let states = self.inner.states.read().await;
                states.get(&name).cloned()
            };
            if vm
                .as_ref()
                .is_some_and(|vm| is_create_in_progress_state(vm.state))
            {
                failed = failed.saturating_add(1);
                warn!(
                    vm = name,
                    "skipping vm prune while create is still in progress"
                );
                continue;
            }

            match cleanup_tracked_vm(&self.inner, &name, false).await {
                Ok(CleanupOutcome::Deleted | CleanupOutcome::Missing) => {
                    deleted = deleted.saturating_add(1);
                    self.clear_lease_expiry_error_log(&name).await;
                }
                Ok(CleanupOutcome::SkippedNotExpired) => {
                    failed = failed.saturating_add(1);
                    warn!(vm = name, "skipping vm prune due to non-expired lease");
                }
                Err(e) => {
                    failed = failed.saturating_add(1);
                    warn!(vm = name, error = %e, "failed to prune tracked vm");
                }
            }
        }

        PruneVmsResponse {
            requested,
            deleted,
            failed,
        }
    }

    pub(super) async fn clear_lease_expiry_error_log(&self, name: &str) {
        let mut lease_expiry_error_log = self.inner.lease_expiry_error_log.write().await;
        lease_expiry_error_log.remove(name);
    }

    pub(super) async fn log_lease_expiry_error(&self, name: &str, err: &anyhow::Error) {
        let signature = error_chain_to_string(err);
        let now_s = now_unix_s();

        let should_log = {
            let mut lease_expiry_error_log = self.inner.lease_expiry_error_log.write().await;
            let prev = lease_expiry_error_log.get(name);
            let (should_log, next_state) =
                next_lease_expiry_error_log_state(prev, &signature, now_s);
            lease_expiry_error_log.insert(name.to_string(), next_state);
            should_log
        };

        if should_log {
            warn!(
                error = %signature,
                vm = name,
                "failed to clean up lease-expired vm"
            );
        }
    }
}
