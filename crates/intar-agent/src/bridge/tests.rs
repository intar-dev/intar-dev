use intar_contracts::bridge_v9::{CheckStatus, LabState, VmTaskV1};
use intar_contracts::oci::OciDigest;
use intar_contracts::scenario::SpecMode;

use crate::vm::VmTerminalTarget;

use super::*;

fn digest(digit: char) -> OciDigest {
    OciDigest::try_from(format!("sha256:{}", digit.to_string().repeat(64)))
        .unwrap_or_else(|error| panic!("test digest: {error}"))
}

fn desired_vm() -> DesiredVmV3 {
    DesiredVmV3 {
        vm_id: "vm-1".to_string(),
        name: "web".to_string(),
        run_id: "run-1".to_string(),
        runtime_execution_id: "execution-1".to_string(),
        owner_user_id: "user-1".to_string(),
        generation: 1,
        desired_phase: DesiredVmPhase::Running,
        lease_expires_at_unix_ms: now_ms() + 60_000,
        image: digest('a'),
        kino: digest('b'),
        spec: digest('c'),
        mode: SpecMode::Learn,
        cpu_millis: 125,
        memory_mib: 512,
        disk_mib: 4096,
        peers: Vec::new(),
        ssh_authorized_keys: vec!["ssh-ed25519 AAAATEST run".to_string()],
        terminal: true,
        egress: false,
    }
}

#[test]
fn host_hardware_fails_closed_without_a_jailerd_attestation() {
    let hardware = collect_host_hardware(None);
    assert_eq!(hardware.cloud_hypervisor_sha256, None);
    assert!(!hardware.kvm && !hardware.landlock && !hardware.hard_cpu_quota);
}

#[test]
fn the_hello_carries_the_guest_contract_and_the_hardware() {
    let hello = BridgeMessageV9::ClientHello(ClientHelloV9 {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        host_id: "host-1".to_string(),
        agent_version: "0.0.0".to_string(),
        role: HostRoleV1::Agent,
        last_applied_desired_version: None,
        guest_contract: GUEST_CONTRACT,
        hardware: collect_host_hardware(None),
    });
    let value = serde_json::to_value(&hello).expect("serialize");
    assert_eq!(value["type"], "client_hello");
    assert_eq!(value["protocol_version"], 9);
    assert_eq!(value["guest_contract"], GUEST_CONTRACT);
    assert_eq!(value["hardware"]["vsock"], true);
    let raw = serde_json::to_string(&hello).expect("serialize");
    assert_eq!(parse_bridge_json(&raw).expect("v9 hello"), hello);
}

fn empty_desired_state(version: u64) -> HostDesiredStateV3 {
    HostDesiredStateV3 {
        scope: intar_contracts::bridge::HostScope::Personal,
        owner_user_id: "user-1".to_string(),
        schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
        host_id: "host-1".to_string(),
        version,
        generated_at_unix_ms: 123,
        cached_images: Vec::new(),
        kino_pin: None,
        vms: Vec::new(),
    }
}

#[test]
fn char_device_probe_rejects_missing_and_regular_files() {
    let regular = tempfile::NamedTempFile::new().expect("tempfile");

    assert!(!can_open_char_device(Path::new(
        "/tmp/intar-agent-missing-char-device"
    )));
    assert!(!can_open_char_device(regular.path()));
}

#[cfg(unix)]
#[test]
fn char_device_probe_accepts_openable_char_devices() {
    assert!(can_open_char_device(Path::new("/dev/null")));
}

#[test]
fn parses_only_v9_bridge_messages() {
    let message = BridgeMessageV9::SyncRequest(SyncRequestV9 {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        host_id: "host-1".to_string(),
        reason: SyncRequestReason::Connect,
    });
    let raw = serde_json::to_string(&message).expect("serialize");

    assert!(parse_bridge_json(&raw).is_ok());

    let raw_v8 = raw.replace("\"protocol_version\":9", "\"protocol_version\":8");
    let error = parse_bridge_json(&raw_v8).expect_err("v8 should fail");
    assert!(error.to_string().contains("expected v9"));

    // A v8 message the v9 schema does not know is refused outright.
    let build_report = r#"{"type":"build_report","protocol_version":9,"host_id":"host-1"}"#;
    assert!(parse_bridge_json(build_report).is_err());
    let unknown_field = raw.replace("\"reason\"", "\"later\":1,\"reason\"");
    assert!(parse_bridge_json(&unknown_field).is_err());
}

#[test]
fn a_refused_protocol_backs_off_long_without_resetting_the_backoff() {
    assert_eq!(
        retry_after_failure(RETRY_MIN_MS, false),
        (RETRY_MIN_MS, 2 * RETRY_MIN_MS)
    );
    assert_eq!(
        retry_after_failure(RETRY_MAX_MS, false),
        (RETRY_MAX_MS, RETRY_MAX_MS)
    );
    let (wait, next) = retry_after_failure(RETRY_MIN_MS, true);
    assert_eq!(wait, UPGRADE_RETRY_MS);
    assert!(
        wait >= 10 * RETRY_MAX_MS,
        "an upgrade refusal must not hot-loop"
    );
    assert_eq!(next, RETRY_MAX_MS);
}

#[test]
fn close_4426_is_upgrade_required() {
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    let close = |code: u16| {
        Message::Close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: "".into(),
        }))
    };
    let error = parse_bridge_message(close(4426)).expect_err("4426 closes");
    assert!(error.downcast_ref::<UpgradeRequired>().is_some());
    let error = parse_bridge_message(close(1000)).expect_err("1000 closes");
    assert!(error.downcast_ref::<UpgradeRequired>().is_none());
}

#[tokio::test]
async fn bootstrap_426_is_upgrade_required_and_sends_the_protocol_header() {
    crate::tls_provider::ensure_ring_provider().expect("rustls provider");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/api/agent/bootstrap",
                axum::routing::post(|headers: axum::http::HeaderMap| async move {
                    if headers
                        .get(BRIDGE_PROTOCOL_HEADER)
                        .and_then(|value| value.to_str().ok())
                        == Some("9")
                    {
                        axum::http::StatusCode::UPGRADE_REQUIRED
                    } else {
                        axum::http::StatusCode::BAD_REQUEST
                    }
                }),
            ),
        )
        .await
        .expect("serve");
    });
    let mut cfg = test_bridge_config();
    cfg.base_url = format!("http://{address}");
    let result = bootstrap_agent_access(&cfg, &HttpClient::new()).await;
    server.abort();
    let error = result.err().expect("426 fails the bootstrap");
    assert!(
        error.downcast_ref::<UpgradeRequired>().is_some(),
        "{error:#}"
    );
}

#[tokio::test]
async fn terminal_subscription_retains_transition_during_initial_snapshot() {
    let (terminal_tx, _) = tokio::sync::broadcast::channel(1);
    // connect_once establishes this receiver before it starts building the
    // initial state report. The send below models readiness becoming
    // durable while that report still contains the preceding Pending view.
    let mut terminal_updates = terminal_tx.subscribe();
    let state = VmTerminalState {
        run_id: "run-1".to_string(),
        vm_name: "web".to_string(),
        state: VmTerminalStateKind::Ready,
        terminal_target: Some(VmTerminalTarget {
            host: Some("203.0.113.7".to_string()),
            port: 22_001,
            username: "ubuntu".to_string(),
            checked_at: 2_000,
        }),
        reason: None,
        observed_at: 2_000,
        runtime_constraints: Some(VmRuntimeConstraintsV2 {
            generation: "generation-1".to_string(),
            cpu_millis: 1_000,
            quota_verified_at_unix_ms: Some(1_999),
        }),
    };

    terminal_tx
        .send(state.clone())
        .expect("pre-snapshot subscription retains readiness transition");

    assert_eq!(
        timeout(
            Duration::from_millis(INVENTORY_DELIVERY_TARGET_MS),
            terminal_updates.recv(),
        )
        .await
        .expect("readiness transition stays inside delivery target")
        .expect("terminal channel stays open"),
        state
    );
}

#[tokio::test]
async fn fresh_terminal_subscription_drops_lagged_retained_tail() {
    let state = |observed_at| VmTerminalState {
        run_id: "run-1".to_string(),
        vm_name: "web".to_string(),
        state: VmTerminalStateKind::Pending,
        terminal_target: None,
        reason: Some(format!("revision-{observed_at}")),
        observed_at,
        runtime_constraints: None,
    };
    let (terminal_tx, _) = tokio::sync::broadcast::channel(1);
    let mut lagged = terminal_tx.subscribe();
    terminal_tx.send(state(1)).expect("first transition");
    terminal_tx.send(state(2)).expect("second transition");
    assert!(matches!(
        lagged.recv().await,
        Err(tokio::sync::broadcast::error::RecvError::Lagged(1))
    ));

    // The bridge replaces a lagged receiver and uses cached inventory as
    // authority, so the retained revision 2 must not enter the urgent FIFO.
    let mut fresh = terminal_tx.subscribe();
    terminal_tx.send(state(3)).expect("future transition");
    assert_eq!(fresh.recv().await.expect("fresh transition"), state(3));
}

#[tokio::test]
async fn outbound_writer_prioritizes_urgent_terminal_reports() {
    let (urgent_tx, mut urgent_rx) = mpsc::channel(1);
    let (inventory_tx, mut inventory_rx) = mpsc::channel(1);
    let (normal_tx, mut normal_rx) = mpsc::channel(1);
    normal_tx
        .send(BridgeMessageV9::SyncRequest(SyncRequestV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "normal".to_string(),
            reason: SyncRequestReason::Connect,
        }))
        .await
        .expect("queue normal message");
    inventory_tx
        .send(BridgeMessageV9::SyncRequest(SyncRequestV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "inventory".to_string(),
            reason: SyncRequestReason::Reconnect,
        }))
        .await
        .expect("queue inventory message");
    urgent_tx
        .send(BridgeMessageV9::SyncRequest(SyncRequestV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "terminal".to_string(),
            reason: SyncRequestReason::Reconnect,
        }))
        .await
        .expect("queue urgent terminal message");

    let next = timeout(
        Duration::from_millis(INVENTORY_DELIVERY_TARGET_MS),
        next_outbound_message(&mut urgent_rx, &mut inventory_rx, &mut normal_rx),
    )
    .await
    .expect("priority dequeue stays inside terminal budget")
    .expect("queued message");

    assert_eq!(bridge_message_host_id(&next), "terminal");
}

#[tokio::test]
async fn outbound_writer_prioritizes_inventory_reports() {
    let (_urgent_tx, mut urgent_rx) = mpsc::channel(1);
    let (inventory_tx, mut inventory_rx) = mpsc::channel(1);
    let (normal_tx, mut normal_rx) = mpsc::channel(1);
    normal_tx
        .send(BridgeMessageV9::SyncRequest(SyncRequestV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "normal".to_string(),
            reason: SyncRequestReason::Connect,
        }))
        .await
        .expect("queue normal message");
    inventory_tx
        .send(BridgeMessageV9::SyncRequest(SyncRequestV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "inventory".to_string(),
            reason: SyncRequestReason::Reconnect,
        }))
        .await
        .expect("queue inventory message");

    let next = timeout(
        Duration::from_millis(INVENTORY_DELIVERY_TARGET_MS),
        next_outbound_message(&mut urgent_rx, &mut inventory_rx, &mut normal_rx),
    )
    .await
    .expect("priority dequeue stays inside inventory budget")
    .expect("queued message");

    assert_eq!(bridge_message_host_id(&next), "inventory");
}

#[test]
fn bounded_inventory_path_fits_delivery_target() {
    let worst_case_ms = INVENTORY_REPORT_JAILER_BUDGET_MS
        .saturating_add(OUTBOUND_SEND_BUDGET_MS)
        .saturating_add(OUTBOUND_SEND_BUDGET_MS);
    assert!(worst_case_ms < INVENTORY_DELIVERY_TARGET_MS);
}

#[test]
fn bounded_urgent_path_fits_delivery_target() {
    // Eight VM creates may finalize together. Include one send already in
    // flight plus the entire bounded urgent FIFO; a blocked ninth enqueue
    // cannot extend the last admitted transition past this bound.
    let worst_case_ms =
        OUTBOUND_SEND_BUDGET_MS.saturating_mul((URGENT_OUTBOUND_CAPACITY as u64).saturating_add(1));
    assert!(worst_case_ms < INVENTORY_DELIVERY_TARGET_MS);
}

#[test]
fn terminal_updates_are_run_and_generation_fenced() {
    assert!(terminal_identities_match(
        "run-1",
        Some("generation-2"),
        &VmTerminalStateKind::Ready,
        Some("run-1"),
        Some("generation-2"),
    ));
    assert!(!terminal_identities_match(
        "run-1",
        Some("generation-1"),
        &VmTerminalStateKind::Ready,
        Some("run-1"),
        Some("generation-2"),
    ));
    assert!(!terminal_identities_match(
        "run-old",
        Some("generation-2"),
        &VmTerminalStateKind::Ready,
        Some("run-new"),
        Some("generation-2"),
    ));
    assert!(!terminal_identities_match(
        "run-1",
        None,
        &VmTerminalStateKind::Ready,
        Some("run-1"),
        None,
    ));
    assert!(terminal_identities_match(
        "run-1",
        None,
        &VmTerminalStateKind::Failed,
        Some("run-1"),
        None,
    ));
}

#[test]
fn immutable_attestation_survives_transient_live_refresh_failure() {
    assert_eq!(preserve_last_attestation(None, Some(&42_u8)), Some(42));
    assert_eq!(
        preserve_last_attestation(Some(&7_u8), Some(&42_u8)),
        Some(7)
    );
    assert_eq!(preserve_last_attestation::<u8>(None, None), None);
}

#[test]
fn explicit_terminal_contract_exposes_targets_only_when_ready() {
    let ready = terminal_state_from_manager(&VmTerminalState {
        run_id: "run-1".to_string(),
        vm_name: "web".to_string(),
        state: VmTerminalStateKind::Ready,
        terminal_target: Some(VmTerminalTarget {
            host: Some("203.0.113.7".to_string()),
            port: 22_001,
            username: "ubuntu".to_string(),
            checked_at: 2_000,
        }),
        reason: None,
        observed_at: 2_000,
        runtime_constraints: None,
    });
    assert_eq!(ready.state, VmTerminalStateKindV1::Ready);
    assert_eq!(
        ready.target.as_ref().map(|target| target.port),
        Some(22_001)
    );

    let pending = terminal_state_from_manager(&VmTerminalState {
        run_id: "run-1".to_string(),
        vm_name: "web".to_string(),
        state: VmTerminalStateKind::Pending,
        terminal_target: Some(VmTerminalTarget {
            host: Some("203.0.113.7".to_string()),
            port: 22_001,
            username: "ubuntu".to_string(),
            checked_at: 2_000,
        }),
        reason: Some("sealing CPU quota".to_string()),
        observed_at: 2_000,
        runtime_constraints: None,
    });
    assert_eq!(pending.state, VmTerminalStateKindV1::Pending);
    assert_eq!(pending.target, None);
}

#[test]
fn desired_state_versions_never_regress() {
    let current = empty_desired_state(7);

    assert!(desired_state_is_stale(
        Some(&current),
        &empty_desired_state(6)
    ));
    assert!(!desired_state_is_stale(
        Some(&current),
        &empty_desired_state(7)
    ));
    assert!(!desired_state_is_stale(
        Some(&current),
        &empty_desired_state(8)
    ));
    assert!(!desired_state_is_stale(None, &empty_desired_state(1)));
}

#[test]
fn cache_refresh_wakes_for_initial_state_and_new_pins() {
    let current = empty_desired_state(1);
    assert!(required_cache_pins_changed(None, &current));

    let mut incoming = current.clone();
    incoming.version = 2;
    incoming.cached_images.push(digest('a'));
    assert!(required_cache_pins_changed(Some(&current), &incoming));

    let mut kino = current.clone();
    kino.version = 2;
    kino.kino_pin = Some(digest('b'));
    assert!(required_cache_pins_changed(Some(&current), &kino));
}

#[test]
fn cache_refresh_ignores_revision_pin_order_and_duplicates() {
    let first = desired_vm();
    let mut second = desired_vm();
    second.name = "worker".to_string();
    second.image = digest('d');
    second.kino = digest('e');

    let mut current = empty_desired_state(1);
    current.cached_images = vec![first.image.clone(), second.image.clone()];
    current.vms = vec![first.clone(), second.clone()];

    let mut incoming = current.clone();
    incoming.version = 2;
    incoming.cached_images.reverse();
    incoming.vms.reverse();
    incoming.cached_images.push(first.image);

    assert!(!required_cache_pins_changed(Some(&current), &incoming));
}

#[test]
fn cache_refresh_tracks_running_pins_and_ignores_stopped_ones() {
    let mut stopped = desired_vm();
    stopped.desired_phase = DesiredVmPhase::Absent;
    let mut current = empty_desired_state(1);
    current.vms = vec![stopped.clone()];

    let mut changed_stopped_pin = current.clone();
    changed_stopped_pin.version = 2;
    changed_stopped_pin.vms[0].image = digest('d');
    changed_stopped_pin.vms[0].kino = digest('e');
    assert!(!required_cache_pins_changed(
        Some(&current),
        &changed_stopped_pin
    ));

    let mut running = changed_stopped_pin.clone();
    running.version = 3;
    running.vms[0].desired_phase = DesiredVmPhase::Running;
    assert!(required_cache_pins_changed(Some(&current), &running));

    let mut stopped_again = running.clone();
    stopped_again.version = 4;
    stopped_again.vms[0].desired_phase = DesiredVmPhase::Absent;
    assert!(required_cache_pins_changed(Some(&running), &stopped_again));
}

#[test]
fn creating_vm_is_booting_only_after_runtime_constraints_exist() {
    assert_eq!(creating_vm_report_phase(false), VmPhaseV2::CreatingDisks);
    assert_eq!(creating_vm_report_phase(true), VmPhaseV2::Booting);
}

#[test]
fn desired_peers_are_the_named_running_vms_of_the_same_run() {
    let mut web = desired_vm();
    web.run_id = "run-pair".to_string();
    web.peers = vec![
        "db".to_string(),
        "cache".to_string(),
        "other".to_string(),
        "web".to_string(),
        "ghost".to_string(),
    ];

    let mut db = web.clone();
    db.name = "db".to_string();
    let mut absent = web.clone();
    absent.name = "cache".to_string();
    absent.desired_phase = DesiredVmPhase::Absent;
    let mut other_run = web.clone();
    other_run.run_id = "other-run".to_string();
    other_run.name = "other".to_string();

    let mut desired = empty_desired_state(1);
    desired.vms = vec![web.clone(), db, absent, other_run];

    assert_eq!(
        desired_peer_vm_names(&desired, &web),
        vec!["db".to_string()]
    );
}

fn lab_with_task_passed(passed_at_unix_ms: u64) -> VmLabV1 {
    VmLabV1 {
        state: LabState::Ready,
        kino_version: "kino 2".to_string(),
        ready: Vec::new(),
        tasks: vec![VmTaskV1 {
            id: "nginx".to_string(),
            status: CheckStatus::Pass,
            message: String::new(),
            passed_at_unix_ms: Some(passed_at_unix_ms),
        }],
        verify: None,
        timings_ms: BTreeMap::new(),
        failure: None,
    }
}

#[test]
fn a_vm_report_is_ready_only_with_its_forward_and_starts_cold() {
    let mut status = VmStatusResponse::test_status("web", Some("run-1"));
    status.state = VmLifecycleState::Running;
    if let Some(details) = status.details.as_mut() {
        details.image = Some(digest('a'));
        details.kino = Some(digest('b'));
    }
    let lab = ReportedLab {
        lab: lab_with_task_passed(7),
        first_report_ms: Some(1_234),
    };
    let report = build_vm_report_from_status(
        "host-1",
        None,
        None,
        status.clone(),
        Some(lab.clone()),
        None,
        None,
    );
    assert_eq!(report.schema_version, VM_REPORT_SCHEMA_VERSION);
    assert_eq!(report.vm.phase, VmPhaseV2::Running, "no forward, not ready");
    assert_eq!(
        report.vm.start,
        Some(VmStartV1 {
            path: VmStartPath::Cold,
            reason: None,
            first_report_ms: Some(1_234),
        })
    );
    assert_eq!(report.vm.lab, Some(lab.lab));
    assert_eq!(report.vm.image, Some(digest('a')));
    assert_eq!(report.vm.kino, Some(digest('b')));

    if let Some(details) = status.details.as_mut() {
        details.ssh_public_port = Some(22_001);
    }
    let ready = vm_state_from_status(None, None, status, None, None, None);
    assert_eq!(ready.phase, VmPhaseV2::Ready);
    assert_eq!(ready.lab, None);
    assert_eq!(ready.start.and_then(|start| start.first_report_ms), None);
    // The v9 schema itself refuses the v8 Solved phase.
    assert!(serde_json::from_str::<VmPhaseV2>("\"solved\"").is_err());
}

#[test]
fn a_persisted_lab_is_reported_only_when_it_parses() {
    let row = VmLabRow {
        vm_name: "web".to_string(),
        run_id: "run-1".to_string(),
        jail_generation: "generation-1".to_string(),
        lab_json: serde_json::to_string(&lab_with_task_passed(9)).expect("lab"),
        first_report_ms: Some(42),
        updated_at_ms: 1,
    };
    assert_eq!(
        ReportedLab::from_row(&row),
        Some(ReportedLab {
            lab: lab_with_task_passed(9),
            first_report_ms: Some(42),
        })
    );
    let broken = VmLabRow {
        lab_json: "{\"state\":\"ready\"}".to_string(),
        ..row
    };
    assert_eq!(ReportedLab::from_row(&broken), None);
}

#[test]
fn a_failed_reconcile_reports_the_desired_digests() {
    let desired = empty_desired_state(3);
    let report = failed_vm_report("host-1", &desired, &desired_vm(), 5, "boom".to_string());
    assert_eq!(report.vm.phase, VmPhaseV2::Failed);
    assert_eq!(report.vm.image, Some(digest('a')));
    assert_eq!(report.vm.desired_version, Some(3));
    assert_eq!(report.vm.terminal.state, VmTerminalStateKindV1::Failed);
    let raw = serde_json::to_string(&BridgeMessageV9::VmReport(VmReportV9 {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        host_id: "host-1".to_string(),
        report,
    }))
    .expect("serialize");
    assert!(parse_bridge_json(&raw).is_ok());
}

#[test]
fn expired_desired_lease_is_rejected() {
    let mut vm = desired_vm();
    vm.lease_expires_at_unix_ms = now_ms() - 1_000;
    assert!(desired_lease_duration_seconds(&vm, now_ms()).is_err());
}

fn test_bridge_config() -> BridgeConfig {
    BridgeConfig {
        host_id: "host-1".into(),
        owner_user_id: "user-1".into(),
        ..BridgeConfig::default()
    }
}

#[test]
fn desired_identity_is_mandatory_and_personal_owner_is_bound() {
    let cfg = test_bridge_config();
    let mut desired = empty_desired_state(1);
    desired.vms.push(desired_vm());
    validate_desired_state(&cfg, &desired).expect("valid fixture");
    for field in [
        "owner_user_id",
        "runtime_execution_id",
        "generation",
        "vm_id",
    ] {
        let mut value = serde_json::to_value(&desired).expect("valid fixture");
        value["vms"][0]
            .as_object_mut()
            .expect("fixture object")
            .remove(field);
        assert!(
            serde_json::from_value::<HostDesiredStateV3>(value).is_err(),
            "{field}"
        );
    }
    for field in ["scope", "owner_user_id"] {
        let mut value = serde_json::to_value(&desired).expect("valid fixture");
        value.as_object_mut().expect("fixture object").remove(field);
        assert!(
            serde_json::from_value::<HostDesiredStateV3>(value).is_err(),
            "{field}"
        );
    }
    let mut wrong = desired.clone();
    wrong.vms[0].owner_user_id = "another-user".into();
    assert!(validate_desired_state(&cfg, &wrong).is_err());
    wrong = desired.clone();
    wrong.vms[0].runtime_execution_id.clear();
    assert!(validate_desired_state(&cfg, &wrong).is_err());
    wrong = desired.clone();
    wrong.vms[0].generation = 0;
    assert!(validate_desired_state(&cfg, &wrong).is_err());
    wrong = desired.clone();
    wrong.vms.push(desired_vm());
    assert!(
        validate_desired_state(&cfg, &wrong).is_err(),
        "a VM name appears twice"
    );
    wrong = desired.clone();
    wrong.schema_version = 6;
    assert!(validate_desired_state(&cfg, &wrong).is_err());
    wrong = desired.clone();
    wrong.scope = intar_contracts::bridge::HostScope::Platform;
    assert!(validate_desired_state(&cfg, &wrong).is_err());
    wrong = desired;
    wrong.owner_user_id = "another-owner".into();
    assert!(validate_desired_state(&cfg, &wrong).is_err());
}

#[test]
fn platform_host_accepts_explicit_workload_owners_without_rebinding_host_owner() {
    let mut cfg = test_bridge_config();
    cfg.scope = intar_contracts::bridge::HostScope::Platform;
    let mut desired = empty_desired_state(1);
    desired.scope = cfg.scope;
    desired.vms.push(desired_vm());
    desired.vms[0].owner_user_id = "learner-2".into();
    validate_desired_state(&cfg, &desired).expect("valid fixture");
    desired.owner_user_id = "learner-2".into();
    assert!(validate_desired_state(&cfg, &desired).is_err());
}

#[test]
fn organization_host_accepts_members_without_rebinding_host_identity() {
    let mut cfg = test_bridge_config();
    cfg.scope = intar_contracts::bridge::HostScope::Organization;
    let mut desired = empty_desired_state(1);
    desired.scope = cfg.scope;
    desired.vms.push(desired_vm());
    desired.vms[0].owner_user_id = "learner-2".into();
    validate_desired_state(&cfg, &desired).expect("valid fixture");
    let value = serde_json::to_value(&desired).expect("serialize organization state");
    assert_eq!(value["scope"], "organization");
    let decoded: HostDesiredStateV3 = serde_json::from_value(value).expect("organization scope");
    validate_desired_state(&cfg, &decoded).expect("organization round trip");
    desired.scope = intar_contracts::bridge::HostScope::Platform;
    assert!(validate_desired_state(&cfg, &desired).is_err());
    desired.scope = cfg.scope;
    desired.owner_user_id = "learner-2".into();
    assert!(validate_desired_state(&cfg, &desired).is_err());
}

#[test]
fn execution_transition_rejects_regression_and_identity_reuse() {
    let mut current = empty_desired_state(4);
    current.vms.push(desired_vm());
    current.vms[0].generation = 2;
    let mut incoming = current.clone();
    incoming.version += 1;
    validate_desired_transition(Some(&current), &incoming).expect("valid fixture");
    incoming.vms[0].generation = 1;
    assert!(validate_desired_transition(Some(&current), &incoming).is_err());
    incoming.vms[0].generation = 2;
    incoming.vms[0].runtime_execution_id = "different".into();
    assert!(validate_desired_transition(Some(&current), &incoming).is_err());
    incoming.vms[0].generation = 3;
    validate_desired_transition(Some(&current), &incoming).expect("valid fixture");
    incoming.version = current.version;
    assert!(validate_desired_transition(Some(&current), &incoming).is_err());
}

#[test]
fn relay_credentials_are_bound_to_the_current_control_session() {
    use intar_contracts::{bridge::HostRelayCredentials, stargate::HostRelayIdentity};
    let cfg = test_bridge_config();
    let mut credentials = HostRelayCredentials {
        websocket_url: "wss://relay.example.test/host".into(),
        token: "secret".into(),
        gateway_host_key_openssh: "ssh-ed25519 key".into(),
        expires_at_unix_ms: now_ms() + 60_000,
        identity: HostRelayIdentity {
            host_id: cfg.host_id.clone(),
            session_id: "current".into(),
            credential_generation: cfg.credential_generation,
        },
    };
    validate_relay_identity(&cfg, "current", Some(&credentials)).expect("valid fixture");
    assert!(validate_relay_identity(&cfg, "replacement", Some(&credentials)).is_err());
    credentials.identity.credential_generation += 1;
    assert!(validate_relay_identity(&cfg, "current", Some(&credentials)).is_err());
}

#[tokio::test]
async fn access_refresh_failure_reaches_the_control_connection() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test service operation");
    let address = listener.local_addr().expect("test listener address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/api/agent/bootstrap",
                axum::routing::post(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE }),
            ),
        )
        .await
        .expect("valid fixture");
    });
    let mut cfg = test_bridge_config();
    cfg.base_url = format!("http://{address}");
    let result = refresh_agent_access(&cfg, &HttpClient::new()).await;
    server.abort();
    let error = result
        .err()
        .expect("refresh failure must exit the control loop");
    assert!(format!("{error:#}").contains("HTTP 503"));
}

#[tokio::test]
async fn access_refresh_timeout_reaches_the_control_connection() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test service operation");
    let address = listener.local_addr().expect("test listener address");
    let requested = std::sync::Arc::new(tokio::sync::Notify::new());
    let signal = requested.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/api/agent/bootstrap",
                axum::routing::post(move || {
                    let signal = signal.clone();
                    async move {
                        signal.notify_one();
                        std::future::pending::<axum::http::StatusCode>().await
                    }
                }),
            ),
        )
        .await
        .expect("valid fixture");
    });
    let mut cfg = test_bridge_config();
    cfg.base_url = format!("http://{address}");
    let refresh = tokio::spawn(async move { refresh_agent_access(&cfg, &HttpClient::new()).await });
    requested.notified().await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(RUN_CLI_ACCESS_REFRESH_TIMEOUT_SECS + 1)).await;
    let result = refresh.await.expect("refresh task");
    tokio::time::resume();
    server.abort();
    let error = result.err().expect("timeout must exit the control loop");
    assert!(error.to_string().contains("refresh timed out"));
}
