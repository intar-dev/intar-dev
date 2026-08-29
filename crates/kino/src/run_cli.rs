//! Non-interactive learner-facing `intar` multicall CLI.
//!
//! This module intentionally knows nothing about run identity, hints, or
//! solution source data. It sends one bounded request to a generation-fenced
//! runtime broker, renders only the broker's safe projection, and runs fresh
//! selected checks through Kino's local control socket.

use crate::run_cli_control::configured_socket_path;
use crate::run_cli_pending::{
    PendingHintReveal, clear_if_matches_at, configured_path as pending_hint_path, load_at,
    persist_at,
};
use crate::run_cli_wire::{read_message, write_message};
use intar_contracts::run_cli::{
    RUN_CLI_MAX_FRAME_BYTES, RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliCheckStatusV1,
    RunCliErrorCodeV1, RunCliProbeCheckEventKindV1, RunCliProbeCheckEventV1,
    RunCliProbeCheckRequestV1, RunCliProbeCheckResultV1, RunCliProbeCheckStreamValidatorV1,
    RunCliRequestV1, RunCliResponseV1, RunCliResultV1, RunCliSolutionStateV1, RunCliViewV1,
};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{IsTerminal as _, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use thiserror::Error;
use tokio::net::UnixStream;

#[cfg(target_os = "linux")]
use tokio_vsock::{VsockAddr, VsockStream};

pub(crate) const ENV_RUN_CLI_BROKER: &str = "INTAR_RUN_CLI_BROKER";
pub(crate) const ENV_RUN_CLI_BROKER_FILE: &str = "INTAR_RUN_CLI_BROKER_FILE";
pub(crate) const DEFAULT_RUN_CLI_BROKER_FILE: &str = "/run/intar/run-cli-broker";

const EXIT_OK: i32 = 0;
const EXIT_CHECKS_NOT_PASSED: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_LOCKED_OR_UNAVAILABLE: i32 = 3;
const EXIT_FAILURE: i32 = 4;
const EXIT_INTERRUPTED: i32 = 130;

const BROKER_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const BROKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const COMPLETION_TIMEOUT: Duration = Duration::from_millis(250);
const LOCAL_CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const LOCAL_CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(310);
const MAX_BROKER_CONFIG_BYTES: u64 = 1024;
// A broker frame is bounded to this many bytes. A Rust `char` never occupies
// fewer than one byte, so this cap cannot silently truncate any one valid
// server-provided value after terminal sanitizing.
const MAX_DISPLAY_CHARS: usize = RUN_CLI_MAX_FRAME_BYTES;

static NEXT_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Status,
    Check,
    Hints,
    Hint {
        alias: String,
    },
    Solution,
    SolutionReveal,
    Help,
    Complete {
        cursor_index: usize,
        words: Vec<String>,
    },
}

#[derive(Debug)]
struct CliResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    pending_hint_clear: Option<PendingHintClear>,
}

#[derive(Debug)]
struct PendingHintClear {
    path: PathBuf,
    pending: PendingHintReveal,
}

impl CliResult {
    fn success(stdout: impl Into<String>) -> Self {
        Self {
            stdout: stdout.into(),
            stderr: String::new(),
            exit_code: EXIT_OK,
            pending_hint_clear: None,
        }
    }

    fn failure(exit_code: i32, stderr: impl Into<String>) -> Self {
        Self {
            stdout: String::new(),
            stderr: stderr.into(),
            exit_code,
            pending_hint_clear: None,
        }
    }

    fn plain(exit_code: i32, stdout: impl Into<String>) -> Self {
        Self {
            stdout: stdout.into(),
            stderr: String::new(),
            exit_code,
            pending_hint_clear: None,
        }
    }

    fn clear_pending_hint_after_output(mut self, path: &Path, pending: &PendingHintReveal) -> Self {
        self.pending_hint_clear = Some(PendingHintClear {
            path: path.to_path_buf(),
            pending: pending.clone(),
        });
        self
    }
}

#[derive(Clone, Copy, Debug)]
struct TerminalStyle {
    color: bool,
    unicode: bool,
    progress: bool,
    columns: usize,
}

#[derive(Clone, Copy, Debug)]
struct TerminalAutoOptions {
    ci: bool,
    no_color: bool,
    clicolor_disabled: bool,
    utf8: bool,
}

impl TerminalStyle {
    fn detect() -> Self {
        let term = env::var("TERM").ok();
        let ci = env::var_os("CI").is_some_and(|value| !value.is_empty());
        let no_color = env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
        let clicolor_disabled = env::var("CLICOLOR").ok().as_deref() == Some("0");
        let is_tty = std::io::stdout().is_terminal();
        let stderr_is_tty = std::io::stderr().is_terminal();
        let columns = env::var("COLUMNS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| (20..=500).contains(value))
            .unwrap_or(80);
        Self::automatic(
            is_tty,
            stderr_is_tty,
            term.as_deref(),
            TerminalAutoOptions {
                ci,
                no_color,
                clicolor_disabled,
                utf8: utf8_locale(),
            },
            columns,
        )
    }

    fn automatic(
        stdout_is_tty: bool,
        stderr_is_tty: bool,
        term: Option<&str>,
        options: TerminalAutoOptions,
        columns: usize,
    ) -> Self {
        let term_supports_output = term.is_some_and(|value| !value.eq_ignore_ascii_case("dumb"));
        let color = stdout_is_tty
            && term_supports_output
            && !options.ci
            && !options.no_color
            && !options.clicolor_disabled;
        let unicode = stdout_is_tty && term_supports_output && !options.ci && options.utf8;
        let progress = stdout_is_tty && stderr_is_tty && term_supports_output && !options.ci;
        Self {
            color,
            unicode,
            progress,
            columns,
        }
    }

    #[cfg(test)]
    fn from_values(color: bool, unicode: bool, columns: usize) -> Self {
        Self {
            color,
            unicode,
            progress: false,
            columns,
        }
    }

    fn paint(self, color_code: &str, text: &str) -> String {
        if self.color {
            format!("\x1b[{color_code}m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }

    fn success_marker(self) -> &'static str {
        if self.unicode { "✓" } else { "[OK]" }
    }

    fn warning_marker(self) -> &'static str {
        if self.unicode { "!" } else { "[!]" }
    }

    fn separator(self) -> &'static str {
        if self.unicode { " · " } else { " - " }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum BrokerEndpoint {
    Unix(PathBuf),
    Vsock { cid: u32, port: u32 },
}

#[derive(Debug, Error, PartialEq, Eq)]
enum EndpointError {
    #[error("run CLI broker is not configured")]
    NotConfigured,
    #[error("run CLI broker configuration is invalid")]
    Invalid,
    #[error("run CLI broker configuration could not be read")]
    Read,
}

#[derive(Debug, Error)]
enum TransportError {
    #[error("run CLI transport is unavailable")]
    Unavailable,
    #[error("run CLI transport returned an invalid response")]
    InvalidResponse,
    #[error("run CLI output pipe closed")]
    OutputClosed,
}

#[derive(Debug)]
enum BrokerFailure {
    Remote(RunCliErrorCodeV1),
    Transport,
}

pub(crate) fn invoked_as_intar(argv0: &OsStr) -> bool {
    Path::new(argv0)
        .file_name()
        .is_some_and(|name| name == OsStr::new("intar"))
}

/// Run the multicall entrypoint and write only bounded, learner-safe text.
/// It never reads stdin or opens `/dev/tty`.
pub(crate) async fn run_from_environment() -> i32 {
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    let style = TerminalStyle::detect();
    let parsed = parse_command(args);
    let result = match parsed {
        Ok(command) => {
            tokio::select! {
                result = execute(command, style) => result,
                _signal = tokio::signal::ctrl_c() => CliResult::failure(
                    EXIT_INTERRUPTED,
                    "Interrupted.\nNext: intar status\n",
                ),
            }
        }
        Err(()) => usage_result(),
    };
    write_result(result)
}

fn write_result(result: CliResult) -> i32 {
    let mut stdout = std::io::stdout().lock();
    let mut stderr = std::io::stderr().lock();
    deliver_result_to(&result, &mut stdout, &mut stderr)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WriteOutcome {
    Complete,
    BrokenPipe,
    Failure,
}

fn deliver_result_to(result: &CliResult, stdout: &mut impl Write, stderr: &mut impl Write) -> i32 {
    match write_result_to(result, stdout, stderr) {
        WriteOutcome::Complete => {
            if let Some(pending) = &result.pending_hint_clear
                && clear_if_matches_at(&pending.path, &pending.pending).is_err()
            {
                return EXIT_FAILURE;
            }
            result.exit_code
        }
        // The action may already have completed, but the learner did not
        // receive its body. Keep the pending marker so the next invocation
        // renders the exact same ordinal instead of advancing the ladder.
        WriteOutcome::BrokenPipe => result.exit_code,
        WriteOutcome::Failure => EXIT_FAILURE,
    }
}

fn write_result_to(
    result: &CliResult,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> WriteOutcome {
    if !result.stdout.is_empty() {
        match stdout.write_all(result.stdout.as_bytes()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {
                return WriteOutcome::BrokenPipe;
            }
            Err(_) => return WriteOutcome::Failure,
        }
    }
    if !result.stderr.is_empty() {
        match stderr.write_all(result.stderr.as_bytes()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {
                return WriteOutcome::BrokenPipe;
            }
            Err(_) => return WriteOutcome::Failure,
        }
    }
    WriteOutcome::Complete
}

fn parse_command(args: Vec<OsString>) -> Result<Command, ()> {
    let args = args
        .into_iter()
        .map(|value| value.into_string().map_err(|_| ()))
        .collect::<Result<Vec<_>, _>>()?;
    match args.as_slice() {
        [] => Ok(Command::Status),
        [command] if command == "status" => Ok(Command::Status),
        [command] if command == "check" => Ok(Command::Check),
        [command] if command == "hints" => Ok(Command::Hints),
        [command, alias] if command == "hint" && valid_completion_candidate(alias) => {
            Ok(Command::Hint {
                alias: alias.clone(),
            })
        }
        [command] if command == "solution" => Ok(Command::Solution),
        [command, action] if command == "solution" && action == "reveal" => {
            Ok(Command::SolutionReveal)
        }
        [command] if matches!(command.as_str(), "help" | "--help" | "-h") => Ok(Command::Help),
        [hidden, cursor, words @ ..] if hidden == "__complete" => {
            let cursor_index = cursor.parse::<usize>().map_err(|_| ())?;
            Ok(Command::Complete {
                cursor_index,
                words: words.to_vec(),
            })
        }
        _ => Err(()),
    }
}

async fn execute(command: Command, style: TerminalStyle) -> CliResult {
    match command {
        Command::Help => CliResult::success(render_help()),
        Command::Complete {
            cursor_index,
            words,
        } => complete(cursor_index, words).await,
        command => {
            let endpoint = match BrokerEndpoint::configured() {
                Ok(value) => value,
                Err(_) => return unavailable_result(),
            };
            let broker = BrokerClient { endpoint };
            execute_broker_command(command, style, &broker).await
        }
    }
}

async fn execute_broker_command(
    command: Command,
    style: TerminalStyle,
    broker: &BrokerClient,
) -> CliResult {
    match command {
        Command::Status => match broker
            .view(RunCliActionV1::Status, BROKER_REQUEST_TIMEOUT)
            .await
        {
            Ok(view) => CliResult::success(render_status(&view, style)),
            Err(error) => broker_failure_result(error),
        },
        Command::Hints => match broker
            .view(RunCliActionV1::Hints, BROKER_REQUEST_TIMEOUT)
            .await
        {
            Ok(view) => CliResult::success(render_hints(&view, style)),
            Err(error) => broker_failure_result(error),
        },
        Command::Hint { alias } => reveal_hint(broker, alias, style).await,
        Command::Solution => match broker
            .view(RunCliActionV1::Solution, BROKER_REQUEST_TIMEOUT)
            .await
        {
            Ok(view) => render_solution(&view, style),
            Err(error) => broker_failure_result(error),
        },
        Command::SolutionReveal => {
            match broker
                .view(RunCliActionV1::SolutionReveal, BROKER_REQUEST_TIMEOUT)
                .await
            {
                Ok(view) => render_revealed_solution(&view, style),
                Err(error) => broker_failure_result(error),
            }
        }
        Command::Check => run_fresh_checks(broker, style).await,
        Command::Help | Command::Complete { .. } => unreachable!("handled before broker setup"),
    }
}

async fn reveal_hint(broker: &BrokerClient, alias: String, style: TerminalStyle) -> CliResult {
    let path = match pending_hint_path() {
        Ok(path) => path,
        Err(_) => return unavailable_result(),
    };
    reveal_hint_with_path(broker, alias, style, &path).await
}

#[cfg(test)]
async fn reveal_hint_at(
    broker: &BrokerClient,
    alias: String,
    style: TerminalStyle,
    pending_path: &Path,
) -> CliResult {
    reveal_hint_with_path(broker, alias, style, pending_path).await
}

async fn reveal_hint_with_path(
    broker: &BrokerClient,
    alias: String,
    style: TerminalStyle,
    pending_path: &Path,
) -> CliResult {
    let current_view = match broker
        .view(RunCliActionV1::Status, BROKER_REQUEST_TIMEOUT)
        .await
    {
        Ok(view) => view,
        Err(error) => return broker_failure_result(error),
    };

    let loaded_pending = match load_at(pending_path) {
        Ok(Some(pending)) if pending.retry_scope != current_view.retry_scope => {
            if clear_if_matches_at(pending_path, &pending).is_err() {
                return unavailable_result();
            }
            None
        }
        Ok(value) => value,
        Err(_) => return unavailable_result(),
    };
    let pending = match loaded_pending {
        Some(pending) if pending.alias == alias => {
            if hint_ordinal_is_revealed(&current_view, &pending) {
                return finish_revealed_hint(pending_path, &pending, &current_view, style);
            }
            if hint_ordinal_is_ready(&current_view, &pending) {
                pending
            } else {
                return pending_hint_confirmation_result(&pending);
            }
        }
        Some(pending) => return other_pending_hint_result(&pending),
        None => {
            let Some(expected_ordinal) = ready_hint_ordinal(&current_view, &alias) else {
                return CliResult::plain(
                    EXIT_LOCKED_OR_UNAVAILABLE,
                    "This hint is unavailable.\nNext: intar status\n",
                );
            };
            let pending = PendingHintReveal {
                retry_scope: current_view.retry_scope.clone(),
                alias: alias.clone(),
                expected_ordinal,
                request_id: next_request_id(),
            };
            if persist_at(pending_path, &pending).is_err() {
                return unavailable_result();
            }
            pending
        }
    };

    let action = RunCliActionV1::HintReveal {
        alias: pending.alias.clone(),
        expected_ordinal: pending.expected_ordinal,
    };
    match broker
        .view_with_request_id(action, pending.request_id.clone(), BROKER_REQUEST_TIMEOUT)
        .await
    {
        Ok(view) if hint_ordinal_is_revealed(&view, &pending) => {
            finish_revealed_hint(pending_path, &pending, &view, style)
        }
        Ok(_) => pending_hint_confirmation_result(&pending),
        Err(BrokerFailure::Transport) => {
            confirm_pending_hint_after_transport(broker, pending_path, &pending, style).await
        }
        Err(error) => {
            let confirmation =
                confirm_pending_hint_after_transport(broker, pending_path, &pending, style).await;
            if confirmation.exit_code == EXIT_OK {
                confirmation
            } else {
                let _ = clear_if_matches_at(pending_path, &pending);
                broker_failure_result(error)
            }
        }
    }
}

async fn confirm_pending_hint_after_transport(
    broker: &BrokerClient,
    pending_path: &Path,
    pending: &PendingHintReveal,
    style: TerminalStyle,
) -> CliResult {
    match broker
        .view(RunCliActionV1::Status, BROKER_REQUEST_TIMEOUT)
        .await
    {
        Ok(view) if hint_ordinal_is_revealed(&view, pending) => {
            finish_revealed_hint(pending_path, pending, &view, style)
        }
        Ok(_) | Err(_) => pending_hint_confirmation_result(pending),
    }
}

fn ready_hint_ordinal(view: &RunCliViewV1, alias: &str) -> Option<u16> {
    view.hint_groups
        .iter()
        .find(|group| group.alias == alias)
        .and_then(|group| {
            group
                .entries
                .iter()
                .find(|entry| entry.state == intar_contracts::run_cli::RunCliHintStateV1::Ready)
        })
        .map(|entry| entry.ordinal)
}

fn hint_ordinal_is_ready(view: &RunCliViewV1, pending: &PendingHintReveal) -> bool {
    hint_ordinal_state(view, pending) == Some(intar_contracts::run_cli::RunCliHintStateV1::Ready)
}

fn hint_ordinal_is_revealed(view: &RunCliViewV1, pending: &PendingHintReveal) -> bool {
    hint_ordinal_state(view, pending) == Some(intar_contracts::run_cli::RunCliHintStateV1::Revealed)
}

fn hint_ordinal_state(
    view: &RunCliViewV1,
    pending: &PendingHintReveal,
) -> Option<intar_contracts::run_cli::RunCliHintStateV1> {
    if view.retry_scope != pending.retry_scope {
        return None;
    }
    view.hint_groups
        .iter()
        .find(|group| group.alias == pending.alias)
        .and_then(|group| {
            group
                .entries
                .iter()
                .find(|entry| entry.ordinal == pending.expected_ordinal)
        })
        .map(|entry| entry.state)
}

fn finish_revealed_hint(
    pending_path: &Path,
    pending: &PendingHintReveal,
    view: &RunCliViewV1,
    style: TerminalStyle,
) -> CliResult {
    render_revealed_hint_at(view, &pending.alias, pending.expected_ordinal, style)
        .clear_pending_hint_after_output(pending_path, pending)
}

fn pending_hint_confirmation_result(pending: &PendingHintReveal) -> CliResult {
    CliResult::failure(
        EXIT_FAILURE,
        format!(
            "Hint reveal is still being confirmed.\nNext: intar hint {}\n",
            pending.alias
        ),
    )
}

fn other_pending_hint_result(pending: &PendingHintReveal) -> CliResult {
    CliResult::failure(
        EXIT_FAILURE,
        format!(
            "A hint reveal is still being confirmed.\nNext: intar hint {}\n",
            pending.alias
        ),
    )
}

async fn run_fresh_checks(broker: &BrokerClient, style: TerminalStyle) -> CliResult {
    run_fresh_checks_with_progress(broker, style, &configured_socket_path(), true, true).await
}

#[cfg(test)]
async fn run_fresh_checks_at(
    broker: &BrokerClient,
    style: TerminalStyle,
    control_socket_path: &Path,
) -> CliResult {
    run_fresh_checks_with_progress(broker, style, control_socket_path, false, false).await
}

async fn run_fresh_checks_with_progress(
    broker: &BrokerClient,
    style: TerminalStyle,
    control_socket_path: &Path,
    emit_progress: bool,
    emit_probe_results: bool,
) -> CliResult {
    let view = match broker
        .view(RunCliActionV1::Status, BROKER_REQUEST_TIMEOUT)
        .await
    {
        Ok(view) => view,
        Err(error) => return broker_failure_result(error),
    };
    if view.checks.is_empty() {
        return CliResult::plain(
            EXIT_LOCKED_OR_UNAVAILABLE,
            "No checks are available.\nNext: intar status\n",
        );
    }

    let labels_by_id = view
        .checks
        .iter()
        .map(|check| (check.probe_id.as_str(), check.label.as_str()))
        .collect::<BTreeMap<_, _>>();
    let probe_ids = view
        .checks
        .iter()
        .map(|check| check.probe_id.clone())
        .collect::<Vec<_>>();
    if emit_progress && style.progress {
        emit_check_start_line(view.checks.len());
    }
    let mut streamed_rows = String::new();
    let local_results = match request_local_checks_at(control_socket_path, probe_ids, |result| {
        let Some(label) = labels_by_id.get(result.probe_id.as_str()) else {
            return Err(TransportError::InvalidResponse);
        };
        let line = render_check_line(style, label, result.status);
        if emit_probe_results {
            emit_check_result_line(&line).map_err(|error| {
                if error.kind() == std::io::ErrorKind::BrokenPipe {
                    TransportError::OutputClosed
                } else {
                    TransportError::Unavailable
                }
            })?;
        } else {
            streamed_rows.push_str(&line);
        }
        Ok(())
    })
    .await
    {
        Ok(results) => results,
        Err(TransportError::OutputClosed) => {
            return CliResult::failure(
                EXIT_FAILURE,
                "Check output was interrupted.\nNext: intar status\n",
            );
        }
        Err(_) => return unavailable_result(),
    };

    // Direct-cloud workshops use this action to publish the now-fresh local
    // state immediately. KVM's existing ready push races independently, but
    // the same action makes command semantics consistent for both runtimes.
    if broker
        .view(RunCliActionV1::CheckSync, BROKER_REQUEST_TIMEOUT)
        .await
        .is_err()
    {
        return CliResult {
            stdout: streamed_rows,
            stderr: "Checks finished, but Intar could not update run status. Try again.\nNext: intar status\n"
                .to_owned(),
            exit_code: EXIT_FAILURE,
            pending_hint_clear: None,
        };
    }

    let mut output = streamed_rows;
    let mut passed = 0_usize;
    for check in &view.checks {
        let Some(status) = local_results.get(&check.probe_id).copied() else {
            return unavailable_result();
        };
        if status == RunCliCheckStatusV1::Pass {
            passed += 1;
        }
        if !emit_probe_results {
            // Test and non-streaming callers retain rows in the same actual
            // completion order captured above rather than re-sorting here.
        }
    }
    output.push('\n');
    output.push_str(&format!("{passed}/{} checks verified\n", view.checks.len()));
    if passed == view.checks.len() {
        output.push_str("Next: intar status\n");
        CliResult::success(output)
    } else {
        output.push_str(&format!("Next: {}\n", next_command(&view)));
        CliResult::plain(EXIT_CHECKS_NOT_PASSED, output)
    }
}

fn emit_check_start_line(check_count: usize) {
    let line = check_start_line(check_count);
    // This is the sole in-flight progress output. It is static, uses no
    // cursor control, and failure to write it must not alter the eventual
    // check result.
    let _ = std::io::stderr().lock().write_all(line.as_bytes());
}

fn emit_check_result_line(line: &str) -> std::io::Result<()> {
    std::io::stdout().lock().write_all(line.as_bytes())
}

fn check_start_line(check_count: usize) -> String {
    format!(
        "Checking {check_count} work-order item{}...\n",
        if check_count == 1 { "" } else { "s" }
    )
}

async fn request_local_checks_at(
    control_socket_path: &Path,
    probe_ids: Vec<String>,
    mut on_probe: impl FnMut(&RunCliProbeCheckResultV1) -> Result<(), TransportError>,
) -> Result<BTreeMap<String, RunCliCheckStatusV1>, TransportError> {
    let request = RunCliProbeCheckRequestV1 {
        protocol_version: RUN_CLI_PROTOCOL_VERSION,
        request_id: next_request_id(),
        probe_ids: probe_ids.clone(),
    };
    request
        .validate()
        .map_err(|_| TransportError::InvalidResponse)?;

    let mut stream = tokio::time::timeout(
        LOCAL_CONTROL_CONNECT_TIMEOUT,
        UnixStream::connect(control_socket_path),
    )
    .await
    .map_err(|_| TransportError::Unavailable)?
    .map_err(|_| TransportError::Unavailable)?;
    let statuses = tokio::time::timeout(LOCAL_CONTROL_REQUEST_TIMEOUT, async {
        write_message(&mut stream, &request)
            .await
            .map_err(|_| TransportError::Unavailable)?;
        let mut validator = RunCliProbeCheckStreamValidatorV1::new(&request)
            .map_err(|_| TransportError::InvalidResponse)?;
        let mut statuses = BTreeMap::new();
        while !validator.is_complete() {
            let event = read_message::<RunCliProbeCheckEventV1, _>(&mut stream)
                .await
                .map_err(|_| TransportError::Unavailable)?;
            validator
                .observe(&event)
                .map_err(|_| TransportError::InvalidResponse)?;
            if let RunCliProbeCheckEventKindV1::Probe { check } = &event.event {
                on_probe(check)?;
                statuses.insert(check.probe_id.clone(), check.status);
            }
        }
        validator
            .finish()
            .map_err(|_| TransportError::InvalidResponse)?;
        Ok::<_, TransportError>(statuses)
    })
    .await
    .map_err(|_| TransportError::Unavailable)??;
    let requested = probe_ids.into_iter().collect::<BTreeSet<_>>();
    if requested.len() != statuses.len() {
        return Err(TransportError::InvalidResponse);
    }
    if !statuses.keys().all(|probe_id| requested.contains(probe_id)) {
        return Err(TransportError::InvalidResponse);
    }
    Ok(statuses)
}

async fn complete(cursor_index: usize, words: Vec<String>) -> CliResult {
    complete_with_endpoint(BrokerEndpoint::configured().ok(), cursor_index, words).await
}

async fn complete_with_endpoint(
    endpoint: Option<BrokerEndpoint>,
    cursor_index: usize,
    words: Vec<String>,
) -> CliResult {
    // Completion must be silent even for malformed shell state. The static
    // command words are handled by the Bash hook; this only serves aliases.
    let wants_hint_alias = words.get(1).is_some_and(|word| word == "hint") && cursor_index == 2;
    if !wants_hint_alias {
        return CliResult::success(String::new());
    }
    let Some(endpoint) = endpoint else {
        return CliResult::success(String::new());
    };
    let broker = BrokerClient { endpoint };
    let Ok(view) = broker
        .view(RunCliActionV1::Status, COMPLETION_TIMEOUT)
        .await
    else {
        return CliResult::success(String::new());
    };
    let mut aliases = view
        .hint_groups
        .iter()
        .filter(|group| group.can_reveal && valid_completion_candidate(&group.alias))
        .map(|group| group.alias.clone())
        .collect::<Vec<_>>();
    aliases.sort();
    aliases.dedup();
    CliResult::success(
        aliases
            .into_iter()
            .map(|alias| format!("{alias}\n"))
            .collect::<String>(),
    )
}

impl BrokerEndpoint {
    fn configured() -> Result<Self, EndpointError> {
        let raw = if let Some(value) = env::var_os(ENV_RUN_CLI_BROKER) {
            value.into_string().map_err(|_| EndpointError::Invalid)?
        } else {
            let file = env::var_os(ENV_RUN_CLI_BROKER_FILE)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_RUN_CLI_BROKER_FILE));
            read_broker_file(&file)?
        };
        parse_broker_endpoint(raw.trim())
    }
}

fn read_broker_file(path: &Path) -> Result<String, EndpointError> {
    let metadata = std::fs::metadata(path).map_err(|_| EndpointError::NotConfigured)?;
    if !metadata.is_file() || metadata.len() > MAX_BROKER_CONFIG_BYTES {
        return Err(EndpointError::Invalid);
    }
    std::fs::read_to_string(path).map_err(|_| EndpointError::Read)
}

fn parse_broker_endpoint(raw: &str) -> Result<BrokerEndpoint, EndpointError> {
    if raw.is_empty() || raw.len() > usize::try_from(MAX_BROKER_CONFIG_BYTES).unwrap_or(1024) {
        return Err(EndpointError::NotConfigured);
    }
    if let Some(path) = raw.strip_prefix("unix://") {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            return Ok(BrokerEndpoint::Unix(path));
        }
        return Err(EndpointError::Invalid);
    }
    let Some(address) = raw.strip_prefix("vsock://") else {
        return Err(EndpointError::Invalid);
    };
    let Some((cid, port)) = address.split_once(':') else {
        return Err(EndpointError::Invalid);
    };
    let cid = cid.parse::<u32>().map_err(|_| EndpointError::Invalid)?;
    let port = port.parse::<u32>().map_err(|_| EndpointError::Invalid)?;
    if port == 0 {
        return Err(EndpointError::Invalid);
    }
    Ok(BrokerEndpoint::Vsock { cid, port })
}

struct BrokerClient {
    endpoint: BrokerEndpoint,
}

impl BrokerClient {
    async fn view(
        &self,
        action: RunCliActionV1,
        timeout: Duration,
    ) -> Result<RunCliViewV1, BrokerFailure> {
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: next_request_id(),
            action,
        };
        self.view_request(request, timeout).await
    }

    async fn view_with_request_id(
        &self,
        action: RunCliActionV1,
        request_id: String,
        timeout: Duration,
    ) -> Result<RunCliViewV1, BrokerFailure> {
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id,
            action,
        };
        self.view_request(request, timeout).await
    }

    async fn view_request(
        &self,
        request: RunCliRequestV1,
        timeout: Duration,
    ) -> Result<RunCliViewV1, BrokerFailure> {
        request.validate().map_err(|_| BrokerFailure::Transport)?;
        let response = self
            .request(&request, timeout)
            .await
            .map_err(|_| BrokerFailure::Transport)?;
        match response.result {
            RunCliResultV1::Ok { view } => Ok(view),
            RunCliResultV1::Error { error } => Err(BrokerFailure::Remote(error.code)),
        }
    }

    async fn request(
        &self,
        request: &RunCliRequestV1,
        timeout: Duration,
    ) -> Result<RunCliResponseV1, TransportError> {
        tokio::time::timeout(timeout, self.request_once(request))
            .await
            .map_err(|_| TransportError::Unavailable)?
    }

    async fn request_once(
        &self,
        request: &RunCliRequestV1,
    ) -> Result<RunCliResponseV1, TransportError> {
        match &self.endpoint {
            BrokerEndpoint::Unix(path) => {
                let mut stream =
                    tokio::time::timeout(BROKER_CONNECT_TIMEOUT, UnixStream::connect(path))
                        .await
                        .map_err(|_| TransportError::Unavailable)?
                        .map_err(|_| TransportError::Unavailable)?;
                request_over_stream(&mut stream, request).await
            }
            BrokerEndpoint::Vsock { cid, port } => request_vsock(*cid, *port, request).await,
        }
    }
}

#[cfg(target_os = "linux")]
async fn request_vsock(
    cid: u32,
    port: u32,
    request: &RunCliRequestV1,
) -> Result<RunCliResponseV1, TransportError> {
    let mut stream = tokio::time::timeout(
        BROKER_CONNECT_TIMEOUT,
        VsockStream::connect(VsockAddr::new(cid, port)),
    )
    .await
    .map_err(|_| TransportError::Unavailable)?
    .map_err(|_| TransportError::Unavailable)?;
    request_over_stream(&mut stream, request).await
}

#[cfg(not(target_os = "linux"))]
async fn request_vsock(
    _cid: u32,
    _port: u32,
    _request: &RunCliRequestV1,
) -> Result<RunCliResponseV1, TransportError> {
    Err(TransportError::Unavailable)
}

async fn request_over_stream<S>(
    stream: &mut S,
    request: &RunCliRequestV1,
) -> Result<RunCliResponseV1, TransportError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    write_message(stream, request)
        .await
        .map_err(|_| TransportError::Unavailable)?;
    let response = read_message::<RunCliResponseV1, _>(stream)
        .await
        .map_err(|_| TransportError::Unavailable)?;
    response
        .validate()
        .map_err(|_| TransportError::InvalidResponse)?;
    if response.protocol_version != RUN_CLI_PROTOCOL_VERSION
        || response.request_id != request.request_id
    {
        return Err(TransportError::InvalidResponse);
    }
    Ok(response)
}

fn broker_failure_result(error: BrokerFailure) -> CliResult {
    match error {
        BrokerFailure::Remote(RunCliErrorCodeV1::Locked | RunCliErrorCodeV1::Unavailable) => {
            CliResult::plain(
                EXIT_LOCKED_OR_UNAVAILABLE,
                "This action is unavailable.\nNext: intar status\n",
            )
        }
        BrokerFailure::Remote(RunCliErrorCodeV1::InvalidRequest) => usage_result(),
        BrokerFailure::Remote(
            RunCliErrorCodeV1::Conflict
            | RunCliErrorCodeV1::Unauthorized
            | RunCliErrorCodeV1::ProtocolMismatch
            | RunCliErrorCodeV1::FrameTooLarge
            | RunCliErrorCodeV1::Internal,
        )
        | BrokerFailure::Transport => unavailable_result(),
    }
}

fn unavailable_result() -> CliResult {
    CliResult::failure(
        EXIT_FAILURE,
        "Intar is unavailable. Try again.\nNext: intar status\n",
    )
}

fn usage_result() -> CliResult {
    CliResult::failure(
        EXIT_USAGE,
        format!("{}\nNext: intar help\n", render_usage_line()),
    )
}

fn render_usage_line() -> &'static str {
    "Usage: intar [status|check|hints|hint <alias>|solution [reveal]|help]"
}

fn render_help() -> String {
    format!(
        "Intar run commands\n\n  intar                 Show run status\n  intar status          Show run status\n  intar check           Run fresh checks\n  intar hints           List available hints\n  intar hint <alias>    Reveal the next hint\n  intar solution        Show solution state\n  intar solution reveal Reveal the full solution\n  intar help            Show this help\n\n{}\nNext: intar status\n",
        render_usage_line()
    )
}

fn render_status(view: &RunCliViewV1, style: TerminalStyle) -> String {
    let title = display_line(&view.run.title, "Intar run");
    let mut header = format!("Intar{}{title}", style.separator());
    if let Some(context) = view.run.context.as_deref() {
        let context = display_line(context, "");
        if !context.is_empty() {
            header.push_str(style.separator());
            header.push_str(&context);
        }
    }
    let passed = view
        .checks
        .iter()
        .filter(|check| check.status == RunCliCheckStatusV1::Pass)
        .count();
    let hints_used = view
        .hint_groups
        .iter()
        .map(|group| usize::from(group.revealed_count))
        .sum::<usize>();
    let hints_total = view
        .hint_groups
        .iter()
        .map(|group| usize::from(group.total_count))
        .sum::<usize>();
    let solution = match view.solution.state {
        RunCliSolutionStateV1::Sealed => "Full solution sealed",
        RunCliSolutionStateV1::Revealed => "Full solution revealed",
        RunCliSolutionStateV1::Unavailable => "Full solution unavailable",
    };
    let solution =
        if view.solution.state == RunCliSolutionStateV1::Revealed && view.solution.assisted {
            format!("{solution}{}assisted", style.separator())
        } else {
            solution.to_owned()
        };
    format!(
        "{}\n\n{passed}/{} checks verified\n{hints_used}/{hints_total} hints used\n{solution}\n\nNext: {}\n",
        style.paint("38;5;208", &header),
        view.checks.len(),
        next_command(view),
    )
}

fn render_check_line(style: TerminalStyle, raw_label: &str, status: RunCliCheckStatusV1) -> String {
    let label = display_line(raw_label, "Check");
    let (marker, raw_word, color) = match status {
        RunCliCheckStatusV1::Pass => (style.success_marker(), "Verified", "32"),
        RunCliCheckStatusV1::Fail => (style.warning_marker(), "Needs repair", "33"),
        RunCliCheckStatusV1::Unknown => (style.warning_marker(), "Unavailable", "31"),
    };
    let marker = style.paint(color, marker);
    let word = style.paint(color, raw_word);
    if style.columns >= 60 {
        let label = truncate_chars(&label, 36);
        let padded = pad_chars(&label, 36);
        format!("{marker} {padded} {word}\n")
    } else {
        format!("{marker} {label} {word}\n")
    }
}

fn render_hints(view: &RunCliViewV1, style: TerminalStyle) -> String {
    if view.hint_groups.is_empty() {
        return format!("No hints are available.\nNext: {}\n", next_command(view));
    }
    let mut output = String::new();
    for (index, group) in view.hint_groups.iter().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        output.push_str(&style.paint("38;5;208", &display_line(&group.label, "Hints")));
        output.push('\n');
        for entry in &group.entries {
            let state = match entry.state {
                intar_contracts::run_cli::RunCliHintStateV1::Revealed => "revealed",
                intar_contracts::run_cli::RunCliHintStateV1::Ready => "ready",
                intar_contracts::run_cli::RunCliHintStateV1::Locked => "locked",
            };
            output.push_str(&format!(
                "  Hint {}{}{}\n",
                entry.ordinal,
                style.separator(),
                state
            ));
        }
        if group.can_reveal && valid_completion_candidate(&group.alias) {
            output.push_str(&format!("  Reveal: intar hint {}\n", group.alias));
        }
    }
    output.push_str(&format!("\nNext: {}\n", next_command(view)));
    output
}

fn render_revealed_hint_at(
    view: &RunCliViewV1,
    alias: &str,
    expected_ordinal: u16,
    style: TerminalStyle,
) -> CliResult {
    let Some(group) = view.hint_groups.iter().find(|group| group.alias == alias) else {
        return CliResult::plain(
            EXIT_LOCKED_OR_UNAVAILABLE,
            "This hint is unavailable.\nNext: intar status\n",
        );
    };
    let Some(entry) = group.entries.iter().find(|entry| {
        entry.ordinal == expected_ordinal
            && entry.state == intar_contracts::run_cli::RunCliHintStateV1::Revealed
            && entry.body_markdown.is_some()
    }) else {
        return CliResult::plain(
            EXIT_LOCKED_OR_UNAVAILABLE,
            "This hint is unavailable.\nNext: intar status\n",
        );
    };
    let heading = entry
        .title
        .as_deref()
        .map(|title| display_line(title, "Hint"))
        .unwrap_or_else(|| format!("Hint {}", entry.ordinal));
    let body = render_markdown(entry.body_markdown.as_deref().unwrap_or_default());
    CliResult::success(format!(
        "{}\n\n{}\nNext: {}\n",
        style.paint("38;5;208", &heading),
        body,
        next_command(view),
    ))
}

fn render_solution(view: &RunCliViewV1, style: TerminalStyle) -> CliResult {
    match view.solution.state {
        RunCliSolutionStateV1::Revealed => render_revealed_solution(view, style),
        RunCliSolutionStateV1::Sealed => CliResult::plain(
            EXIT_LOCKED_OR_UNAVAILABLE,
            "Full solution sealed.\nNext: intar solution reveal\n",
        ),
        RunCliSolutionStateV1::Unavailable => CliResult::plain(
            EXIT_LOCKED_OR_UNAVAILABLE,
            "Full solution unavailable.\nNext: intar status\n",
        ),
    }
}

fn render_revealed_solution(view: &RunCliViewV1, style: TerminalStyle) -> CliResult {
    if view.solution.state != RunCliSolutionStateV1::Revealed {
        return render_solution(view, style);
    }
    let Some(body) = view.solution.body_markdown.as_deref() else {
        return CliResult::plain(
            EXIT_LOCKED_OR_UNAVAILABLE,
            "Full solution unavailable.\nNext: intar status\n",
        );
    };
    let assisted = if view.solution.assisted {
        "\nThis run is assisted.\n"
    } else {
        "\n"
    };
    CliResult::success(format!(
        "{}{}\n{}\nNext: {}\n",
        style.paint("38;5;208", "Full solution"),
        assisted,
        render_markdown(body),
        next_command(view)
    ))
}

fn next_hint_alias(view: &RunCliViewV1) -> Option<&str> {
    view.hint_groups
        .iter()
        .find(|group| group.can_reveal && valid_completion_candidate(&group.alias))
        .map(|group| group.alias.as_str())
}

fn next_command(view: &RunCliViewV1) -> String {
    if let Some(alias) = next_hint_alias(view) {
        return format!("intar hint {alias}");
    }
    if view
        .checks
        .iter()
        .any(|check| check.status != RunCliCheckStatusV1::Pass)
    {
        return "intar check".to_owned();
    }
    if view.run.kind == intar_contracts::run_cli::RunCliRunKindV1::Scenario
        && view.solution.state == RunCliSolutionStateV1::Sealed
    {
        return "intar solution reveal".to_owned();
    }
    "intar status".to_owned()
}

fn next_request_id() -> String {
    let sequence = NEXT_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("kino-{}-{sequence}", std::process::id())
}

fn utf8_locale() -> bool {
    ["LC_ALL", "LC_CTYPE", "LANG"]
        .into_iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.is_empty()))
        .is_some_and(|value| {
            let normalized = value.to_ascii_lowercase();
            normalized.contains("utf-8") || normalized.contains("utf8")
        })
}

fn valid_completion_candidate(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn display_line(value: &str, fallback: &str) -> String {
    let value = sanitize_terminal_text(value, false);
    if value.trim().is_empty() {
        fallback.to_owned()
    } else {
        value
    }
}

fn render_markdown(value: &str) -> String {
    let sanitized = sanitize_terminal_text(value, true);
    let mut output = String::new();
    let mut in_fence = false;
    for raw_line in sanitized.lines() {
        let line = raw_line.trim_end();
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        let rendered = if !in_fence {
            line.trim_start_matches('#').trim_start()
        } else {
            line
        };
        output.push_str(rendered);
        output.push('\n');
    }
    let output = output.trim_end();
    if output.is_empty() {
        "No learner-safe content is available.\n".to_owned()
    } else {
        format!("{output}\n")
    }
}

fn sanitize_terminal_text(value: &str, allow_newlines: bool) -> String {
    let mut output = String::with_capacity(value.len().min(MAX_DISPLAY_CHARS));
    let mut previous_space = false;
    let mut displayed_chars = 0_usize;
    for character in value.chars() {
        if displayed_chars >= MAX_DISPLAY_CHARS {
            break;
        }
        if is_terminal_control_or_bidi(character) {
            if allow_newlines && character == '\n' {
                if !output.ends_with('\n') {
                    output.push('\n');
                    displayed_chars += 1;
                }
                previous_space = false;
            }
            continue;
        }
        if !allow_newlines && character.is_whitespace() {
            if !previous_space {
                output.push(' ');
                displayed_chars += 1;
                previous_space = true;
            }
            continue;
        }
        output.push(character);
        displayed_chars += 1;
        previous_space = character == ' ';
    }
    output.trim().to_owned()
}

fn is_terminal_control_or_bidi(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{061c}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
        )
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    let count = value.chars().count();
    if count <= maximum {
        value.to_owned()
    } else if maximum > 3 {
        format!("{}...", value.chars().take(maximum - 3).collect::<String>())
    } else {
        value.chars().take(maximum).collect()
    }
}

fn pad_chars(value: &str, width: usize) -> String {
    let missing = width.saturating_sub(value.chars().count());
    format!("{value}{}", " ".repeat(missing))
}

#[cfg(test)]
mod tests {
    use super::{
        BrokerEndpoint, CliResult, Command, TerminalAutoOptions, TerminalStyle, TransportError,
        check_start_line, complete_with_endpoint, deliver_result_to, parse_broker_endpoint,
        parse_command, render_check_line, render_hints, render_markdown, render_revealed_hint_at,
        render_solution, render_status, request_local_checks_at, reveal_hint_at,
        run_fresh_checks_at, sanitize_terminal_text, valid_completion_candidate,
    };
    use crate::config::{IntarProbeMetadata, ProbeConfig, ProbeKindConfig};
    use crate::probe::build_probes;
    use crate::run_cli_control::start_at;
    use crate::run_cli_pending::{PendingHintReveal, load_at, persist_at};
    use crate::run_cli_wire::{read_message, write_message};
    use crate::scheduler::ProbeExecutor;
    use crate::state::ProbeStore;
    use intar_contracts::run_cli::{
        RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliCheckStatusV1, RunCliHintGroupV1,
        RunCliHintStateV1, RunCliRequestV1, RunCliResponseV1, RunCliResultV1, RunCliRunKindV1,
        RunCliRunV1, RunCliSolutionStateV1, RunCliSolutionV1, RunCliViewV1,
    };
    use std::ffi::OsString;
    use std::io::{Error, ErrorKind, Write};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::net::UnixListener;

    fn view() -> RunCliViewV1 {
        RunCliViewV1 {
            retry_scope: "test_scope".to_owned(),
            run: RunCliRunV1 {
                kind: RunCliRunKindV1::Scenario,
                title: "Broken Nginx\u{1b}[31m".to_owned(),
                context: Some("webserver\u{202e}".to_owned()),
            },
            checks: vec![intar_contracts::run_cli::RunCliCheckV1 {
                probe_id: "private-probe-id".to_owned(),
                alias: "check-1".to_owned(),
                label: "Start the web server\u{1b}[2J".to_owned(),
                status: RunCliCheckStatusV1::Pass,
            }],
            hint_groups: vec![RunCliHintGroupV1 {
                alias: "general".to_owned(),
                label: "General guidance".to_owned(),
                revealed_count: 1,
                total_count: 2,
                can_reveal: true,
                entries: vec![
                    intar_contracts::run_cli::RunCliHintEntryV1 {
                        ordinal: 1,
                        state: RunCliHintStateV1::Revealed,
                        title: Some("A safe title".to_owned()),
                        body_markdown: Some("# Look\n\u{1b}[31mNo controls".to_owned()),
                    },
                    intar_contracts::run_cli::RunCliHintEntryV1 {
                        ordinal: 2,
                        state: RunCliHintStateV1::Ready,
                        title: None,
                        body_markdown: None,
                    },
                ],
            }],
            solution: RunCliSolutionV1 {
                state: RunCliSolutionStateV1::Sealed,
                assisted: false,
                body_markdown: None,
            },
        }
    }

    fn hint_view(first: RunCliHintStateV1, second: RunCliHintStateV1, scope: &str) -> RunCliViewV1 {
        let mut value = view();
        value.retry_scope = scope.to_owned();
        let group = &mut value.hint_groups[0];
        group.entries[0].state = first;
        group.entries[0].title =
            (first == RunCliHintStateV1::Revealed).then(|| "First hint".to_owned());
        group.entries[0].body_markdown =
            (first == RunCliHintStateV1::Revealed).then(|| "First body".to_owned());
        group.entries[1].state = second;
        group.entries[1].title =
            (second == RunCliHintStateV1::Revealed).then(|| "Second hint".to_owned());
        group.entries[1].body_markdown =
            (second == RunCliHintStateV1::Revealed).then(|| "Second body".to_owned());
        group.revealed_count = group
            .entries
            .iter()
            .filter(|entry| entry.state == RunCliHintStateV1::Revealed)
            .count() as u16;
        group.can_reveal = group
            .entries
            .iter()
            .any(|entry| entry.state == RunCliHintStateV1::Ready);
        value
    }

    async fn reply_with_view(
        stream: &mut tokio::net::UnixStream,
        request: RunCliRequestV1,
        view: RunCliViewV1,
    ) {
        let response = RunCliResponseV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: request.request_id,
            result: RunCliResultV1::Ok { view },
        };
        write_message(stream, &response)
            .await
            .expect("write view response");
    }

    #[test]
    fn parses_only_the_public_noninteractive_command_surface() {
        assert_eq!(parse_command(Vec::new()), Ok(Command::Status));
        assert_eq!(
            parse_command(vec![OsString::from("solution"), OsString::from("reveal")]),
            Ok(Command::SolutionReveal)
        );
        assert!(parse_command(vec![OsString::from("check"), OsString::from("--json")]).is_err());
        assert!(parse_command(vec![OsString::from("hint")]).is_err());
        assert!(parse_command(vec![OsString::from("solution"), OsString::from("--yes")]).is_err());
    }

    struct BrokenPipeWriter;

    impl Write for BrokenPipeWriter {
        fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
            Err(Error::from(ErrorKind::BrokenPipe))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn broken_pipe_preserves_the_semantic_exit_code() {
        let mut stderr = Vec::new();
        assert_eq!(
            deliver_result_to(
                &CliResult::plain(1, "failed checks\n"),
                &mut BrokenPipeWriter,
                &mut stderr,
            ),
            1
        );

        let mut stdout = Vec::new();
        assert_eq!(
            deliver_result_to(
                &CliResult::failure(3, "solution is sealed\n"),
                &mut stdout,
                &mut BrokenPipeWriter,
            ),
            3
        );
    }

    #[tokio::test]
    async fn broken_hint_output_keeps_the_pending_marker_for_the_same_ordinal_retry() {
        let temp = tempfile::tempdir().expect("tempdir");
        let pending_path = temp.path().join("pending.json");
        let pending = PendingHintReveal {
            retry_scope: "scope_current".to_owned(),
            alias: "general".to_owned(),
            expected_ordinal: 1,
            request_id: "kino-1-1".to_owned(),
        };
        persist_at(&pending_path, &pending).expect("persist pending");
        let revealed = hint_view(
            RunCliHintStateV1::Revealed,
            RunCliHintStateV1::Revealed,
            "scope_current",
        );
        let initial = render_revealed_hint_at(
            &revealed,
            "general",
            1,
            TerminalStyle::from_values(false, false, 80),
        )
        .clear_pending_hint_after_output(&pending_path, &pending);
        let mut stderr = Vec::new();
        assert_eq!(
            deliver_result_to(&initial, &mut BrokenPipeWriter, &mut stderr),
            0
        );
        assert_eq!(
            load_at(&pending_path).expect("pending survives pipe"),
            Some(pending)
        );

        let broker_path = temp.path().join("broker.sock");
        let listener = UnixListener::bind(&broker_path).expect("bind broker");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("status request");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("read status");
            assert_eq!(request.action, RunCliActionV1::Status);
            reply_with_view(&mut stream, request, revealed).await;
        });
        let broker = super::BrokerClient {
            endpoint: BrokerEndpoint::Unix(broker_path),
        };
        let retry = reveal_hint_at(
            &broker,
            "general".to_owned(),
            TerminalStyle::from_values(false, false, 80),
            &pending_path,
        )
        .await;
        server.await.expect("broker task");
        assert_eq!(retry.exit_code, 0);
        assert!(retry.stdout.contains("First body"));
        assert!(!retry.stdout.contains("Second body"));
        let mut stdout = Vec::new();
        assert_eq!(deliver_result_to(&retry, &mut stdout, &mut stderr), 0);
        assert_eq!(load_at(&pending_path).expect("marker cleared"), None);
    }

    #[tokio::test]
    async fn lost_hint_response_retries_the_same_ordinal_then_uses_the_next_one() {
        let temp = tempfile::tempdir().expect("tempdir");
        let broker_path = temp.path().join("broker.sock");
        let pending_path = temp.path().join("pending.json");
        let listener = UnixListener::bind(&broker_path).expect("bind broker");
        let ready_first = hint_view(
            RunCliHintStateV1::Ready,
            RunCliHintStateV1::Locked,
            "scope_current",
        );
        let revealed_first = hint_view(
            RunCliHintStateV1::Revealed,
            RunCliHintStateV1::Ready,
            "scope_current",
        );
        let revealed_both = hint_view(
            RunCliHintStateV1::Revealed,
            RunCliHintStateV1::Revealed,
            "scope_current",
        );
        let server = tokio::spawn(async move {
            let mut action_request_ids = Vec::new();

            let (mut stream, _) = listener.accept().await.expect("first status");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("first status request");
            assert_eq!(request.action, RunCliActionV1::Status);
            reply_with_view(&mut stream, request, ready_first.clone()).await;

            let (mut stream, _) = listener.accept().await.expect("lost reveal");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("lost reveal request");
            match request.action {
                RunCliActionV1::HintReveal {
                    alias,
                    expected_ordinal,
                } => {
                    assert_eq!(alias, "general");
                    assert_eq!(expected_ordinal, 1);
                    action_request_ids.push(request.request_id);
                }
                other => panic!("unexpected action: {other:?}"),
            }
            drop(stream);

            let (mut stream, _) = listener.accept().await.expect("confirmation status");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("confirmation status request");
            assert_eq!(request.action, RunCliActionV1::Status);
            reply_with_view(&mut stream, request, ready_first.clone()).await;

            let (mut stream, _) = listener.accept().await.expect("retry status");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("retry status request");
            assert_eq!(request.action, RunCliActionV1::Status);
            reply_with_view(&mut stream, request, ready_first).await;

            let (mut stream, _) = listener.accept().await.expect("retry reveal");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("retry reveal request");
            match &request.action {
                RunCliActionV1::HintReveal {
                    alias,
                    expected_ordinal,
                } => {
                    assert_eq!(alias, "general");
                    assert_eq!(*expected_ordinal, 1);
                    action_request_ids.push(request.request_id.clone());
                }
                other => panic!("unexpected action: {other:?}"),
            }
            reply_with_view(&mut stream, request, revealed_first.clone()).await;

            let (mut stream, _) = listener.accept().await.expect("fresh status");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("fresh status request");
            assert_eq!(request.action, RunCliActionV1::Status);
            reply_with_view(&mut stream, request, revealed_first).await;

            let (mut stream, _) = listener.accept().await.expect("fresh reveal");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("fresh reveal request");
            match &request.action {
                RunCliActionV1::HintReveal {
                    alias,
                    expected_ordinal,
                } => {
                    assert_eq!(alias, "general");
                    assert_eq!(*expected_ordinal, 2);
                    action_request_ids.push(request.request_id.clone());
                }
                other => panic!("unexpected action: {other:?}"),
            }
            reply_with_view(&mut stream, request, revealed_both).await;
            action_request_ids
        });

        let broker = super::BrokerClient {
            endpoint: BrokerEndpoint::Unix(broker_path),
        };
        let style = TerminalStyle::from_values(false, false, 80);
        let first = reveal_hint_at(&broker, "general".to_owned(), style, &pending_path).await;
        assert_eq!(first.exit_code, 4);
        let pending = load_at(&pending_path)
            .expect("load pending")
            .expect("pending reveal exists");
        assert_eq!(pending.retry_scope, "scope_current");
        assert_eq!(pending.expected_ordinal, 1);

        let retried = reveal_hint_at(&broker, "general".to_owned(), style, &pending_path).await;
        assert_eq!(retried.exit_code, 0);
        assert!(retried.stdout.contains("First body"));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        assert_eq!(deliver_result_to(&retried, &mut stdout, &mut stderr), 0);
        assert_eq!(load_at(&pending_path).expect("cleared pending"), None);

        let fresh = reveal_hint_at(&broker, "general".to_owned(), style, &pending_path).await;
        assert_eq!(fresh.exit_code, 0);
        assert!(fresh.stdout.contains("Second body"));
        assert_eq!(deliver_result_to(&fresh, &mut stdout, &mut stderr), 0);
        assert_eq!(load_at(&pending_path).expect("cleared fresh pending"), None);

        let request_ids = server.await.expect("broker task");
        assert_eq!(request_ids.len(), 3);
        assert_eq!(request_ids[0], request_ids[1]);
        assert_ne!(request_ids[1], request_ids[2]);
    }

    #[tokio::test]
    async fn stale_retry_scope_is_cleared_and_never_replayed_into_a_new_run() {
        let temp = tempfile::tempdir().expect("tempdir");
        let broker_path = temp.path().join("broker.sock");
        let pending_path = temp.path().join("pending.json");
        let stale = PendingHintReveal {
            retry_scope: "scope_old".to_owned(),
            alias: "general".to_owned(),
            expected_ordinal: 1,
            request_id: "kino-old-1".to_owned(),
        };
        persist_at(&pending_path, &stale).expect("persist stale action");
        let current = hint_view(
            RunCliHintStateV1::Locked,
            RunCliHintStateV1::Ready,
            "scope_new",
        );
        let completed = hint_view(
            RunCliHintStateV1::Locked,
            RunCliHintStateV1::Revealed,
            "scope_new",
        );
        let listener = UnixListener::bind(&broker_path).expect("bind broker");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("status request");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("read status");
            assert_eq!(request.action, RunCliActionV1::Status);
            reply_with_view(&mut stream, request, current).await;

            let (mut stream, _) = listener.accept().await.expect("reveal request");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("read reveal");
            match &request.action {
                RunCliActionV1::HintReveal {
                    alias,
                    expected_ordinal,
                } => {
                    assert_eq!(alias, "general");
                    assert_eq!(*expected_ordinal, 2);
                    assert_ne!(request.request_id, "kino-old-1");
                }
                other => panic!("unexpected action: {other:?}"),
            }
            reply_with_view(&mut stream, request, completed).await;
        });
        let result = reveal_hint_at(
            &super::BrokerClient {
                endpoint: BrokerEndpoint::Unix(broker_path),
            },
            "general".to_owned(),
            TerminalStyle::from_values(false, false, 80),
            &pending_path,
        )
        .await;
        server.await.expect("broker task");
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("Second body"));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        assert_eq!(deliver_result_to(&result, &mut stdout, &mut stderr), 0);
        assert_eq!(
            load_at(&pending_path).expect("cleared current marker"),
            None
        );
    }

    #[test]
    fn check_start_line_is_static_and_precedes_probe_results() {
        assert_eq!(check_start_line(1), "Checking 1 work-order item...\n");
        assert_eq!(check_start_line(2), "Checking 2 work-order items...\n");
    }

    #[test]
    fn automatic_terminal_style_falls_back_cleanly_for_plain_environments() {
        let options = |ci, no_color, clicolor_disabled, utf8| TerminalAutoOptions {
            ci,
            no_color,
            clicolor_disabled,
            utf8,
        };
        let rich = TerminalStyle::automatic(
            true,
            true,
            Some("xterm-256color"),
            options(false, false, false, true),
            80,
        );
        assert!(rich.color);
        assert!(rich.unicode);
        assert!(rich.progress);

        for style in [
            TerminalStyle::automatic(
                false,
                true,
                Some("xterm"),
                options(false, false, false, true),
                80,
            ),
            TerminalStyle::automatic(true, true, None, options(false, false, false, true), 80),
            TerminalStyle::automatic(
                true,
                true,
                Some("dumb"),
                options(false, false, false, true),
                80,
            ),
            TerminalStyle::automatic(
                true,
                true,
                Some("xterm"),
                options(true, false, false, true),
                80,
            ),
            TerminalStyle::automatic(
                true,
                true,
                Some("xterm"),
                options(false, true, false, true),
                80,
            ),
            TerminalStyle::automatic(
                true,
                true,
                Some("xterm"),
                options(false, false, true, true),
                80,
            ),
        ] {
            assert!(!style.color);
        }
        let ascii = TerminalStyle::automatic(
            true,
            true,
            Some("xterm"),
            options(false, false, false, false),
            20,
        );
        assert!(!ascii.unicode);
        assert_eq!(ascii.columns, 20);
        assert!(
            TerminalStyle::automatic(
                true,
                true,
                Some("xterm"),
                options(false, true, false, true),
                80
            )
            .progress
        );
        assert!(
            !TerminalStyle::automatic(
                true,
                false,
                Some("xterm"),
                options(false, false, false, true),
                80
            )
            .progress
        );
    }

    #[test]
    fn parses_only_private_unix_and_vsock_broker_endpoints() {
        assert_eq!(
            parse_broker_endpoint("unix:///run/intar/broker.sock"),
            Ok(BrokerEndpoint::Unix(PathBuf::from(
                "/run/intar/broker.sock"
            )))
        );
        assert_eq!(
            parse_broker_endpoint("vsock://2:18082"),
            Ok(BrokerEndpoint::Vsock {
                cid: 2,
                port: 18_082
            })
        );
        assert!(parse_broker_endpoint("tcp://127.0.0.1:1").is_err());
        assert!(parse_broker_endpoint("unix://relative.sock").is_err());
        assert!(parse_broker_endpoint("vsock://2:0").is_err());
    }

    #[test]
    fn terminal_renderer_strips_controls_bidi_and_internal_ids() {
        let style = TerminalStyle::from_values(false, false, 40);
        let rendered = render_status(&view(), style);
        assert!(!rendered.contains('\u{1b}'));
        assert!(!rendered.contains('\u{202e}'));
        assert!(!rendered.contains('·'));
        assert!(!rendered.contains("private-probe-id"));
        assert!(rendered.contains("Intar - Broken Nginx[31m - webserver"));
        assert!(rendered.contains("Broken Nginx[31m"));
        let check = render_check_line(style, "label\u{1b}[2J", RunCliCheckStatusV1::Fail);
        assert_eq!(check, "[!] label[2J Needs repair\n");
    }

    #[test]
    fn markdown_renderer_and_solution_state_are_safe_and_noninteractive() {
        let rendered = render_markdown("# Heading\n```sh\necho hi\n```\n\u{1b}[2Jdone");
        assert_eq!(rendered, "Heading\necho hi\n[2Jdone\n");
        let result = render_solution(&view(), TerminalStyle::from_values(false, false, 80));
        assert_eq!(result.exit_code, 3);
        assert!(result.stdout.contains("intar solution reveal"));
    }

    #[test]
    fn markdown_renderer_does_not_silently_truncate_valid_broker_content() {
        let body = "x".repeat(20_000);
        let rendered = render_markdown(&body);
        assert_eq!(rendered, format!("{body}\n"));
    }

    #[test]
    fn status_and_hints_choose_one_non_looping_next_command() {
        let mut multiple_ready = view();
        multiple_ready.hint_groups.push(RunCliHintGroupV1 {
            alias: "check-2".to_owned(),
            label: "Second guidance".to_owned(),
            revealed_count: 0,
            total_count: 1,
            can_reveal: true,
            entries: vec![intar_contracts::run_cli::RunCliHintEntryV1 {
                ordinal: 1,
                state: RunCliHintStateV1::Ready,
                title: None,
                body_markdown: None,
            }],
        });
        let rendered_hints = render_hints(
            &multiple_ready,
            TerminalStyle::from_values(false, false, 80),
        );
        assert_eq!(rendered_hints.matches("Next:").count(), 1);
        assert!(rendered_hints.contains("Reveal: intar hint general"));
        assert!(rendered_hints.contains("Reveal: intar hint check-2"));

        let mut exhausted = multiple_ready.clone();
        for group in &mut exhausted.hint_groups {
            group.can_reveal = false;
            for entry in &mut group.entries {
                if entry.state == RunCliHintStateV1::Ready {
                    entry.state = RunCliHintStateV1::Locked;
                }
            }
        }
        let exhausted_hints =
            render_hints(&exhausted, TerminalStyle::from_values(false, false, 80));
        assert_eq!(exhausted_hints.matches("Next:").count(), 1);

        let mut zero_checks = view();
        zero_checks.checks.clear();
        zero_checks.hint_groups.clear();
        zero_checks.solution.state = RunCliSolutionStateV1::Unavailable;
        let zero_status = render_status(&zero_checks, TerminalStyle::from_values(false, false, 80));
        assert!(zero_status.contains("Next: intar status"));

        let mut all_passed_workshop = zero_checks;
        all_passed_workshop.run.kind = RunCliRunKindV1::Workshop;
        all_passed_workshop
            .checks
            .push(intar_contracts::run_cli::RunCliCheckV1 {
                probe_id: "check".to_owned(),
                alias: "check-1".to_owned(),
                label: "Check".to_owned(),
                status: RunCliCheckStatusV1::Pass,
            });
        let all_passed_status = render_status(
            &all_passed_workshop,
            TerminalStyle::from_values(false, false, 80),
        );
        assert!(all_passed_status.contains("Next: intar status"));
        let no_hint_list = render_hints(
            &all_passed_workshop,
            TerminalStyle::from_values(false, false, 80),
        );
        assert!(no_hint_list.contains("Next: intar status"));
    }

    #[test]
    fn completion_candidates_are_deliberately_shell_safe() {
        assert!(valid_completion_candidate("check-3"));
        assert!(valid_completion_candidate("group-v1"));
        assert!(!valid_completion_candidate("group.v1"));
        assert!(!valid_completion_candidate("bad alias"));
        assert!(!valid_completion_candidate("$(whoami)"));
    }

    #[test]
    fn text_sanitizing_preserves_plain_words_only() {
        assert_eq!(
            sanitize_terminal_text(" one\t\u{1b}[31m two\u{202e}", false),
            "one[31m two"
        );
    }

    #[tokio::test]
    async fn broker_client_rejects_a_response_for_a_different_request() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let server_task = tokio::spawn(async move {
            let request = read_message::<RunCliRequestV1, _>(&mut server)
                .await
                .expect("request");
            let response = RunCliResponseV1 {
                protocol_version: RUN_CLI_PROTOCOL_VERSION,
                request_id: format!("{}-wrong", request.request_id),
                result: RunCliResultV1::Ok { view: view() },
            };
            write_message(&mut server, &response)
                .await
                .expect("response");
        });
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "request-1".to_owned(),
            action: RunCliActionV1::Status,
        };
        let result = super::request_over_stream(&mut client, &request).await;
        assert!(result.is_err());
        server_task.await.expect("server task");
    }

    #[tokio::test]
    async fn completion_reads_only_ready_safe_aliases() {
        let temp = tempfile::tempdir().expect("tempdir");
        let socket_path = temp.path().join("broker.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind broker socket");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept CLI request");
            let request = read_message::<RunCliRequestV1, _>(&mut stream)
                .await
                .expect("read status request");
            assert_eq!(request.action, RunCliActionV1::Status);
            let mut response_view = view();
            response_view.hint_groups.push(RunCliHintGroupV1 {
                alias: "sealed-group".to_owned(),
                label: "Sealed".to_owned(),
                revealed_count: 0,
                total_count: 1,
                can_reveal: false,
                entries: vec![intar_contracts::run_cli::RunCliHintEntryV1 {
                    ordinal: 1,
                    state: RunCliHintStateV1::Locked,
                    title: None,
                    body_markdown: None,
                }],
            });
            let response = RunCliResponseV1 {
                protocol_version: RUN_CLI_PROTOCOL_VERSION,
                request_id: request.request_id,
                result: RunCliResultV1::Ok {
                    view: response_view,
                },
            };
            write_message(&mut stream, &response)
                .await
                .expect("write response");
        });
        let result = complete_with_endpoint(
            Some(BrokerEndpoint::Unix(socket_path)),
            2,
            vec!["intar".to_owned(), "hint".to_owned(), String::new()],
        )
        .await;
        server.await.expect("broker task");
        assert_eq!(result.exit_code, 0);
        assert!(result.stderr.is_empty());
        assert_eq!(result.stdout, "general\n");
    }

    #[tokio::test]
    async fn check_selects_broker_checks_runs_local_kino_and_syncs_afterward() {
        let temp = tempfile::tempdir().expect("tempdir");
        let control_path = temp.path().join("kino-control.sock");
        let config = ProbeConfig {
            id: "private-probe-id".to_owned(),
            every: Duration::from_secs(60),
            timeout: Duration::from_secs(1),
            intar: IntarProbeMetadata::default(),
            kind: ProbeKindConfig::FileExists {
                path: "/dev/null".into(),
            },
        };
        let probes = build_probes(&[config])
            .await
            .expect("build probe")
            .into_iter()
            .map(Arc::new)
            .collect::<Vec<_>>();
        let control = start_at(
            control_path.clone(),
            ProbeExecutor::new(&probes),
            ProbeStore::new(&probes),
        )
        .await
        .expect("start control socket");

        let broker_path = temp.path().join("broker.sock");
        let listener = UnixListener::bind(&broker_path).expect("bind broker socket");
        let server = tokio::spawn(async move {
            for expected in [RunCliActionV1::Status, RunCliActionV1::CheckSync] {
                let (mut stream, _) = listener.accept().await.expect("accept CLI request");
                let request = read_message::<RunCliRequestV1, _>(&mut stream)
                    .await
                    .expect("read CLI request");
                assert_eq!(request.action, expected);
                let response = RunCliResponseV1 {
                    protocol_version: RUN_CLI_PROTOCOL_VERSION,
                    request_id: request.request_id,
                    result: RunCliResultV1::Ok { view: view() },
                };
                write_message(&mut stream, &response)
                    .await
                    .expect("write broker response");
            }
        });

        let broker = super::BrokerClient {
            endpoint: BrokerEndpoint::Unix(broker_path),
        };
        let result = run_fresh_checks_at(
            &broker,
            TerminalStyle::from_values(false, false, 80),
            &control_path,
        )
        .await;
        server.await.expect("broker task");
        control.shutdown().await;

        assert_eq!(result.exit_code, 0);
        assert!(!result.stdout.contains("Checking 1 work-order item..."));
        assert!(result.stdout.contains("[OK] Start the web server[2J"));
        assert!(result.stdout.contains("1/1 checks verified"));
        assert!(!result.stdout.contains("private-probe-id"));
    }

    #[tokio::test]
    async fn streamed_probe_output_closed_is_preserved_for_immediate_cancellation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let socket_path = temp.path().join("kino-control.sock");
        let config = ProbeConfig {
            id: "private-probe-id".to_owned(),
            every: Duration::from_secs(60),
            timeout: Duration::from_secs(1),
            intar: IntarProbeMetadata::default(),
            kind: ProbeKindConfig::FileExists {
                path: "/dev/null".into(),
            },
        };
        let probes = build_probes(&[config])
            .await
            .expect("build probe")
            .into_iter()
            .map(Arc::new)
            .collect::<Vec<_>>();
        let control = start_at(
            socket_path.clone(),
            ProbeExecutor::new(&probes),
            ProbeStore::new(&probes),
        )
        .await
        .expect("start control socket");
        let result =
            request_local_checks_at(&socket_path, vec!["private-probe-id".to_owned()], |_| {
                Err(TransportError::OutputClosed)
            })
            .await;
        assert!(matches!(result, Err(TransportError::OutputClosed)));
        control.shutdown().await;
    }
}
