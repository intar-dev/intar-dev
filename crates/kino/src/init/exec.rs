//! The executor: write a script into a root-only directory and run it with
//! `bash -euo pipefail` in its own process group, under a deadline.

use super::Status;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

/// The learner message of a failing `run` with no `FAIL:` line (T4 finding 3).
pub(crate) const DEFAULT_MESSAGE: &str = "Not done yet.";
/// `Task.message` cap in `kino.v2`.
const MESSAGE_BYTES: usize = 512;
/// `Step.tail` cap in `kino.v2`; `Ready.tail` is cut further by the encoder.
const TAIL_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub(crate) status: Status,
    pub(crate) exit: Option<i32>,
    /// Learner-safe: only the first `FAIL:` line, or [`DEFAULT_MESSAGE`].
    pub(crate) message: String,
    /// Admin-only: the end of stdout and stderr, or why the script did not run.
    pub(crate) tail: String,
}

/// Write `script` to `dir/<name>.sh` and run it. A non-zero exit is `FAIL`; a
/// script that cannot start or outlives `timeout` is `ERROR`.
pub(crate) async fn run(dir: &Path, name: &str, script: &str, timeout: Duration) -> Outcome {
    let output = match write_script(dir, name, script) {
        Ok(path) => tokio::time::timeout(timeout, run_bash(&path)).await,
        Err(error) => return error_outcome(format!("failed to write script: {error}")),
    };
    match output {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let pass = output.status.success();
            Outcome {
                status: if pass { Status::Pass } else { Status::Fail },
                exit: output.status.code(),
                message: if pass {
                    String::new()
                } else {
                    fail_message(&stdout)
                },
                tail: tail(&stdout, &String::from_utf8_lossy(&output.stderr)),
            }
        }
        Ok(Err(error)) => error_outcome(format!("failed to run: {error}")),
        Err(_) => error_outcome(format!("timed out after {}s", timeout.as_secs())),
    }
}

fn error_outcome(tail: String) -> Outcome {
    Outcome {
        status: Status::Error,
        exit: None,
        message: String::new(),
        tail,
    }
}

/// The run disk is read-only and noexec, so scripts are copied out first.
fn write_script(dir: &Path, name: &str, content: &str) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let path = dir.join(format!("{name}.sh"));
    std::io::Write::write_all(
        &mut std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o700)
            .open(&path)?,
        content.as_bytes(),
    )?;
    Ok(path)
}

/// Dropping the future (the deadline) kills the child; on Linux the guard
/// kills its whole process group too.
///
/// ponytail: output is collected whole, then cut to a tail; stream into a ring
/// buffer if a real scenario prints gigabytes inside its timeout.
async fn run_bash(script: &Path) -> std::io::Result<std::process::Output> {
    let mut command = Command::new("bash");
    command
        .arg("-euo")
        .arg("pipefail")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "linux")]
    command.process_group(0);
    let child = command.spawn()?;
    #[cfg(target_os = "linux")]
    let mut group = crate::probe::ProcessGroupKillGuard::new(child.id());
    let output = child.wait_with_output().await;
    #[cfg(target_os = "linux")]
    group.disarm();
    output
}

/// The first stdout line starting with `FAIL:`, else [`DEFAULT_MESSAGE`].
pub(crate) fn fail_message(stdout: &str) -> String {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix("FAIL:"))
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map_or_else(
            || DEFAULT_MESSAGE.to_owned(),
            |message| head(message, MESSAGE_BYTES).to_owned(),
        )
}

fn tail(stdout: &str, stderr: &str) -> String {
    let combined = match (stdout.is_empty(), stderr.is_empty()) {
        (_, true) => stdout.to_owned(),
        (true, false) => stderr.to_owned(),
        (false, false) => format!("{}\n{stderr}", stdout.trim_end_matches('\n')),
    };
    let mut start = combined.len().saturating_sub(TAIL_BYTES);
    while !combined.is_char_boundary(start) {
        start += 1;
    }
    combined[start..].to_owned()
}

fn head(value: &str, limit: usize) -> &str {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
