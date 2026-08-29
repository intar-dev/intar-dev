//! Versioned, private contracts for the learner-facing `intar` run CLI.
//!
//! These values cross only the guest-to-broker boundary. They deliberately
//! contain the safe projection required to render the CLI: never raw probe
//! values, command output, host identity, credentials, or sealed content.

use std::{collections::BTreeSet, error::Error, fmt};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

/// Version of the private broker and local Kino control protocol.
pub const RUN_CLI_PROTOCOL_VERSION: u16 = 1;
/// Version carried by the generated JSON schemas and TypeScript declarations.
pub const RUN_CLI_SCHEMA_VERSION: u16 = 1;
/// Number of bytes in a length-prefixed frame header.
pub const RUN_CLI_FRAME_HEADER_BYTES: usize = 4;
/// Largest accepted JSON payload in a private broker or Kino frame.
pub const RUN_CLI_MAX_FRAME_BYTES: usize = 256 * 1024;
/// Maximum opaque request identifier length.
pub const RUN_CLI_MAX_REQUEST_ID_BYTES: usize = 128;
/// Maximum opaque retry-scope token length.
pub const RUN_CLI_MAX_RETRY_SCOPE_BYTES: usize = 128;
/// Maximum public hint-alias length.
pub const RUN_CLI_MAX_HINT_ALIAS_BYTES: usize = 128;
/// Maximum number of probes that one local Kino check may select.
pub const RUN_CLI_MAX_PROBE_IDS: usize = 128;
/// Maximum internal probe identifier length.
pub const RUN_CLI_MAX_PROBE_ID_BYTES: usize = 128;

/// A request from the learner CLI to its generation-fenced broker.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliRequestV1 {
    #[schemars(range(min = 1, max = 1))]
    pub protocol_version: u16,
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._-]+$"))]
    pub request_id: String,
    pub action: RunCliActionV1,
}

impl RunCliRequestV1 {
    /// Check inexpensive, transport-bound limits before dispatching a request.
    pub fn validate(&self) -> Result<(), RunCliValidationError> {
        validate_protocol_version(self.protocol_version)?;
        validate_request_id(&self.request_id)?;
        if let RunCliActionV1::HintReveal {
            alias,
            expected_ordinal,
        } = &self.action
        {
            validate_hint_alias(alias)?;
            validate_expected_hint_ordinal(*expected_ordinal)?;
        }
        Ok(())
    }
}

/// One command-only learner action. A hint reveal names one immutable ladder
/// position, so retrying an interrupted reveal cannot advance to the next
/// hint. `check_sync` publishes the result of an already-completed local Kino
/// check; it does not request a new check itself.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunCliActionV1 {
    Status,
    Hints,
    HintReveal {
        #[schemars(
            length(min = 1, max = 128),
            regex(pattern = "^[a-z0-9][a-z0-9-]{0,127}$")
        )]
        alias: String,
        #[schemars(range(min = 1))]
        expected_ordinal: u16,
    },
    Solution,
    SolutionReveal,
    CheckSync,
}

/// A response from the broker. The `request_id` lets a client match a complete
/// response without treating a retried state-changing action as a new action.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliResponseV1 {
    #[schemars(range(min = 1, max = 1))]
    pub protocol_version: u16,
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._-]+$"))]
    pub request_id: String,
    pub result: RunCliResultV1,
}

impl RunCliResponseV1 {
    /// Check the common response envelope limits before rendering it.
    pub fn validate(&self) -> Result<(), RunCliValidationError> {
        validate_protocol_version(self.protocol_version)?;
        validate_request_id(&self.request_id)?;
        if let RunCliResultV1::Ok { view } = &self.result {
            view.validate()?;
        }
        Ok(())
    }
}

/// The broker either returns one safe full view or one safe structured error.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunCliResultV1 {
    Ok { view: RunCliViewV1 },
    Error { error: RunCliErrorV1 },
}

/// The full, safe learner projection used by every successful CLI command.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliViewV1 {
    /// Opaque, generation-fenced retry scope for local pending hint state. It
    /// is not a learner-facing identifier, display value, or credential.
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9_-]+$"))]
    pub retry_scope: String,
    pub run: RunCliRunV1,
    pub checks: Vec<RunCliCheckV1>,
    pub hint_groups: Vec<RunCliHintGroupV1>,
    pub solution: RunCliSolutionV1,
}

impl RunCliViewV1 {
    /// Reject an inconsistent safe projection before it reaches a learner VM.
    /// In particular, sealed hint and solution text is never merely hidden by
    /// the renderer: it is forbidden on this wire contract.
    pub fn validate(&self) -> Result<(), RunCliValidationError> {
        validate_retry_scope(&self.retry_scope)?;
        for (index, check) in self.checks.iter().enumerate() {
            validate_probe_id(&check.probe_id, index)?;
            if !is_run_cli_alias(&check.alias) {
                return Err(RunCliValidationError::InvalidView);
            }
        }

        for group in &self.hint_groups {
            if !is_run_cli_alias(&group.alias)
                || usize::from(group.total_count) != group.entries.len()
            {
                return Err(RunCliValidationError::InvalidView);
            }

            let mut revealed_count = 0_u16;
            let mut can_reveal = false;
            for (index, entry) in group.entries.iter().enumerate() {
                let expected_ordinal =
                    u16::try_from(index + 1).map_err(|_| RunCliValidationError::InvalidView)?;
                if entry.ordinal != expected_ordinal {
                    return Err(RunCliValidationError::InvalidView);
                }
                match entry.state {
                    RunCliHintStateV1::Revealed => {
                        revealed_count = revealed_count
                            .checked_add(1)
                            .ok_or(RunCliValidationError::InvalidView)?;
                    }
                    RunCliHintStateV1::Ready => can_reveal = true,
                    RunCliHintStateV1::Locked => {}
                }
                if entry.state != RunCliHintStateV1::Revealed
                    && (entry.title.is_some() || entry.body_markdown.is_some())
                {
                    return Err(RunCliValidationError::InvalidView);
                }
            }
            if group.revealed_count != revealed_count || group.can_reveal != can_reveal {
                return Err(RunCliValidationError::InvalidView);
            }
        }

        if self.solution.state != RunCliSolutionStateV1::Revealed
            && self.solution.body_markdown.is_some()
        {
            return Err(RunCliValidationError::InvalidView);
        }
        Ok(())
    }
}

/// Public context needed for a concise CLI header. `context` is a safe display
/// label (for example a VM or released workshop module), never an identifier.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliRunV1 {
    pub kind: RunCliRunKindV1,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunCliRunKindV1 {
    Scenario,
    Workshop,
}

/// A safe check projection. `probe_id` is an internal broker selector and must
/// never be rendered by the learner CLI; `alias` and `label` are the public
/// values used for CLI text and completion.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliCheckV1 {
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._-]+$"))]
    pub probe_id: String,
    pub alias: String,
    pub label: String,
    pub status: RunCliCheckStatusV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunCliCheckStatusV1 {
    Pass,
    Fail,
    Unknown,
}

/// One public hint ladder. `alias` is only a safe public target, and callers
/// must use `can_reveal` to offer dynamic completion candidates.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliHintGroupV1 {
    pub alias: String,
    pub label: String,
    pub revealed_count: u16,
    pub total_count: u16,
    pub can_reveal: bool,
    pub entries: Vec<RunCliHintEntryV1>,
}

/// A hint entry. `title` and `body_markdown` are omitted until that exact hint
/// has been revealed; hidden entries must never populate either field.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliHintEntryV1 {
    #[schemars(range(min = 1))]
    pub ordinal: u16,
    pub state: RunCliHintStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_markdown: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunCliHintStateV1 {
    Revealed,
    Ready,
    Locked,
}

/// Full-solution state. `sealed` is the scenario state that may be explicitly
/// revealed; `unavailable` is used for a workshop solution not released by a
/// facilitator. Only `revealed` may contain `body_markdown`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliSolutionV1 {
    pub state: RunCliSolutionStateV1,
    pub assisted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_markdown: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunCliSolutionStateV1 {
    Sealed,
    Revealed,
    Unavailable,
}

/// A safe, structured broker failure. `message` is already a learner-safe
/// explanation; implementers must not put broker, host, probe, or secret data
/// into it.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliErrorV1 {
    pub code: RunCliErrorCodeV1,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunCliErrorCodeV1 {
    InvalidRequest,
    Locked,
    Unavailable,
    Conflict,
    Unauthorized,
    ProtocolMismatch,
    FrameTooLarge,
    Internal,
}

/// A local request from the `intar` CLI to Kino. The broker decides the safe
/// internal probe identifiers; the learner CLI never prints them.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliProbeCheckRequestV1 {
    #[schemars(range(min = 1, max = 1))]
    pub protocol_version: u16,
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._-]+$"))]
    pub request_id: String,
    #[schemars(
        length(min = 1, max = 128),
        inner(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._-]+$"))
    )]
    pub probe_ids: Vec<String>,
}

impl RunCliProbeCheckRequestV1 {
    /// Check local Kino request limits before it is queued for execution.
    pub fn validate(&self) -> Result<(), RunCliValidationError> {
        validate_protocol_version(self.protocol_version)?;
        validate_request_id(&self.request_id)?;
        validate_probe_ids(&self.probe_ids)
    }
}

/// One aggregate local Kino response. It contains no raw probe value,
/// command, output, or error text; new fresh-check callers should use
/// [`RunCliProbeCheckEventV1`] to stream real per-probe completions instead.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliProbeCheckResponseV1 {
    #[schemars(range(min = 1, max = 1))]
    pub protocol_version: u16,
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._-]+$"))]
    pub request_id: String,
    #[schemars(length(max = 128))]
    pub checks: Vec<RunCliProbeCheckResultV1>,
}

/// One event in a bounded local Kino probe-check stream. Every event carries
/// the request envelope so a client can reject cross-request or stale frames.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliProbeCheckEventV1 {
    #[schemars(range(min = 1, max = 1))]
    pub protocol_version: u16,
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._-]+$"))]
    pub request_id: String,
    pub event: RunCliProbeCheckEventKindV1,
}

impl RunCliProbeCheckEventV1 {
    /// Validate one event before it is accepted by a stream client.
    pub fn validate(&self) -> Result<(), RunCliValidationError> {
        validate_protocol_version(self.protocol_version)?;
        validate_request_id(&self.request_id)?;
        match &self.event {
            RunCliProbeCheckEventKindV1::Probe { check } => validate_probe_id(&check.probe_id, 0),
            RunCliProbeCheckEventKindV1::Complete { completed_count } => {
                if *completed_count == 0 || usize::from(*completed_count) > RUN_CLI_MAX_PROBE_IDS {
                    Err(RunCliValidationError::InvalidCompletedProbeCount)
                } else {
                    Ok(())
                }
            }
        }
    }
}

/// A local Kino check produces exactly one `complete` event after every
/// requested probe has emitted one `probe` completion event.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunCliProbeCheckEventKindV1 {
    Probe {
        check: RunCliProbeCheckResultV1,
    },
    Complete {
        #[schemars(range(min = 1, max = 128))]
        completed_count: u16,
    },
}

/// Incrementally validates a local Kino probe-check stream against its
/// request. It intentionally holds no probe values or diagnostics.
#[derive(Clone, Debug)]
pub struct RunCliProbeCheckStreamValidatorV1 {
    request_id: String,
    expected_probe_ids: BTreeSet<String>,
    observed_probe_ids: BTreeSet<String>,
    complete: bool,
}

impl RunCliProbeCheckStreamValidatorV1 {
    /// Start validation for the exact selected probe set.
    pub fn new(request: &RunCliProbeCheckRequestV1) -> Result<Self, RunCliProbeCheckStreamError> {
        request
            .validate()
            .map_err(RunCliProbeCheckStreamError::InvalidRequest)?;
        Ok(Self {
            request_id: request.request_id.clone(),
            expected_probe_ids: request.probe_ids.iter().cloned().collect(),
            observed_probe_ids: BTreeSet::new(),
            complete: false,
        })
    }

    /// Accept one event. A probe result is valid only once and only for an ID
    /// selected in the original request; the terminal count must match both
    /// the selected and observed counts.
    pub fn observe(
        &mut self,
        event: &RunCliProbeCheckEventV1,
    ) -> Result<(), RunCliProbeCheckStreamError> {
        event
            .validate()
            .map_err(RunCliProbeCheckStreamError::InvalidEvent)?;
        if self.complete {
            return Err(RunCliProbeCheckStreamError::EventAfterComplete);
        }
        if event.request_id != self.request_id {
            return Err(RunCliProbeCheckStreamError::RequestIdMismatch);
        }
        match &event.event {
            RunCliProbeCheckEventKindV1::Probe { check } => {
                if !self.expected_probe_ids.contains(&check.probe_id) {
                    return Err(RunCliProbeCheckStreamError::UnknownProbeResult);
                }
                if !self.observed_probe_ids.insert(check.probe_id.clone()) {
                    return Err(RunCliProbeCheckStreamError::DuplicateProbeResult);
                }
            }
            RunCliProbeCheckEventKindV1::Complete { completed_count } => {
                let expected_count = self.expected_probe_ids.len();
                let observed_count = self.observed_probe_ids.len();
                if usize::from(*completed_count) != expected_count
                    || observed_count != expected_count
                {
                    return Err(RunCliProbeCheckStreamError::CompletedCountMismatch {
                        expected: expected_count,
                        observed: observed_count,
                        declared: usize::from(*completed_count),
                    });
                }
                self.complete = true;
            }
        }
        Ok(())
    }

    /// Confirm that one terminal completion event was observed.
    pub fn finish(&self) -> Result<(), RunCliProbeCheckStreamError> {
        if self.complete {
            Ok(())
        } else {
            Err(RunCliProbeCheckStreamError::MissingComplete)
        }
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }
}

/// A local Kino stream was malformed, stale, or incomplete. Variants do not
/// contain probe IDs, preserving the no-raw-probe-data transport boundary.
#[derive(Debug)]
pub enum RunCliProbeCheckStreamError {
    InvalidRequest(RunCliValidationError),
    InvalidEvent(RunCliValidationError),
    RequestIdMismatch,
    UnknownProbeResult,
    DuplicateProbeResult,
    CompletedCountMismatch {
        expected: usize,
        observed: usize,
        declared: usize,
    },
    EventAfterComplete,
    MissingComplete,
}

impl fmt::Display for RunCliProbeCheckStreamError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(_) => {
                formatter.write_str("run CLI probe-check request is invalid")
            }
            Self::InvalidEvent(_) => formatter.write_str("run CLI probe-check event is invalid"),
            Self::RequestIdMismatch => {
                formatter.write_str("run CLI probe-check event request ID does not match")
            }
            Self::UnknownProbeResult => {
                formatter.write_str("run CLI probe-check event returned an unknown probe")
            }
            Self::DuplicateProbeResult => {
                formatter.write_str("run CLI probe-check event repeated a probe")
            }
            Self::CompletedCountMismatch { .. } => {
                formatter.write_str("run CLI probe-check completion count does not match")
            }
            Self::EventAfterComplete => {
                formatter.write_str("run CLI probe-check event followed completion")
            }
            Self::MissingComplete => {
                formatter.write_str("run CLI probe-check stream ended before completion")
            }
        }
    }
}

impl Error for RunCliProbeCheckStreamError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidRequest(error) | Self::InvalidEvent(error) => Some(error),
            Self::RequestIdMismatch
            | Self::UnknownProbeResult
            | Self::DuplicateProbeResult
            | Self::CompletedCountMismatch { .. }
            | Self::EventAfterComplete
            | Self::MissingComplete => None,
        }
    }
}

impl RunCliProbeCheckResponseV1 {
    /// Check the response envelope and internal result identifiers.
    pub fn validate(&self) -> Result<(), RunCliValidationError> {
        validate_protocol_version(self.protocol_version)?;
        validate_request_id(&self.request_id)?;
        if self.checks.len() > RUN_CLI_MAX_PROBE_IDS {
            return Err(RunCliValidationError::TooManyProbeIds {
                maximum: RUN_CLI_MAX_PROBE_IDS,
            });
        }
        for (index, check) in self.checks.iter().enumerate() {
            validate_probe_id(&check.probe_id, index)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunCliProbeCheckResultV1 {
    #[schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._-]+$"))]
    pub probe_id: String,
    pub status: RunCliCheckStatusV1,
    pub duration_ms: u64,
}

/// Validation failure for untrusted private-broker inputs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunCliValidationError {
    UnsupportedProtocolVersion { expected: u16, received: u16 },
    EmptyRequestId,
    InvalidRequestId,
    RequestIdTooLong { maximum: usize },
    EmptyRetryScope,
    InvalidRetryScope,
    RetryScopeTooLong { maximum: usize },
    EmptyHintAlias,
    InvalidHintAlias,
    HintAliasTooLong { maximum: usize },
    InvalidExpectedHintOrdinal,
    EmptyProbeIds,
    TooManyProbeIds { maximum: usize },
    EmptyProbeId { index: usize },
    InvalidProbeId { index: usize },
    ProbeIdTooLong { index: usize, maximum: usize },
    DuplicateProbeId { index: usize },
    InvalidCompletedProbeCount,
    InvalidView,
}

impl fmt::Display for RunCliValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedProtocolVersion { expected, received } => write!(
                formatter,
                "unsupported run CLI protocol version {received}; expected {expected}"
            ),
            Self::EmptyRequestId => formatter.write_str("run CLI request id must not be empty"),
            Self::InvalidRequestId => {
                formatter.write_str("run CLI request id must be an ASCII token or UUID")
            }
            Self::RequestIdTooLong { maximum } => {
                write!(formatter, "run CLI request id exceeds {maximum} bytes")
            }
            Self::EmptyRetryScope => formatter.write_str("run CLI retry scope must not be empty"),
            Self::InvalidRetryScope => {
                formatter.write_str("run CLI retry scope must be an opaque safe token")
            }
            Self::RetryScopeTooLong { maximum } => {
                write!(formatter, "run CLI retry scope exceeds {maximum} bytes")
            }
            Self::EmptyHintAlias => formatter.write_str("run CLI hint alias must not be empty"),
            Self::InvalidHintAlias => formatter.write_str(
                "run CLI hint alias must start with a lowercase letter or digit and use only lowercase letters, digits, or hyphens",
            ),
            Self::HintAliasTooLong { maximum } => {
                write!(formatter, "run CLI hint alias exceeds {maximum} bytes")
            }
            Self::InvalidExpectedHintOrdinal => {
                formatter.write_str("run CLI expected hint ordinal must be at least 1")
            }
            Self::EmptyProbeIds => formatter.write_str("run CLI probe ids must not be empty"),
            Self::TooManyProbeIds { maximum } => {
                write!(
                    formatter,
                    "run CLI request selects more than {maximum} probes"
                )
            }
            Self::EmptyProbeId { index } => {
                write!(
                    formatter,
                    "run CLI probe id at index {index} must not be empty"
                )
            }
            Self::InvalidProbeId { index } => write!(
                formatter,
                "run CLI probe id at index {index} must be a safe identifier"
            ),
            Self::ProbeIdTooLong { index, maximum } => write!(
                formatter,
                "run CLI probe id at index {index} exceeds {maximum} bytes"
            ),
            Self::DuplicateProbeId { index } => {
                write!(formatter, "run CLI probe id at index {index} is duplicated")
            }
            Self::InvalidCompletedProbeCount => {
                formatter.write_str("run CLI completed probe count is invalid")
            }
            Self::InvalidView => formatter.write_str("run CLI response view is invalid"),
        }
    }
}

impl Error for RunCliValidationError {}

/// Errors from length-prefixed JSON framing. These errors intentionally retain
/// no serialized payload, so callers do not accidentally log learner content.
#[derive(Debug)]
pub enum RunCliFrameError {
    PayloadTooLarge { maximum: usize, received: usize },
    InvalidFrameLength { expected: usize, received: usize },
    EmptyPayload,
    InvalidJson(serde_json::Error),
}

impl fmt::Display for RunCliFrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadTooLarge { maximum, received } => write!(
                formatter,
                "run CLI frame payload is {received} bytes; maximum is {maximum}"
            ),
            Self::InvalidFrameLength { expected, received } => write!(
                formatter,
                "run CLI frame length is {received} bytes; expected {expected}"
            ),
            Self::EmptyPayload => formatter.write_str("run CLI frame payload must not be empty"),
            Self::InvalidJson(_) => formatter.write_str("run CLI frame contains invalid JSON"),
        }
    }
}

impl Error for RunCliFrameError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidJson(error) => Some(error),
            Self::PayloadTooLarge { .. } | Self::InvalidFrameLength { .. } | Self::EmptyPayload => {
                None
            }
        }
    }
}

/// Serialize a message as a bounded big-endian u32 length-prefixed JSON frame.
pub fn encode_run_cli_frame<T>(message: &T) -> Result<Vec<u8>, RunCliFrameError>
where
    T: Serialize,
{
    let payload = serde_json::to_vec(message).map_err(RunCliFrameError::InvalidJson)?;
    if payload.len() > RUN_CLI_MAX_FRAME_BYTES {
        return Err(RunCliFrameError::PayloadTooLarge {
            maximum: RUN_CLI_MAX_FRAME_BYTES,
            received: payload.len(),
        });
    }
    let payload_length =
        u32::try_from(payload.len()).map_err(|_| RunCliFrameError::PayloadTooLarge {
            maximum: RUN_CLI_MAX_FRAME_BYTES,
            received: payload.len(),
        })?;
    let mut frame = Vec::with_capacity(RUN_CLI_FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&payload_length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

/// Decode a bounded big-endian u32 length-prefixed JSON frame.
pub fn decode_run_cli_frame<T>(frame: &[u8]) -> Result<T, RunCliFrameError>
where
    T: DeserializeOwned,
{
    if frame.len() < RUN_CLI_FRAME_HEADER_BYTES {
        return Err(RunCliFrameError::InvalidFrameLength {
            expected: RUN_CLI_FRAME_HEADER_BYTES,
            received: frame.len(),
        });
    }
    let mut prefix = [0_u8; RUN_CLI_FRAME_HEADER_BYTES];
    prefix.copy_from_slice(&frame[..RUN_CLI_FRAME_HEADER_BYTES]);
    let payload_length = run_cli_frame_payload_len(prefix)?;
    let actual_payload_length = frame.len() - RUN_CLI_FRAME_HEADER_BYTES;
    if actual_payload_length != payload_length {
        return Err(RunCliFrameError::InvalidFrameLength {
            expected: RUN_CLI_FRAME_HEADER_BYTES + payload_length,
            received: frame.len(),
        });
    }
    serde_json::from_slice(&frame[RUN_CLI_FRAME_HEADER_BYTES..])
        .map_err(RunCliFrameError::InvalidJson)
}

/// Decode and bound a frame prefix before allocating or reading its payload.
pub fn run_cli_frame_payload_len(
    prefix: [u8; RUN_CLI_FRAME_HEADER_BYTES],
) -> Result<usize, RunCliFrameError> {
    let payload_length = u32::from_be_bytes(prefix) as usize;
    if payload_length == 0 {
        return Err(RunCliFrameError::EmptyPayload);
    }
    if payload_length > RUN_CLI_MAX_FRAME_BYTES {
        return Err(RunCliFrameError::PayloadTooLarge {
            maximum: RUN_CLI_MAX_FRAME_BYTES,
            received: payload_length,
        });
    }
    Ok(payload_length)
}

fn validate_protocol_version(protocol_version: u16) -> Result<(), RunCliValidationError> {
    if protocol_version == RUN_CLI_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(RunCliValidationError::UnsupportedProtocolVersion {
            expected: RUN_CLI_PROTOCOL_VERSION,
            received: protocol_version,
        })
    }
}

fn validate_request_id(request_id: &str) -> Result<(), RunCliValidationError> {
    if request_id.is_empty() {
        Err(RunCliValidationError::EmptyRequestId)
    } else if request_id.len() > RUN_CLI_MAX_REQUEST_ID_BYTES {
        Err(RunCliValidationError::RequestIdTooLong {
            maximum: RUN_CLI_MAX_REQUEST_ID_BYTES,
        })
    } else if !request_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        Err(RunCliValidationError::InvalidRequestId)
    } else {
        Ok(())
    }
}

fn validate_retry_scope(retry_scope: &str) -> Result<(), RunCliValidationError> {
    if retry_scope.is_empty() {
        Err(RunCliValidationError::EmptyRetryScope)
    } else if retry_scope.len() > RUN_CLI_MAX_RETRY_SCOPE_BYTES {
        Err(RunCliValidationError::RetryScopeTooLong {
            maximum: RUN_CLI_MAX_RETRY_SCOPE_BYTES,
        })
    } else if !retry_scope
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        Err(RunCliValidationError::InvalidRetryScope)
    } else {
        Ok(())
    }
}

fn validate_hint_alias(alias: &str) -> Result<(), RunCliValidationError> {
    if alias.is_empty() {
        Err(RunCliValidationError::EmptyHintAlias)
    } else if alias.len() > RUN_CLI_MAX_HINT_ALIAS_BYTES {
        Err(RunCliValidationError::HintAliasTooLong {
            maximum: RUN_CLI_MAX_HINT_ALIAS_BYTES,
        })
    } else if !is_run_cli_alias(alias) {
        Err(RunCliValidationError::InvalidHintAlias)
    } else {
        Ok(())
    }
}

fn validate_expected_hint_ordinal(ordinal: u16) -> Result<(), RunCliValidationError> {
    if ordinal == 0 {
        Err(RunCliValidationError::InvalidExpectedHintOrdinal)
    } else {
        Ok(())
    }
}

fn validate_probe_ids(probe_ids: &[String]) -> Result<(), RunCliValidationError> {
    if probe_ids.is_empty() {
        return Err(RunCliValidationError::EmptyProbeIds);
    }
    if probe_ids.len() > RUN_CLI_MAX_PROBE_IDS {
        return Err(RunCliValidationError::TooManyProbeIds {
            maximum: RUN_CLI_MAX_PROBE_IDS,
        });
    }
    let mut seen = BTreeSet::new();
    for (index, probe_id) in probe_ids.iter().enumerate() {
        validate_probe_id(probe_id, index)?;
        if !seen.insert(probe_id) {
            return Err(RunCliValidationError::DuplicateProbeId { index });
        }
    }
    Ok(())
}

fn validate_probe_id(probe_id: &str, index: usize) -> Result<(), RunCliValidationError> {
    if probe_id.is_empty() {
        Err(RunCliValidationError::EmptyProbeId { index })
    } else if probe_id.len() > RUN_CLI_MAX_PROBE_ID_BYTES {
        Err(RunCliValidationError::ProbeIdTooLong {
            index,
            maximum: RUN_CLI_MAX_PROBE_ID_BYTES,
        })
    } else if !is_safe_probe_id(probe_id) {
        Err(RunCliValidationError::InvalidProbeId { index })
    } else {
        Ok(())
    }
}

fn is_run_cli_alias(alias: &str) -> bool {
    let mut bytes = alias.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn is_safe_probe_id(probe_id: &str) -> bool {
    probe_id != "."
        && probe_id != ".."
        && probe_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}
