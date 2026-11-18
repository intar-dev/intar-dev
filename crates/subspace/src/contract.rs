//! The desktop app's channel to intar (`/api/local/runs`, version 1).
//!
//! The app signs in as a public OAuth client and sends its access token as a
//! bearer credential. It starts a local run, boots what the answer names on
//! the learner's own computer, and reports its VMs in the shape an agent host
//! does ([`VmStateV3`]).
//!
//! The types live here, not in `intar-contracts`: every released product
//! builds from that crate, so a change there releases all of them. The
//! website's side is `apps/web/src/lib/desktop-channel.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use intar_contracts::bridge_v9::VmStateV3;

/// Version of the channel's requests and answers.
pub const SUBSPACE_PROTOCOL_VERSION: u16 = 1;
/// The OAuth client the app signs in as.
pub const SUBSPACE_OAUTH_CLIENT_ID: &str = "intar-jumper";
/// The scopes the app asks for: a refresh token, and local runs.
pub const SUBSPACE_OAUTH_SCOPE: &str = "offline_access local-runs";

/// `POST /api/local/runs`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLocalRunV1 {
    pub protocol: u16,
    /// `<namespace>/<slug>`.
    pub scenario_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    /// The guest contracts the app can boot.
    pub guest_contracts: Vec<u32>,
    /// The computer's architecture, as Rust names it (`x86_64`, `aarch64`).
    pub arch: String,
}

/// A local run as the server holds it, and what to run for it.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRunV1 {
    pub run_id: String,
    pub scenario_id: String,
    /// The run's phase on the server.
    pub state: String,
    /// False once the server has closed the run: the app stops its VMs.
    pub active: bool,
    /// Every reported VM state names this execution and generation.
    pub execution_id: Option<String>,
    pub generation: Option<u64>,
    pub machines: Vec<LocalRunMachineV1>,
}

/// One machine of a local run.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRunMachineV1 {
    pub name: String,
    /// Digest of the machine image manifest (`/v2/machines/<hex>`).
    pub image: String,
    /// Digest of the spec blob (`/v2/specs`).
    pub spec: String,
    /// Digest of the Kino artifact (`/v2/kino`).
    pub kino: String,
    pub mode: String,
    pub cpu_millis: u64,
    pub memory_mib: u64,
    pub disk_mib: u64,
    pub egress: bool,
    pub terminal: bool,
    /// The other machines of the run, by name.
    pub peers: Vec<String>,
}

/// The answer to a start, a read, an end and a report.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct LocalRunAnswerV1 {
    pub protocol: u16,
    pub run: LocalRunV1,
    /// On a start: the same request was answered before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reused: Option<bool>,
}

/// A refusal. `run` is present when the run is closed (`run_closed`).
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct LocalRunRefusalV1 {
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<LocalRunV1>,
}

/// `POST /api/local/runs/<id>/report`: one to all of the run's VMs.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct LocalRunReportV1 {
    pub protocol: u16,
    pub vms: Vec<VmStateV3>,
}
