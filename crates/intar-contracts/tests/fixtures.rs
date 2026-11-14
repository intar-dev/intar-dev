use intar_contracts::{
    catalog::CourseCatalogSnapshotV2,
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
fn course_catalog_v2_fixture_round_trips() {
    assert_round_trip::<CourseCatalogSnapshotV2>(include_str!(
        "../fixtures/catalog/course-catalog-v2.json"
    ));
}

#[test]
fn source_refusal_fixture_round_trips() {
    assert_round_trip::<SourceRefusalV1>(include_str!("../fixtures/source/source-refusal-v1.json"));
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
