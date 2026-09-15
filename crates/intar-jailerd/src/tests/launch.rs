use super::*;

#[test]
fn capabilities_and_prepare_image_v2_require_fast_template_store() {
    let config = test_config();
    let digest = Sha256Digest::parse("a".repeat(64)).expect("digest");
    let cached_source = |path: &str| ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from(path),
        sha256: Some(digest.clone()),
        access: ArtifactAccess::ReadOnly,
    };
    let request = PrepareImageV2Request {
        image_sha256: digest.clone(),
        virtual_size_bytes: 4 * 1024 * 1024 * 1024,
        root_disk: cached_source("images/root.raw"),
        kernel: cached_source("artifacts/kernel"),
        initrd: Some(cached_source("artifacts/initrd")),
        request_class: RequestClass::Foreground,
    };

    let mut unavailable = JailerdCore::new_with_readiness(
        config.clone(),
        FakeBackend::default(),
        FakePreparer,
        4_000,
        ready_readiness(),
    )
    .expect("core");
    assert!(!unavailable.capabilities().supports_jailer_v2);
    assert!(matches!(
        unavailable.handle(Request::PrepareImageV2(Box::new(request.clone()))),
        Response::Error(ProtocolError { ref code, .. }) if code == "host_not_ready"
    ));

    let mut available = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        FakeTemplatePreparer,
        4_000,
        ready_readiness(),
    )
    .expect("core");
    let capabilities = available.capabilities();
    assert_eq!(capabilities.protocol_version, 4);
    assert!(capabilities.supports_jailer_v3);
    assert!(capabilities.supports_jailer_v2);
    assert!(capabilities.supports_template_backed_launch);
    assert!(capabilities.fast_template_store);
    let prepared = match available.handle(Request::PrepareImageV2(Box::new(request))) {
        Response::PrepareImageV2(prepared) => prepared,
        other => panic!("unexpected prepare response: {other:?}"),
    };
    assert_eq!(prepared.root_disk.source_root, PREPARED_IMAGE_SOURCE_ROOT);
    assert_eq!(prepared.root_disk.access, ArtifactAccess::ReadWrite);
    assert!(prepared.fast_template_store);
}

#[test]
fn live_template_validation_withdraws_fast_host_capabilities() {
    let core = JailerdCore::new_with_readiness(
        test_config(),
        FakeBackend::default(),
        RevokedFastTemplatePreparer,
        4_000,
        ready_readiness(),
    )
    .expect("core");
    let capabilities = core.capabilities();
    assert!(!capabilities.fast_template_store);
    assert!(!capabilities.supports_jailer_v2);
    assert!(!capabilities.supports_template_backed_launch);
}

#[test]
fn launch_vm_v2_requires_and_uses_one_prepared_template_bundle() {
    let config = test_config();
    let digest = Sha256Digest::parse("d".repeat(64)).expect("digest");
    let cached_source = |path: &str| ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from(path),
        sha256: Some(digest.clone()),
        access: ArtifactAccess::ReadOnly,
    };
    let prepare = PrepareImageV2Request {
        image_sha256: digest.clone(),
        virtual_size_bytes: 4 * 1024 * 1024 * 1024,
        root_disk: cached_source("images/root.raw"),
        kernel: cached_source("artifacts/kernel"),
        initrd: Some(cached_source("artifacts/initrd")),
        request_class: RequestClass::Foreground,
    };
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        FakeTemplatePreparer,
        4_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    let prepared = match core.handle(Request::PrepareImageV2(Box::new(prepare))) {
        Response::PrepareImageV2(prepared) => prepared,
        other => panic!("unexpected prepare response: {other:?}"),
    };
    let mut prepared_launch = launch(0, 125);
    prepared_launch.artifacts.root_disk = prepared.root_disk.clone();
    prepared_launch.artifacts.kernel = prepared.kernel.clone();
    prepared_launch.artifacts.initrd = prepared.initrd.clone();

    let v2 = LaunchVmV2Request {
        image_sha256: prepared.image_sha256,
        virtual_size_bytes: prepared.virtual_size_bytes,
        launch: prepared_launch,
    };
    let mut unavailable = JailerdCore::new_with_readiness(
        test_config(),
        FakeBackend::default(),
        FakePreparer,
        4_000,
        ready_readiness(),
    )
    .expect("core without fast template store");
    assert!(matches!(
        unavailable.handle(Request::LaunchVmV2(Box::new(v2.clone()))),
        Response::Error(ProtocolError { ref code, .. }) if code == "host_not_ready"
    ));
    assert!(matches!(
        core.handle(Request::LaunchVmV2(Box::new(v2))),
        Response::LaunchVmV2(_)
    ));
}

#[test]
fn detached_v2_launch_releases_core_lock_and_reserves_capacity() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let backend = BlockingSharedBackend::default();
    let core = Arc::new(Mutex::new(
        JailerdCore::new_with_readiness(
            config,
            backend.clone(),
            FakeTemplatePreparer,
            2_000,
            ready_readiness(),
        )
        .expect("core"),
    ));
    {
        let mut core = core.lock().expect("core lock");
        let response = core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run").expect("run ID"),
            guest_cidr: "10.77.0.0/28".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        }));
        assert!(matches!(response, Response::EnsureRunNetwork(_)));
    }

    let first = match launch_vm_v2_response(&core, launch_v2(0, 1_000)) {
        Response::LaunchVmV2(result) => result,
        other => panic!("unexpected first launch response: {other:?}"),
    };
    assert!(matches!(
        core.lock()
            .expect("core lock")
            .handle(Request::FinalizeVmBoot(FinalizeVmBootRequest {
                generation: first.generation.clone(),
            })),
        Response::FinalizeVmBoot(_)
    ));

    backend.block_next_launch();
    let launch_core = Arc::clone(&core);
    let launch_thread =
        std::thread::spawn(move || launch_vm_v2_response(&launch_core, launch_v2(1, 1_000)));
    backend.wait_until_launch_enters();

    {
        let mut live = core
            .try_lock()
            .expect("long VMM activation must not hold the core lock");
        assert_eq!(live.inflight_launches.len(), 1);
        assert_eq!(live.pending_cpu_reservations.len(), 1);
        assert_eq!(live.capabilities().committed_cpu_millis, 2_000);
        assert!(matches!(
            live.handle(Request::FinalizeVmBoot(FinalizeVmBootRequest {
                generation: first.generation,
            })),
            Response::FinalizeVmBoot(_)
        ));
    }

    let duplicate = launch_vm_v2_response(&core, launch_v2(1, 1_000));
    assert!(matches!(
        duplicate,
        Response::Error(ProtocolError { ref code, .. }) if code == "cpu_capacity_exhausted"
    ));
    assert_eq!(
        core.lock().expect("core lock").inflight_launches.len(),
        1,
        "an idempotent retry must not reserve a second generation"
    );

    let rejected = launch_vm_v2_response(&core, launch_v2(2, 1_000));
    assert!(matches!(
        rejected,
        Response::Error(ProtocolError { ref code, .. }) if code == "cpu_capacity_exhausted"
    ));

    backend.release_launch();
    assert!(matches!(
        launch_thread.join().expect("launch thread"),
        Response::LaunchVmV2(_)
    ));
    let live = core.lock().expect("core lock");
    assert!(live.inflight_launches.is_empty());
    assert!(live.pending_cpu_reservations.is_empty());
    assert_eq!(live.records.len(), 2);
    assert_eq!(live.capabilities().committed_cpu_millis, 2_000);
}

#[test]
fn detached_v2_launch_failure_releases_proven_capacity() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let backend = BlockingSharedBackend::default();
    backend.state.lock().expect("backend state").fail_vm_network = true;
    let core = Arc::new(Mutex::new(
        JailerdCore::new_with_readiness(
            config,
            backend,
            FakeTemplatePreparer,
            2_000,
            ready_readiness(),
        )
        .expect("core"),
    ));
    {
        let mut core = core.lock().expect("core lock");
        assert!(matches!(
            core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
                run_id: ValidatedId::parse("run").expect("run ID"),
                guest_cidr: "10.77.0.0/28".to_owned(),
                gateway: "10.77.0.1".to_owned(),
            })),
            Response::EnsureRunNetwork(_)
        ));
    }

    assert!(matches!(
        launch_vm_v2_response(&core, launch_v2(0, 1_000)),
        Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
    ));
    let live = core.lock().expect("core lock");
    assert!(live.inflight_launches.is_empty());
    assert!(live.pending_cpu_reservations.is_empty());
    assert!(live.records.is_empty());
    assert_eq!(live.capabilities().committed_cpu_millis, 0);
}

#[test]
fn detached_v2_launch_retains_capacity_until_failed_unit_is_contained() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let backend = BlockingSharedBackend::default();
    {
        let mut state = backend.state.lock().expect("backend state");
        state.fail_start_after_create = true;
        state.fail_stop_unit = true;
        state.fail_destroy_unit = true;
    }
    let core = Arc::new(Mutex::new(
        JailerdCore::new_with_readiness(
            config,
            backend,
            FakeTemplatePreparer,
            2_000,
            ready_readiness(),
        )
        .expect("core"),
    ));
    {
        let mut core = core.lock().expect("core lock");
        assert!(matches!(
            core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
                run_id: ValidatedId::parse("run").expect("run ID"),
                guest_cidr: "10.77.0.0/28".to_owned(),
                gateway: "10.77.0.1".to_owned(),
            })),
            Response::EnsureRunNetwork(_)
        ));
    }

    assert!(matches!(
        launch_vm_v2_response(&core, launch_v2(0, 1_000)),
        Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
    ));
    let live = core.lock().expect("core lock");
    assert!(live.inflight_launches.is_empty());
    assert_eq!(live.pending_cpu_reservations.len(), 1);
    assert_eq!(live.unresolved_recoveries.len(), 1);
    assert_eq!(live.capabilities().committed_cpu_millis, 1_000);
    assert!(!live.capabilities().supports_jailer_v2);
}

#[test]
fn detached_existing_identity_mismatch_releases_only_proven_capacity() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let backend = BlockingSharedBackend::default();
    let core = Arc::new(Mutex::new(
        JailerdCore::new_with_readiness(
            config,
            backend.clone(),
            FakeTemplatePreparer,
            2_000,
            ready_readiness(),
        )
        .expect("core"),
    ));
    {
        let mut core = core.lock().expect("core lock");
        assert!(matches!(
            core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
                run_id: ValidatedId::parse("run").expect("run ID"),
                guest_cidr: "10.77.0.0/28".to_owned(),
                gateway: "10.77.0.1".to_owned(),
            })),
            Response::EnsureRunNetwork(_)
        ));
    }

    let request = launch_v2(0, 1_000);
    let launched = match launch_vm_v2_response(&core, request.clone()) {
        Response::LaunchVmV2(result) => result,
        other => panic!("unexpected launch response: {other:?}"),
    };
    {
        let mut state = backend.state.lock().expect("backend state");
        state
            .units
            .get_mut(&launched.unit_name)
            .expect("launched unit")
            .pid_start_time_ticks = Some(99);
    }

    assert!(matches!(
        launch_vm_v2_response(&core, request),
        Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
    ));
    let live = core.lock().expect("core lock");
    assert!(live.records.is_empty());
    assert!(live.pending_cpu_reservations.is_empty());
    assert!(live.unresolved_recoveries.is_empty());
    assert_eq!(live.capabilities().committed_cpu_millis, 0);
    assert!(!live.capabilities().supports_jailer_v2);
    drop(live);

    let state = backend.state.lock().expect("backend state");
    assert!(!state.units.contains_key(&launched.unit_name));
    assert_eq!(state.destroyed_vm_networks.len(), 1);
}

#[test]
fn detached_existing_identity_mismatch_retains_boot_capacity_until_drain() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let backend = BlockingSharedBackend::default();
    let core = Arc::new(Mutex::new(
        JailerdCore::new_with_readiness(
            config,
            backend.clone(),
            FakeTemplatePreparer,
            2_000,
            ready_readiness(),
        )
        .expect("core"),
    ));
    {
        let mut core = core.lock().expect("core lock");
        assert!(matches!(
            core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
                run_id: ValidatedId::parse("run").expect("run ID"),
                guest_cidr: "10.77.0.0/28".to_owned(),
                gateway: "10.77.0.1".to_owned(),
            })),
            Response::EnsureRunNetwork(_)
        ));
    }

    let request = launch_v2(0, 1_000);
    let launched = match launch_vm_v2_response(&core, request.clone()) {
        Response::LaunchVmV2(result) => result,
        other => panic!("unexpected launch response: {other:?}"),
    };
    {
        let mut state = backend.state.lock().expect("backend state");
        state
            .units
            .get_mut(&launched.unit_name)
            .expect("launched unit")
            .pid_start_time_ticks = Some(99);
        state.active_ssh_forwards.insert((
            ValidatedId::parse("run").expect("run ID"),
            launched.generation.clone(),
        ));
        state.fail_stop_unit = true;
        state.fail_destroy_unit = true;
    }

    assert!(matches!(
        launch_vm_v2_response(&core, request),
        Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
    ));
    let live = core.lock().expect("core lock");
    assert!(live.records.is_empty());
    assert!(live.inflight_launches.is_empty());
    assert_eq!(live.pending_cpu_reservations.len(), 1);
    assert_eq!(live.unresolved_recoveries.len(), 1);
    assert_eq!(live.capabilities().committed_cpu_millis, 1_000);
    assert!(!live.capabilities().supports_jailer_v2);
    drop(live);

    let state = backend.state.lock().expect("backend state");
    assert!(state.units.contains_key(&launched.unit_name));
    assert!(state.active_ssh_forwards.is_empty());
    assert!(state.destroyed_vm_networks.is_empty());
}

#[test]
fn eight_eighth_cpu_vms_fill_exactly_one_schedulable_core() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        FakeTemplatePreparer,
        1_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    for index in 0..8 {
        let response = launch_prepared_v2(&mut core, index, 125);
        assert!(matches!(response, Response::LaunchVmV2(_)), "{response:?}");
    }
    let response = launch_prepared_v2(&mut core, 8, 125);
    assert!(matches!(
        response,
        Response::Error(ProtocolError { ref code, .. }) if code == "cpu_capacity_exhausted"
    ));
    assert_eq!(core.capabilities().committed_cpu_millis, 1_000);
}

#[test]
fn half_cpu_launches_share_capacity_and_keep_ssh_closed() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        FakeTemplatePreparer,
        1000,
        ready_readiness(),
    )
    .expect("valid CPU test fixture");
    ensure_test_network(&mut core);
    for index in 0..2 {
        let launched = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(index, 500)))) {
            Response::LaunchVmV2(result) => result,
            response => panic!("{response:?}"),
        };
        assert_eq!(launched.cpu_runtime.quota.cpu_millis, 500);
        let proof = launched
            .cpu_runtime
            .attestation
            .expect("valid CPU test fixture");
        assert_eq!(proof.cpu_max, "50000 100000");
        assert_eq!(proof.cpu_max_burst, 0);
        assert_eq!(
            core.backend.started_specs[index as usize]
                .cpu_quota
                .cpu_millis,
            500
        );
        assert!(core.backend.active_ssh_forwards.is_empty());
    }
    assert_eq!(core.capabilities().committed_cpu_millis, 1000);
    let before = core.allocated_identities.len();
    assert!(
        matches!(core.handle(Request::LaunchVmV2(Box::new(launch_v2(2, 500)))), Response::Error(ref error) if error.code == "cpu_capacity_exhausted")
    );
    assert_eq!(core.backend.started_specs.len(), 2);
    assert_eq!(core.allocated_identities.len(), before);
}

#[test]
fn finalize_seals_quota_before_ingress_and_is_idempotent() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        TrackingPreparer::default(),
        4_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    let launched = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected launch response {other:?}"),
    };
    let request = FinalizeVmBootRequest {
        generation: launched.generation.clone(),
    };

    let first = match core.handle(Request::FinalizeVmBoot(request.clone())) {
        Response::FinalizeVmBoot(value) => value,
        other => panic!("unexpected finalize response {other:?}"),
    };
    assert!(first.changed);
    assert!(first.ssh_forward_active);
    assert_eq!(first.cpu_runtime.quota.cpu_millis, 1_000);
    assert_eq!(core.backend.boundary_operations, ["quota:1000", "ssh:true"]);
    assert_eq!(core.capabilities().committed_cpu_millis, 1_000);

    let second = match core.handle(Request::FinalizeVmBoot(request)) {
        Response::FinalizeVmBoot(value) => value,
        other => panic!("unexpected idempotent finalize response {other:?}"),
    };
    assert!(!second.changed);
    assert_eq!(
        core.backend.boundary_operations,
        ["quota:1000", "ssh:true", "quota:1000", "ssh:true"]
    );
}

#[test]
fn finalize_persistence_and_ingress_rollback_failure_contains_vm() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let preparer = TrackingPreparer {
        // Launch intent, launch identity, CPU seal, then ingress state.
        fail_persist_call: Some(4),
        ..TrackingPreparer::default()
    };
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        preparer,
        4_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    let launched = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected launch response {other:?}"),
    };
    core.backend.fail_ssh_forward_disable = true;

    let response = core.handle(Request::FinalizeVmBoot(FinalizeVmBootRequest {
        generation: launched.generation.clone(),
    }));
    assert!(matches!(response, Response::Error(_)));
    assert!(!core.records.contains_key(&launched.generation));
    assert!(core.backend.active_ssh_forwards.is_empty());
    assert!(core.backend.stopped_units.contains(&launched.unit_name));
    assert!(core.backend.destroyed_units.contains(&launched.unit_name));
    assert!(core.preparer.quarantined.contains(&launched.generation));
    assert!(!core.records.contains_key(&launched.generation));
    assert_eq!(core.capabilities().committed_cpu_millis, 0);
    assert!(!core.capabilities().supports_jailer_v2);
}

#[test]
fn quota_exhaustion_is_rejected_before_launch() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        FakeTemplatePreparer,
        1_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    assert!(matches!(
        core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))),
        Response::LaunchVmV2(_)
    ));
    assert!(matches!(
        core.handle(Request::LaunchVmV2(Box::new(launch_v2(1, 1_000)))),
        Response::Error(ProtocolError { ref code, .. }) if code == "cpu_capacity_exhausted"
    ));
    assert_eq!(core.capabilities().committed_cpu_millis, 1_000);
}

#[test]
fn failed_quota_readback_contains_vm_without_exposing_ssh() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        TrackingPreparer::default(),
        4_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    let launched = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected launch response {other:?}"),
    };
    core.backend.fail_quota_verification = true;

    let response = core.handle(Request::FinalizeVmBoot(FinalizeVmBootRequest {
        generation: launched.generation.clone(),
    }));
    assert!(matches!(response, Response::Error(_)));
    assert!(!core.records.contains_key(&launched.generation));
    assert!(core.backend.active_ssh_forwards.is_empty());
    assert!(core.backend.ssh_forward_updates.is_empty());
    assert!(core.backend.stopped_units.contains(&launched.unit_name));
    assert!(core.backend.destroyed_units.contains(&launched.unit_name));
    assert!(core.preparer.quarantined.contains(&launched.generation));
    assert!(!core.capabilities().supports_hard_cpu_quota);
}
