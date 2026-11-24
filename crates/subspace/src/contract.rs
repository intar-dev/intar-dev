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
    /// The app boots Talos cluster labs. intar refuses a cluster's start
    /// from an app that does not say so.
    #[serde(default)]
    pub clusters: bool,
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
    /// The learner; every reported VM state names them as its owner. Absent
    /// from an intar that predates reports from the app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
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
    /// The machine's name in the archive routes. Absent from an intar that
    /// predates them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_name: Option<String>,
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

/// `GET /api/local/catalog`: the courses the learner sees on the website.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct LocalCatalogV1 {
    pub protocol: u16,
    pub courses: Vec<CatalogCourseV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCourseV1 {
    pub course_id: String,
    /// What a start of one of this course's lectures takes as its organization.
    pub organization_id: Option<String>,
    pub organization_name: Option<String>,
    pub title: String,
    pub summary: String,
    pub body_markdown: String,
    /// Lectures unlock in order.
    pub sequential: bool,
    pub lectures: Vec<CatalogLectureV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLectureV1 {
    pub lecture_id: String,
    pub title: String,
    pub summary: String,
    pub category: String,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub difficulty: Option<String>,
    pub estimated_minutes: Option<u32>,
    /// What a start takes; absent on a lecture without a lab.
    pub scenario_id: Option<String>,
    /// `locked`, `available`, `waiting_for_scenario`, `in_progress` or `completed`.
    pub state: String,
    /// The learner's active run of this lecture, local or not.
    pub active_run_id: Option<String>,
}

/// `GET /api/local/app-release`: the release of the app that intar offers
/// this system and processor as an update, if it pins one.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct AppReleaseAnswerV1 {
    pub protocol: u16,
    pub release: Option<AppReleaseV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct AppReleaseV1 {
    pub version: String,
    /// The SHA-256 of the download at `url`, as lowercase hex.
    pub sha256: String,
    pub url: String,
}

/// `GET /api/local/courses/<courseId>/lectures/<lectureId>`: a lecture's
/// theory, as the website's lecture page shows it. `lecture` is absent and
/// `locked` true while an earlier lecture of a sequential course is open.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct LocalLectureAnswerV1 {
    pub protocol: u16,
    #[serde(default)]
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lecture: Option<LocalLectureV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLectureV1 {
    pub course_id: String,
    pub lecture_id: String,
    pub title: String,
    pub body_markdown: String,
    /// One-based position in its course, and the course's lecture count.
    pub ordinal: u32,
    pub count: u32,
    /// Same meaning as [`CatalogLectureV1::state`].
    pub state: String,
}

/// `GET /api/local/runs/<id>/learning`, and the answer to a hint or solution
/// reveal: what the website's learning panel shows beside a run.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct LocalRunLearningAnswerV1 {
    pub protocol: u16,
    pub learning: LocalRunLearningV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRunLearningV1 {
    pub run_id: String,
    pub lecture_title: Option<String>,
    /// The lecture's theory as it was when the run started, or the
    /// scenario's briefing for a run that predates that snapshot.
    pub lecture_markdown: String,
    /// The whole run is solved.
    pub solved: bool,
    pub checks: Vec<LocalRunCheckV1>,
    pub hints: Vec<LocalRunHintV1>,
    pub solution: LocalRunSolutionV1,
}

/// One check (a probe or a task) the learner works towards.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRunCheckV1 {
    /// What a probe-scoped hint names as its `check_key`.
    pub key: String,
    /// The machine the check runs on.
    pub machine: String,
    pub title: String,
    pub description: Option<String>,
    /// `verified`, `checking` or `needs_repair`, as the website shows it.
    pub status: String,
    #[serde(default)]
    pub optional: bool,
}

/// Hints unlock in order per ladder: the run's own and one per check. A
/// sealed hint has neither title nor body; `unlocked` marks the one hint of
/// each ladder that can be revealed next.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRunHintV1 {
    /// What a reveal names.
    pub key: String,
    /// The check whose ladder it is on; absent on the run's own ladder.
    pub check_key: Option<String>,
    pub title: Option<String>,
    pub revealed: bool,
    pub unlocked: bool,
    pub body_markdown: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRunSolutionV1 {
    pub unlocked: bool,
    pub revealed: bool,
    /// The learner revealed it before solving the run.
    #[serde(default)]
    pub assisted: bool,
    pub body_markdown: Option<String>,
}

/// `POST /api/local/runs/<id>/hints/reveal`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealHintV1 {
    pub protocol: u16,
    pub hint_key: String,
}

/// `GET /api/local/runs`: the learner's runs, newest first, as the website's
/// run history lists them. Runs on intar's hosts are listed too; the app
/// shows their recap but cannot open them.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct LocalRunHistoryV1 {
    pub protocol: u16,
    pub runs: Vec<LocalRunSummaryV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRunSummaryV1 {
    pub run_id: String,
    pub scenario_id: String,
    pub organization_id: Option<String>,
    pub title: String,
    /// The run's machines ran on the learner's own computer.
    pub local: bool,
    pub active: bool,
    /// `in_progress`, `succeeded`, `cancelled` or `failed`.
    pub outcome: String,
    /// `foreground`, `background` or `settled`, as the website groups runs.
    pub activity: String,
    /// Unix milliseconds.
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub solved_at: Option<i64>,
    pub solve_duration_ms: Option<i64>,
    pub solution_assisted: bool,
    pub has_replay: bool,
}

/// `GET /api/local/runs/<id>/recap`: what the website's recap shows once a
/// run has ended. Any run of the learner's, local or not.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct LocalRunRecapAnswerV1 {
    pub protocol: u16,
    pub recap: LocalRunRecapV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRunRecapV1 {
    pub run_id: String,
    pub scenario_id: String,
    pub title: String,
    /// `saving`, `solved`, `could_not_finish` or `ended_early`.
    pub kind: String,
    /// The website's heading and line for `kind`.
    pub heading: String,
    pub description: String,
    pub solve_duration_ms: Option<i64>,
    pub hints_revealed: u32,
    pub solution_used: bool,
    /// The final checks; `status` is `verified` or not.
    pub checks: Vec<LocalRunCheckV1>,
    /// `none`, `pending`, `unavailable` or `ready`.
    pub replay: String,
    pub replay_parts: Vec<LocalReplayPartV1>,
}

/// One terminal session of the replay, in playing order.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReplayPartV1 {
    pub key: String,
    /// The machine's name; absent for a one-machine run.
    pub machine_label: Option<String>,
    pub part_label: String,
    /// The asciicast at `GET /api/local/runs/<id>/artifacts/<artifactId>`;
    /// absent when this part's recording is missing.
    pub cast_artifact_id: Option<String>,
    pub size_bytes: Option<u64>,
}
