use super::*;

pub(super) fn config_runtime_fingerprint(
    config: &JailerdConfig,
    runtime_sha256: &str,
    jailerd_sha256: &str,
    jailer_sha256: &str,
) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(b"intar-jailerd-self-test-attestation-v2\0");
    hasher.update(serde_json::to_vec(config)?);
    hasher.update(b"\0");
    hasher.update(runtime_sha256.as_bytes());
    hasher.update(b"\0");
    hasher.update(jailerd_sha256.as_bytes());
    hasher.update(b"\0");
    hasher.update(jailer_sha256.as_bytes());
    Ok(hex_digest(hasher.finalize()))
}

pub(super) fn verify_artifacts(artifacts: &SelfTestArtifacts) -> Result<PathBuf> {
    artifacts.validate()?;
    let artifact_list = [
        Some(&artifacts.kernel),
        artifacts.initrd.as_ref(),
        Some(&artifacts.root_disk),
        Some(&artifacts.runtime_disk),
        Some(&artifacts.recording_disk),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let artifact_root = shared_artifact_parent(&artifact_list)?;
    ensure_trusted_directory(&artifact_root)
        .context("self-test artifact root is not root-only and trusted")?;
    for artifact in artifact_list {
        let (actual_sha256, metadata) = file_sha256_and_metadata(&artifact.path)?;
        ensure!(
            actual_sha256 == artifact.sha256,
            "self-test artifact hash mismatch: {}",
            artifact.path.display()
        );
        ensure!(
            metadata.is_file(),
            "self-test artifact is not a regular file"
        );
        ensure!(
            metadata.nlink() == 1,
            "self-test artifact must have one link"
        );
        ensure!(
            metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
            "self-test artifacts must be root-owned and non-writable"
        );
    }
    Ok(artifact_root)
}

pub(super) fn shared_artifact_parent(artifacts: &[&VerifiedArtifact]) -> Result<PathBuf> {
    let first = artifacts.first().context("self-test has no artifacts")?;
    let parent = first
        .path
        .parent()
        .context("self-test artifact has no parent directory")?;
    ensure!(
        artifacts
            .iter()
            .all(|artifact| artifact.path.parent() == Some(parent)),
        "all self-test artifacts must share one root-only parent directory"
    );
    Ok(parent.to_path_buf())
}

pub(super) fn run_cloud_hypervisor_smoke(
    config: &JailerdConfig,
    artifacts: &SelfTestArtifacts,
    artifact_root: &Path,
    directory: &Path,
) -> Result<()> {
    let agent_probe_executable = trusted_current_exe()?.path;
    let lifecycle_root = directory.join("cloud-hypervisor-lifecycle");
    create_root_directory(&lifecycle_root)?;
    let mut smoke_config = config.clone();
    smoke_config.jail_root = lifecycle_root.join("jails");
    create_root_directory(&smoke_config.jail_root)?;
    grant_agent_self_test_traversal(config, directory, &lifecycle_root, &smoke_config.jail_root)?;
    // This isolated Core instance has no other reservations.  The operator
    // reserve is validated by the normal daemon; retaining it here would
    // make the proof impossible on an otherwise empty one-core CI host.
    smoke_config.cpu_reserved_millis = 0;
    // The saturation proof intentionally exercises eight 125m cgroups in
    // one isolated 1000m authority. Production boot-lease defaults are
    // covered separately; using them here would test the boot pool rather
    // than the steady hard-quota invariant this proof exists to attest.
    smoke_config.boot_cpu_millis = SELF_TEST_CPU_MILLIS;
    smoke_config.guest_network_pool = "10.77.255.240/28".to_owned();
    if !smoke_config
        .allowed_source_roots
        .iter()
        .any(|root| root == artifact_root)
    {
        smoke_config
            .allowed_source_roots
            .push(artifact_root.to_path_buf());
    }
    ensure_saturation_resources(&smoke_config, artifacts)?;

    // The ordinary constructor accepts only a durable verified
    // attestation.  This narrowly scoped constructor is available only to
    // this root self-test module and carries the in-memory negative-access
    // proof until the full lifecycle succeeds and is published.
    let backend = SystemdHostBackend::connect_with_landlock_attestation(&smoke_config, true)?;
    let readiness = HostReadiness {
        uid_gid_range_collision_free: crate::identity_range_is_free(&smoke_config),
        config_trusted: true,
        source_roots_trusted: true,
        jailer_binary_trusted: true,
        runtime_hash_verified: true,
        runtime_statically_linked: crate::elf_has_no_interpreter(
            &smoke_config.cloud_hypervisor_binary,
        ),
        systemd_version: Some(read_systemd_version()?),
        supports_systemd_transient_units: true,
        supports_cgroup_v2: true,
        seccomp_supported: true,
        landlock_abi: Some(3),
        privileged_self_test_passed: true,
        kvm_accounting_proven: true,
        posix_acl_supported: true,
    };
    let mut core = JailerdCore::new_with_readiness(
        smoke_config.clone(),
        backend,
        FileSystemJailPreparer::default(),
        // The disposable authority intentionally advertises exactly one
        // schedulable core. This makes the ninth 125m launch exercise the
        // same final local admission path used in production even on a
        // host with more CPUs.
        SELF_TEST_SATURATION_CPU_MILLIS,
        readiness,
    )?;

    let suffix = Uuid::new_v4().simple().to_string();
    let run_id = ValidatedId::parse(format!("selftest-{}", &suffix[..12]))?;
    let network_request = EnsureRunNetworkRequest {
        run_id: run_id.clone(),
        guest_cidr: "10.77.255.240/28".to_owned(),
        gateway: "10.77.255.241".to_owned(),
    };
    let prepared_image = prepare_smoke_image(&mut core, &smoke_config, artifacts)
        .context("prepare the package-smoke image in the root-owned v2 template store")?;
    // Fast-template readiness is a host-level prerequisite. Prove it
    // before creating a run namespace so a fail-closed readiness error
    // cannot leave network authority behind.
    expect_run_network(core.handle(Request::EnsureRunNetwork(network_request.clone())))?;

    // Boot eight independent v2 template-backed VMMs in the same run
    // network. Their 125m
    // reservations fill exactly one advertised schedulable core while
    // retaining separate generations, identities, TAPs, units and leaf
    // cgroups. A ninth typed request is then required to fail admission
    // before any privileged resource is allocated.
    let launch_requests = (0..SELF_TEST_SATURATION_VM_COUNT)
        .map(|index| {
            smoke_launch_request(
                &smoke_config,
                artifacts,
                &prepared_image,
                &run_id,
                &suffix,
                u8::try_from(index).expect("saturation VM index fits in u8"),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let tasks_before = snapshot_tasks()?;
    let mut launches = Vec::with_capacity(launch_requests.len());
    let mut selectors = Vec::with_capacity(launch_requests.len());
    for request in &launch_requests {
        match launch_smoke_vm(&mut core, request) {
            Ok(launch) => {
                selectors.push(VmIdentityRequest::by_generation(launch.generation.clone()));
                launches.push(launch);
            }
            Err(operation) => {
                let cleanup = cleanup_smoke_vms(&mut core, &selectors, &run_id);
                return match cleanup {
                    Ok(()) => Err(operation),
                    Err(cleanup) => Err(operation).context(format!(
                        "partial saturation package-smoke cleanup also failed: {cleanup:#}"
                    )),
                };
            }
        }
    }

    let admission = prove_saturation_admission(
        &mut core,
        &smoke_config,
        artifacts,
        &prepared_image,
        &run_id,
        &suffix,
        &mut selectors,
    );
    if let Err(operation) = admission {
        let cleanup = cleanup_smoke_vms(&mut core, &selectors, &run_id);
        return match cleanup {
            Ok(()) => Err(operation),
            Err(cleanup) => Err(operation).context(format!(
                "saturation admission cleanup also failed: {cleanup:#}"
            )),
        };
    }

    let lifecycle = (|| -> Result<()> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let mut clients = Vec::with_capacity(launches.len());
        for ((launch, request), index) in launches.iter().zip(&launch_requests).zip(0..) {
            ensure!(
                !launch.paths.host_jail_root.join("dev/vhost-vsock").exists(),
                "package smoke VM {index} unexpectedly exposed /dev/vhost-vsock"
            );
            let landlock_canary = launch.paths.host_jail_root.join("run/landlock-api-canary");
            write_new_root_file(&landlock_canary, b"landlock-vmm-negative\n", 0o444)
                .with_context(|| format!("create package-smoke VM {index} Landlock canary"))?;
            prove_agent_api_access(
                &agent_probe_executable,
                &launch.paths.host_api_socket,
                smoke_config.agent_uid,
                smoke_config.agent_gid,
            )
            .with_context(|| {
                format!("prove package-smoke VM {index} API access as the agent identity")
            })?;
            let client = CloudHypervisorClient::new(path_utf8(&launch.paths.host_api_socket)?)?;
            let vm_config = smoke_vm_config(launch, &request.launch)?;
            runtime
                .block_on(start_smoke_vm(&client, &vm_config))
                .with_context(|| format!("start package-smoke VM {index}"))?;
            assert_smoke_vsock_socket(&smoke_config, launch)
                .with_context(|| format!("validate package-smoke VM {index} vsock"))?;
            clients.push(client);
        }

        let mut inspections = Vec::with_capacity(selectors.len());
        for (index, (selector, launch)) in selectors.iter().zip(&launches).enumerate() {
            let inspection = expect_inspection(
                core.handle(Request::InspectVm(selector.clone())),
                &format!("inspect booted package-smoke VM {index}"),
            )?;
            wait_for_guest_ready(
                &launch.paths.host_console_log,
                SATURATION_GUEST_READY_TIMEOUT,
            )
            .with_context(|| format!("wait for package-smoke VM {index}"))?;
            match core.handle(Request::FinalizeVmBoot(FinalizeVmBootRequest {
                generation: launch.generation.clone(),
            })) {
                Response::FinalizeVmBoot(result)
                    if result.cpu_runtime.phase == intar_jailer_protocol::VmCpuPhase::Steady => {}
                Response::Error(error) => bail!(
                    "finalize package-smoke VM {index}: {}: {}",
                    error.code,
                    error.message
                ),
                response => bail!(
                    "finalize package-smoke VM {index} returned unexpected response: {response:?}"
                ),
            }
            assert_smoke_inspection(&inspection)
                .with_context(|| format!("validate package-smoke VM {index}"))?;
            runtime
                .block_on(prove_cloud_hypervisor_landlock(&clients[index]))
                .with_context(|| format!("prove package-smoke VM {index} Landlock"))?;
            let post_landlock_inspection = expect_inspection(
                core.handle(Request::InspectVm(selector.clone())),
                &format!("inspect package-smoke VM {index} after Landlock denial"),
            )?;
            assert_smoke_inspection(&post_landlock_inspection).with_context(|| {
                format!("validate package-smoke VM {index} after Landlock denial")
            })?;
            inspections.push(post_landlock_inspection);
        }

        assert_saturation_vm_isolation(&inspections, &tasks_before)?;
        for (index, client) in clients.iter().enumerate() {
            runtime
                .block_on(shutdown_smoke_vm(client))
                .with_context(|| format!("shutdown package-smoke VM {index}"))?;
        }
        Ok(())
    })();

    let cleanup = cleanup_smoke_vms(&mut core, &selectors, &run_id);
    match (lifecycle, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(error).context("clean up package-smoke VM"),
        (Err(operation), Err(cleanup)) => {
            Err(operation).context(format!("package-smoke cleanup also failed: {cleanup:#}"))
        }
    }
}

pub(super) fn grant_agent_self_test_traversal(
    config: &JailerdConfig,
    directory: &Path,
    lifecycle_root: &Path,
    smoke_jail_root: &Path,
) -> Result<()> {
    let self_test_root = directory
        .parent()
        .context("disposable self-test jail has no parent")?;
    let setfacl = crate::trusted_setfacl_binary()?;
    let acl = format!("u:{}:--x,m::--x", config.agent_uid);
    // The API worker deliberately runs as the exact unprivileged agent
    // identity. Grant only directory traversal across the disposable
    // ancestors; it still cannot list, create, read, or write here. The
    // ordinary jail preparation grants the narrower run/socket access.
    for path in [
        config.jail_root.as_path(),
        self_test_root,
        directory,
        lifecycle_root,
        smoke_jail_root,
    ] {
        crate::run_setfacl(&setfacl, path, &acl).with_context(|| {
            format!(
                "grant agent traversal of self-test ancestor {}",
                path.display()
            )
        })?;
    }
    Ok(())
}

pub(super) fn prove_agent_api_access(
    executable: &Path,
    socket: &Path,
    agent_uid: u32,
    agent_gid: u32,
) -> Result<()> {
    let output = Command::new(executable)
        .args([
            OsStr::new("self-test-agent-api-worker"),
            OsStr::new("--socket"),
            socket.as_os_str(),
            OsStr::new("--expected-uid"),
            OsStr::new(&agent_uid.to_string()),
            OsStr::new("--expected-gid"),
            OsStr::new(&agent_gid.to_string()),
        ])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("execute agent-identity Cloud Hypervisor API worker")?;
    ensure!(
        output.status.success(),
        "agent-identity Cloud Hypervisor API worker failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

pub(super) fn ensure_saturation_resources(
    config: &JailerdConfig,
    artifacts: &SelfTestArtifacts,
) -> Result<()> {
    let host_cpu_millis = host_cpu_capacity_millis()?;
    ensure!(
        host_cpu_millis >= SELF_TEST_SATURATION_CPU_MILLIS,
        "eight-VM saturation proof requires at least one online host CPU"
    );
    let identity_count = u64::from(config.uid_gid_end)
        .checked_sub(u64::from(config.uid_gid_start))
        .and_then(|value| value.checked_add(1))
        .context("self-test UID/GID range arithmetic overflow")?;
    ensure!(
        identity_count >= u64::try_from(SELF_TEST_SATURATION_VM_COUNT)?,
        "eight-VM saturation proof requires at least eight disposable identities"
    );

    let meminfo = std::fs::read_to_string("/proc/meminfo")?;
    let available_kib = meminfo
        .lines()
        .find_map(|line| line.strip_prefix("MemAvailable:"))
        .and_then(|value| {
            let mut fields = value.split_whitespace();
            let kib = fields.next()?.parse::<u64>().ok()?;
            (fields.next() == Some("kB") && fields.next().is_none()).then_some(kib)
        })
        .context("/proc/meminfo has no valid MemAvailable value")?;
    let required_memory_mib = u64::from(SELF_TEST_VM_MEMORY_MIB)
        .checked_mul(u64::try_from(SELF_TEST_SATURATION_VM_COUNT)?)
        .and_then(|value| value.checked_add(SELF_TEST_RESOURCE_HEADROOM_MIB))
        .context("self-test memory requirement overflow")?;
    ensure!(
        available_kib >= required_memory_mib.saturating_mul(1024),
        "eight-VM saturation proof requires {required_memory_mib} MiB available memory; host reports {} MiB",
        available_kib / 1024
    );

    let fixture_bytes = [
        Some(&artifacts.kernel),
        artifacts.initrd.as_ref(),
        Some(&artifacts.root_disk),
        Some(&artifacts.runtime_disk),
        Some(&artifacts.recording_disk),
    ]
    .into_iter()
    .flatten()
    .try_fold(0_u64, |total, artifact| {
        total
            .checked_add(std::fs::metadata(&artifact.path)?.len())
            .context("self-test fixture size overflow")
    })?;
    let per_vm_bytes = fixture_bytes
        .checked_add(std::fs::metadata(&config.cloud_hypervisor_binary)?.len())
        .context("self-test per-VM disk requirement overflow")?;
    let required_disk_bytes = per_vm_bytes
        .checked_mul(u64::try_from(SELF_TEST_SATURATION_VM_COUNT)?)
        .and_then(|value| {
            value.checked_add(SELF_TEST_RESOURCE_HEADROOM_MIB.saturating_mul(1024 * 1024))
        })
        .context("self-test disk requirement overflow")?;
    let jail_root = open_absolute_nofollow(&config.jail_root, OFlags::RDONLY | OFlags::DIRECTORY)?;
    let filesystem = rustix::fs::fstatvfs(&jail_root)?;
    let fragment_size = if filesystem.f_frsize == 0 {
        filesystem.f_bsize
    } else {
        filesystem.f_frsize
    };
    let available_disk_bytes = filesystem
        .f_bavail
        .checked_mul(fragment_size)
        .context("self-test available disk size overflow")?;
    ensure!(
        available_disk_bytes >= required_disk_bytes,
        "eight-VM saturation proof requires {} MiB free in the jail filesystem; host reports {} MiB",
        required_disk_bytes / (1024 * 1024),
        available_disk_bytes / (1024 * 1024)
    );
    ensure!(
        filesystem.f_favail >= u64::try_from(SELF_TEST_SATURATION_VM_COUNT)?.saturating_mul(64),
        "jail filesystem lacks free inodes for eight disposable VMs"
    );
    Ok(())
}

pub(super) fn prove_saturation_admission(
    core: &mut JailerdCore<SystemdHostBackend, FileSystemJailPreparer>,
    config: &JailerdConfig,
    artifacts: &SelfTestArtifacts,
    prepared_image: &PreparedImageV2Result,
    run_id: &ValidatedId,
    suffix: &str,
    selectors: &mut Vec<VmIdentityRequest>,
) -> Result<()> {
    ensure!(
        selectors.len() == SELF_TEST_SATURATION_VM_COUNT,
        "saturation admission proof requires eight launched VMs"
    );
    let before = core.capabilities();
    ensure!(
        before.total_cpu_millis == SELF_TEST_SATURATION_CPU_MILLIS
            && before.reserved_cpu_millis == 0
            && before.schedulable_cpu_millis == SELF_TEST_SATURATION_CPU_MILLIS
            && before.committed_cpu_millis == SELF_TEST_SATURATION_CPU_MILLIS,
        "eight 125m VM reservations did not fill exactly one schedulable core"
    );
    ensure!(
        before.supports_jailer_v2
            && before.supports_template_backed_launch
            && before.fast_template_store
            && before.supports_hard_cpu_quota,
        "saturation authority stopped advertising hard v2 template-backed CPU quotas"
    );

    let rejected_index =
        u8::try_from(SELF_TEST_SATURATION_VM_COUNT).expect("saturation VM count fits in u8");
    let ninth = smoke_launch_request(
        config,
        artifacts,
        prepared_image,
        run_id,
        suffix,
        rejected_index,
    )?;
    match core.handle(Request::LaunchVmV2(Box::new(ninth))) {
        Response::Error(error) => ensure!(
            error.code == "boot_capacity_pending",
            "ninth 125m launch failed with unexpected error {}: {}",
            error.code,
            error.message
        ),
        Response::LaunchVmV2(launch) => {
            // Retain the selector so the caller's fail-closed cleanup also
            // drains an erroneously admitted ninth unit and jail.
            selectors.push(VmIdentityRequest::by_generation(launch.generation));
            bail!("ninth 125m VM was admitted after one schedulable core was full")
        }
        response => bail!("ninth 125m launch returned unexpected response: {response:?}"),
    }
    let after = core.capabilities();
    ensure!(
        after.committed_cpu_millis == before.committed_cpu_millis
            && after.schedulable_cpu_millis == before.schedulable_cpu_millis,
        "rejected ninth launch changed local CPU reservations"
    );
    Ok(())
}

pub(super) fn smoke_launch_request(
    config: &JailerdConfig,
    artifacts: &SelfTestArtifacts,
    prepared_image: &PreparedImageV2Result,
    run_id: &ValidatedId,
    suffix: &str,
    index: u8,
) -> Result<LaunchVmV2Request> {
    ensure!(
        usize::from(index) <= SELF_TEST_SATURATION_VM_COUNT,
        "package smoke supports eight VMs plus one rejected admission probe"
    );
    Ok(LaunchVmV2Request {
        image_sha256: prepared_image.image_sha256.clone(),
        virtual_size_bytes: prepared_image.virtual_size_bytes,
        launch: VmLaunchRequest {
            run_id: run_id.clone(),
            vm_id: ValidatedId::parse(format!("vm-{index}"))?,
            cpu_millis: SELF_TEST_CPU_MILLIS,
            vcpu_count: 1,
            memory_mib: SELF_TEST_VM_MEMORY_MIB,
            root_disk_size_bytes: prepared_image.virtual_size_bytes,
            tap_name: format!("is{index}{}", &suffix[..10]),
            mac_address: format!(
                "02:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                u8::from_str_radix(&suffix[0..2], 16)?,
                u8::from_str_radix(&suffix[2..4], 16)?,
                u8::from_str_radix(&suffix[4..6], 16)?,
                u8::from_str_radix(&suffix[6..8], 16)?,
                index.saturating_add(1),
            ),
            guest_ip_cidr: format!("10.77.255.{}/28", index.saturating_add(242)),
            ssh_public_port: None,
            vsock_cid: 4_294_000_001_u32.saturating_add(u32::from(index)),
            artifacts: protocol_artifacts(config, artifacts, prepared_image)?,
        },
    })
}

pub(super) fn launch_smoke_vm(
    core: &mut JailerdCore<SystemdHostBackend, FileSystemJailPreparer>,
    request: &LaunchVmV2Request,
) -> Result<VmLaunchResult> {
    match core.handle(Request::LaunchVmV2(Box::new(request.clone()))) {
        Response::LaunchVmV2(launch) => Ok(launch),
        Response::Error(error) => bail!(
            "jailerd package-smoke launch failed for {}: {}: {}",
            request.launch.vm_id,
            error.code,
            error.message
        ),
        response => bail!(
            "unexpected package-smoke launch response for {}: {response:?}",
            request.launch.vm_id
        ),
    }
}

pub(super) fn prepare_smoke_image(
    core: &mut JailerdCore<SystemdHostBackend, FileSystemJailPreparer>,
    config: &JailerdConfig,
    artifacts: &SelfTestArtifacts,
) -> Result<PreparedImageV2Result> {
    let request = PrepareImageV2Request {
        // The package self-test has no registry descriptor, so the verified
        // raw-root digest is its stable content-addressed image identity.
        image_sha256: Sha256Digest::parse(artifacts.root_disk.sha256.clone())?,
        virtual_size_bytes: std::fs::metadata(&artifacts.root_disk.path)
            .context("stat package-smoke root image")?
            .len(),
        root_disk: protocol_artifact(config, &artifacts.root_disk, ArtifactAccess::ReadOnly)?,
        kernel: protocol_artifact(config, &artifacts.kernel, ArtifactAccess::ReadOnly)?,
        initrd: artifacts
            .initrd
            .as_ref()
            .map(|artifact| protocol_artifact(config, artifact, ArtifactAccess::ReadOnly))
            .transpose()?,
    };
    match core.handle(Request::PrepareImageV2(Box::new(request))) {
        Response::PrepareImageV2(prepared) if prepared.fast_template_store => Ok(prepared),
        Response::PrepareImageV2(_) => {
            bail!("package-smoke image preparation did not attest the fast template store")
        }
        Response::Error(error) => bail!(
            "jailerd package-smoke image preparation failed: {}: {}",
            error.code,
            error.message
        ),
        response => bail!("unexpected package-smoke image preparation response: {response:?}"),
    }
}

pub(super) fn protocol_artifacts(
    config: &JailerdConfig,
    artifacts: &SelfTestArtifacts,
    prepared_image: &PreparedImageV2Result,
) -> Result<SourceArtifacts> {
    Ok(SourceArtifacts {
        kernel: prepared_image.kernel.clone(),
        initrd: prepared_image.initrd.clone(),
        root_disk: prepared_image.root_disk.clone(),
        runtime_disk: protocol_artifact(config, &artifacts.runtime_disk, ArtifactAccess::ReadOnly)?,
        recording_disk: protocol_artifact(
            config,
            &artifacts.recording_disk,
            ArtifactAccess::ReadWrite,
        )?,
        tools_disk: None,
    })
}

pub(super) fn protocol_artifact(
    config: &JailerdConfig,
    artifact: &VerifiedArtifact,
    access: ArtifactAccess,
) -> Result<ArtifactSource> {
    for (index, root) in config.allowed_source_roots.iter().enumerate() {
        let Ok(relative_path) = artifact.path.strip_prefix(root) else {
            continue;
        };
        if relative_path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
        {
            return Ok(ArtifactSource {
                source_root: u16::try_from(index).context("too many allowed source roots")?,
                relative_path: relative_path.to_path_buf(),
                sha256: Some(Sha256Digest::parse(artifact.sha256.clone())?),
                access,
            });
        }
    }
    bail!(
        "self-test artifact is not beneath an allowed source root: {}",
        artifact.path.display()
    )
}

pub(super) fn expect_run_network(response: Response) -> Result<()> {
    match response {
        Response::EnsureRunNetwork(_) => Ok(()),
        Response::Error(error) => {
            bail!(
                "ensure package-smoke network failed: {}: {}",
                error.code,
                error.message
            )
        }
        response => bail!("unexpected ensure-network response: {response:?}"),
    }
}

pub(super) fn smoke_vm_config(
    launch: &VmLaunchResult,
    request: &VmLaunchRequest,
) -> Result<VmConfig> {
    Ok(VmConfig {
        cpus: Some(CpusConfig {
            boot_vcpus: 1,
            max_vcpus: 1,
        }),
        memory: Some(MemoryConfig {
            size: i64::from(SELF_TEST_VM_MEMORY_MIB) * 1024 * 1024,
        }),
        payload: PayloadConfig {
            kernel: Some(path_utf8(&launch.paths.jailed_kernel)?),
            initramfs: launch
                .paths
                .jailed_initrd
                .as_ref()
                .map(|path| path_utf8(path))
                .transpose()?,
            cmdline: Some(
                "console=hvc0 root=/dev/vda rw reboot=k panic=1 init=/sbin/init".to_owned(),
            ),
            ..PayloadConfig::default()
        },
        disks: Some(vec![
            DiskConfig {
                path: path_utf8(&launch.paths.jailed_root_disk)?,
                readonly: false,
                id: Some("selftest-root".to_owned()),
                image_type: Some(DiskImageType::Raw),
            },
            DiskConfig {
                path: path_utf8(&launch.paths.jailed_runtime_disk)?,
                readonly: true,
                id: Some("selftest-runtime".to_owned()),
                image_type: Some(DiskImageType::Raw),
            },
            DiskConfig {
                path: path_utf8(&launch.paths.jailed_recording_disk)?,
                readonly: false,
                id: Some("selftest-recording".to_owned()),
                image_type: Some(DiskImageType::Raw),
            },
        ]),
        net: Some(vec![NetConfig {
            tap: request.tap_name.clone(),
            mac: Some(request.mac_address.clone()),
            ip: None,
            mask: None,
        }]),
        serial: Some(SerialConfig {
            file: Some(path_utf8(&launch.paths.jailed_serial_log)?),
            mode: "File".to_owned(),
            iommu: false,
            socket: None,
        }),
        console: Some(ConsoleConfig {
            file: Some(path_utf8(&launch.paths.jailed_console_log)?),
            mode: "File".to_owned(),
            iommu: false,
            socket: None,
        }),
        // Exercise the same v53 Unix-backend path used by production.
        // This proves that the jailed VMM can create /run/kino.vsock
        // without exposing /dev/vhost-vsock.
        vsock: Some(VsockConfig {
            cid: u64::from(request.vsock_cid),
            socket: path_utf8(&launch.paths.jailed_vsock_socket)?,
            iommu: false,
            pci_segment: None,
            id: Some("selftest-kino-vsock".to_owned()),
        }),
        landlock_enable: Some(true),
    })
}
