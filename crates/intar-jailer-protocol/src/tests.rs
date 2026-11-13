use super::*;

#[test]
fn quota_for_one_eighth_cpu_is_exact() {
    let quota = CpuQuota::from_millis(125).expect("valid quota");
    assert_eq!(quota.quota_micros, 12_500);
    assert_eq!(quota.cpu_max(), "12500 100000");
}

#[test]
fn removed_boot_cpu_settings_are_rejected() {
    for key in ["boot_cpu_millis", "boot_cpu_lease_ms"] {
        let mut value =
            serde_json::to_value(JailerdConfig::default()).expect("valid CPU test fixture");
        value[key] = serde_json::json!(2000);
        assert!(serde_json::from_value::<JailerdConfig>(value).is_err());
    }
}

#[test]
fn fractional_limits_derive_only_guest_topology() {
    for (millis, count, quota_us) in [
        (125, 1, 12500),
        (500, 1, 50000),
        (1000, 1, 100000),
        (1500, 2, 150000),
    ] {
        let quota = CpuQuota::from_millis(millis).expect("valid CPU test fixture");
        assert_eq!(quota.vcpu_count(), count);
        assert_eq!(quota.quota_micros, quota_us);
        assert_eq!(quota.period_micros, 100000);
    }
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
        quota: steady_quota,
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
fn chunked_v3_uses_a_bounded_manifest_root_and_prepared_boot_artifacts() {
    let image_id = Sha256Digest::parse("a".repeat(64)).expect("image digest");
    let manifest_sha256 = Sha256Digest::parse("b".repeat(64)).expect("manifest digest");
    let artifact_sha256 = Sha256Digest::parse("c".repeat(64)).expect("artifact digest");
    let readonly = |path: &str, sha256: Sha256Digest| ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from(path),
        sha256: Some(sha256),
        access: ArtifactAccess::ReadOnly,
    };
    let prepare = PrepareChunkedImageV3Request {
        image_id: image_id.clone(),
        chunk_manifest_sha256: manifest_sha256.clone(),
        virtual_size_bytes: 8 * 1024 * 1024,
        image_manifest: readonly("blobs/manifest", image_id.clone()),
        manifest: readonly("manifests/image.json", manifest_sha256.clone()),
        chunk_cache_root: TrustedDirectorySource {
            source_root: 0,
            relative_path: PathBuf::from("chunks"),
        },
        kernel: readonly("artifacts/kernel", artifact_sha256.clone()),
        initrd: Some(readonly("artifacts/initrd", artifact_sha256.clone())),
        request_class: RequestClass::Foreground,
        prepare_wake: false,
    };
    prepare.validate().expect("valid chunked prepare");
    let mut other_manifest = prepare.clone();
    other_manifest.image_manifest.sha256 = Some(manifest_sha256.clone());
    assert!(
        other_manifest.validate().is_err(),
        "the image manifest's hash must be the image id"
    );
    let envelope = RequestEnvelope::new(
        11,
        Request::PrepareChunkedImageV3(Box::new(prepare.clone())),
    );
    assert_eq!(
        RequestEnvelope::decode(&envelope.encode().expect("encode")).expect("decode"),
        envelope
    );

    let mut invalid_cache = prepare.clone();
    invalid_cache.chunk_cache_root.source_root = PREPARED_IMAGE_SOURCE_ROOT;
    assert_eq!(
        invalid_cache.validate(),
        Err(ValidationError::InvalidChunkCacheRoot)
    );
    let traversal = serde_json::json!({
        "source_root": 0,
        "relative_path": "../chunks"
    });
    let traversal: TrustedDirectorySource = serde_json::from_value(traversal).expect("shape");
    assert_eq!(
        traversal.validate(),
        Err(ValidationError::InvalidRelativeArtifactPath)
    );

    let prepared = |name: &str, access| ArtifactSource {
        source_root: PREPARED_IMAGE_SOURCE_ROOT,
        relative_path: PathBuf::from(image_id.as_str()).join(name),
        sha256: Some(artifact_sha256.clone()),
        access,
    };
    let agent = |name: &str, access, sha256: Option<Sha256Digest>| ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from(name),
        sha256,
        access,
    };
    let launch = VmLaunchRequest {
        run_id: ValidatedId::parse("run-v3").expect("run ID"),
        vm_id: ValidatedId::parse("vm-v3").expect("VM ID"),
        cpu_millis: 1_000,
        memory_mib: 512,
        root_disk_size_bytes: 8 * 1024 * 1024,
        tap_name: "tap-v3".to_string(),
        mac_address: "02:00:00:00:00:03".to_string(),
        guest_ip_cidr: "10.77.0.2/28".to_string(),
        ssh_public_port: Some(22_000),
        vsock_cid: 3,
        egress: false,
        artifacts: SourceArtifacts {
            kernel: prepared("kernel", ArtifactAccess::ReadOnly),
            initrd: Some(prepared("initrd", ArtifactAccess::ReadOnly)),
            root_disk: prepared("root.raw", ArtifactAccess::ReadWrite),
            runtime_disk: agent("runtime.raw", ArtifactAccess::ReadOnly, None),
            recording_disk: agent("recordings.vfat", ArtifactAccess::ReadWrite, None),
            wake: None,
        },
    };
    let request = LaunchVmV3Request {
        image_id: image_id.clone(),
        chunk_manifest_sha256: manifest_sha256,
        virtual_size_bytes: 8 * 1024 * 1024,
        launch,
    };
    request.validate().expect("valid v3 launch");
    request
        .launch
        .validate_persisted()
        .expect("persisted v3 launch");
    assert_eq!(
        request.launch.validate(),
        Err(ValidationError::TemplateLaunchRequiresV2),
        "a raw launch must not reference prepared boot artifacts"
    );
    let mut writable_runtime = request.clone();
    writable_runtime.launch.artifacts.runtime_disk.access = ArtifactAccess::ReadWrite;
    assert_eq!(
        writable_runtime.validate(),
        Err(ValidationError::InvalidArtifactAccess)
    );

    // A suspended guest: the launch's own template files, RAM writable.
    let wake = WakeArtifacts {
        ram: prepared("ram", ArtifactAccess::ReadWrite),
        stub: prepared("stub", ArtifactAccess::ReadOnly),
        cpu_profile: prepared("cpu-profile.json", ArtifactAccess::ReadOnly),
    };
    let mut waking = request;
    waking.launch.artifacts.wake = Some(wake.clone());
    waking.validate().expect("valid wake launch");
    assert_eq!(
        waking.launch.validate(),
        Err(ValidationError::TemplateLaunchRequiresV2),
        "a raw launch carries no suspended guest"
    );
    let broken: [fn(&mut WakeArtifacts); 5] = [
        |wake| wake.ram.access = ArtifactAccess::ReadOnly,
        |wake| wake.stub.access = ArtifactAccess::ReadWrite,
        |wake| {
            wake.cpu_profile.relative_path = PathBuf::from("b".repeat(64)).join("cpu-profile.json")
        },
        |wake| wake.stub.source_root = 0,
        |wake| wake.ram.sha256 = None,
    ];
    for change in broken {
        let mut broken = waking.clone();
        if let Some(wake) = broken.launch.artifacts.wake.as_mut() {
            change(wake);
        }
        assert_eq!(
            broken.validate(),
            Err(ValidationError::InvalidPreparedLaunchArtifact)
        );
    }
    // An older peer's launch, without the field, still decodes.
    let mut value = serde_json::to_value(&waking).expect("encode");
    value["launch"]["artifacts"]
        .as_object_mut()
        .expect("artifacts")
        .remove("wake");
    let decoded: LaunchVmV3Request = serde_json::from_value(value).expect("decode");
    assert!(decoded.launch.artifacts.wake.is_none());
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
fn protocol_v5_rejects_legacy_handshake_authority() {
    assert_eq!(PROTOCOL_VERSION, 5);
    let legacy = RequestEnvelope::decode(
        br#"{"version":1,"request_id":1,"request":{"operation":"capabilities"}}"#,
    )
    .expect("legacy envelope remains syntactically decodable");
    assert_ne!(legacy.version, PROTOCOL_VERSION);
}

#[test]
fn capabilities_require_every_fast_launch_attestation() {
    let capabilities = JailerCapabilities {
        protocol_version: PROTOCOL_VERSION,
        cloud_hypervisor_version: CLOUD_HYPERVISOR_VERSION.to_owned(),
        cloud_hypervisor_sha256: "a".repeat(64),
        total_cpu_millis: 8_000,
        reserved_cpu_millis: 1_000,
        schedulable_cpu_millis: 7_000,
        committed_cpu_millis: 2_000,
        supports_jailer_v3: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_wake: false,
        supports_hard_cpu_quota: true,
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
    let encoded = serde_json::to_value(&capabilities).expect("serialize capabilities");
    // A host without wake support says nothing of it, as an older one did.
    assert!(encoded.get("supports_wake").is_none());
    let waking = JailerCapabilities {
        supports_wake: true,
        ..capabilities
    };
    let waking_encoded = serde_json::to_value(&waking).expect("serialize capabilities");
    assert_eq!(waking_encoded["supports_wake"], serde_json::json!(true));
    assert_eq!(
        serde_json::from_value::<JailerCapabilities>(waking_encoded).expect("decode"),
        waking
    );
    for required in [
        "supports_jailer_v3",
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
fn guest_cpu_count_cannot_be_added_to_launch_request() {
    let request = VmLaunchRequest {
        run_id: ValidatedId::parse("run").expect("valid CPU test fixture"),
        vm_id: ValidatedId::parse("vm").expect("valid CPU test fixture"),
        cpu_millis: 500,
        memory_mib: 512,
        root_disk_size_bytes: 4096,
        tap_name: "tap0".to_owned(),
        mac_address: "02:00:00:00:00:01".to_owned(),
        guest_ip_cidr: "10.77.0.2/28".to_owned(),
        ssh_public_port: Some(22000),
        vsock_cid: 3,
        egress: false,
        artifacts: SourceArtifacts {
            kernel: source("/trusted/kernel", ArtifactAccess::ReadOnly),
            initrd: None,
            root_disk: source("/trusted/root", ArtifactAccess::ReadWrite),
            runtime_disk: source("/trusted/runtime", ArtifactAccess::ReadOnly),
            recording_disk: source("/trusted/recording", ArtifactAccess::ReadWrite),
            wake: None,
        },
    };
    assert_eq!(
        request
            .validate()
            .expect("valid CPU test fixture")
            .cpu_millis,
        500
    );
    let mut value = serde_json::to_value(&request).expect("valid CPU test fixture");
    assert!(serde_json::from_value::<VmLaunchRequest>(value.clone()).is_ok());
    value["vcpu_count"] = serde_json::json!(1);
    assert!(serde_json::from_value::<VmLaunchRequest>(value).is_err());
    assert!(CpuQuota::from_millis(0).is_err());
    assert!(CpuQuota::from_millis(u32::MAX).is_err());
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
fn jailerd_config_rejects_another_runtime_binary() {
    let config = JailerdConfig {
        agent_uid: 991,
        agent_gid: 991,
        cloud_hypervisor_binary: PathBuf::from("/usr/lib/intar/cloud-hypervisor-v53.0"),
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
        sha256: Some(Sha256Digest::for_bytes(b"fixture")),
        access,
    }
}

#[test]
fn the_wake_stub_replacement_names_one_generation() {
    let generation = ValidatedId::parse("generation-1").expect("generation");
    let envelope = RequestEnvelope::new(
        8,
        Request::ReplaceWakeStub(VmIdentityRequest::by_generation(generation)),
    );
    let encoded = envelope.encode().expect("encode");
    assert!(String::from_utf8_lossy(&encoded).contains(r#""operation":"replace_wake_stub""#));
    assert_eq!(RequestEnvelope::decode(&encoded).expect("decode"), envelope);
    let response = ResponseEnvelope::new(
        8,
        Response::ReplaceWakeStub(OperationResult { changed: true }),
    );
    assert_eq!(
        ResponseEnvelope::decode(&response.encode().expect("encode")).expect("decode"),
        response
    );
}
