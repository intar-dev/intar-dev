use intar_contracts::{
    bridge::{
        BridgeMessageV8, BuildReportV1, DesiredBuildV1, DesiredSourceCompileV1, HostDesiredStateV2,
        HostStateReportV2, VmReportV2,
    },
    catalog::{CourseCatalogSnapshotV2, ScenarioManifestV5},
    source::SourceRefusalV1,
    stargate::{
        ActivateTerminalTargetRequest, IssueTerminalSessionRequest, IssueTerminalSessionResponse,
        IssueWorkspaceAppSessionRequest, IssueWorkspaceAppSessionResponse, RunMirrorRequest,
        SHARE_ID_LEN, SHARE_WRITE_TOKEN_LEN, ShareIngestMessage, StageTerminalTargetRequest,
        StageTerminalTargetResponse, validate_share_secret,
    },
};

#[test]
fn stargate_request_fixture_round_trips() {
    assert_round_trip::<IssueTerminalSessionRequest>(include_str!(
        "../fixtures/stargate/issue-terminal-session-request.json"
    ));
}

#[test]
fn stargate_stage_request_fixture_round_trips() {
    assert_round_trip::<StageTerminalTargetRequest>(include_str!(
        "../fixtures/stargate/stage-terminal-target-request.json"
    ));
}

#[test]
fn stargate_stage_response_fixture_round_trips() {
    assert_round_trip::<StageTerminalTargetResponse>(include_str!(
        "../fixtures/stargate/stage-terminal-target-response.json"
    ));
}

#[test]
fn stargate_activate_request_fixture_round_trips() {
    assert_round_trip::<ActivateTerminalTargetRequest>(include_str!(
        "../fixtures/stargate/activate-terminal-target-request.json"
    ));
}

#[test]
fn stargate_run_mirror_request_fixture_round_trips() {
    let raw = include_str!("../fixtures/stargate/run-mirror-request.json");
    assert_round_trip::<RunMirrorRequest>(raw);
    let request: RunMirrorRequest = serde_json::from_str(raw).expect("fixture should decode");
    assert!(validate_share_secret(&request.share_id, SHARE_ID_LEN).is_ok());
    assert!(validate_share_secret(&request.write_token, SHARE_WRITE_TOKEN_LEN).is_ok());
}

#[test]
fn stargate_share_ingest_fixtures_round_trip() {
    assert_round_trip::<ShareIngestMessage>(include_str!(
        "../fixtures/stargate/share-ingest-start.json"
    ));
    assert_round_trip::<ShareIngestMessage>(include_str!(
        "../fixtures/stargate/share-ingest-events.json"
    ));
}

/// The ingest socket carries terminal output only; an input event or an
/// unknown field is a protocol error.
#[test]
fn stargate_share_ingest_rejects_input_events_and_unknown_fields() {
    let input = serde_json::json!({ "type": "events", "events": [[0, "i", "secret"]] });
    assert!(serde_json::from_value::<ShareIngestMessage>(input).is_err());
    let extra = serde_json::json!({ "type": "gap", "bytes": 1, "data": "x" });
    assert!(serde_json::from_value::<ShareIngestMessage>(extra).is_err());
}

#[test]
fn share_secrets_must_be_exact_base64url() {
    assert!(validate_share_secret("Zm9vYmFyYmF6cXV4cXV1eA", SHARE_ID_LEN).is_ok());
    assert!(validate_share_secret("Zm9vYmFyYmF6cXV4cXV1e", SHARE_ID_LEN).is_err());
    assert!(validate_share_secret("Zm9vYmFyYmF6cXV4cXV1e=", SHARE_ID_LEN).is_err());
    assert!(validate_share_secret("Zm9vYmFyYmF6cXV4cXV1/A", SHARE_ID_LEN).is_err());
}

/// A stage call carries ready data only. A pending shape on that call is a
/// protocol error, and this test holds the fixture to that rule.
#[test]
fn stargate_stage_request_rejects_a_pending_shape() {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "../fixtures/stargate/stage-terminal-target-request.json"
    ))
    .expect("fixture json");
    value["target"] = serde_json::json!({ "state": "pending" });

    assert!(serde_json::from_value::<StageTerminalTargetRequest>(value).is_err());
}

#[test]
fn stargate_response_fixture_round_trips() {
    assert_round_trip::<IssueTerminalSessionResponse>(include_str!(
        "../fixtures/stargate/issue-terminal-session-response.json"
    ));
}

#[test]
fn stargate_workspace_app_request_fixture_round_trips() {
    assert_round_trip::<IssueWorkspaceAppSessionRequest>(include_str!(
        "../fixtures/stargate/issue-workspace-app-session-request.json"
    ));
}

#[test]
fn stargate_workspace_app_response_fixture_round_trips() {
    assert_round_trip::<IssueWorkspaceAppSessionResponse>(include_str!(
        "../fixtures/stargate/issue-workspace-app-session-response.json"
    ));
}

#[test]
fn catalog_manifest_fixture_round_trips() {
    assert_round_trip::<ScenarioManifestV5>(include_str!(
        "../fixtures/catalog/scenario-manifest-v5.json"
    ));
}

#[test]
fn course_catalog_v2_fixture_round_trips() {
    assert_round_trip::<CourseCatalogSnapshotV2>(include_str!(
        "../fixtures/catalog/course-catalog-v2.json"
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
fn old_host_reports_default_run_cli_completion_to_false() {
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/bridge/host-state-report-v2.json"))
            .expect("fixture json");
    value["capabilities"]
        .as_object_mut()
        .expect("capabilities object")
        .remove("supports_run_cli_completion_v1");

    let report: HostStateReportV2 = serde_json::from_value(value).expect("legacy report");
    assert!(!report.capabilities.supports_run_cli_completion_v1);
}

/// Hosts and desired states from before source compiles keep their exact
/// shape: the new fields default on read and stay absent on write.
#[test]
fn documents_without_source_fields_keep_their_shape() {
    let report: HostStateReportV2 =
        serde_json::from_str(include_str!("../fixtures/bridge/host-state-report-v2.json"))
            .expect("report fixture");
    assert_eq!(report.capabilities.source_compile_platform, None);
    let capabilities = serde_json::to_value(&report.capabilities).expect("capabilities");
    assert!(capabilities.get("source_compile_platform").is_none());

    let desired: HostDesiredStateV2 = serde_json::from_str(include_str!(
        "../fixtures/bridge/host-desired-state-v2.json"
    ))
    .expect("desired state fixture");
    assert!(desired.source_compiles.is_empty());
    let desired = serde_json::to_value(&desired).expect("desired state");
    assert!(desired.get("source_compiles").is_none());
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
fn bridge_desired_source_compile_fixture_round_trips() {
    assert_round_trip::<DesiredSourceCompileV1>(include_str!(
        "../fixtures/bridge/desired-source-compile-v1.json"
    ));
}

#[test]
fn source_refusal_fixture_round_trips() {
    assert_round_trip::<SourceRefusalV1>(include_str!("../fixtures/source/source-refusal-v1.json"));
}

#[test]
fn bridge_build_report_fixture_round_trips() {
    assert_round_trip::<BuildReportV1>(include_str!("../fixtures/bridge/build-report-v1.json"));
}

#[test]
fn bridge_message_fixture_round_trips() {
    assert_round_trip::<BridgeMessageV8>(include_str!("../fixtures/bridge/sync-request-v8.json"));
}

#[test]
fn catalog_v4_rejects_legacy_whole_image_fields() {
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

    assert!(serde_json::from_value::<ScenarioManifestV5>(value).is_err());
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
