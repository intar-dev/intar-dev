use super::*;

#[test]
fn launch_grants_mknod_only_for_the_jail_devices() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        FakeTemplatePreparer,
        125,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    assert!(matches!(
        launch_prepared_v2(&mut core, 0, 125),
        Response::LaunchVmV2(_)
    ));
    assert_eq!(core.backend.started_specs.len(), 1);
    assert_eq!(
        core.backend.started_specs[0].device_allow,
        [
            "/dev/kvm rwm",
            "/dev/net/tun rwm",
            "/dev/urandom rm",
            "/dev/null rwm",
        ]
    );
}

#[test]
fn reservation_is_held_until_destroy_after_exit() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        FakeTemplatePreparer,
        125,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    let launched = match launch_prepared_v2(&mut core, 1, 125) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected response {other:?}"),
    };
    assert_eq!(core.capabilities().committed_cpu_millis, 125);
    let identity = VmIdentityRequest::by_generation(launched.generation);
    assert!(matches!(
        core.handle(Request::StopVm(identity.clone())),
        Response::StopVm(_)
    ));
    assert_eq!(core.capabilities().committed_cpu_millis, 125);
    assert!(matches!(
        core.handle(Request::DestroyVm(identity)),
        Response::DestroyVm(_)
    ));
    assert_eq!(core.capabilities().committed_cpu_millis, 0);
}

#[test]
fn destroy_continues_after_systemd_garbage_collects_a_drained_unit() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        FakeTemplatePreparer,
        125,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    let launched = match launch_prepared_v2(&mut core, 1, 125) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected response {other:?}"),
    };
    let identity = VmIdentityRequest::by_generation(launched.generation.clone());
    assert!(matches!(
        core.handle(Request::StopVm(identity.clone())),
        Response::StopVm(_)
    ));
    assert!(core.backend.units.remove(&launched.unit_name).is_some());
    assert!(matches!(
        core.handle(Request::StopVm(identity.clone())),
        Response::StopVm(OperationResult { changed: false })
    ));
    assert_eq!(core.capabilities().committed_cpu_millis, 125);

    assert!(matches!(
        core.handle(Request::DestroyVm(identity)),
        Response::DestroyVm(_)
    ));
    assert_eq!(core.capabilities().committed_cpu_millis, 0);
    assert!(!core.records.contains_key(&launched.generation));
    assert_eq!(core.backend.destroyed_vm_networks.len(), 1);
}

#[test]
fn destroy_refuses_a_populated_unit() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        FakeTemplatePreparer,
        125,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    let launched = match launch_prepared_v2(&mut core, 1, 125) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected response {other:?}"),
    };

    assert!(matches!(
        core.handle(Request::DestroyVm(VmIdentityRequest::by_generation(
            launched.generation.clone()
        ))),
        Response::Error(_)
    ));
    assert_eq!(core.capabilities().committed_cpu_millis, 125);
    assert!(core.records.contains_key(&launched.generation));
}

#[test]
fn logical_vm_launch_is_idempotent_and_conflicts_on_changed_resources() {
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
    let request = prepare_launch_v2(&mut core, 1, 125);
    let first = match core.handle(Request::LaunchVmV2(Box::new(request.clone()))) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected first launch response {other:?}"),
    };
    let second = match core.handle(Request::LaunchVmV2(Box::new(request.clone()))) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected idempotent launch response {other:?}"),
    };
    assert_eq!(first.generation, second.generation);
    assert_eq!(core.capabilities().committed_cpu_millis, 125);

    let mut changed = request;
    changed.launch.cpu_millis = 126;
    let response = core.handle(Request::LaunchVmV2(Box::new(changed)));
    assert!(matches!(
        response,
        Response::Error(ProtocolError { ref code, .. }) if code == "conflict"
    ));
}

#[test]
fn idempotent_launch_still_rejects_a_changed_live_process_identity() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        TrackingPreparer::default(),
        1_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);
    let request = prepare_launch_v2(&mut core, 1, 125);
    let launched = match core.handle(Request::LaunchVmV2(Box::new(request.clone()))) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected first launch response {other:?}"),
    };
    core.backend
        .units
        .get_mut(&launched.unit_name)
        .expect("fake unit")
        .pid_start_time_ticks = Some(8);

    let response = core.handle(Request::LaunchVmV2(Box::new(request)));
    assert!(matches!(
        response,
        Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
    ));
    assert!(core.backend.stopped_units.contains(&launched.unit_name));
    assert!(core.backend.destroyed_units.contains(&launched.unit_name));
    assert!(core.preparer.quarantined.contains(&launched.generation));
}

#[cfg(target_os = "linux")]
#[test]
fn inspect_healthy_vm_still_requires_a_live_api_ping() {
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
    let launched = match launch_prepared_v2(&mut core, 1, 125) {
        Response::LaunchVmV2(value) => value,
        other => panic!("unexpected launch response {other:?}"),
    };

    let response = core.handle(Request::InspectVm(VmIdentityRequest::by_generation(
        launched.generation,
    )));
    assert!(matches!(
        response,
        Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
    ));
    assert!(core.backend.stopped_units.contains(&launched.unit_name));
    assert!(core.backend.destroyed_units.contains(&launched.unit_name));
}

#[test]
fn network_setup_failure_revokes_partial_network_and_quarantines_generation() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend {
            fail_vm_network: true,
            ..FakeBackend::default()
        },
        TrackingPreparer::default(),
        1_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);

    assert!(matches!(
        launch_prepared_v2(&mut core, 1, 125),
        Response::Error(_)
    ));
    assert!(core.records.is_empty());
    assert_eq!(core.preparer.quarantined.len(), 1);
    assert_eq!(core.backend.destroyed_vm_networks.len(), 1);
    assert_eq!(
        core.backend.destroyed_vm_networks[0],
        (
            ValidatedId::parse("run").expect("run ID"),
            core.preparer.quarantined[0].clone(),
        )
    );
}

#[test]
fn partial_start_failure_stops_then_destroys_the_transient_unit() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend {
            fail_start_after_create: true,
            ..FakeBackend::default()
        },
        TrackingPreparer::default(),
        1_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);

    let response = launch_prepared_v2(&mut core, 1, 125);
    assert!(matches!(response, Response::Error(_)));
    assert!(core.records.is_empty());
    let generation = core
        .preparer
        .quarantined
        .first()
        .expect("failed generation quarantined");
    let unit_name = format!("intar-vm-{generation}.service");
    assert_eq!(
        core.backend.unit_operations,
        [format!("stop:{unit_name}"), format!("destroy:{unit_name}")]
    );
    assert!(!core.backend.units.contains_key(&unit_name));
    assert_eq!(
        core.backend.destroyed_vm_networks,
        [(
            ValidatedId::parse("run").expect("run ID"),
            generation.clone()
        )]
    );
}

#[test]
fn post_start_persistence_failure_rolls_back_the_transient_unit() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        TrackingPreparer {
            fail_persist_call: Some(2),
            ..TrackingPreparer::default()
        },
        1_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);

    let response = launch_prepared_v2(&mut core, 1, 125);
    assert!(matches!(response, Response::Error(_)));
    assert!(core.records.is_empty());
    let generation = core
        .preparer
        .quarantined
        .first()
        .expect("failed generation quarantined");
    let unit_name = format!("intar-vm-{generation}.service");
    assert_eq!(
        core.backend.unit_operations,
        [format!("stop:{unit_name}"), format!("destroy:{unit_name}")]
    );
    assert!(!core.backend.units.contains_key(&unit_name));
    assert_eq!(core.preparer.persist_calls, 2);
    assert_eq!(core.preparer.runtime_access_calls, 1);
}

#[test]
fn runtime_socket_acl_failure_rolls_back_the_transient_unit() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        TrackingPreparer {
            fail_runtime_access: true,
            ..TrackingPreparer::default()
        },
        1_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);

    let Response::Error(error) = launch_prepared_v2(&mut core, 1, 125) else {
        panic!("runtime socket ACL failure unexpectedly succeeded")
    };
    assert!(
        error
            .message
            .contains("injected runtime socket ACL failure")
    );
    assert!(core.records.is_empty());
    assert_eq!(core.preparer.runtime_access_calls, 1);
    assert_eq!(core.preparer.persist_calls, 1);
    let generation = core
        .preparer
        .quarantined
        .first()
        .expect("failed generation quarantined");
    let unit_name = format!("intar-vm-{generation}.service");
    assert_eq!(
        core.backend.unit_operations,
        [format!("stop:{unit_name}"), format!("destroy:{unit_name}")]
    );
    assert!(!core.backend.units.contains_key(&unit_name));
}

#[test]
fn failed_launch_reports_every_rollback_failure() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    config.boot_cpu_millis = 2_000;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend {
            fail_start_after_create: true,
            fail_stop_unit: true,
            fail_destroy_unit: true,
            fail_destroy_vm_network: true,
            ..FakeBackend::default()
        },
        TrackingPreparer {
            fail_quarantine: true,
            ..TrackingPreparer::default()
        },
        2_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);

    let Response::Error(error) = core.handle(Request::LaunchVmV2(Box::new(launch_v2(1, 1_000))))
    else {
        panic!("failed launch unexpectedly succeeded")
    };
    for expected in [
        "injected transient unit activation failure",
        "injected transient unit stop failure",
        "injected transient unit destroy failure",
        "preserved VM network and generation",
    ] {
        assert!(
            error.message.contains(expected),
            "missing {expected:?} from {:?}",
            error.message
        );
    }
    assert_eq!(core.backend.stopped_units.len(), 1);
    assert_eq!(core.backend.destroyed_units.len(), 1);
    assert!(core.backend.destroyed_vm_networks.is_empty());
    assert!(core.preparer.quarantined.is_empty());
    assert_eq!(core.capabilities().committed_cpu_millis, 2_000);
    assert_eq!(core.pending_cpu_reservations.len(), 1);
    assert_eq!(core.unresolved_recoveries.len(), 1);

    core.backend.fail_stop_unit = false;
    core.backend.fail_destroy_unit = false;
    core.backend.fail_destroy_vm_network = false;
    core.preparer.fail_quarantine = false;
    assert_eq!(core.enforce_boot_deadlines().expect("retry cleanup"), 0);
    assert_eq!(core.capabilities().committed_cpu_millis, 0);
    assert!(core.pending_cpu_reservations.is_empty());
    assert!(core.unresolved_recoveries.is_empty());
}

#[test]
fn drained_failed_launch_reports_network_and_quarantine_failures() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    config.boot_cpu_millis = 2_000;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend {
            fail_start_after_create: true,
            fail_destroy_vm_network: true,
            ..FakeBackend::default()
        },
        TrackingPreparer {
            fail_quarantine: true,
            ..TrackingPreparer::default()
        },
        2_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);

    let Response::Error(error) = core.handle(Request::LaunchVmV2(Box::new(launch_v2(1, 1_000))))
    else {
        panic!("failed launch unexpectedly succeeded")
    };
    for expected in [
        "injected transient unit activation failure",
        "injected VM network destroy failure",
        "injected jail quarantine failure",
    ] {
        assert!(error.message.contains(expected));
    }
    assert_eq!(core.backend.destroyed_vm_networks.len(), 1);
    assert_eq!(core.preparer.quarantined.len(), 1);
    assert_eq!(core.capabilities().committed_cpu_millis, 0);
    assert_eq!(core.unresolved_recoveries.len(), 1);
}

#[test]
fn mismatched_started_unit_never_controls_the_returned_unit_name() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut core = JailerdCore::new_with_readiness(
        config,
        FakeBackend {
            returned_unit_name: Some("ssh.service".to_owned()),
            ..FakeBackend::default()
        },
        TrackingPreparer::default(),
        1_000,
        ready_readiness(),
    )
    .expect("core");
    ensure_test_network(&mut core);

    assert!(matches!(
        launch_prepared_v2(&mut core, 1, 125),
        Response::Error(_)
    ));
    assert!(core.records.is_empty());
    let generation = core
        .preparer
        .quarantined
        .first()
        .expect("failed generation quarantined");
    assert_eq!(
        core.backend.stopped_units,
        vec![format!("intar-vm-{generation}.service")]
    );
    assert_eq!(
        core.backend.destroyed_units,
        vec![format!("intar-vm-{generation}.service")]
    );
    assert!(core.backend.units.is_empty());
    assert!(
        !core
            .backend
            .stopped_units
            .iter()
            .any(|unit| unit == "ssh.service")
    );
    assert_eq!(
        core.backend.destroyed_vm_networks,
        vec![(
            ValidatedId::parse("run").expect("run ID"),
            generation.clone(),
        )]
    );
}

#[test]
fn durable_v2_metadata_requires_explicit_cpu_and_ingress_state() {
    let config = test_config();
    let record = recovered_record(&config);
    let encoded = serde_json::to_value(&record).expect("serialize v2 metadata");
    for required in [
        "schema_version",
        "steady_quota",
        "effective_quota",
        "cpu_phase",
        "boot_deadline_unix_ms",
        "quota_attestation",
        "ssh_forward_active",
    ] {
        let mut incomplete = encoded.clone();
        incomplete
            .as_object_mut()
            .expect("metadata object")
            .remove(required);
        let bytes = serde_json::to_vec(&incomplete).expect("encode incomplete metadata");
        assert!(
            decode_vm_record_v2(&bytes).is_err(),
            "missing required v2 field {required:?} was accepted"
        );
    }
}

#[test]
fn legacy_metadata_shape_cannot_be_decoded_as_v2() {
    let config = test_config();
    let mut legacy =
        serde_json::to_value(recovered_record(&config)).expect("serialize legacy metadata shape");
    let object = legacy.as_object_mut().expect("metadata object");
    let legacy_quota = object
        .remove("steady_quota")
        .expect("serialized steady quota");
    object.insert("quota".to_owned(), legacy_quota);
    for field in [
        "schema_version",
        "effective_quota",
        "cpu_phase",
        "boot_deadline_unix_ms",
        "quota_attestation",
        "ssh_forward_active",
    ] {
        object.remove(field);
    }
    let bytes = serde_json::to_vec(&legacy).expect("encode legacy metadata shape");
    assert!(decode_vm_record_v2(&bytes).is_err());
}

#[test]
fn recovery_contains_non_v2_metadata_without_restoring_ingress() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut record = recovered_record(&config);
    record.schema_version = 1;
    let forwarding_key = (record.request.run_id.clone(), record.generation.clone());
    let mut backend = FakeBackend::default();
    backend
        .units
        .insert(record.unit_name.clone(), recovered_inspection(&record));
    backend.active_ssh_forwards.insert(forwarding_key);

    let core = JailerdCore::new_with_readiness(
        config,
        backend,
        RecoverPreparer {
            records: vec![record.clone()],
            ..RecoverPreparer::default()
        },
        1_000,
        ready_readiness(),
    )
    .expect("contain legacy recovery");

    assert!(core.records.is_empty());
    assert!(core.backend.active_ssh_forwards.is_empty());
    assert!(core.backend.ssh_forward_updates.is_empty());
    assert_eq!(core.backend.stopped_units, vec![record.unit_name.clone()]);
    assert_eq!(core.backend.destroyed_units, vec![record.unit_name]);
    assert_eq!(core.preparer.quarantined, vec![record.generation]);
}

#[test]
fn recovery_reattaches_a_matching_drained_generation() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let record = recovered_record(&config);
    let mut backend = FakeBackend::default();
    backend
        .units
        .insert(record.unit_name.clone(), recovered_inspection(&record));
    let core = JailerdCore::new_with_readiness(
        config,
        backend,
        RecoverPreparer {
            records: vec![record.clone()],
            ..RecoverPreparer::default()
        },
        1_000,
        ready_readiness(),
    )
    .expect("recover core");
    assert!(core.records.contains_key(&record.generation));
    assert_eq!(core.capabilities().committed_cpu_millis, 125);
    assert!(core.preparer.quarantined.is_empty());
}

#[test]
fn recovery_derives_unit_name_before_draining_tampered_metadata() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    let mut record = recovered_record(&config);
    let expected_unit = format!("intar-vm-{}.service", record.generation);
    record.unit_name = "ssh.service".to_owned();
    let core = JailerdCore::new_with_readiness(
        config,
        FakeBackend::default(),
        RecoverPreparer {
            records: vec![record.clone()],
            ..RecoverPreparer::default()
        },
        1_000,
        ready_readiness(),
    )
    .expect("quarantine tampered record without aborting recovery");
    assert!(core.records.is_empty());
    assert_eq!(core.backend.stopped_units, vec![expected_unit.clone()]);
    assert_eq!(core.backend.destroyed_units, vec![expected_unit]);
    assert_eq!(core.preparer.quarantined, vec![record.generation.clone()]);
    assert_eq!(
        core.preparer.reserved,
        vec![(record.generation, record.uid, record.gid)]
    );
}

#[test]
fn recovery_starts_watchdog_and_accounts_boot_quota_when_containment_fails() {
    let mut config = test_config();
    config.cpu_reserved_millis = 0;
    config.boot_cpu_millis = 2_000;
    let mut record = recovered_record(&config);
    record.cpu_phase = VmCpuPhase::BootBurst;
    record.effective_quota = CpuQuota::from_millis(2_000).expect("boot quota");
    record.boot_deadline_unix_ms = Some(u64::MAX);
    record.quota_attestation = None;
    record.ssh_forward_active = false;
    let mut backend = FakeBackend {
        fail_quota_update: true,
        fail_stop_unit: true,
        fail_destroy_unit: true,
        ..FakeBackend::default()
    };
    backend
        .units
        .insert(record.unit_name.clone(), recovered_inspection(&record));
    let mut core = JailerdCore::new_with_readiness(
        config,
        backend,
        RecoverPreparer {
            records: vec![record.clone()],
            ..RecoverPreparer::default()
        },
        4_000,
        ready_readiness(),
    )
    .expect("recovery must retain a live watchdog");

    assert!(core.records.is_empty());
    assert_eq!(core.capabilities().committed_cpu_millis, 2_000);
    assert_eq!(core.pending_cpu_reservations.len(), 1);
    assert!(core.unresolved_recoveries.contains_key(&record.generation));

    core.backend.fail_quota_update = false;
    core.backend.fail_stop_unit = false;
    core.backend.fail_destroy_unit = false;
    assert_eq!(core.enforce_boot_deadlines().expect("retry containment"), 0);
    assert_eq!(core.capabilities().committed_cpu_millis, 0);
    assert!(core.pending_cpu_reservations.is_empty());
    assert!(core.unresolved_recoveries.is_empty());
    assert!(!core.backend.units.contains_key(&record.unit_name));
    assert!(core.preparer.quarantined.contains(&record.generation));
}

#[test]
fn transient_unit_properties_encode_hard_quota_and_safety() {
    let quota = CpuQuota::from_millis(125).expect("quota");
    let generation = ValidatedId::parse("test").expect("generation");
    let spec = UnitLaunchSpec {
        generation,
        unit_name: "intar-vm-test.service".to_owned(),
        description: "test".to_owned(),
        jailer_binary: "/intar-jailer".into(),
        jail_spec_path: "/spec".into(),
        api_socket_path: "/api.sock".into(),
        cpu_quota: quota,
        steady_cpu_quota: quota,
        boot_cpu_lease_ms: Some(45_000),
        vmm_executable_identity: None,
        uid: 200_000,
        gid: 200_000,
        device_allow: vec!["/dev/kvm rw"],
    };
    let properties = spec.required_properties();
    assert_eq!(properties["CPUQuotaPerSecUSec"], "125000");
    assert_eq!(properties["CPUQuotaPeriodUSec"], "100000");
    assert_eq!(properties["KillMode"], "control-group");
    assert_eq!(properties["RestrictRealtime"], "yes");
    assert_eq!(properties["BindsTo"], "intar-vm-boot-lease-test.service");
}

#[test]
fn boot_cpu_guardian_unit_is_generation_bound_typed_and_hardened() {
    let generation = ValidatedId::parse("generation-1").expect("generation");
    let quota = CpuQuota::from_millis(1_000).expect("steady quota");
    let request = BootCpuGuardianRequest::new(
        generation.clone(),
        vm_unit_name(&generation),
        quota,
        123_456,
    )
    .expect("guardian request");
    let unit = BootCpuGuardianUnitSpec::new(PathBuf::from("/usr/lib/intar/intar-jailerd"), request)
        .expect("guardian unit");
    assert_eq!(unit.unit_name, "intar-vm-boot-lease-generation-1.service");
    assert_eq!(
        vm_cgroup_path(unit.request.unit_name()),
        PathBuf::from("/intar.slice/intar-vms.slice/intar-vm-generation-1.service")
    );
    assert_eq!(
        unit.command_argv(),
        vec![
            "/usr/lib/intar/intar-jailerd",
            "boot-cpu-lease-guardian",
            "--generation",
            "generation-1",
            "--unit-name",
            "intar-vm-generation-1.service",
            "--steady-cpu-millis",
            "1000",
            "--deadline-uptime-millis",
            "123456",
        ]
    );
    let properties = unit.required_properties();
    assert_eq!(properties["Type"], "oneshot");
    assert_eq!(properties["RemainAfterExit"], "yes");
    assert_eq!(properties["PartOf"], "intar-vm-generation-1.service");
    assert_eq!(properties["User"], "root");
    assert_eq!(properties["NoNewPrivileges"], "yes");
    assert_eq!(properties["ProtectSystem"], "strict");
    assert_eq!(properties["ProtectControlGroups"], "no");
    assert_eq!(properties["CapabilityBoundingSet"], "0");

    let mismatch = BootCpuGuardianRequest::new(
        generation,
        "intar-vm-other.service".to_owned(),
        quota,
        123_456,
    )
    .expect_err("cross-generation guardian must fail");
    assert!(mismatch.to_string().contains("unit mismatch"));
}
