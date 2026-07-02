use intar_contracts::{
    bridge::{BridgeMessageV4, HostDesiredStateV1, HostStateReportV1, VmReportV1},
    catalog::ScenarioManifestV1,
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
    assert_round_trip::<ScenarioManifestV1>(include_str!(
        "../fixtures/catalog/scenario-manifest-v1.json"
    ));
}

#[test]
fn bridge_desired_state_fixture_round_trips() {
    assert_round_trip::<HostDesiredStateV1>(include_str!(
        "../fixtures/bridge/host-desired-state-v1.json"
    ));
}

#[test]
fn bridge_state_report_fixture_round_trips() {
    assert_round_trip::<HostStateReportV1>(include_str!(
        "../fixtures/bridge/host-state-report-v1.json"
    ));
}

#[test]
fn bridge_vm_report_fixture_round_trips() {
    assert_round_trip::<VmReportV1>(include_str!("../fixtures/bridge/vm-report-v1.json"));
}

#[test]
fn bridge_message_fixture_round_trips() {
    assert_round_trip::<BridgeMessageV4>(include_str!("../fixtures/bridge/sync-request-v4.json"));
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
