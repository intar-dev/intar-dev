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
        "name": "demo",
        "run_id": "abc123demo",
        "image": "broken-nginx-webserver-amd64",
        "image_sha256": "a".repeat(64),
        "runtime": {
            "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"],
            "network": {
                "guest_ip_cidr": "10.200.0.44/24",
                "gateway": "10.200.0.1",
                "dns": ["1.1.1.1", "8.8.8.8"]
            },
            "kino": {
                "vsock_cid": 10044,
                "vsock_port": 19090
            }
        },
        "lease_duration_seconds": 300
    }))
    .expect("request should parse");

    assert_eq!(req.lease_duration_seconds, Some(300));
    assert_eq!(req.image_sha256, "a".repeat(64));
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
            .vsock_port,
        Some(19090)
    );
}

#[test]
fn create_scenario_vm_request_rejects_missing_runtime() {
    let err = serde_json::from_value::<CreateScenarioVmRequest>(json!({
        "name": "demo",
        "run_id": "abc123demo",
        "image": "broken-nginx-webserver-amd64",
        "image_sha256": "a".repeat(64)
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
        "name": "demo",
        "run_id": "abc123demo",
        "image": "broken-nginx-webserver-amd64",
        "runtime": {
            "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"]
        }
    }))
    .expect_err("the v2 launch descriptor digest must be explicit");
    assert!(error.to_string().contains("image_sha256"));
}

#[test]
fn create_scenario_vm_request_rejects_unknown_field() {
    let err = serde_json::from_value::<CreateScenarioVmRequest>(json!({
        "name": "demo",
        "run_id": "abc123demo",
        "image": "broken-nginx-webserver-amd64",
        "image_sha256": "a".repeat(64),
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
        "name": "demo",
        "run_id": "abc123demo",
        "image": "broken-nginx-webserver-amd64",
        "image_sha256": "a".repeat(64),
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
    details.ssh_public_port = Some(2222);
    details.jail_generation = Some("generation-1".to_string());
    details.cpu_runtime = Some(VmCpuRuntimeState {
        phase: VmCpuPhase::Steady,
        steady_quota: quota,
        effective_quota: quota,
        boot_deadline_unix_ms: None,
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
            .map(|constraints| constraints.phase.clone()),
        Some(VmRuntimeConstraintPhaseV1::Steady)
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
        phase: VmCpuPhase::Steady,
        steady_quota: quota,
        effective_quota: quota,
        boot_deadline_unix_ms: None,
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
