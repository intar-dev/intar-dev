use super::*;

pub(super) struct RunCreateInput<'a> {
    pub(super) api_started_at: Instant,
    pub(super) name: &'a str,
    pub(super) run_id: &'a str,
    pub(super) image: &'a OciDigest,
    pub(super) kino: &'a OciDigest,
    pub(super) spec: &'a OciDigest,
    pub(super) mode: SpecMode,
    pub(super) egress: bool,
    pub(super) terminal: bool,
    pub(super) runtime: &'a CreateScenarioVmRuntime,
    pub(super) tap: &'a str,
    pub(super) ssh_public_port: Option<u16>,
    pub(super) kino_vsock_cid: u32,
    pub(super) cpu_millis: u32,
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
    pub(super) cpu_millis: u32,
    pub(super) name: &'a str,
    pub(super) cmdline: &'a str,
    pub(super) paths: &'a JailPathMap,
    pub(super) memory_mib: u32,
    pub(super) tap: &'a str,
    pub(super) mac: &'a str,
    pub(super) kino_vsock_cid: u32,
}

pub(super) fn build_cloud_hypervisor_vm_config(
    input: CloudHypervisorVmConfigInput<'_>,
) -> Result<VmConfig> {
    let paths = input.paths;
    let text = |path: &Path| path.display().to_string();
    let (kernel, initramfs) = (
        text(&paths.jailed_kernel),
        paths.jailed_initrd.as_deref().map(text),
    );
    let (root, runtime, recording) = (
        text(&paths.jailed_root_disk),
        text(&paths.jailed_runtime_disk),
        text(&paths.jailed_recording_disk),
    );
    let (serial, console, vsock) = (
        text(&paths.jailed_serial_log),
        text(&paths.jailed_console_log),
        text(&paths.jailed_vsock_socket),
    );
    Ok(cloud_hypervisor_client::machine::machine_vm_config(
        &cloud_hypervisor_client::machine::MachineVmInput {
            name: input.name,
            cpu_millis: input.cpu_millis,
            memory_mib: input.memory_mib,
            kernel: &kernel,
            initramfs: initramfs.as_deref(),
            cmdline: input.cmdline,
            root_disk: &root,
            runtime_disk: &runtime,
            recording_disk: &recording,
            serial_log: &serial,
            console_log: &console,
            tap: input.tap,
            mac: input.mac,
            vsock_socket: &vsock,
            vsock_cid: input.kino_vsock_cid,
        },
    ))
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

#[tracing::instrument(name = "vm.prepare_image", skip_all, fields(image = image.image.as_str()))]
pub(super) async fn ensure_jailer_image_template(
    inner: &Inner,
    image: &image_cache::PulledMachine,
    request_class: RequestClass,
    prepare_wake: bool,
) -> Result<PreparedImageV3Result> {
    let capabilities = cached_jailer_launch_capabilities(inner).await?;
    if !(capabilities.supports_jailer_v3
        && capabilities.supports_template_backed_launch
        && capabilities.fast_template_store)
    {
        anyhow::bail!("jailerd does not attest the mandatory v3 chunked launch contract");
    }
    let cache_root =
        image_cache::default_cache_root().context("failed to determine image cache root")?;
    let store = image_cache::BlobStore::new(&cache_root);
    let roots = &capabilities.allowed_source_roots;
    let blob = |digest: &OciDigest| {
        artifact_source(
            &store.path(digest),
            roots,
            Some(digest.hex()),
            ArtifactAccess::ReadOnly,
        )
    };
    let config = &image.manifest.config.digest;
    let request = PrepareChunkedImageV3Request {
        image_id: Sha256Digest::parse(image.image.hex().to_owned())?,
        chunk_manifest_sha256: Sha256Digest::parse(config.hex().to_owned())?,
        virtual_size_bytes: image.config.disk.size_bytes,
        image_manifest: blob(&image.image)?,
        manifest: blob(config)?,
        chunk_cache_root: trusted_directory_source(store.directory(), roots)?,
        kernel: blob(&image.kernel)?,
        initrd: image.initrd.as_ref().map(blob).transpose()?,
        // A learner launch waits for this template, so the launch path passes
        // `Foreground` and is never parked. The background cache warmer passes
        // `Background`, which keeps it inside jailerd's background lane.
        request_class,
        prepare_wake,
    };
    request.validate()?;
    let result = match request_jailerd_with_timeout(
        inner,
        JailerRequest::PrepareChunkedImageV3(Box::new(request.clone())),
        // A background import is rate limited on purpose, so its budget must
        // cover the physical minimum for this image size. The foreground
        // class keeps the fixed budget and is never parked.
        jailer_prepare_timeout(
            request_class,
            request.virtual_size_bytes,
            wake_prepare_bytes(image, prepare_wake),
        ),
    )
    .await?
    {
        JailerResponse::PrepareChunkedImageV3(result) => result,
        JailerResponse::Error(error) if error.code == "image_prepare_requeued" => {
            // Jailerd parked the background import at a block boundary to keep
            // a boot responsive. The work is not lost and the request is not
            // broken: the cache pass requeues it.
            return Err(ImagePrepareRequeued {
                message: error.message,
            }
            .into());
        }
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => anyhow::bail!(
            "jailerd returned unexpected response to prepare_chunked_image_v3: {response:?}"
        ),
    };
    validate_prepared_image_v3_result(&request, &result)?;
    image_cache::mark_template_ready(&cache_root, image, &result).await?;
    Ok(result)
}

/// The suspended guest's RAM size plus a pack's delta bytes, when asked.
pub(super) fn wake_prepare_bytes(
    image: &image_cache::PulledMachine,
    prepare_wake: bool,
) -> Option<u64> {
    let ram = image.config.wake.as_ref()?.ram.size_bytes;
    prepare_wake.then(|| {
        image
            .manifest
            .layers
            .iter()
            .filter(|layer| layer.media_type == intar_contracts::oci::WAKE_DELTA_MEDIA_TYPE)
            .fold(ram, |total, layer| total.saturating_add(layer.size))
    })
}

fn validate_prepared_image_v3_result(
    request: &PrepareChunkedImageV3Request,
    result: &PreparedImageV3Result,
) -> Result<()> {
    anyhow::ensure!(
        result.image_id == request.image_id
            && result.chunk_manifest_sha256 == request.chunk_manifest_sha256
            && result.virtual_size_bytes == request.virtual_size_bytes
            && result.fast_template_store,
        "jailerd prepared v3 image identity mismatch"
    );
    for (source, name, sha256, access) in [
        (
            &result.root_disk,
            "root.raw",
            Some(&request.image_id),
            ArtifactAccess::ReadWrite,
        ),
        (
            &result.kernel,
            "kernel",
            request.kernel.sha256.as_ref(),
            ArtifactAccess::ReadOnly,
        ),
    ] {
        anyhow::ensure!(
            source.source_root == PREPARED_IMAGE_SOURCE_ROOT
                && source.relative_path == PathBuf::from(request.image_id.as_str()).join(name)
                && source.sha256.as_ref() == sha256
                && source.access == access,
            "jailerd returned an invalid prepared v3 {name} descriptor"
        );
    }
    match (&request.initrd, &result.initrd) {
        (Some(expected), Some(actual)) => anyhow::ensure!(
            actual.relative_path == PathBuf::from(request.image_id.as_str()).join("initrd")
                && actual.sha256 == expected.sha256
                && actual.access == ArtifactAccess::ReadOnly,
            "jailerd returned invalid prepared v3 initrd"
        ),
        (None, None) => {}
        _ => anyhow::bail!("jailerd prepared v3 initrd shape mismatch"),
    }
    anyhow::ensure!(
        !request.prepare_wake || result.wake.is_some(),
        "jailerd prepared no wake files although asked to"
    );
    if let Some(wake) = &result.wake {
        image_cache::check_prepared_wake(request.image_id.as_str(), wake)?;
    }
    Ok(())
}

fn build_jailer_launch_operation(
    request: VmLaunchRequest,
    prepared: &PreparedImageV3Result,
) -> Result<JailerRequest> {
    let operation = LaunchVmV3Request {
        image_id: prepared.image_id.clone(),
        chunk_manifest_sha256: prepared.chunk_manifest_sha256.clone(),
        virtual_size_bytes: prepared.virtual_size_bytes,
        launch: request,
    };
    operation.validate()?;
    Ok(JailerRequest::LaunchVmV3(Box::new(operation)))
}

pub(super) async fn request_v3_launch_with_single_retry<F, Fut>(
    operation: JailerRequest,
    mut send: F,
) -> Result<JailerResponse>
where
    F: FnMut(JailerRequest) -> Fut,
    Fut: Future<Output = Result<JailerResponse>>,
{
    anyhow::ensure!(
        matches!(operation, JailerRequest::LaunchVmV3(_)),
        "v3 launch retry requires an exact LaunchVmV3 operation"
    );
    let retry = operation.clone();
    match send(operation).await {
        Ok(response) => Ok(response),
        Err(first_error) => send(retry).await.with_context(|| {
            format!(
                "identical LaunchVmV3 retry failed after the first transport attempt failed: {first_error:#}"
            )
        }),
    }
}

#[tracing::instrument(name = "vm.launch", skip_all, fields(vm = req.name, run_id = req.run_id))]
pub(super) async fn launch_jailed_cloud_hypervisor(
    inner: &Inner,
    req: &RunCreateInput<'_>,
    ready: &image_cache::ReadyImage,
    wake: bool,
) -> Result<VmLaunchResult> {
    let prepared = &ready.prepared_image;
    let run_id = ValidatedId::parse(req.run_id.to_string()).context("validate jailer run ID")?;
    let vm_id = ValidatedId::parse(req.name.to_string()).context("validate jailer VM ID")?;

    let capabilities = cached_jailer_launch_capabilities(inner).await?;

    let root_disk_size_bytes = req
        .disk_mib
        .map(|target_disk_mib| u64::from(target_disk_mib) * 1024 * 1024)
        .unwrap_or(ready.disk_size_bytes);
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
        wake: if wake {
            Some(
                prepared
                    .wake
                    .clone()
                    .context("the image's suspended guest is not prepared")?,
            )
        } else {
            None
        },
    };

    let request = VmLaunchRequest {
        run_id,
        vm_id,
        cpu_millis: req.cpu_millis,
        memory_mib: req.memory_mib,
        root_disk_size_bytes,
        tap_name: req.tap.to_string(),
        mac_address: req.mac.to_string(),
        guest_ip_cidr: req.network.guest_ip_cidr.clone(),
        ssh_public_port: req.ssh_public_port,
        vsock_cid: req.kino_vsock_cid,
        egress: req.egress,
        artifacts,
    };
    let launch_operation = build_jailer_launch_operation(request, prepared)?;

    // A transport timeout can occur after jailerd committed the launch but
    // before the response arrived. Replay the byte-equivalent v2 operation so
    // jailerd's fingerprint and generation fences remain authoritative. Never
    // synthesize success from InspectVm, which cannot attest the request.
    let launch_response = request_v3_launch_with_single_retry(launch_operation, |operation| {
        request_jailerd(inner, operation)
    })
    .await?;

    match launch_response {
        JailerResponse::LaunchVmV3(result) => Ok(result),
        JailerResponse::Error(error) if error.code == "cpu_capacity_exhausted" => {
            Err(CpuCapacityPending {
                message: error.message,
            }
            .into())
        }
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => {
            anyhow::bail!("jailerd returned unexpected response to v3 launch: {response:?}")
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
    let attestation = result
        .cpu_runtime
        .attestation
        .as_ref()
        .context("jailerd finalized VM without quota readback attestation")?;
    anyhow::ensure!(
        attestation.quota == result.cpu_runtime.quota
            && attestation.cpu_max == result.cpu_runtime.quota.cpu_max()
            && attestation.cpu_max_burst == 0,
        "jailerd CPU quota attestation did not match the recorded entitlement"
    );
    anyhow::ensure!(
        !expect_ssh_forward || result.ssh_forward_active,
        "jailerd finalized VM without activating its reserved SSH forward"
    );
    Ok(result)
}

pub(super) async fn commit_ready_vm(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
    ready: &GuestUpdate,
) -> Result<()> {
    anyhow::ensure!(
        ready.vm_name == name,
        "guest report identifies a different VM"
    );
    anyhow::ensure!(
        ready.jail_generation == generation.as_str(),
        "guest report generation does not match the live generation"
    );
    anyhow::ensure!(
        ready.ssh_ready && ready.failed.is_none(),
        "guest report is not a ready one"
    );
    let lab_row = lab_row(ready)?;
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
        "guest report run does not match the live VM"
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
        Some(runtime.quota.cpu_millis) == details.cpu_millis
            && runtime
                .attestation
                .as_ref()
                .is_some_and(|proof| proof.quota == runtime.quota
                    && proof.cpu_max == runtime.quota.cpu_max()
                    && proof.cpu_max_burst == 0
                    && proof.verified_at_unix_ms > 0),
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
        .upsert_vm_and_lab(committed.to_db_row(), lab_row)
        .await
        .context("atomically persist running VM and its lab")?;
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

fn trusted_directory_source(
    path: &Path,
    allowed_source_roots: &[PathBuf],
) -> Result<TrustedDirectorySource> {
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
        .context("jailer directory is outside configured trusted source roots")?;
    Ok(TrustedDirectorySource {
        source_root: u16::try_from(source_root).context("too many jailer source roots")?,
        relative_path,
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

/// Difference rounded cumulative timestamps so adjacent phases sum exactly to
/// the rounded total. Guest detail timings overlap and are not part of this sum.
pub(super) fn boot_phase_millis(start: Instant, ends: [Instant; 10]) -> [u128; 10] {
    let mut previous = 0;
    ends.map(|end| {
        let elapsed = end.duration_since(start).as_millis();
        let phase = elapsed - previous;
        previous = elapsed;
        phase
    })
}

pub(super) async fn run_create(
    inner: &Arc<Inner>,
    req: RunCreateInput<'_>,
    boot_guard: image_cache::BootCriticalGuard,
) -> Result<()> {
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
    let image_prepare_deadline = Instant::now() + Duration::from_secs(60);
    let mut descriptor_refresh_requested = false;
    let ready_image = loop {
        match image_cache::require_ready_image(&cache_root, req.image).await {
            Ok(ready) => break ready,
            Err(error) if Instant::now() < image_prepare_deadline => {
                if !std::mem::replace(&mut descriptor_refresh_requested, true) {
                    image_cache::wake_cache_refresh();
                    debug!(
                        vm = req.name,
                        "requested image preparation for an unready launch descriptor"
                    );
                }
                debug!(vm = req.name, error = %error, "waiting for event-driven image preparation");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error) => {
                return Err(match image_cache::image_failure(req.image) {
                    Some(failure) => error.context(failure),
                    None => error,
                })
                .context("image was not prepared within 60 seconds");
            }
        }
    };
    let image_ready_at = Instant::now();
    // Kino and the spec come by digest and are checked against it before
    // anything reaches the run disk.
    let store = image_cache::BlobStore::new(&cache_root);
    let (kino_binary, spec) = tokio::try_join!(
        async {
            inner
                .oci
                .kino_binary(req.kino, &store)
                .await
                .context("the VM's Kino is unavailable")
        },
        async {
            inner
                .oci
                .spec(req.spec)
                .await
                .context("the VM's machine spec is unavailable")
        },
    )?;
    ensure_create_not_deleted(inner, req.name).await?;
    set_state(inner, req.name, VmLifecycleState::PreparingDisks).await;

    let base_virtual_size_bytes = ready_image.disk_size_bytes;
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
    let root_resize = req.disk_mib.is_some_and(|target_disk_mib| {
        u64::from(target_disk_mib) * 1024 * 1024 > base_virtual_size_bytes
    });

    let boot = runtime_disk::boot_json(&runtime_disk::BootJsonInput {
        hostname: req.hostname,
        network: req.network,
        egress: req.egress,
        peer_guest_ips: req.peer_guest_ips,
        ssh_enabled: req.terminal,
        ssh_authorized_keys_openssh: &req.runtime.ssh_authorized_keys_openssh,
        root_resize,
        mode: req.mode,
        spec: &spec,
    })
    .context("failed to build boot.json")?;
    // The report filter needs this digest after a restart too, so it is
    // durable before the guest can send a report.
    {
        let persisted = {
            let mut states = inner.states.write().await;
            let vm = states
                .get_mut(req.name)
                .context("VM state disappeared before its run disk was written")?;
            let details = vm
                .details
                .as_mut()
                .context("VM details disappeared before its run disk was written")?;
            details.boot_sha256 = Some(boot.sha256.clone());
            vm.clone()
        };
        inner
            .db
            .upsert_vm(persisted.to_db_row())
            .await
            .context("persist the VM's boot.json digest")?;
        publish_inventory_update(inner);
    }
    ensure_create_not_deleted(inner, req.name).await?;

    info!(path = %req.config_disk_path.display(), "writing run disk");
    let config_disk_path = req.config_disk_path.to_path_buf();
    let runtime_disk_task = tokio::task::spawn_blocking(move || {
        runtime_disk::write_runtime_disk(&config_disk_path, &boot.bytes, &kino_binary)
    });
    let (runtime_disk_result, network_result) = tokio::join!(runtime_disk_task, network_task);
    let runtime_disk_result = runtime_disk_result.context("run disk task panicked")?;
    let run_network = network_result.context("run network task panicked")?;
    let run_network = run_network.context("failed to ensure jailed run network")?;
    runtime_disk_result.context("failed to write the run disk")?;
    ensure_create_not_deleted(inner, req.name).await?;
    let disks_ready_at = Instant::now();

    set_state(inner, req.name, VmLifecycleState::CreatingVm).await;

    let decision = start_decision(inner, &req, &ready_image).await?;
    match &decision {
        StartDecision::Wake => info!(
            vm = req.name,
            image = req.image.as_str(),
            "waking the VM from its image's suspended guest"
        ),
        StartDecision::Cold(reason) => info!(
            vm = req.name,
            image = req.image.as_str(),
            reason = reason.as_str(),
            "booting the VM cold"
        ),
    }
    let mut backend = LiveStart {
        inner,
        req: &req,
        ready: &ready_image,
        run_network: &run_network,
        run_guard: Some(run_launch_guard),
        launch_deadline: Instant::now() + Duration::from_secs(SCENARIO_READY_MAX_TIMEOUT_SECONDS),
        attempt: None,
    };
    let (launch, start) = start_vm(&mut backend, decision).await?;
    let attempt = backend
        .attempt
        .take()
        .context("the VM start left no booted attempt")?;
    if start.path == VmStartPath::Wake {
        // The woken jail no longer needs the agent's sources.
        remove_agent_launch_sources(&req)
            .await
            .context("remove unprivileged launch staging files")?;
        ensure_create_not_deleted(inner, req.name).await?;
    }
    if start.path == VmStartPath::WakeFallback {
        info!(
            vm = req.name,
            image = req.image.as_str(),
            reason = start.reason.as_deref().unwrap_or_default(),
            "the wake fell back to a cold boot"
        );
    }
    persist_vm_start(inner, req.name, start).await?;
    let StartAttempt {
        ch,
        details,
        readiness_updates,
        jail_ready_at,
        vmm_ready_at,
        boot_accepted_at,
        ..
    } = attempt;

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
    commit_ready_vm(inner, req.name, &launch.generation, &ready)
        .await
        .context("durably commit sealed VM readiness")?;
    let terminal = terminal_state_for_attested_ready(inner, req.name, &launch.generation)
        .await
        .context("build generation-fenced terminal-ready projection")?;
    emit_terminal_state_update(inner, terminal, false).await;
    start_terminal_worker(inner, req.name)
        .await
        .context("failed to start vm terminal worker")?;
    let terminal_ready_at = Instant::now();
    // The boot-critical window ends at the durable terminal-ready boundary.
    // Background cache work may resume between its blocks now; an error,
    // a delete request, or a task cancel drops this guard on the same path.
    drop(boot_guard);
    let [
        queue_ms,
        image_cache_ms,
        disk_stage_ms,
        jail_launch_ms,
        vmm_start_ms,
        vm_api_ms,
        guest_ready_ms,
        quota_seal_ms,
        ssh_verify_ms,
        terminal_publish_ms,
    ] = boot_phase_millis(
        req.api_started_at,
        [
            create_started_at,
            image_ready_at,
            disks_ready_at,
            jail_ready_at,
            vmm_ready_at,
            boot_accepted_at,
            guest_ready_at,
            quota_sealed_at,
            ssh_verified_at,
            terminal_ready_at,
        ],
    );
    info!(
        vm = req.name,
        run_id = req.run_id,
        boot_timing_version = 2_u16,
        queue_ms,
        image_cache_ms,
        disk_stage_ms,
        jail_launch_ms,
        vmm_start_ms,
        vm_api_ms,
        guest_ready_ms,
        first_report_ms = ready.first_report_ms,
        guest_timings_ms = ?ready.lab.timings_ms,
        quota_seal_ms,
        ssh_verify_ms,
        terminal_publish_ms,
        total_ms = terminal_ready_at
            .duration_since(req.api_started_at)
            .as_millis(),
        "vm booted"
    );

    Ok(())
}

/// Whether this VM wakes, from the host's settings, the prepared image,
/// jailerd and the VM's size.
async fn start_decision(
    inner: &Inner,
    req: &RunCreateInput<'_>,
    ready: &image_cache::ReadyImage,
) -> Result<StartDecision> {
    let capabilities = cached_jailer_launch_capabilities(inner).await?;
    let fell_back_recently = inner
        .wake_fallbacks
        .lock()
        .is_ok_and(|fallbacks| fell_back_recently(&fallbacks, req.image, Instant::now()));
    let now_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        });
    Ok(decide_start(&StartFacts {
        config: &inner.wake,
        wake: ready.wake.as_ref(),
        prepared: ready.prepared_image.wake.is_some(),
        jailer_supports_wake: capabilities.supports_wake,
        vmm_version: CLOUD_HYPERVISOR_VERSION,
        now_unix_ms,
        memory_mib: req.memory_mib,
        cpu_millis: req.cpu_millis,
        fell_back_recently,
    }))
}

/// Keep how the VM started, for its `VmStartV1` reports.
async fn persist_vm_start(inner: &Inner, name: &str, start: VmStartV1) -> Result<()> {
    let persisted = {
        let mut states = inner.states.write().await;
        let vm = states
            .get_mut(name)
            .context("VM state disappeared during its start")?;
        vm.details
            .as_mut()
            .context("VM details disappeared during its start")?
            .start = Some(start);
        vm.clone()
    };
    inner
        .db
        .upsert_vm(persisted.to_db_row())
        .await
        .context("persist how the VM started")
}

/// The booted generation's handles.
struct StartAttempt {
    ch: ChClient,
    details: VmDetails,
    readiness_updates: broadcast::Receiver<GuestUpdate>,
    first_reports: broadcast::Receiver<GuestUpdate>,
    booted_at: Instant,
    jail_ready_at: Instant,
    vmm_ready_at: Instant,
    boot_accepted_at: Instant,
}

/// A VM start against jailerd and cloud-hypervisor.
struct LiveStart<'a> {
    inner: &'a Arc<Inner>,
    req: &'a RunCreateInput<'a>,
    ready: &'a image_cache::ReadyImage,
    run_network: &'a RunNetworkResult,
    /// The run fence the first launch inherits; a second launch takes it
    /// again.
    run_guard: Option<OwnedMutexGuard<()>>,
    launch_deadline: Instant,
    attempt: Option<StartAttempt>,
}

impl StartBackend for LiveStart<'_> {
    type Launched = VmLaunchResult;

    async fn launch(&mut self, wake: bool) -> Result<VmLaunchResult> {
        let (inner, req) = (self.inner, self.req);
        let run_guard = match self.run_guard.take() {
            Some(guard) => guard,
            None => acquire_run_cleanup_lock(&inner.run_cleanup_locks, req.run_id).await,
        };
        ensure_create_not_deleted(inner, req.name).await?;
        let mut capacity_attempt = 0_u32;
        let launch = loop {
            match launch_jailed_cloud_hypervisor(inner, req, self.ready, wake).await {
                Ok(result) => break result,
                Err(error) if error.downcast_ref::<CpuCapacityPending>().is_some() => {
                    ensure_create_not_deleted(inner, req.name).await?;
                    if Instant::now() >= self.launch_deadline {
                        return Err(error).context("timed out waiting for jailerd CPU capacity");
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
        persist_jail_launch(inner, req.name, &launch, self.run_network).await?;
        drop(run_guard);

        // A wake keeps the agent's sources until it reported, so a fallback
        // can launch again.
        if !wake {
            remove_agent_launch_sources(req)
                .await
                .context("remove unprivileged launch staging files")?;
        }
        ensure_create_not_deleted(inner, req.name).await?;
        Ok(launch)
    }

    async fn boot(&mut self, launch: &VmLaunchResult, wake: bool) -> Result<()> {
        let (inner, req) = (self.inner, self.req);
        let jail_ready_at = Instant::now();
        let cold = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
            cpu_millis: req.cpu_millis,
            name: req.name,
            cmdline: &self.ready.cmdline,
            paths: &launch.paths,
            memory_mib: req.memory_mib,
            tap: req.tap,
            mac: req.mac,
            kino_vsock_cid: req.kino_vsock_cid,
        })?;
        let guest = match (wake, self.ready.wake.as_ref(), launch.paths.wake.as_ref()) {
            (false, _, _) => None,
            (true, Some(guest), Some(paths)) => Some((guest, paths)),
            (true, _, _) => anyhow::bail!("the wake launch has no suspended guest"),
        };
        let vm_cfg = match guest {
            Some((guest, paths)) => wake_vm_config(cold, guest, paths, req.memory_mib)?,
            None => cold,
        };

        // LaunchVmV3 returns only after jailerd has pinned and pinged the API socket.
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
        let readiness_updates = inner.guest_reports_tx.subscribe();
        let first_reports = inner.guest_reports_tx.subscribe();
        // Bind and activate the guest-initiated report socket before boot. A
        // fast guest's first Kino report must not race listener startup and fall
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
        mark_vmm_started(inner, req.name);
        let booted_at = Instant::now();
        ch.vm_boot()
            .await
            .context("cloud-hypervisor vm.boot failed")?;
        if let Some((guest, _)) = guest {
            let vcpus = vcpu_count(req.cpu_millis);
            if vcpus > guest.shape.boot_vcpus {
                ch.vm_resize(&cloud_hypervisor_client::VmResize {
                    desired_vcpus: Some(vcpus),
                    ..Default::default()
                })
                .await
                .context("cloud-hypervisor vm.resize failed")?;
            }
        }
        ensure_create_not_deleted(inner, req.name).await?;
        self.attempt = Some(StartAttempt {
            ch,
            details,
            readiness_updates,
            first_reports,
            booted_at,
            jail_ready_at,
            vmm_ready_at,
            boot_accepted_at: Instant::now(),
        });
        Ok(())
    }

    async fn first_report(
        &mut self,
        launch: &VmLaunchResult,
        limit: Duration,
    ) -> Option<&'static str> {
        let (name, run_id) = (self.req.name, self.req.run_id);
        let Some(attempt) = self.attempt.as_mut() else {
            return Some("the wake left no booted VM");
        };
        let deadline = tokio::time::Instant::from_std(attempt.booted_at + limit);
        let mut poll = tokio::time::interval(Duration::from_millis(
            SCENARIO_READY_PROCESS_POLL_INTERVAL_MILLIS,
        ));
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => return Some("no report within 10 s"),
                update = attempt.first_reports.recv() => match update {
                    Ok(update) => {
                        if ready_gate(&update, name, run_id, launch.generation.as_str())
                            != ReadyGate::OtherVm
                        {
                            return None;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        return Some("the report channel closed");
                    }
                },
                _ = poll.tick() => {
                    if ensure_scenario_runtime_process_live(name, &attempt.details).await.is_err() {
                        return Some("the VMM exited before the first report");
                    }
                    match timeout(Duration::from_secs(1), attempt.ch.vm_info()).await {
                        Ok(Ok(info))
                            if matches!(info.state, cloud_hypervisor_client::VmState::Shutdown) =>
                        {
                            return Some("the guest shut down before the first report");
                        }
                        Ok(Err(cloud_hypervisor_client::Error::HttpStatus { status: 404, .. })) => {
                            return Some("the VM disappeared before the first report");
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    async fn destroy(&mut self, launch: VmLaunchResult) -> Result<()> {
        let (inner, name) = (self.inner, self.req.name);
        self.attempt = None;
        stop_probe_worker(inner, name).await;
        stop_run_cli_broker(inner, name).await;
        cleanup_jailed_vm_by_selector(inner, VmIdentityRequest::by_generation(launch.generation))
            .await
            .context("destroy the woken jail generation")
    }

    async fn ensure_wanted(&mut self) -> Result<()> {
        ensure_create_not_deleted(self.inner, self.req.name).await
    }

    fn record_fallback(&mut self) {
        if let Ok(mut fallbacks) = self.inner.wake_fallbacks.lock() {
            remember_fallback(&mut fallbacks, self.req.image, Instant::now());
        }
    }
}
