use super::*;

pub(super) struct RunCreateInput<'a> {
    pub(super) name: &'a str,
    pub(super) run_id: &'a str,
    pub(super) image_key: &'a str,
    pub(super) expected_image_sha256: &'a str,
    pub(super) runtime: &'a CreateScenarioVmRuntime,
    pub(super) tap: &'a str,
    pub(super) ssh_public_port: Option<u16>,
    pub(super) kino_vsock_cid: u32,
    pub(super) kino_vsock_port: u32,
    pub(super) kino_host_ready_port: u32,
    pub(super) cpu_millis: u32,
    pub(super) vcpus: u32,
    pub(super) memory_mib: u32,
    pub(super) disk_mib: Option<u32>,
    pub(super) hostname: &'a str,
    pub(super) mac: &'a str,
    pub(super) root_disk_path: &'a Path,
    pub(super) config_disk_path: &'a Path,
    pub(super) recording_disk_path: &'a Path,
    pub(super) network: &'a CreateVmNetwork,
    pub(super) peer_guest_ips: &'a BTreeMap<String, String>,
}

pub(super) struct CloudHypervisorVmConfigInput<'a> {
    pub(super) name: &'a str,
    pub(super) cmdline: &'a str,
    pub(super) paths: &'a JailPathMap,
    pub(super) vcpus: u32,
    pub(super) memory_mib: u32,
    pub(super) tap: &'a str,
    pub(super) mac: &'a str,
    pub(super) kino_vsock_cid: u32,
}

pub(super) fn build_cloud_hypervisor_vm_config(
    input: CloudHypervisorVmConfigInput<'_>,
) -> Result<VmConfig> {
    Ok(VmConfig {
        cpus: Some(CpusConfig {
            boot_vcpus: input.vcpus,
            max_vcpus: input.vcpus,
        }),
        memory: Some(MemoryConfig {
            size: (input.memory_mib as i64) * 1024 * 1024,
        }),
        payload: PayloadConfig {
            kernel: Some(input.paths.jailed_kernel.display().to_string()),
            initramfs: input
                .paths
                .jailed_initrd
                .as_ref()
                .map(|path| path.display().to_string()),
            cmdline: Some(input.cmdline.to_string()),
            ..PayloadConfig::default()
        },
        serial: Some(SerialConfig {
            file: Some(input.paths.jailed_serial_log.display().to_string()),
            mode: "File".to_string(),
            iommu: false,
            socket: None,
        }),
        console: Some(ConsoleConfig {
            file: Some(input.paths.jailed_console_log.display().to_string()),
            mode: "File".to_string(),
            iommu: false,
            socket: None,
        }),
        disks: Some(vec![
            DiskConfig {
                path: input.paths.jailed_root_disk.display().to_string(),
                readonly: false,
                id: Some(format!("{}-root", input.name)),
                image_type: Some(DiskImageType::Raw),
            },
            DiskConfig {
                path: input.paths.jailed_runtime_disk.display().to_string(),
                readonly: true,
                id: Some(format!("{}-{RUNTIME_DISK_ID_SUFFIX}", input.name)),
                image_type: Some(DiskImageType::Raw),
            },
            DiskConfig {
                path: input.paths.jailed_recording_disk.display().to_string(),
                readonly: false,
                id: Some(format!("{}-recordings", input.name)),
                image_type: Some(DiskImageType::Raw),
            },
        ]),
        net: Some(vec![NetConfig {
            tap: input.tap.to_string(),
            mac: Some(input.mac.to_string()),
            ip: None,
            mask: None,
        }]),
        vsock: Some(VsockConfig {
            cid: u64::from(input.kino_vsock_cid),
            socket: input.paths.jailed_vsock_socket.display().to_string(),
            iommu: false,
            pci_segment: None,
            id: Some(format!("{}-kino-vsock", input.name)),
        }),
        landlock_enable: Some(true),
    })
}

pub(super) async fn cached_jailer_launch_capabilities(
    inner: &Inner,
) -> Result<&JailerCapabilities> {
    inner
        .jailer_launch_capabilities
        .get_or_try_init(|| async {
            match request_jailerd(inner, JailerRequest::Capabilities).await? {
                JailerResponse::Capabilities(capabilities) => Ok(capabilities),
                JailerResponse::Error(error) => {
                    anyhow::bail!("jailerd {}: {}", error.code, error.message)
                }
                response => anyhow::bail!(
                    "jailerd returned unexpected response to capabilities request: {response:?}"
                ),
            }
        })
        .await
}

pub(super) async fn ensure_jailer_image_template(
    inner: &Inner,
    image: &image_cache::CachedImage,
) -> Result<PreparedImageV2Result> {
    let capabilities = cached_jailer_launch_capabilities(inner).await?;
    if !(capabilities.supports_jailer_v2
        && capabilities.supports_template_backed_launch
        && capabilities.fast_template_store)
    {
        anyhow::bail!("jailerd does not attest the mandatory template-backed v2 launch contract");
    }

    let request = PrepareImageV2Request {
        image_sha256: Sha256Digest::parse(image.image_sha256.to_ascii_lowercase())
            .context("validate prepared image identity")?,
        virtual_size_bytes: image.virtual_size_bytes,
        root_disk: artifact_source(
            &image.raw_path,
            &capabilities.allowed_source_roots,
            Some(&image.raw_sha256),
            ArtifactAccess::ReadOnly,
        )?,
        kernel: artifact_source(
            &image.kernel_path,
            &capabilities.allowed_source_roots,
            Some(&image.kernel_sha256),
            ArtifactAccess::ReadOnly,
        )?,
        initrd: Some(artifact_source(
            &image.initrd_path,
            &capabilities.allowed_source_roots,
            Some(&image.initrd_sha256),
            ArtifactAccess::ReadOnly,
        )?),
    };
    request
        .validate()
        .context("validate prepared image request")?;
    let result = match request_jailerd_with_timeout(
        inner,
        JailerRequest::PrepareImageV2(Box::new(request.clone())),
        JAILER_PREPARE_IMAGE_TIMEOUT,
    )
    .await?
    {
        JailerResponse::PrepareImageV2(result) => result,
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => {
            anyhow::bail!("jailerd returned unexpected response to prepare_image_v2: {response:?}")
        }
    };
    validate_prepared_image_result(&request, &result)?;
    image_cache::mark_template_ready(image, &result)
        .await
        .context("persist prepared jail template readiness")?;
    Ok(result)
}

pub(super) fn validate_prepared_image_result(
    request: &PrepareImageV2Request,
    result: &PreparedImageV2Result,
) -> Result<()> {
    anyhow::ensure!(
        result.image_sha256 == request.image_sha256
            && result.virtual_size_bytes == request.virtual_size_bytes
            && result.fast_template_store,
        "jailerd prepared image identity or fast-store attestation mismatch"
    );
    let expected = [
        (
            &result.root_disk,
            "root.raw",
            request.root_disk.sha256.as_ref(),
            ArtifactAccess::ReadWrite,
        ),
        (
            &result.kernel,
            "kernel",
            request.kernel.sha256.as_ref(),
            ArtifactAccess::ReadOnly,
        ),
    ];
    for (source, name, sha256, access) in expected {
        anyhow::ensure!(
            source.source_root == PREPARED_IMAGE_SOURCE_ROOT
                && source.relative_path == PathBuf::from(request.image_sha256.as_str()).join(name)
                && source.sha256.as_ref() == sha256
                && source.access == access,
            "jailerd returned an invalid prepared {name} descriptor"
        );
    }
    match (&request.initrd, &result.initrd) {
        (Some(request_source), Some(source)) => anyhow::ensure!(
            source.source_root == PREPARED_IMAGE_SOURCE_ROOT
                && source.relative_path
                    == PathBuf::from(request.image_sha256.as_str()).join("initrd")
                && source.sha256 == request_source.sha256
                && source.access == ArtifactAccess::ReadOnly,
            "jailerd returned an invalid prepared initrd descriptor"
        ),
        (None, None) => {}
        _ => anyhow::bail!("jailerd prepared image initrd shape mismatch"),
    }
    Ok(())
}

pub(super) fn build_jailer_launch_operation(
    request: VmLaunchRequest,
    prepared_image: Option<&PreparedImageV2Result>,
) -> Result<JailerRequest> {
    let prepared = prepared_image
        .context("prepared v2 image is mandatory; this breaking launch path has no v1 fallback")?;
    let request = LaunchVmV2Request {
        image_sha256: prepared.image_sha256.clone(),
        virtual_size_bytes: prepared.virtual_size_bytes,
        launch: request,
    };
    request
        .validate()
        .context("validate jailer template-backed launch request")?;
    Ok(JailerRequest::LaunchVmV2(Box::new(request)))
}

pub(super) async fn request_v2_launch_with_single_retry<F, Fut>(
    operation: JailerRequest,
    mut send: F,
) -> Result<JailerResponse>
where
    F: FnMut(JailerRequest) -> Fut,
    Fut: Future<Output = Result<JailerResponse>>,
{
    anyhow::ensure!(
        matches!(operation, JailerRequest::LaunchVmV2(_)),
        "v2 launch retry requires an exact LaunchVmV2 operation"
    );
    let retry_operation = operation.clone();
    match send(operation).await {
        Ok(response) => Ok(response),
        Err(first_error) => send(retry_operation).await.with_context(|| {
            format!(
                "identical LaunchVmV2 retry failed after the first transport attempt failed: {first_error:#}"
            )
        }),
    }
}

pub(super) async fn launch_jailed_cloud_hypervisor(
    inner: &Inner,
    req: &RunCreateInput<'_>,
    cached_image: &image_cache::CachedImage,
    prepared: &PreparedImageV2Result,
) -> Result<VmLaunchResult> {
    let run_id = ValidatedId::parse(req.run_id.to_string()).context("validate jailer run ID")?;
    let vm_id = ValidatedId::parse(req.name.to_string()).context("validate jailer VM ID")?;

    let capabilities = cached_jailer_launch_capabilities(inner).await?;

    let root_disk_size_bytes = req
        .disk_mib
        .map(|target_disk_mib| u64::from(target_disk_mib) * 1024 * 1024)
        .unwrap_or(cached_image.virtual_size_bytes);
    let artifacts = SourceArtifacts {
        kernel: prepared.kernel.clone(),
        initrd: prepared.initrd.clone(),
        root_disk: prepared.root_disk.clone(),
        runtime_disk: artifact_source(
            req.config_disk_path,
            &capabilities.allowed_source_roots,
            None,
            ArtifactAccess::ReadOnly,
        )?,
        recording_disk: artifact_source(
            req.recording_disk_path,
            &capabilities.allowed_source_roots,
            None,
            ArtifactAccess::ReadWrite,
        )?,
    };

    let request = VmLaunchRequest {
        run_id,
        vm_id,
        cpu_millis: req.cpu_millis,
        vcpu_count: u16::try_from(req.vcpus).context("vCPU count exceeds jailer contract")?,
        memory_mib: req.memory_mib,
        root_disk_size_bytes,
        tap_name: req.tap.to_string(),
        mac_address: req.mac.to_string(),
        guest_ip_cidr: req.network.guest_ip_cidr.clone(),
        ssh_public_port: req.ssh_public_port,
        vsock_cid: req.kino_vsock_cid,
        artifacts,
    };
    let launch_operation = build_jailer_launch_operation(request, Some(prepared))?;

    // A transport timeout can occur after jailerd committed the launch but
    // before the response arrived. Replay the byte-equivalent v2 operation so
    // jailerd's fingerprint and generation fences remain authoritative. Never
    // synthesize success from InspectVm, which cannot attest the request.
    let launch_response = request_v2_launch_with_single_retry(launch_operation, |operation| {
        request_jailerd(inner, operation)
    })
    .await?;

    match launch_response {
        JailerResponse::LaunchVmV2(result) => Ok(result),
        JailerResponse::Error(error) if error.code == "boot_capacity_pending" => {
            Err(BootCapacityPending {
                message: error.message,
            }
            .into())
        }
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => {
            anyhow::bail!("jailerd returned unexpected response to v2 launch: {response:?}")
        }
    }
}

pub(super) async fn ensure_jailed_run_network(
    inner: &Inner,
    run_id: &str,
    network: &CreateVmNetwork,
) -> Result<RunNetworkResult> {
    let run_id = ValidatedId::parse(run_id.to_string()).context("validate jailer run ID")?;
    let (guest_ip, prefix) = parse_ipv4_cidr(&network.guest_ip_cidr, "network.guest_ip_cidr")?;
    let run_cidr = format!(
        "{}/{prefix}",
        Ipv4Addr::from(ipv4_network_u32(guest_ip, prefix))
    );
    match request_jailerd(
        inner,
        JailerRequest::EnsureRunNetwork(EnsureRunNetworkRequest {
            run_id,
            guest_cidr: run_cidr,
            gateway: network.gateway.clone(),
        }),
    )
    .await?
    {
        JailerResponse::EnsureRunNetwork(result) => Ok(result),
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => anyhow::bail!(
            "jailerd returned unexpected response to ensure_run_network: {response:?}"
        ),
    }
}

pub(super) async fn finalize_jailed_vm_boot(
    inner: &Inner,
    generation: &ValidatedId,
    expect_ssh_forward: bool,
) -> Result<FinalizeVmBootResult> {
    let response = request_jailerd(
        inner,
        JailerRequest::FinalizeVmBoot(FinalizeVmBootRequest {
            generation: generation.clone(),
        }),
    )
    .await?;
    let result = match response {
        JailerResponse::FinalizeVmBoot(result) => result,
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => {
            anyhow::bail!("jailerd returned unexpected response to finalize_vm_boot: {response:?}")
        }
    };
    anyhow::ensure!(
        result.generation == *generation,
        "jailerd finalized a different VM generation"
    );
    anyhow::ensure!(
        result.cpu_runtime.phase == VmCpuPhase::Steady,
        "jailerd finalized VM without entering steady CPU phase"
    );
    let attestation = result
        .cpu_runtime
        .attestation
        .as_ref()
        .context("jailerd finalized VM without quota readback attestation")?;
    anyhow::ensure!(
        attestation.quota == result.cpu_runtime.steady_quota
            && result.cpu_runtime.effective_quota == result.cpu_runtime.steady_quota
            && attestation.cpu_max == result.cpu_runtime.steady_quota.cpu_max()
            && attestation.cpu_max_burst == 0,
        "jailerd steady quota attestation did not match the recorded entitlement"
    );
    anyhow::ensure!(
        !expect_ssh_forward || result.ssh_forward_active,
        "jailerd finalized VM without activating its reserved SSH forward"
    );
    Ok(result)
}

pub(super) async fn commit_ready_vm_and_probe(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
    ready: &ProbeUpdateEnvelope,
) -> Result<()> {
    anyhow::ensure!(
        ready.vm_name == name,
        "Kino ready snapshot identifies a different VM"
    );
    anyhow::ensure!(
        ready.jail_generation == generation.as_str(),
        "Kino ready snapshot generation does not match the live generation"
    );
    anyhow::ensure!(
        ready.collection_state == ProbeCollectionState::Ok,
        "Kino ready snapshot is not successful"
    );
    let probe_row = probe_state_row(ready)?;
    let now_s = now_unix_s();
    let observed_at = now_unix_ms();

    // Hold the state generation fence until SQLite acknowledges both rows.
    // This prevents a delete/recreate from being overwritten by a stale ready
    // commit while keeping external publication strictly after durability.
    let mut states = inner.states.write().await;
    let current = states
        .get_mut(name)
        .ok_or_else(|| anyhow::anyhow!("VM state disappeared during ready commit"))?;
    let mut committed = current.clone();
    let details = committed
        .details
        .as_mut()
        .context("VM details disappeared during ready commit")?;
    anyhow::ensure!(
        details.run_id.as_deref() == Some(ready.run_id.as_str()),
        "Kino ready snapshot run does not match the live VM"
    );
    anyhow::ensure!(
        details.jail_generation.as_deref() == Some(generation.as_str()),
        "VM generation changed during ready commit"
    );
    let runtime = details
        .cpu_runtime
        .as_ref()
        .context("VM has no live CPU quota attestation during ready commit")?;
    anyhow::ensure!(
        runtime.phase == VmCpuPhase::Steady
            && runtime.effective_quota == runtime.steady_quota
            && runtime.attestation.is_some(),
        "VM CPU quota is not attested steady during ready commit"
    );
    details.ssh_host_keys_openssh = normalize_ssh_host_keys(ready.ssh_host_keys_openssh.clone());
    committed.state = VmLifecycleState::Running;
    committed.updated_at_s = now_s;
    committed.updated_at = format_rfc3339_s(now_s);
    committed.error = None;
    committed.running_at_s.get_or_insert(now_s);
    committed.lease_expires_at =
        compute_lease_expires_at(committed.running_at_s, committed.lease_duration_seconds);

    let terminal = terminal_state_from_vm(&committed, &inner.ssh_access, true, observed_at)
        .context("ready VM is missing terminal identity")?;
    if committed
        .details
        .as_ref()
        .and_then(|details| details.ssh_public_port)
        .is_some()
    {
        anyhow::ensure!(
            terminal.state == VmTerminalStateKind::Ready && terminal.terminal_target.is_some(),
            "authenticated SSH did not produce a terminal-ready state"
        );
    }

    inner
        .db
        .upsert_ready_vm_and_probe_state(committed.to_db_row(), probe_row)
        .await
        .context("atomically persist running VM and Kino snapshot")?;
    *current = committed;
    drop(states);
    // Running remains internal until the generation-fenced terminal state is
    // cached. Publishing from this intermediate commit would create an
    // externally observable Ready/Pending snapshot and let its expensive
    // inventory projection race ahead of the composite terminal-ready event.
    Ok(())
}

pub(super) async fn terminal_state_for_attested_ready(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
) -> Result<VmTerminalState> {
    let mut states = inner.states.write().await;
    let vm = states
        .get_mut(name)
        .context("VM state disappeared before terminal-ready publication")?;
    let expects_terminal = {
        let details = vm
            .details
            .as_mut()
            .context("VM details disappeared before terminal-ready publication")?;
        anyhow::ensure!(
            details.jail_generation.as_deref() == Some(generation.as_str()),
            "VM generation changed before terminal-ready publication"
        );
        details.ssh_public_port.is_some()
    };
    anyhow::ensure!(
        vm.state == VmLifecycleState::Running,
        "VM is not durably running before terminal-ready publication"
    );
    let terminal = terminal_state_from_vm(vm, &inner.ssh_access, true, now_unix_ms())
        .context("ready VM is missing terminal identity")?;
    if expects_terminal {
        anyhow::ensure!(
            terminal.state == VmTerminalStateKind::Ready && terminal.terminal_target.is_some(),
            "authenticated SSH did not produce a terminal-ready state"
        );
    }
    Ok(terminal)
}

pub(super) async fn persist_cpu_runtime(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
    runtime: VmCpuRuntimeState,
) -> Result<()> {
    let persisted = {
        let mut states = inner.states.write().await;
        let vm = states
            .get_mut(name)
            .ok_or_else(|| anyhow::anyhow!("VM state disappeared during CPU quota finalization"))?;
        let details = vm.details.as_mut().ok_or_else(|| {
            anyhow::anyhow!("VM details disappeared during CPU quota finalization")
        })?;
        anyhow::ensure!(
            details.jail_generation.as_deref() == Some(generation.as_str()),
            "VM generation changed during CPU quota finalization"
        );
        details.cpu_runtime = Some(runtime);
        vm.clone()
    };
    inner
        .db
        .upsert_vm(persisted.to_db_row())
        .await
        .context("persist finalized VM CPU runtime")?;
    // The steady quota is durable for crash recovery, but remains private
    // until SSH authentication and the atomic Running/Kino commit succeed.
    // A later failure publishes through mark_vm_failed; a successful boot
    // publishes one composite terminal-ready inventory revision.
    Ok(())
}

pub(super) async fn seal_ready_vm_cpu(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
    expect_ssh_forward: bool,
) -> Result<FinalizeVmBootResult> {
    let host_keys = {
        let states = inner.states.read().await;
        let details = states
            .get(name)
            .and_then(|vm| vm.details.as_ref())
            .context("VM details disappeared before CPU quota finalization")?;
        anyhow::ensure!(
            details.jail_generation.as_deref() == Some(generation.as_str()),
            "VM generation changed before CPU quota finalization"
        );
        details.ssh_host_keys_openssh.clone()
    };
    if expect_ssh_forward {
        anyhow::ensure!(
            !host_keys.is_empty(),
            "Kino readiness did not include an SSH host key"
        );
    }
    let finalized = finalize_jailed_vm_boot(inner, generation, expect_ssh_forward)
        .await
        .context("seal VM boot CPU and activate steady-state ingress")?;
    persist_cpu_runtime(inner, name, generation, finalized.cpu_runtime.clone())
        .await
        .context("persist steady CPU quota evidence")?;
    Ok(finalized)
}

pub(super) fn artifact_source(
    path: &Path,
    allowed_source_roots: &[PathBuf],
    sha256: Option<&str>,
    access: ArtifactAccess,
) -> Result<ArtifactSource> {
    let (source_root, relative_path) = allowed_source_roots
        .iter()
        .enumerate()
        .find_map(|(index, root)| {
            let relative = path.strip_prefix(root).ok()?;
            (!relative.as_os_str().is_empty()
                && relative
                    .components()
                    .all(|component| matches!(component, std::path::Component::Normal(_))))
            .then(|| (index, relative.to_path_buf()))
        })
        .context("jailer artifact path is outside the configured trusted source roots")?;
    let source_root = u16::try_from(source_root).context("too many jailer source roots")?;
    let sha256 = sha256
        .map(|value| Sha256Digest::parse(value.to_ascii_lowercase()))
        .transpose()
        .context("validate jailer artifact SHA-256")?;
    Ok(ArtifactSource {
        source_root,
        relative_path,
        sha256,
        access,
    })
}

pub(super) async fn persist_jail_launch(
    inner: &Inner,
    name: &str,
    launch: &VmLaunchResult,
    run_network: &RunNetworkResult,
) -> Result<()> {
    let persisted = {
        let mut states = inner.states.write().await;
        let vm = states
            .get_mut(name)
            .ok_or_else(|| anyhow::anyhow!("VM state disappeared during jailed launch"))?;
        let details = vm
            .details
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("VM details disappeared during jailed launch"))?;
        details.root_disk_path = launch.paths.host_root_disk.display().to_string();
        details.seed_disk_path = launch.paths.host_runtime_disk.display().to_string();
        // Keep the trusted agent-side export path. Jailerd owns the live disk
        // and copies it back to this path only after StopVm has drained the
        // unit; the unprivileged agent never opens a jail disk directly.
        details.ch_socket_path = Some(launch.paths.host_api_socket.display().to_string());
        details.ch_pid = launch.pid;
        details.ch_start_time_ticks = launch.pid_start_time_ticks;
        details.host_boot_id = launch.host_boot_id.clone();
        details.ch_executable_sha256 = Some(launch.cloud_hypervisor_sha256.clone());
        details.jail_generation = Some(launch.generation.as_str().to_string());
        details.jail_unit_name = Some(launch.unit_name.clone());
        details.jail_cgroup_path = launch
            .cgroup_path
            .as_ref()
            .map(|path| path.display().to_string());
        details.jail_root_path = Some(launch.paths.host_jail_root.display().to_string());
        details.jail_root_inode = launch.jail_root_inode;
        details.jail_uid = Some(launch.uid);
        details.jail_gid = Some(launch.gid);
        details.jail_netns_name = Some(launch.netns_name.clone());
        details.cpu_runtime = Some(launch.cpu_runtime.clone());
        details.bridge_name = Some(run_network.bridge_name.clone());
        details.kino_vsock_path = Some(launch.paths.host_vsock_socket.display().to_string());
        vm.clone()
    };
    inner
        .db
        .upsert_vm(persisted.to_db_row())
        .await
        .context("persist jailed VM runtime identity")?;
    publish_inventory_update(inner);
    Ok(())
}

pub(super) async fn remove_agent_launch_sources(req: &RunCreateInput<'_>) -> Result<()> {
    let root_parent = req
        .root_disk_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("root disk staging path has no parent"))?;
    if req.config_disk_path.parent() != Some(root_parent) {
        anyhow::bail!("root and runtime disk staging paths do not share a VM directory");
    }

    match tokio::fs::remove_dir_all(root_parent).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(anyhow::anyhow!(
                "failed to remove staged VM sources {}: {error}",
                root_parent.display()
            ));
        }
    }
    match tokio::fs::remove_file(req.recording_disk_path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(anyhow::anyhow!(
                "failed to remove staged recording disk {}: {error}",
                req.recording_disk_path.display()
            ));
        }
    }
    Ok(())
}

pub(super) async fn run_create(inner: &Arc<Inner>, req: RunCreateInput<'_>) -> Result<()> {
    let create_started_at = Instant::now();
    set_state(inner, req.name, VmLifecycleState::CachingImage).await;

    // New-run network construction and descriptor validation are independent.
    // Hold the per-run lifecycle fence while both proceed so a concurrent
    // cleanup cannot remove topology underneath this launch.
    let run_launch_guard = acquire_run_cleanup_lock(&inner.run_cleanup_locks, req.run_id).await;
    ensure_create_not_deleted(inner, req.name).await?;
    let cache_root =
        image_cache::default_cache_root().context("failed to determine image cache root")?;
    let network_inner = Arc::clone(inner);
    let network_run_id = req.run_id.to_string();
    let network_config = req.network.clone();
    let network_task = tokio::spawn(async move {
        ensure_jailed_run_network(&network_inner, &network_run_id, &network_config).await
    });
    let _network_abort = AbortTaskOnDrop(network_task.abort_handle());
    let ready_image = image_cache::require_ready_image_launch(
        &cache_root,
        req.image_key,
        Some(req.expected_image_sha256),
    )
    .await
    .context("image is not eligible for foreground launch")?;
    let image_ready_at = Instant::now();
    let cached_image = ready_image.image;
    let prepared_image = ready_image.prepared_image;
    if let Err(error) = image_cache::touch_cached_image(&inner.db, &cached_image).await {
        warn!(
            error = %error,
            vm = req.name,
            image = %cached_image.image_key,
            "failed to update image cache access metadata"
        );
    }
    {
        let persisted = {
            let mut states = inner.states.write().await;
            let Some(vm) = states.get_mut(req.name) else {
                return Ok(());
            };
            if let Some(details) = vm.details.as_mut() {
                details.image_key = Some(cached_image.image_key.clone());
                details.image_sha256 = Some(cached_image.image_sha256.clone());
            }
            vm.clone()
        };
        if let Err(error) = inner.db.upsert_vm(persisted.to_db_row()).await {
            warn!(
                error = %error,
                vm = req.name,
                "failed to persist vm cached image identity"
            );
        }
        publish_inventory_update(inner);
    }
    ensure_create_not_deleted(inner, req.name).await?;
    set_state(inner, req.name, VmLifecycleState::PreparingDisks).await;

    let base_virtual_size_bytes = cached_image.virtual_size_bytes;
    if let Some(target_disk_mib) = req.disk_mib {
        let target_bytes = u64::from(target_disk_mib) * 1024 * 1024;
        if target_bytes < base_virtual_size_bytes {
            anyhow::bail!(
                "requested disk_mib {} MiB is smaller than the base image size {} MiB",
                target_disk_mib,
                base_virtual_size_bytes / (1024 * 1024)
            );
        }
    }
    let root_resize_required = req.disk_mib.is_some_and(|target_disk_mib| {
        u64::from(target_disk_mib) * 1024 * 1024 > base_virtual_size_bytes
    });

    ensure_create_not_deleted(inner, req.name).await?;

    let runtime = req.runtime;
    info!(
        path = %req.config_disk_path.display(),
        "writing scenario runtime disk"
    );
    let config_disk_path = req.config_disk_path.to_path_buf();
    let ssh_authorized_keys_openssh = runtime.ssh_authorized_keys_openssh.clone();
    let kino_vsock_cid = req.kino_vsock_cid;
    let kino_vsock_port = req.kino_vsock_port;
    let kino_host_ready_port = req.kino_host_ready_port;
    let network = req.network.clone();
    let peer_guest_ips = req.peer_guest_ips.clone();
    let hostname = req.hostname.to_string();
    let runtime_disk_task = tokio::task::spawn_blocking(move || {
        runtime_disk::write_runtime_disk(&runtime_disk::RuntimeDiskInput {
            path: &config_disk_path,
            ssh_authorized_keys_openssh: &ssh_authorized_keys_openssh,
            kino_vsock_cid,
            kino_vsock_port,
            kino_host_ready_port,
            hostname: &hostname,
            network: &network,
            root_resize_required,
            peer_guest_ips: &peer_guest_ips,
        })
    });
    let (runtime_disk_result, network_result) = tokio::join!(runtime_disk_task, network_task);
    let runtime_disk_result = runtime_disk_result.context("scenario runtime disk task panicked")?;
    let run_network = network_result.context("run network task panicked")?;
    let run_network = run_network.context("failed to ensure jailed run network")?;
    runtime_disk_result.context("failed to write scenario runtime disk")?;
    ensure_create_not_deleted(inner, req.name).await?;
    let disks_ready_at = Instant::now();

    set_state(inner, req.name, VmLifecycleState::CreatingVm).await;

    let launch_deadline = Instant::now() + Duration::from_secs(SCENARIO_READY_MAX_TIMEOUT_SECONDS);
    let mut capacity_attempt = 0_u32;
    let launch = loop {
        match launch_jailed_cloud_hypervisor(inner, &req, &cached_image, &prepared_image).await {
            Ok(result) => break result,
            Err(error) if error.downcast_ref::<BootCapacityPending>().is_some() => {
                ensure_create_not_deleted(inner, req.name).await?;
                if Instant::now() >= launch_deadline {
                    return Err(error).context("timed out waiting for jailerd boot CPU capacity");
                }
                let delay = boot_capacity_retry_delay(capacity_attempt);
                capacity_attempt = capacity_attempt.saturating_add(1);
                debug!(
                    vm = req.name,
                    attempt = capacity_attempt,
                    delay_ms = delay.as_millis(),
                    "waiting for capacity-accounted VM boot CPU"
                );
                tokio::time::sleep(delay).await;
            }
            Err(error) => return Err(error),
        }
    };
    persist_jail_launch(inner, req.name, &launch, &run_network).await?;
    drop(run_launch_guard);

    remove_agent_launch_sources(&req)
        .await
        .context("remove unprivileged launch staging files")?;
    ensure_create_not_deleted(inner, req.name).await?;
    let jail_ready_at = Instant::now();

    let vm_cfg = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
        name: req.name,
        cmdline: &cached_image.cmdline,
        paths: &launch.paths,
        vcpus: req.vcpus,
        memory_mib: req.memory_mib,
        tap: req.tap,
        mac: req.mac,
        kino_vsock_cid: req.kino_vsock_cid,
    })?;

    // LaunchVmV2 returns only after jailerd has pinned and pinged the API socket.
    // Repeating the readiness loop here adds another VMM API request and up to
    // one polling interval to every boot. Recovery still uses the bounded
    // readiness helper because it does not inherit that launch attestation.
    let ch = ChClient::new(launch.paths.host_api_socket.display().to_string())
        .context("open jailerd-attested cloud-hypervisor API socket")?;
    let vmm_ready_at = Instant::now();

    debug!("calling cloud-hypervisor vm.create");
    ch.vm_create(&vm_cfg)
        .await
        .context("cloud-hypervisor vm.create failed")?;

    set_state(inner, req.name, VmLifecycleState::BootingVm).await;

    let mut details = {
        let states = inner.states.read().await;
        states
            .get(req.name)
            .and_then(|vm| vm.details.clone())
            .ok_or_else(|| anyhow::anyhow!("VM state disappeared after jailed launch"))?
    };
    details.ssh_host_keys_openssh = current_ssh_host_keys(inner, req.name).await;
    let readiness_updates = inner.kino_readiness_tx.subscribe();
    // Bind and activate the guest-initiated readiness socket before boot. A
    // fast guest's first Kino push must not race listener startup and fall
    // through to Kino's reconnect interval.
    start_probe_worker(inner, req.name, &details)
        .await
        .context("failed to start vm probe worker")?;
    // Bind the private guest-to-host command broker before boot, alongside
    // Kino's readiness listener. The broker refuses requests until this VM is
    // durably Running, but a fast SSH guest can never race listener setup.
    start_run_cli_broker(inner, req.name, &details)
        .await
        .context("failed to start vm run CLI broker")?;

    debug!("calling cloud-hypervisor vm.boot");
    ch.vm_boot()
        .await
        .context("cloud-hypervisor vm.boot failed")?;
    ensure_create_not_deleted(inner, req.name).await?;
    let boot_accepted_at = Instant::now();

    let ready = wait_for_scenario_runtime_ready(inner, req.name, &ch, &details, readiness_updates)
        .await
        .context("scenario runtime did not become ready")?;
    ensure_create_not_deleted(inner, req.name).await?;
    let guest_ready_at = Instant::now();
    seal_ready_vm_cpu(
        inner,
        req.name,
        &launch.generation,
        req.ssh_public_port.is_some(),
    )
    .await?;
    let quota_sealed_at = Instant::now();
    if req.ssh_public_port.is_some() {
        wait_for_guest_ssh_before_running(inner, req.name, &launch.generation).await?;
    }
    ensure_create_not_deleted(inner, req.name).await?;
    let ssh_verified_at = Instant::now();

    // The VM can become externally ready only after jailerd has live-read the
    // steady cgroup quota, activated DNAT, and the agent has authenticated the
    // guest host key. Atomically commit Running + Kino state, then emit exactly
    // one composite ready event.
    commit_ready_vm_and_probe(inner, req.name, &launch.generation, &ready)
        .await
        .context("durably commit sealed VM readiness")?;
    let terminal_ready_at = Instant::now();
    let terminal = terminal_state_for_attested_ready(inner, req.name, &launch.generation)
        .await
        .context("build generation-fenced terminal-ready projection")?;
    emit_terminal_state_update(inner, terminal, false).await;
    start_terminal_worker(inner, req.name)
        .await
        .context("failed to start vm terminal worker")?;
    info!(
        image_cache_ms = image_ready_at.duration_since(create_started_at).as_millis(),
        disk_stage_ms = disks_ready_at.duration_since(image_ready_at).as_millis(),
        jail_launch_ms = jail_ready_at.duration_since(disks_ready_at).as_millis(),
        vmm_start_ms = vmm_ready_at.duration_since(jail_ready_at).as_millis(),
        vm_api_ms = boot_accepted_at.duration_since(vmm_ready_at).as_millis(),
        guest_ready_ms = guest_ready_at.duration_since(boot_accepted_at).as_millis(),
        quota_seal_ms = quota_sealed_at.duration_since(guest_ready_at).as_millis(),
        ssh_verify_ms = ssh_verified_at.duration_since(quota_sealed_at).as_millis(),
        terminal_publish_ms = terminal_ready_at
            .duration_since(ssh_verified_at)
            .as_millis(),
        total_ms = terminal_ready_at
            .duration_since(create_started_at)
            .as_millis(),
        "vm booted"
    );

    Ok(())
}
