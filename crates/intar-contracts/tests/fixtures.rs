use intar_contracts::{
    bridge::{
        BridgeMessageV6, BuildReportV1, DesiredBuildV1, HostDesiredStateV2, HostStateReportV2,
        VmReportV2,
    },
    catalog::ScenarioManifestV3,
    stargate::{IssueTerminalSessionRequest, IssueTerminalSessionResponse},
};

#[test]
fn stargate_request_fixture_round_trips() {
    assert_round_trip::<IssueTerminalSessionRequest>(include_str!(
        "../fixtures/stargate/issue-terminal-session-request.json"
    ));
}

#[test]
fn stargate_response_fixture_round_trips() {
    assert_round_trip::<IssueTerminalSessionResponse>(include_str!(
        "../fixtures/stargate/issue-terminal-session-response.json"
    ));
}

#[test]
fn catalog_manifest_fixture_round_trips() {
    assert_round_trip::<ScenarioManifestV3>(include_str!(
        "../fixtures/catalog/scenario-manifest-v3.json"
    ));
}

#[test]
fn bridge_desired_state_fixture_round_trips() {
    assert_round_trip::<HostDesiredStateV2>(include_str!(
        "../fixtures/bridge/host-desired-state-v2.json"
    ));
}

#[test]
fn bridge_state_report_fixture_round_trips() {
    assert_round_trip::<HostStateReportV2>(include_str!(
        "../fixtures/bridge/host-state-report-v2.json"
    ));
}

#[test]
fn bridge_vm_report_fixture_round_trips() {
    assert_round_trip::<VmReportV2>(include_str!("../fixtures/bridge/vm-report-v2.json"));
}

#[test]
fn bridge_desired_build_fixture_round_trips() {
    assert_round_trip::<DesiredBuildV1>(include_str!("../fixtures/bridge/desired-build-v1.json"));
}

#[test]
fn bridge_build_report_fixture_round_trips() {
    assert_round_trip::<BuildReportV1>(include_str!("../fixtures/bridge/build-report-v1.json"));
}

#[test]
fn bridge_message_fixture_round_trips() {
    assert_round_trip::<BridgeMessageV6>(include_str!("../fixtures/bridge/sync-request-v6.json"));
}

#[test]
fn catalog_v3_rejects_v2_cpu_field() {
    let value = serde_json::json!({
        "schema_version": 2,
        "scenario_id": "legacy",
        "name": "legacy",
        "title": "Legacy",
        "category": "test",
        "description": "Legacy manifest",
        "difficulty": "easy",
        "estimated_minutes": 1,
        "tags": [],
        "briefing_markdown": "Legacy",
        "solution_markdown": "Legacy",
        "hints": [],
        "vms": [{
            "name": "vm",
            "image_key": { "scenario": "legacy", "vm": "vm", "arch": "x86_64" },
            "image_sha256": "a",
            "image_format": "raw_zstd",
            "image_virtual_size_bytes": 1,
            "boot": { "kernel_sha256": "b", "initrd_sha256": "c", "cmdline": "" },
            "cpu_count": 1,
            "memory_mib": 1,
            "disk_mib": 1,
            "probes": []
        }]
    });

    assert!(serde_json::from_value::<ScenarioManifestV3>(value).is_err());
}

#[test]
fn desired_state_v2_rejects_v1_cpu_field() {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "../fixtures/bridge/host-desired-state-v2.json"
    ))
    .expect("fixture json");
    let resources = &mut value["vms"][0]["resources"];
    resources["cpu_count"] = serde_json::json!(1);
    resources
        .as_object_mut()
        .expect("resources object")
        .remove("cpu_millis");
    resources
        .as_object_mut()
        .expect("resources object")
        .remove("vcpu_count");

    assert!(serde_json::from_value::<HostDesiredStateV2>(value).is_err());
}

fn assert_round_trip<T>(raw: &str)
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let expected: serde_json::Value = serde_json::from_str(raw).expect("fixture json");
    let decoded: T = serde_json::from_value(expected.clone()).expect("fixture should decode");
    let actual = serde_json::to_value(decoded).expect("fixture should encode");
    assert_eq!(actual, expected);
}
