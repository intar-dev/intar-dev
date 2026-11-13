use super::*;

#[test]
fn lease_expiry_error_log_state_is_throttled_per_vm_signature() {
    let (log_first, state_first) = next_lease_expiry_error_log_state(None, "err-a", 100);
    assert!(log_first);
    assert_eq!(
        state_first,
        LeaseExpiryErrorLogState {
            signature: "err-a".to_string(),
            last_logged_at_s: 100,
        }
    );

    let (log_second, state_second) =
        next_lease_expiry_error_log_state(Some(&state_first), "err-a", 110);
    assert!(!log_second);
    assert_eq!(state_second, state_first);

    let (log_third, state_third) =
        next_lease_expiry_error_log_state(Some(&state_first), "err-a", 161);
    assert!(log_third);
    assert_eq!(
        state_third,
        LeaseExpiryErrorLogState {
            signature: "err-a".to_string(),
            last_logged_at_s: 161,
        }
    );

    let (log_changed, state_changed) =
        next_lease_expiry_error_log_state(Some(&state_first), "err-b", 111);
    assert!(log_changed);
    assert_eq!(
        state_changed,
        LeaseExpiryErrorLogState {
            signature: "err-b".to_string(),
            last_logged_at_s: 111,
        }
    );
}

#[test]
fn create_scenario_vm_request_accepts_runtime() {
    let req: CreateScenarioVmRequest = serde_json::from_value(json!({
        "owner_user_id": "user-1",
        "runtime_execution_id": "execution-1",
        "generation": 1,
        "name": "demo",
        "run_id": "abc123demo",
        "image": format!("sha256:{}", "a".repeat(64)),
        "kino": format!("sha256:{}", "b".repeat(64)),
        "spec": format!("sha256:{}", "c".repeat(64)),
        "mode": "learn",
        "egress": false,
        "terminal": true,
        "runtime": {
            "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"],
            "network": {
                "guest_ip_cidr": "10.200.0.44/24",
                "gateway": "10.200.0.1",
                "dns": ["1.1.1.1", "8.8.8.8"]
            },
            "kino": {
                "vsock_cid": 10044
            }
        },
        "lease_duration_seconds": 300
    }))
    .expect("request should parse");

    assert_eq!(req.lease_duration_seconds, Some(300));
    assert_eq!(req.image.hex(), "a".repeat(64));
    assert_eq!(req.mode, SpecMode::Learn);
    assert!(req.terminal && !req.egress);
    assert!(req.runtime.peer_vm_names.is_empty());
    assert!(req.runtime.peer_vm_aliases.is_empty());
    assert_eq!(
        req.runtime.ssh_authorized_keys_openssh,
        vec!["ssh-ed25519 AAAATEST stargate-target".to_string()]
    );
    assert_eq!(
        req.runtime
            .network
            .as_ref()
            .expect("network override should parse")
            .guest_ip_cidr,
        "10.200.0.44/24"
    );
    assert_eq!(
        req.runtime
            .kino
            .as_ref()
            .expect("kino override should parse")
            .vsock_cid,
        10044
    );
}

#[test]
fn create_scenario_vm_request_rejects_missing_runtime() {
    let err = serde_json::from_value::<CreateScenarioVmRequest>(json!({
        "owner_user_id": "user-1",
        "runtime_execution_id": "execution-1",
        "generation": 1,
        "name": "demo",
        "run_id": "abc123demo",
        "image": format!("sha256:{}", "a".repeat(64)),
        "kino": format!("sha256:{}", "b".repeat(64)),
        "spec": format!("sha256:{}", "c".repeat(64)),
        "mode": "learn",
        "egress": false,
        "terminal": true
    }))
    .expect_err("missing runtime field should be rejected");

    let msg = err.to_string();
    assert!(
        msg.contains("missing field `runtime`"),
        "unexpected serde error: {msg}"
    );
}

#[test]
fn create_scenario_vm_request_rejects_missing_image_digest() {
    let error = serde_json::from_value::<CreateScenarioVmRequest>(json!({
        "owner_user_id": "user-1",
        "runtime_execution_id": "execution-1",
        "generation": 1,
        "name": "demo",
        "run_id": "abc123demo",
        "image": "broken-nginx-webserver-amd64",
        "kino": format!("sha256:{}", "b".repeat(64)),
        "spec": format!("sha256:{}", "c".repeat(64)),
        "mode": "learn",
        "egress": false,
        "terminal": true,
        "runtime": {
            "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"]
        }
    }))
    .expect_err("an image is named by its manifest digest");
    assert!(error.to_string().contains("sha256"), "{error}");
}

#[test]
fn create_scenario_vm_request_rejects_unknown_field() {
    let err = serde_json::from_value::<CreateScenarioVmRequest>(json!({
        "owner_user_id": "user-1",
        "runtime_execution_id": "execution-1",
        "generation": 1,
        "name": "demo",
        "run_id": "abc123demo",
        "image": format!("sha256:{}", "a".repeat(64)),
        "kino": format!("sha256:{}", "b".repeat(64)),
        "spec": format!("sha256:{}", "c".repeat(64)),
        "mode": "learn",
        "egress": false,
        "terminal": true,
        "runtime": {
            "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"]
        },
        "unknown_field": 300
    }))
    .expect_err("unknown field should be rejected");

    let msg = err.to_string();
    assert!(
        msg.contains("unknown field `unknown_field`"),
        "unexpected serde error: {msg}"
    );
}

#[test]
fn create_scenario_vm_request_rejects_legacy_network_field() {
    let err = serde_json::from_value::<CreateScenarioVmRequest>(json!({
        "owner_user_id": "user-1",
        "runtime_execution_id": "execution-1",
        "generation": 1,
        "name": "demo",
        "run_id": "abc123demo",
        "image": format!("sha256:{}", "a".repeat(64)),
        "kino": format!("sha256:{}", "b".repeat(64)),
        "spec": format!("sha256:{}", "c".repeat(64)),
        "mode": "learn",
        "egress": false,
        "terminal": true,
        "runtime": {
            "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"]
        },
        "network": {
            "guest_ip_cidr": "10.0.0.2/24",
            "gateway": "10.0.0.1",
            "dns": ["1.1.1.1"]
        }
    }))
    .expect_err("legacy network field should be rejected");

    let msg = err.to_string();
    assert!(
        msg.contains("unknown field `network`"),
        "unexpected serde error: {msg}"
    );
}

#[test]
fn parse_default_route_interface_extracts_device_from_default_route() {
    let raw = "default via 51.159.109.1 dev ens3 proto dhcp src 51.159.109.212 metric 100";
    let iface = parse_default_route_interface(raw);
    assert_eq!(iface.as_deref(), Some("ens3"));
}

#[test]
fn parse_default_route_interface_extracts_device_from_route_get() {
    let raw = "1.1.1.1 via 10.200.0.1 dev br0 src 10.200.0.10 uid 0\n    cache";
    let iface = parse_default_route_interface(raw);
    assert_eq!(iface.as_deref(), Some("br0"));
}

#[test]
fn terminal_state_reports_ready_when_running_and_ssh_is_ready() {
    let mut vm = test_vm_status("vm-ready", Some("run-1"));
    vm.state = VmLifecycleState::Running;
    let quota = CpuQuota::from_millis(125).expect("quota");
    let details = vm.details.as_mut().expect("details");
    details.cpu_millis = Some(125);
    details.ssh_public_port = Some(2222);
    details.jail_generation = Some("generation-1".to_string());
    details.cpu_runtime = Some(VmCpuRuntimeState {
        quota,
        attestation: Some(CpuQuotaAttestation {
            quota,
            cpu_max: quota.cpu_max(),
            cpu_max_burst: 0,
            verified_at_unix_ms: 1_200,
        }),
    });

    let state =
        terminal_state_from_vm(&vm, &test_ssh_access_config(), true, 1234).expect("terminal state");

    assert_eq!(state.run_id, "run-1");
    assert_eq!(state.vm_name, "vm-ready");
    assert_eq!(state.state, VmTerminalStateKind::Ready);
    assert_eq!(state.reason, None);
    assert_eq!(
        state
            .runtime_constraints
            .as_ref()
            .map(|constraints| constraints.cpu_millis),
        Some(125)
    );
    assert_eq!(
        state.terminal_target,
        Some(VmTerminalTarget {
            host: Some("bridge.example.test".to_string()),
            port: 2222,
            username: "ubuntu".to_string(),
            checked_at: 1234,
        })
    );
    assert!(terminal_state_matches_inventory(
        &state,
        Some("run-1"),
        Some("generation-1")
    ));
    assert!(!terminal_state_matches_inventory(
        &state,
        Some("run-1"),
        Some("generation-2")
    ));
    assert!(!terminal_state_matches_inventory(
        &state,
        Some("run-replaced"),
        Some("generation-1")
    ));
    assert!(!terminal_state_matches_inventory(
        &state,
        Some("run-1"),
        None
    ));
}

#[test]
fn recovered_running_vm_stays_pending_without_fresh_terminal_event() {
    let mut vm = test_vm_status("vm-recovered", Some("run-1"));
    vm.state = VmLifecycleState::Running;
    let quota = CpuQuota::from_millis(1_000).expect("quota");
    let details = vm.details.as_mut().expect("details");
    details.ssh_public_port = Some(2222);
    details.jail_generation = Some("generation-1".to_string());
    details.cpu_runtime = Some(VmCpuRuntimeState {
        quota,
        attestation: Some(CpuQuotaAttestation {
            quota,
            cpu_max: quota.cpu_max(),
            cpu_max_burst: 0,
            verified_at_unix_ms: 1_200,
        }),
    });

    // committed_terminal_state deliberately takes this no-probe path when
    // the process-local generation cache is empty after restart.
    let state = terminal_state_from_vm(&vm, &test_ssh_access_config(), false, 1234)
        .expect("terminal state");

    assert_eq!(state.state, VmTerminalStateKind::Pending);
    assert_eq!(state.terminal_target, None);
    assert!(state.runtime_constraints.is_some());
}

#[test]
fn terminal_state_reports_destroying_pending_when_vm_is_deleting() {
    let mut vm = test_vm_status("vm-deleting", Some("run-1"));
    vm.state = VmLifecycleState::DeletingVm;
    vm.details.as_mut().expect("details").ssh_public_port = Some(2222);

    let state =
        terminal_state_from_vm(&vm, &test_ssh_access_config(), true, 1234).expect("terminal state");

    assert_eq!(state.state, VmTerminalStateKind::Pending);
    assert_eq!(state.reason.as_deref(), Some("destroying"));
    assert_eq!(state.terminal_target, None);
}

#[test]
fn terminal_state_stays_pending_without_steady_quota_attestation() {
    let mut vm = test_vm_status("vm-unsealed", Some("run-1"));
    vm.state = VmLifecycleState::Running;
    vm.details.as_mut().expect("details").ssh_public_port = Some(2222);

    let state =
        terminal_state_from_vm(&vm, &test_ssh_access_config(), true, 1234).expect("terminal state");

    assert_eq!(state.state, VmTerminalStateKind::Pending);
    assert_eq!(state.terminal_target, None);
    assert_eq!(state.runtime_constraints, None);
}

#[test]
fn terminal_state_reports_failed_with_vm_error() {
    let mut vm = test_vm_status("vm-failed", Some("run-1"));
    vm.state = VmLifecycleState::Failed;
    vm.error = Some("boot failed".to_string());

    let state = terminal_state_from_vm(&vm, &test_ssh_access_config(), false, 1234)
        .expect("terminal state");

    assert_eq!(state.state, VmTerminalStateKind::Failed);
    assert_eq!(state.reason.as_deref(), Some("boot failed"));
    assert_eq!(state.terminal_target, None);
}

#[test]
fn a_foreground_prepare_keeps_the_fixed_budget() {
    // A foreground import resolves from a ready descriptor before this path,
    // so the fixed budget stays whatever the size is.
    for bytes in [0, 4 << 30, 64 << 30] {
        assert_eq!(
            jailer_prepare_timeout(RequestClass::Foreground, bytes, None),
            JAILER_PREPARE_IMAGE_TIMEOUT
        );
    }
}

#[test]
fn a_background_prepare_budget_covers_the_rate_limited_import() {
    // The rate limit is the point of the background class: the import is
    // allowed to be slow, so the client budget must cover the physical
    // minimum. A fixed budget would abandon work that jailerd keeps running.
    let biggest = intar_contracts::catalog::MAX_CHUNKED_IMAGE_BYTES;
    let timeout = jailer_prepare_timeout(RequestClass::Background, biggest, None);
    let physical_minimum =
        Duration::from_secs(biggest.div_ceil(BACKGROUND_PREPARE_BYTES_PER_SECOND));
    assert!(
        timeout > JAILER_PREPARE_IMAGE_TIMEOUT,
        "the largest image needs more than the fixed budget: {timeout:?}"
    );
    assert!(
        timeout > physical_minimum,
        "the budget must exceed the rate-limited minimum {physical_minimum:?}"
    );
}

#[test]
fn a_small_background_prepare_keeps_the_foreground_budget() {
    // A catalog-sized image inside the fixed budget is unchanged.
    let four_gib = 4 * 1024 * 1024 * 1024;
    assert_eq!(
        jailer_prepare_timeout(RequestClass::Background, four_gib, None),
        JAILER_PREPARE_IMAGE_TIMEOUT
    );
    // The crossover is exactly where the rate-limited import meets the fixed
    // budget: below it the fixed budget still wins.
    let crossover = JAILER_PREPARE_IMAGE_TIMEOUT
        .as_secs()
        .saturating_sub(JAILER_BACKGROUND_PREPARE_MARGIN_SECONDS)
        .saturating_mul(BACKGROUND_PREPARE_BYTES_PER_SECOND)
        / 2;
    assert_eq!(
        jailer_prepare_timeout(RequestClass::Background, crossover, None),
        JAILER_PREPARE_IMAGE_TIMEOUT
    );
    assert!(
        jailer_prepare_timeout(RequestClass::Background, crossover + 1, None)
            > JAILER_PREPARE_IMAGE_TIMEOUT
    );
}

#[test]
fn the_background_prepare_budget_grows_with_the_image() {
    let mut previous = Duration::ZERO;
    for gib in 1..=64 {
        let timeout = jailer_prepare_timeout(RequestClass::Background, gib << 30, None);
        assert!(timeout >= previous, "the budget must not shrink with size");
        assert!(timeout >= JAILER_PREPARE_IMAGE_TIMEOUT);
        previous = timeout;
    }
}

#[test]
fn the_background_budget_is_bounded_by_the_contract_maximum() {
    // The derivation is a bound, not an open wait: the size is clamped to the
    // contract maximum, so an unvalidated field cannot hold the socket open.
    let over = jailer_prepare_timeout(RequestClass::Background, u64::MAX, None);
    let derived = Duration::from_secs(
        intar_contracts::catalog::MAX_CHUNKED_IMAGE_BYTES
            .div_ceil(BACKGROUND_PREPARE_BYTES_PER_SECOND)
            .saturating_mul(2)
            .saturating_add(JAILER_BACKGROUND_PREPARE_MARGIN_SECONDS),
    );
    assert_eq!(over, derived.max(JAILER_PREPARE_IMAGE_TIMEOUT));
}

#[test]
fn an_old_vm_is_found_by_its_generation_else_by_run_and_name() {
    let row = |run_id: Option<&str>, generation: Option<&str>| crate::db::PendingTeardownRow {
        vm_name: "web".to_string(),
        run_id: run_id.map(str::to_string),
        jail_generation: generation.map(str::to_string),
    };
    let by_generation = previous_schema_jail_selector(&row(Some("run-1"), Some("gen-1")))
        .expect("valid ids")
        .expect("a selector");
    assert_eq!(
        by_generation.generation.map(|g| g.to_string()),
        Some("gen-1".to_string())
    );
    let by_name = previous_schema_jail_selector(&row(Some("run-1"), None))
        .expect("valid ids")
        .expect("a selector");
    assert_eq!(
        by_name.run_id.map(|id| id.to_string()),
        Some("run-1".to_string())
    );
    assert_eq!(
        by_name.vm_id.map(|id| id.to_string()),
        Some("web".to_string())
    );
    assert!(
        previous_schema_jail_selector(&row(None, None))
            .expect("no ids")
            .is_none()
    );
}

#[test]
fn an_old_run_stays_queued_until_its_network_is_gone() {
    let row = |vm: &str, run_id: Option<&str>| crate::db::PendingTeardownRow {
        vm_name: vm.to_string(),
        run_id: run_id.map(str::to_string),
        jail_generation: None,
    };
    let outcomes = vec![
        (row("a1", Some("run-a")), true),
        (row("a2", Some("run-a")), true),
        (row("b1", Some("run-b")), true),
        (row("b2", Some("run-b")), false),
        (row("loose", None), true),
    ];
    assert_eq!(
        previous_schema_runs_to_release(&outcomes),
        vec!["run-a".to_string()]
    );
    // run-a's network destroy failed: its rows stay queued for the next start.
    assert_eq!(
        previous_schema_teardowns_done(&outcomes, &BTreeSet::new()),
        vec!["loose".to_string()]
    );
    assert_eq!(
        previous_schema_teardowns_done(&outcomes, &BTreeSet::from(["run-a".to_string()])),
        vec!["a1".to_string(), "a2".to_string(), "loose".to_string()]
    );
}

#[test]
fn a_wake_prepare_budget_adds_its_ram_delta_and_apply() {
    let rate = BACKGROUND_PREPARE_BYTES_PER_SECOND;
    let (disk, wake) = (8_u64 << 30, (16_u64 << 30) + (1 << 30));
    let expected = (disk + wake).div_ceil(rate) * 2
        + JAILER_BACKGROUND_PREPARE_MARGIN_SECONDS
        + intar_jailer_protocol::WAKE_APPLY_TIMEOUT_SECONDS;
    assert_eq!(
        jailer_prepare_timeout(RequestClass::Background, disk, Some(wake)),
        Duration::from_secs(expected)
    );
    // A small wake still gets the apply's limit on top.
    assert_eq!(
        jailer_prepare_timeout(RequestClass::Background, 0, Some(0)),
        Duration::from_secs(
            JAILER_BACKGROUND_PREPARE_MARGIN_SECONDS
                + intar_jailer_protocol::WAKE_APPLY_TIMEOUT_SECONDS
        )
        .max(JAILER_PREPARE_IMAGE_TIMEOUT)
    );
    // The wake bytes are clamped as the disk is.
    let max = intar_contracts::catalog::MAX_CHUNKED_IMAGE_BYTES;
    assert_eq!(
        jailer_prepare_timeout(RequestClass::Background, disk, Some(u64::MAX)),
        jailer_prepare_timeout(
            RequestClass::Background,
            disk,
            Some(max + image_cache::MAX_WAKE_DELTA_BYTES)
        )
    );
    assert_eq!(
        jailer_prepare_timeout(RequestClass::Foreground, disk, Some(wake)),
        JAILER_PREPARE_IMAGE_TIMEOUT
    );
}
