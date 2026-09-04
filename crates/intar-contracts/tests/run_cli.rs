use intar_contracts::{
    bridge::HostStateReportV2,
    run_cli::{
        RUN_CLI_FRAME_HEADER_BYTES, RUN_CLI_MAX_COMPLETION_ALIASES, RUN_CLI_MAX_HINT_ALIAS_BYTES,
        RUN_CLI_MAX_PROBE_ID_BYTES, RUN_CLI_MAX_PROBE_IDS, RUN_CLI_MAX_REQUEST_ID_BYTES,
        RUN_CLI_MAX_RETRY_SCOPE_BYTES, RunCliFrameError, RunCliProbeCheckEventKindV1,
        RunCliProbeCheckEventV1, RunCliProbeCheckRequestV1, RunCliProbeCheckResultV1,
        RunCliProbeCheckStreamError, RunCliProbeCheckStreamValidatorV1, RunCliRequestV1,
        RunCliResponseV1, RunCliResultV1, RunCliValidationError, decode_run_cli_frame,
        encode_run_cli_frame, run_cli_frame_payload_len,
    },
};

#[test]
fn run_cli_request_fixture_round_trips() {
    let request: RunCliRequestV1 = fixture("request-v1.json");
    request.validate().expect("fixture request is valid");
    assert_fixture_round_trip(&request, "request-v1.json");
}

#[test]
fn run_cli_completion_is_bounded_alias_only_and_action_matched() {
    let request = RunCliRequestV1 {
        protocol_version: 1,
        request_id: "completion-01".to_owned(),
        action: intar_contracts::run_cli::RunCliActionV1::Completion,
    };
    request.validate().expect("completion request is valid");
    assert_eq!(
        serde_json::to_value(&request).expect("completion request JSON"),
        serde_json::json!({
            "protocol_version": 1,
            "request_id": "completion-01",
            "action": { "kind": "completion" },
        })
    );

    let response = RunCliResponseV1 {
        protocol_version: 1,
        request_id: "completion-01".to_owned(),
        result: RunCliResultV1::Completion {
            aliases: vec!["check-3".to_owned(), "general".to_owned()],
        },
    };
    response.validate().expect("completion response is valid");
    response
        .validate_for_action(&request.action)
        .expect("completion result matches completion action");
    let response_json = serde_json::to_value(&response).expect("completion response JSON");
    assert_eq!(
        response_json,
        serde_json::json!({
            "protocol_version": 1,
            "request_id": "completion-01",
            "result": {
                "kind": "completion",
                "aliases": ["check-3", "general"],
            },
        })
    );
    assert!(response_json["result"].get("view").is_none());
    assert!(response_json["result"].get("solution").is_none());

    let mut unsorted = response.clone();
    let RunCliResultV1::Completion { aliases } = &mut unsorted.result else {
        panic!("completion response result");
    };
    *aliases = vec!["general".to_owned(), "check-3".to_owned()];
    assert_eq!(
        unsorted.validate(),
        Err(RunCliValidationError::CompletionAliasesNotSortedUnique { index: 1 })
    );

    let mut duplicate = response.clone();
    let RunCliResultV1::Completion { aliases } = &mut duplicate.result else {
        panic!("completion response result");
    };
    *aliases = vec!["general".to_owned(), "general".to_owned()];
    assert_eq!(
        duplicate.validate(),
        Err(RunCliValidationError::CompletionAliasesNotSortedUnique { index: 1 })
    );

    let mut unsafe_alias = response.clone();
    let RunCliResultV1::Completion { aliases } = &mut unsafe_alias.result else {
        panic!("completion response result");
    };
    *aliases = vec!["private_id".to_owned()];
    assert_eq!(
        unsafe_alias.validate(),
        Err(RunCliValidationError::InvalidCompletionAlias { index: 0 })
    );

    let mut excessive = response.clone();
    let RunCliResultV1::Completion { aliases } = &mut excessive.result else {
        panic!("completion response result");
    };
    *aliases = (0..=RUN_CLI_MAX_COMPLETION_ALIASES)
        .map(|index| format!("hint-{index}"))
        .collect();
    assert_eq!(
        excessive.validate(),
        Err(RunCliValidationError::TooManyCompletionAliases {
            maximum: RUN_CLI_MAX_COMPLETION_ALIASES,
        })
    );

    let full_view: RunCliResponseV1 = fixture("response-v1.json");
    assert_eq!(
        full_view.validate_for_action(&request.action),
        Err(RunCliValidationError::UnexpectedResultForAction)
    );
    assert_eq!(
        response.validate_for_action(&intar_contracts::run_cli::RunCliActionV1::Status),
        Err(RunCliValidationError::UnexpectedResultForAction)
    );
}

#[test]
fn run_cli_response_fixture_round_trips_without_sealed_content() {
    let response: RunCliResponseV1 = fixture("response-v1.json");
    response.validate().expect("fixture response is valid");
    assert_fixture_round_trip(&response, "response-v1.json");

    let value: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/run-cli/response-v1.json"))
            .expect("fixture JSON");
    let ready_entry = &value["result"]["view"]["hint_groups"][0]["entries"][1];
    assert!(ready_entry.get("title").is_none());
    assert!(ready_entry.get("body_markdown").is_none());
    assert!(
        value["result"]["view"]["solution"]
            .get("body_markdown")
            .is_none()
    );

    let mut invalid_scope = value.clone();
    invalid_scope["result"]["view"]["retry_scope"] = serde_json::json!("bad\nscope");
    let invalid_scope: RunCliResponseV1 =
        serde_json::from_value(invalid_scope).expect("response still decodes");
    assert_eq!(
        invalid_scope.validate(),
        Err(RunCliValidationError::InvalidRetryScope)
    );

    let mut missing_scope = value.clone();
    missing_scope["result"]["view"]
        .as_object_mut()
        .expect("view object")
        .remove("retry_scope");
    assert!(serde_json::from_value::<RunCliResponseV1>(missing_scope).is_err());

    let mut oversized_scope = value.clone();
    oversized_scope["result"]["view"]["retry_scope"] =
        serde_json::json!("x".repeat(RUN_CLI_MAX_RETRY_SCOPE_BYTES + 1));
    let oversized_scope: RunCliResponseV1 =
        serde_json::from_value(oversized_scope).expect("response still decodes");
    assert_eq!(
        oversized_scope.validate(),
        Err(RunCliValidationError::RetryScopeTooLong {
            maximum: RUN_CLI_MAX_RETRY_SCOPE_BYTES,
        })
    );

    let mut oversized_check_alias = value.clone();
    oversized_check_alias["result"]["view"]["checks"][0]["alias"] =
        serde_json::json!("x".repeat(RUN_CLI_MAX_HINT_ALIAS_BYTES + 1));
    let oversized_check_alias: RunCliResponseV1 =
        serde_json::from_value(oversized_check_alias).expect("response still decodes");
    assert_eq!(
        oversized_check_alias.validate(),
        Err(RunCliValidationError::HintAliasTooLong {
            maximum: RUN_CLI_MAX_HINT_ALIAS_BYTES,
        })
    );

    let mut oversized_hint_group_alias = value.clone();
    oversized_hint_group_alias["result"]["view"]["hint_groups"][0]["alias"] =
        serde_json::json!("x".repeat(RUN_CLI_MAX_HINT_ALIAS_BYTES + 1));
    let oversized_hint_group_alias: RunCliResponseV1 =
        serde_json::from_value(oversized_hint_group_alias).expect("response still decodes");
    assert_eq!(
        oversized_hint_group_alias.validate(),
        Err(RunCliValidationError::HintAliasTooLong {
            maximum: RUN_CLI_MAX_HINT_ALIAS_BYTES,
        })
    );

    let mut hidden_hint = value.clone();
    hidden_hint["result"]["view"]["hint_groups"][0]["entries"][1]["title"] =
        serde_json::json!("This must remain sealed");
    let hidden_hint: RunCliResponseV1 =
        serde_json::from_value(hidden_hint).expect("response still decodes");
    assert_eq!(
        hidden_hint.validate(),
        Err(RunCliValidationError::InvalidView)
    );

    let mut sealed_solution = value;
    sealed_solution["result"]["view"]["solution"]["body_markdown"] =
        serde_json::json!("This must remain sealed");
    let sealed_solution: RunCliResponseV1 =
        serde_json::from_value(sealed_solution).expect("response still decodes");
    assert_eq!(
        sealed_solution.validate(),
        Err(RunCliValidationError::InvalidView)
    );
}

#[test]
fn run_cli_probe_check_request_fixture_round_trips() {
    let request: RunCliProbeCheckRequestV1 = fixture("probe-check-request-v1.json");
    request.validate().expect("fixture request is valid");
    assert_fixture_round_trip(&request, "probe-check-request-v1.json");
}

#[test]
fn run_cli_probe_check_events_are_bounded_and_terminal() {
    let request: RunCliProbeCheckRequestV1 = fixture("probe-check-request-v1.json");
    let first: RunCliProbeCheckEventV1 = fixture("probe-check-event-v1.json");
    let complete: RunCliProbeCheckEventV1 = fixture("probe-check-complete-v1.json");
    first.validate().expect("probe event is valid");
    complete.validate().expect("complete event is valid");
    assert_fixture_round_trip(&first, "probe-check-event-v1.json");
    assert_fixture_round_trip(&complete, "probe-check-complete-v1.json");

    let mut stream =
        RunCliProbeCheckStreamValidatorV1::new(&request).expect("request starts a valid stream");
    stream.observe(&first).expect("first result accepted");
    stream
        .observe(&RunCliProbeCheckEventV1 {
            protocol_version: 1,
            request_id: "request-02".to_owned(),
            event: RunCliProbeCheckEventKindV1::Probe {
                check: RunCliProbeCheckResultV1 {
                    probe_id: "nginx-http".to_owned(),
                    status: intar_contracts::run_cli::RunCliCheckStatusV1::Fail,
                    duration_ms: 28,
                },
            },
        })
        .expect("second result accepted");
    stream.observe(&complete).expect("terminal count matches");
    assert!(stream.is_complete());
    stream.finish().expect("stream completed");
    assert!(matches!(
        stream.observe(&first),
        Err(RunCliProbeCheckStreamError::EventAfterComplete)
    ));
}

#[test]
fn run_cli_probe_check_stream_rejects_duplicate_unknown_and_mismatched_events() {
    let request: RunCliProbeCheckRequestV1 = fixture("probe-check-request-v1.json");
    let first: RunCliProbeCheckEventV1 = fixture("probe-check-event-v1.json");

    let mut duplicate = RunCliProbeCheckStreamValidatorV1::new(&request).expect("valid request");
    duplicate.observe(&first).expect("first result accepted");
    assert!(matches!(
        duplicate.observe(&first),
        Err(RunCliProbeCheckStreamError::DuplicateProbeResult)
    ));

    let mut unknown = RunCliProbeCheckStreamValidatorV1::new(&request).expect("valid request");
    let unknown_event = RunCliProbeCheckEventV1 {
        protocol_version: 1,
        request_id: "request-02".to_owned(),
        event: RunCliProbeCheckEventKindV1::Probe {
            check: RunCliProbeCheckResultV1 {
                probe_id: "not-requested".to_owned(),
                status: intar_contracts::run_cli::RunCliCheckStatusV1::Unknown,
                duration_ms: 1,
            },
        },
    };
    assert!(matches!(
        unknown.observe(&unknown_event),
        Err(RunCliProbeCheckStreamError::UnknownProbeResult)
    ));

    let mut mismatched_request =
        RunCliProbeCheckStreamValidatorV1::new(&request).expect("valid request");
    let wrong_request_event = RunCliProbeCheckEventV1 {
        protocol_version: 1,
        request_id: "other-request".to_owned(),
        event: RunCliProbeCheckEventKindV1::Probe {
            check: RunCliProbeCheckResultV1 {
                probe_id: "nginx-config".to_owned(),
                status: intar_contracts::run_cli::RunCliCheckStatusV1::Pass,
                duration_ms: 1,
            },
        },
    };
    assert!(matches!(
        mismatched_request.observe(&wrong_request_event),
        Err(RunCliProbeCheckStreamError::RequestIdMismatch)
    ));

    let mut incomplete = RunCliProbeCheckStreamValidatorV1::new(&request).expect("valid request");
    incomplete.observe(&first).expect("first result accepted");
    let wrong_complete = RunCliProbeCheckEventV1 {
        protocol_version: 1,
        request_id: "request-02".to_owned(),
        event: RunCliProbeCheckEventKindV1::Complete { completed_count: 1 },
    };
    assert!(matches!(
        incomplete.observe(&wrong_complete),
        Err(RunCliProbeCheckStreamError::CompletedCountMismatch {
            expected: 2,
            observed: 1,
            declared: 1,
        })
    ));
    assert!(matches!(
        incomplete.finish(),
        Err(RunCliProbeCheckStreamError::MissingComplete)
    ));
}

#[test]
fn run_cli_request_rejects_unknown_fields() {
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/run-cli/request-v1.json"))
            .expect("fixture JSON");
    value["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<RunCliRequestV1>(value).is_err());

    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/run-cli/request-v1.json"))
            .expect("fixture JSON");
    value["action"]["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<RunCliRequestV1>(value).is_err());

    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/run-cli/request-v1.json"))
            .expect("fixture JSON");
    value["action"]
        .as_object_mut()
        .expect("action object")
        .remove("expected_ordinal");
    assert!(serde_json::from_value::<RunCliRequestV1>(value).is_err());
}

#[test]
fn run_cli_validation_bounds_untrusted_inputs() {
    let request = RunCliRequestV1 {
        protocol_version: 1,
        request_id: "x".repeat(RUN_CLI_MAX_REQUEST_ID_BYTES + 1),
        action: intar_contracts::run_cli::RunCliActionV1::Status,
    };
    assert_eq!(
        request.validate(),
        Err(RunCliValidationError::RequestIdTooLong {
            maximum: RUN_CLI_MAX_REQUEST_ID_BYTES,
        })
    );

    let request = RunCliRequestV1 {
        protocol_version: 1,
        request_id: "request-03".to_owned(),
        action: intar_contracts::run_cli::RunCliActionV1::HintReveal {
            alias: "x".repeat(RUN_CLI_MAX_HINT_ALIAS_BYTES + 1),
            expected_ordinal: 1,
        },
    };
    assert_eq!(
        request.validate(),
        Err(RunCliValidationError::HintAliasTooLong {
            maximum: RUN_CLI_MAX_HINT_ALIAS_BYTES,
        })
    );

    let request = RunCliRequestV1 {
        protocol_version: 1,
        request_id: "bad request\nidentifier".to_owned(),
        action: intar_contracts::run_cli::RunCliActionV1::Status,
    };
    assert_eq!(
        request.validate(),
        Err(RunCliValidationError::InvalidRequestId)
    );

    let request = RunCliRequestV1 {
        protocol_version: 1,
        request_id: "request-06".to_owned(),
        action: intar_contracts::run_cli::RunCliActionV1::HintReveal {
            alias: "check_1".to_owned(),
            expected_ordinal: 1,
        },
    };
    assert_eq!(
        request.validate(),
        Err(RunCliValidationError::InvalidHintAlias)
    );

    let request = RunCliRequestV1 {
        protocol_version: 1,
        request_id: "request-ordinal".to_owned(),
        action: intar_contracts::run_cli::RunCliActionV1::HintReveal {
            alias: "check-1".to_owned(),
            expected_ordinal: 0,
        },
    };
    assert_eq!(
        request.validate(),
        Err(RunCliValidationError::InvalidExpectedHintOrdinal)
    );

    let request = RunCliProbeCheckRequestV1 {
        protocol_version: 1,
        request_id: "request-04".to_owned(),
        probe_ids: vec!["probe".to_owned(); RUN_CLI_MAX_PROBE_IDS + 1],
    };
    assert_eq!(
        request.validate(),
        Err(RunCliValidationError::TooManyProbeIds {
            maximum: RUN_CLI_MAX_PROBE_IDS,
        })
    );

    let request = RunCliProbeCheckRequestV1 {
        protocol_version: 1,
        request_id: "request-05".to_owned(),
        probe_ids: vec!["x".repeat(RUN_CLI_MAX_PROBE_ID_BYTES + 1)],
    };
    assert_eq!(
        request.validate(),
        Err(RunCliValidationError::ProbeIdTooLong {
            index: 0,
            maximum: RUN_CLI_MAX_PROBE_ID_BYTES,
        })
    );

    let request = RunCliProbeCheckRequestV1 {
        protocol_version: 1,
        request_id: "request-07".to_owned(),
        probe_ids: vec!["probe\nname".to_owned()],
    };
    assert_eq!(
        request.validate(),
        Err(RunCliValidationError::InvalidProbeId { index: 0 })
    );

    for invalid_probe_id in ["probe name", "probe\0name", ".", ".."] {
        let request = RunCliProbeCheckRequestV1 {
            protocol_version: 1,
            request_id: "request-08".to_owned(),
            probe_ids: vec![invalid_probe_id.to_owned()],
        };
        assert_eq!(
            request.validate(),
            Err(RunCliValidationError::InvalidProbeId { index: 0 }),
            "probe id {invalid_probe_id:?} must be rejected"
        );
    }

    let request = RunCliProbeCheckRequestV1 {
        protocol_version: 1,
        request_id: "request-duplicate".to_owned(),
        probe_ids: vec!["probe-a".to_owned(), "probe-a".to_owned()],
    };
    assert_eq!(
        request.validate(),
        Err(RunCliValidationError::DuplicateProbeId { index: 1 })
    );

    let event = RunCliProbeCheckEventV1 {
        protocol_version: 1,
        request_id: "request-zero-complete".to_owned(),
        event: RunCliProbeCheckEventKindV1::Complete { completed_count: 0 },
    };
    assert_eq!(
        event.validate(),
        Err(RunCliValidationError::InvalidCompletedProbeCount)
    );
}

#[test]
fn run_cli_frame_round_trips_and_rejects_invalid_lengths() {
    let request: RunCliRequestV1 = fixture("request-v1.json");
    let frame = encode_run_cli_frame(&request).expect("encode request frame");
    let prefix: [u8; RUN_CLI_FRAME_HEADER_BYTES] = frame[..RUN_CLI_FRAME_HEADER_BYTES]
        .try_into()
        .expect("frame prefix");
    assert_eq!(
        run_cli_frame_payload_len(prefix).expect("valid frame length"),
        frame.len() - RUN_CLI_FRAME_HEADER_BYTES
    );
    let decoded: RunCliRequestV1 = decode_run_cli_frame(&frame).expect("decode request frame");
    assert_eq!(decoded, request);

    assert!(matches!(
        decode_run_cli_frame::<RunCliRequestV1>(&[0, 0, 0]),
        Err(RunCliFrameError::InvalidFrameLength {
            expected: RUN_CLI_FRAME_HEADER_BYTES,
            received: 3,
        })
    ));
    assert!(matches!(
        run_cli_frame_payload_len(u32::MAX.to_be_bytes()),
        Err(RunCliFrameError::PayloadTooLarge { .. })
    ));
}

#[test]
fn missing_run_cli_capability_defaults_to_false_for_old_agents() {
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/bridge/host-state-report-v2.json"))
            .expect("fixture JSON");
    value["capabilities"]
        .as_object_mut()
        .expect("capabilities object")
        .remove("supports_run_cli_v1");

    let report: HostStateReportV2 =
        serde_json::from_value(value).expect("old bridge report still parses");
    assert!(!report.capabilities.supports_run_cli_v1);
}

fn fixture<T>(name: &str) -> T
where
    T: serde::de::DeserializeOwned,
{
    let source = match name {
        "request-v1.json" => include_str!("../fixtures/run-cli/request-v1.json"),
        "response-v1.json" => include_str!("../fixtures/run-cli/response-v1.json"),
        "probe-check-request-v1.json" => {
            include_str!("../fixtures/run-cli/probe-check-request-v1.json")
        }
        "probe-check-event-v1.json" => {
            include_str!("../fixtures/run-cli/probe-check-event-v1.json")
        }
        "probe-check-complete-v1.json" => {
            include_str!("../fixtures/run-cli/probe-check-complete-v1.json")
        }
        _ => panic!("unknown run CLI fixture {name}"),
    };
    serde_json::from_str(source).expect("fixture should decode")
}

fn assert_fixture_round_trip<T>(decoded: &T, name: &str)
where
    T: SerializeFixture,
{
    let expected: serde_json::Value = match name {
        "request-v1.json" => {
            serde_json::from_str(include_str!("../fixtures/run-cli/request-v1.json"))
        }
        "response-v1.json" => {
            serde_json::from_str(include_str!("../fixtures/run-cli/response-v1.json"))
        }
        "probe-check-request-v1.json" => serde_json::from_str(include_str!(
            "../fixtures/run-cli/probe-check-request-v1.json"
        )),
        "probe-check-event-v1.json" => serde_json::from_str(include_str!(
            "../fixtures/run-cli/probe-check-event-v1.json"
        )),
        "probe-check-complete-v1.json" => serde_json::from_str(include_str!(
            "../fixtures/run-cli/probe-check-complete-v1.json"
        )),
        _ => panic!("unknown run CLI fixture {name}"),
    }
    .expect("fixture JSON");
    let actual = decoded.to_value().expect("fixture should encode");
    assert_eq!(actual, expected);
}

trait SerializeFixture {
    fn to_value(&self) -> Result<serde_json::Value, serde_json::Error>;
}

impl<T> SerializeFixture for T
where
    T: serde::Serialize,
{
    fn to_value(&self) -> Result<serde_json::Value, serde_json::Error> {
        serde_json::to_value(self)
    }
}
