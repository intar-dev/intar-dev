use super::*;

#[test]
fn quota_for_one_eighth_cpu_is_exact() {
    let quota = CpuQuota::from_millis(125).expect("valid quota");
    assert_eq!(quota.quota_micros, 12_500);
    assert_eq!(quota.cpu_max(), "12500 100000");
}

#[test]
fn boot_cpu_defaults_are_root_owned_and_bounded() {
    let config = JailerdConfig::default();
    assert_eq!(config.boot_cpu_millis, 2_000);
    assert_eq!(config.boot_cpu_lease_ms, 45_000);

    let mut invalid = JailerdConfig {
        agent_uid: 991,
        agent_gid: 991,
        ..config
    };
    invalid.boot_cpu_lease_ms = 0;
    assert_eq!(
        invalid.validate(),
        Err(ValidationError::InvalidBootCpuLease)
    );
    invalid.boot_cpu_lease_ms = 1;
    invalid.boot_cpu_millis = 0;
    assert_eq!(invalid.validate(), Err(ValidationError::ZeroCpu));
    invalid.boot_cpu_millis = 1;
    invalid.boot_cpu_lease_ms = DEFAULT_BOOT_CPU_LEASE_MS + 1;
    assert_eq!(
        invalid.validate(),
        Err(ValidationError::InvalidBootCpuLease)
    );
}

#[test]
fn run_network_repair_is_a_distinct_typed_operation() {
    let run_id = ValidatedId::parse("run").expect("run ID");
    let request = RequestEnvelope::new(
        6,
        Request::RepairRunNetwork(EnsureRunNetworkRequest {
            run_id: run_id.clone(),
            guest_cidr: "10.77.0.0/28".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        }),
    );
    assert_eq!(
        RequestEnvelope::decode(&request.encode().expect("encode")).expect("decode"),
        request
    );

    let response = ResponseEnvelope::new(
        6,
        Response::RepairRunNetwork(RunNetworkResult {
            run_id,
            namespace_name: "intar-ns-run".to_owned(),
            namespace_inode: 17,
            bridge_name: "ibr-run".to_owned(),
            host_veth_name: "ivh-run".to_owned(),
            namespace_veth_name: "ivn-run".to_owned(),
            host_transit_cidr: "198.18.0.1/30".to_owned(),
            namespace_transit_cidr: "198.18.0.2/30".to_owned(),
        }),
    );
    assert_eq!(
        ResponseEnvelope::decode(&response.encode().expect("encode")).expect("decode"),
        response
    );
}

#[test]
fn finalize_boot_is_generation_fenced_and_rejects_extra_authority() {
    let generation = ValidatedId::parse("generation-1").expect("generation");
    let envelope = RequestEnvelope::new(
        7,
        Request::FinalizeVmBoot(FinalizeVmBootRequest {
            generation: generation.clone(),
        }),
    );
    assert_eq!(
        RequestEnvelope::decode(&envelope.encode().expect("encode")).expect("decode"),
        envelope
    );
    let with_quota = br#"{"version":1,"request_id":7,"request":{"operation":"finalize_vm_boot","parameters":{"generation":"generation-1","cpu_millis":4000}}}"#;
    assert!(RequestEnvelope::decode(with_quota).is_err());

    let steady_quota = CpuQuota::from_millis(1_000).expect("steady quota");
    let cpu_runtime = VmCpuRuntimeState {
        phase: VmCpuPhase::Steady,
        steady_quota,
        effective_quota: steady_quota,
        boot_deadline_unix_ms: None,
        attestation: Some(CpuQuotaAttestation {
            quota: steady_quota,
            cpu_max: steady_quota.cpu_max(),
            cpu_max_burst: 0,
            verified_at_unix_ms: 124,
        }),
    };
    let response = ResponseEnvelope::new(
        7,
        Response::FinalizeVmBoot(FinalizeVmBootResult {
            generation: generation.clone(),
            changed: true,
            ssh_forward_active: true,
            cpu_runtime,
        }),
    );
    assert_eq!(
        ResponseEnvelope::decode(&response.encode().expect("encode")).expect("decode"),
        response
    );
}

#[test]
fn prepare_image_v2_is_hash_bound_and_cannot_reimport_templates() {
    let digest = Sha256Digest::parse("a".repeat(64)).expect("digest");
    let source = |path: &str| ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from(path),
        sha256: Some(digest.clone()),
        access: ArtifactAccess::ReadOnly,
    };
    let request = PrepareImageV2Request {
        image_sha256: digest.clone(),
        virtual_size_bytes: 4 * 1024 * 1024 * 1024,
        root_disk: source("images/root.raw"),
        kernel: source("artifacts/kernel"),
        initrd: Some(source("artifacts/initrd")),
    };
    request.validate().expect("valid prepared image request");
    let envelope = RequestEnvelope::new(9, Request::PrepareImageV2(Box::new(request.clone())));
    assert_eq!(
        RequestEnvelope::decode(&envelope.encode().expect("encode")).expect("decode"),
        envelope
    );

    let mut invalid = request;
    invalid.root_disk.source_root = PREPARED_IMAGE_SOURCE_ROOT;
    assert_eq!(
        invalid.validate(),
        Err(ValidationError::InvalidTemplateSource)
    );
    invalid.root_disk.source_root = 0;
    invalid.root_disk.sha256 = None;
    assert_eq!(
        invalid.validate(),
        Err(ValidationError::MissingTemplateArtifactHash)
    );
}

#[test]
fn launch_vm_v2_is_template_bound_and_v1_rejects_prepared_sources() {
    let image_sha256 = Sha256Digest::parse("b".repeat(64)).expect("image digest");
    let artifact_sha256 = Sha256Digest::parse("c".repeat(64)).expect("artifact digest");
    let prepared = |name: &str, access| ArtifactSource {
        source_root: PREPARED_IMAGE_SOURCE_ROOT,
        relative_path: PathBuf::from(image_sha256.as_str()).join(name),
        sha256: Some(artifact_sha256.clone()),
        access,
    };
    let agent_owned = |name: &str, access| ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from(name),
        sha256: None,
        access,
    };
    let launch = VmLaunchRequest {
        run_id: ValidatedId::parse("run-1").expect("run ID"),
        vm_id: ValidatedId::parse("vm-1").expect("VM ID"),
        cpu_millis: 1_000,
        vcpu_count: 1,
        memory_mib: 512,
        root_disk_size_bytes: 4 * 1024 * 1024 * 1024,
        tap_name: "tap-test".to_string(),
        mac_address: "02:00:00:00:00:01".to_string(),
        guest_ip_cidr: "10.77.0.2/28".to_string(),
        ssh_public_port: Some(22_000),
        vsock_cid: 3,
        artifacts: SourceArtifacts {
            kernel: prepared("kernel", ArtifactAccess::ReadOnly),
            initrd: Some(prepared("initrd", ArtifactAccess::ReadOnly)),
            root_disk: prepared("root.raw", ArtifactAccess::ReadWrite),
            runtime_disk: agent_owned("runtime.raw", ArtifactAccess::ReadOnly),
            recording_disk: agent_owned("recordings.vfat", ArtifactAccess::ReadWrite),
        },
    };
    assert_eq!(
        launch.validate(),
        Err(ValidationError::TemplateLaunchRequiresV2)
    );

    let request = LaunchVmV2Request {
        image_sha256,
        virtual_size_bytes: 4 * 1024 * 1024 * 1024,
        launch,
    };
    request.validate().expect("valid v2 launch");
    let mut undersized = request.clone();
    undersized.launch.root_disk_size_bytes = undersized.virtual_size_bytes - 1;
    assert_eq!(
        undersized.validate(),
        Err(ValidationError::RootDiskSmallerThanTemplate)
    );
    let envelope = RequestEnvelope::new(10, Request::LaunchVmV2(Box::new(request.clone())));
    assert_eq!(
        RequestEnvelope::decode(&envelope.encode().expect("encode")).expect("decode"),
        envelope
    );

    let mut wrong_bundle = request;
    wrong_bundle.launch.artifacts.kernel.relative_path =
        PathBuf::from(wrong_bundle.image_sha256.as_str()).join("other-kernel");
    assert_eq!(
        wrong_bundle.validate(),
        Err(ValidationError::InvalidPreparedLaunchArtifact)
    );
}

#[test]
fn identifiers_cannot_escape_paths_or_units() {
    for invalid in ["", ".", "../vm", "vm/name", "vm.name", "vm name"] {
        assert!(ValidatedId::parse(invalid).is_err(), "accepted {invalid:?}");
    }
    assert_eq!(
        ValidatedId::parse("run_01-vm").expect("valid ID").as_str(),
        "run_01-vm"
    );
}

#[test]
fn unknown_envelope_fields_are_rejected() {
    let json =
        br#"{"version":1,"request_id":1,"request":{"operation":"capabilities"},"surprise":true}"#;
    assert!(RequestEnvelope::decode(json).is_err());
}

#[test]
fn protocol_v2_rejects_legacy_handshake_authority() {
    assert_eq!(PROTOCOL_VERSION, 2);
    let legacy = RequestEnvelope::decode(
        br#"{"version":1,"request_id":1,"request":{"operation":"capabilities"}}"#,
    )
    .expect("legacy envelope remains syntactically decodable");
    assert_ne!(legacy.version, PROTOCOL_VERSION);
}

#[test]
fn protocol_v2_capabilities_require_every_fast_launch_attestation() {
    let capabilities = JailerCapabilities {
        protocol_version: PROTOCOL_VERSION,
        cloud_hypervisor_version: CLOUD_HYPERVISOR_VERSION.to_owned(),
        cloud_hypervisor_sha256: CLOUD_HYPERVISOR_SHA256.to_owned(),
        total_cpu_millis: 8_000,
        reserved_cpu_millis: 1_000,
        schedulable_cpu_millis: 7_000,
        committed_cpu_millis: 2_000,
        supports_jailer_v2: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_hard_cpu_quota: true,
        supports_boot_cpu_lease: true,
        boot_cpu_millis: DEFAULT_BOOT_CPU_MILLIS,
        boot_cpu_lease_ms: DEFAULT_BOOT_CPU_LEASE_MS,
        supports_landlock: true,
        supports_cgroup_v2: true,
        uid_gid_start: 200_000,
        uid_gid_end: 265_535,
        uid_gid_range_collision_free: true,
        config_trusted: true,
        source_roots_trusted: true,
        jailer_binary_trusted: true,
        runtime_hash_verified: true,
        runtime_statically_linked: true,
        systemd_version: Some("systemd 252".to_string()),
        supports_systemd_transient_units: true,
        seccomp_supported: true,
        landlock_abi: Some(3),
        privileged_self_test_passed: true,
        kvm_accounting_proven: true,
        allow_uid_gid_collisions: false,
        allowed_source_roots: vec![PathBuf::from("/var/lib/intar/source")],
        posix_acl_supported: true,
        guest_network_pool: DEFAULT_GUEST_NETWORK_POOL.to_string(),
        run_guest_network_prefix: RUN_GUEST_NETWORK_PREFIX,
        ssh_public_port_start: DEFAULT_SSH_PUBLIC_PORT_START,
        ssh_public_port_end: DEFAULT_SSH_PUBLIC_PORT_END,
    };
    let encoded = serde_json::to_value(capabilities).expect("serialize capabilities");
    for required in [
        "supports_jailer_v2",
        "supports_template_backed_launch",
        "fast_template_store",
    ] {
        let mut missing = encoded.clone();
        missing
            .as_object_mut()
            .expect("capability object")
            .remove(required);
        assert!(
            serde_json::from_value::<JailerCapabilities>(missing).is_err(),
            "missing {required} was accepted"
        );
    }
}

#[test]
fn unknown_run_network_fields_are_rejected() {
    for operation in ["ensure_run_network", "repair_run_network"] {
        let json = format!(
            r#"{{"version":1,"request_id":1,"request":{{"operation":"{operation}","parameters":{{"run_id":"run","guest_cidr":"10.77.0.0/28","gateway":"10.77.0.1","host_route":"0.0.0.0/0"}}}}}}"#
        );
        assert!(RequestEnvelope::decode(json.as_bytes()).is_err());
    }
}

#[test]
fn unknown_response_fields_are_rejected() {
    let json = br#"{"version":1,"request_id":1,"response":{"result":"stop_vm","value":{"changed":true},"surprise":true}}"#;
    assert!(ResponseEnvelope::decode(json).is_err());
}

#[test]
fn invalid_ids_cannot_enter_through_deserialization() {
    let json = br#"{"version":1,"request_id":1,"request":{"operation":"destroy_vm","parameters":{"generation":"../escape"}}}"#;
    assert!(RequestEnvelope::decode(json).is_err());
}

#[test]
fn oversized_frames_are_rejected_before_json_parsing() {
    let bytes = vec![b' '; MAX_FRAME_BYTES + 1];
    assert!(matches!(
        RequestEnvelope::decode(&bytes),
        Err(FrameError::TooLarge)
    ));
}

#[test]
fn launch_validation_enforces_aggregate_topology_limit() {
    let request = VmLaunchRequest {
        run_id: ValidatedId::parse("run").expect("run ID"),
        vm_id: ValidatedId::parse("vm").expect("VM ID"),
        cpu_millis: 1_001,
        vcpu_count: 1,
        memory_mib: 512,
        root_disk_size_bytes: 4 * 1024 * 1024 * 1024,
        tap_name: "tap0".to_owned(),
        mac_address: "02:00:00:00:00:01".to_owned(),
        guest_ip_cidr: "10.77.0.2/28".to_owned(),
        ssh_public_port: Some(22000),
        vsock_cid: 3,
        artifacts: SourceArtifacts {
            kernel: source("/trusted/kernel", ArtifactAccess::ReadOnly),
            initrd: None,
            root_disk: source("/trusted/root.raw", ArtifactAccess::ReadWrite),
            runtime_disk: source("/trusted/runtime.raw", ArtifactAccess::ReadOnly),
            recording_disk: source("/trusted/recordings.vfat", ArtifactAccess::ReadWrite),
        },
    };
    assert_eq!(
        request.validate(),
        Err(ValidationError::QuotaExceedsTopology)
    );
}

#[test]
fn artifact_sources_are_root_indexed_and_traversal_free() {
    for invalid in ["", "/absolute/kernel", "../kernel", "boot/../kernel"] {
        let artifact = ArtifactSource {
            source_root: 0,
            relative_path: PathBuf::from(invalid),
            sha256: Some(Sha256Digest::parse("a".repeat(64)).expect("digest")),
            access: ArtifactAccess::ReadOnly,
        };
        assert_eq!(
            artifact.validate(),
            Err(ValidationError::InvalidRelativeArtifactPath),
            "accepted {invalid:?}"
        );
    }
}

#[test]
fn vm_selectors_are_exactly_generation_or_logical_identity() {
    let generation = ValidatedId::parse("generation").expect("generation");
    assert!(
        VmIdentityRequest::by_generation(generation)
            .validate()
            .is_ok()
    );
    assert!(
        VmIdentityRequest::by_logical_id(
            ValidatedId::parse("run").expect("run"),
            ValidatedId::parse("vm").expect("vm"),
        )
        .validate()
        .is_ok()
    );
    assert_eq!(
        VmIdentityRequest {
            generation: None,
            run_id: None,
            vm_id: None,
        }
        .validate(),
        Err(ValidationError::InvalidVmSelector)
    );
}

#[test]
fn jailerd_config_rejects_runtime_hash_overrides() {
    let config = JailerdConfig {
        agent_uid: 991,
        agent_gid: 991,
        cloud_hypervisor_sha256: Sha256Digest::parse("a".repeat(64))
            .expect("syntactically valid digest"),
        ..JailerdConfig::default()
    };
    assert_eq!(config.validate(), Err(ValidationError::UnpinnedRuntime));
}

#[test]
fn root_network_policy_rejects_route_hijacks_and_topology_drift() {
    let config = JailerdConfig {
        agent_uid: 991,
        agent_gid: 991,
        ..JailerdConfig::default()
    };
    let request = |guest_cidr: &str, gateway: &str| EnsureRunNetworkRequest {
        run_id: ValidatedId::parse("run").expect("run ID"),
        guest_cidr: guest_cidr.to_owned(),
        gateway: gateway.to_owned(),
    };

    assert!(
        config
            .validate_run_network_request(&request("10.77.12.0/28", "10.77.12.1"))
            .is_ok()
    );
    for invalid in [
        request("0.0.0.0/0", "0.0.0.1"),
        request("10.76.0.0/28", "10.76.0.1"),
        request("10.77.0.0/24", "10.77.0.1"),
        request("10.77.0.16/28", "10.77.0.18"),
    ] {
        assert!(config.validate_run_network_request(&invalid).is_err());
    }
}

#[test]
fn root_network_policy_can_narrow_pool_and_ssh_port_range() {
    let config = JailerdConfig {
        agent_uid: 991,
        agent_gid: 991,
        guest_network_pool: "10.77.128.0/17".to_owned(),
        ssh_public_port_start: 22_500,
        ssh_public_port_end: 22_599,
        ..JailerdConfig::default()
    };
    config.validate().expect("valid narrowed policy");
    let inside = EnsureRunNetworkRequest {
        run_id: ValidatedId::parse("inside").expect("run ID"),
        guest_cidr: "10.77.128.0/28".to_owned(),
        gateway: "10.77.128.1".to_owned(),
    };
    let outside = EnsureRunNetworkRequest {
        run_id: ValidatedId::parse("outside").expect("run ID"),
        guest_cidr: "10.77.0.0/28".to_owned(),
        gateway: "10.77.0.1".to_owned(),
    };
    assert!(config.validate_run_network_request(&inside).is_ok());
    assert_eq!(
        config.validate_run_network_request(&outside),
        Err(ValidationError::RunNetworkOutsideConfiguredPool)
    );
    assert!(config.validate_ssh_public_port(None).is_ok());
    assert!(config.validate_ssh_public_port(Some(22_500)).is_ok());
    assert!(config.validate_ssh_public_port(Some(22_599)).is_ok());
    assert_eq!(
        config.validate_ssh_public_port(Some(22_499)),
        Err(ValidationError::SshPortOutsideConfiguredRange)
    );
    assert_eq!(
        config.validate_ssh_public_port(Some(22_600)),
        Err(ValidationError::SshPortOutsideConfiguredRange)
    );
}

#[test]
fn jailerd_config_rejects_unsafe_network_policy() {
    let mut config = JailerdConfig {
        agent_uid: 991,
        agent_gid: 991,
        ..JailerdConfig::default()
    };
    config.guest_network_pool = "192.168.0.0/16".to_owned();
    assert_eq!(
        config.validate(),
        Err(ValidationError::InvalidGuestNetworkPool)
    );
    config.guest_network_pool = DEFAULT_GUEST_NETWORK_POOL.to_owned();
    config.ssh_public_port_start = 22;
    assert_eq!(config.validate(), Err(ValidationError::InvalidSshPortRange));
    config.ssh_public_port_start = 23_000;
    config.ssh_public_port_end = 22_999;
    assert_eq!(config.validate(), Err(ValidationError::InvalidSshPortRange));
}

#[test]
fn privileged_paths_reject_lexical_traversal() {
    let mut config = JailerdConfig {
        agent_uid: 991,
        agent_gid: 991,
        ..JailerdConfig::default()
    };
    config.jail_root = PathBuf::from("/var/lib/intar/../escape");
    assert_eq!(
        config.validate(),
        Err(ValidationError::UnsafePrivilegedPath(
            config.jail_root.clone()
        ))
    );

    let spec = JailSpecV1 {
        version: PROTOCOL_VERSION,
        generation: ValidatedId::parse("generation").expect("generation"),
        uid: 200_000,
        gid: 200_000,
        jail_root: PathBuf::from("/var/lib/intar/jails/generation/root"),
        netns_path: PathBuf::from("/run/netns/../host"),
        netns_inode: 17,
        nofile_limit: 2_048,
        file_size_limit: None,
    };
    assert_eq!(
        spec.validate(),
        Err(ValidationError::UnsafePrivilegedPath(
            spec.netns_path.clone()
        ))
    );
}

#[test]
fn jail_spec_rejects_zero_file_size_limit() {
    let spec = JailSpecV1 {
        version: PROTOCOL_VERSION,
        generation: ValidatedId::parse("generation").expect("generation"),
        uid: 200_000,
        gid: 200_000,
        jail_root: PathBuf::from("/var/lib/intar/jails/generation/root"),
        netns_path: PathBuf::from("/run/netns/intar-generation"),
        netns_inode: 17,
        nofile_limit: 2_048,
        file_size_limit: Some(0),
    };
    assert_eq!(spec.validate(), Err(ValidationError::InvalidFileSizeLimit));
}

#[test]
fn jail_spec_rejects_zero_network_namespace_inode() {
    let spec = JailSpecV1 {
        version: PROTOCOL_VERSION,
        generation: ValidatedId::parse("generation").expect("generation"),
        uid: 200_000,
        gid: 200_000,
        jail_root: PathBuf::from("/var/lib/intar/jails/generation/root"),
        netns_path: PathBuf::from("/run/netns/intar-generation"),
        netns_inode: 0,
        nofile_limit: 2_048,
        file_size_limit: None,
    };
    assert_eq!(
        spec.validate(),
        Err(ValidationError::InvalidNetworkNamespaceInode)
    );
}

fn source(path: &str, access: ArtifactAccess) -> ArtifactSource {
    ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from(path.trim_start_matches("/trusted/")),
        sha256: None,
        access,
    }
}
