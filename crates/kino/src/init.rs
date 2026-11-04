//! `kino init`, first cut (#309, re-cut from the T4 spike in #290): run the
//! lab's `ready` scripts, report `READY`, then run tasks (learn) or verify.
//!
//! Not here yet: the report channel and `kino.v2`, network, root resize, SSH,
//! the recording disk and the lab release (steps 1–6 of `kino init`). Until
//! the report channel exists, each report change is printed as one JSON line.

mod exec;
mod verify;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::watch;

/// `boot.json` on the run disk the guest loader mounted.
const BOOT_PATH: &str = "/run/intar/run/boot.json";
/// Root-only, on tmpfs: the run disk is noexec.
const SCRIPT_DIR: &str = "/run/intar/scripts";

const READY_INTERVAL: Duration = Duration::from_secs(2);
const READY_TOTAL: Duration = Duration::from_secs(300);
const TASK_INTERVAL: Duration = Duration::from_secs(5);
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// The part of `GuestBootV3` (#307) that `kino init` reads so far. The
/// compiler has already lowered sugar (`http`, files, ...) into `run` scripts,
/// so Kino knows no check kinds.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Boot {
    pub(crate) machine: String,
    pub(crate) mode: Mode,
    #[serde(default)]
    pub(crate) ready: Vec<ReadyScript>,
    #[serde(default)]
    pub(crate) tasks: Vec<Task>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Mode {
    Learn,
    Verify,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReadyScript {
    pub(crate) name: String,
    pub(crate) run: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Task {
    pub(crate) id: String,
    /// The check: exit 0 passes; otherwise the first `FAIL:` line is the
    /// learner message.
    pub(crate) run: String,
    /// `task` on this machine, `machine/task` on a peer.
    #[serde(default)]
    pub(crate) needs: Vec<String>,
    /// Verify only. Without it the task is implied: it must pass once its
    /// `needs` are solved (T4 finding 1).
    #[serde(default)]
    pub(crate) solve: Option<String>,
}

/// Mirrors `kino.v2`'s enums and messages; the learner path is `Task` only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum Phase {
    #[default]
    Preparing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum Status {
    #[default]
    Pending,
    Pass,
    Fail,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct Report {
    pub(crate) phase: Phase,
    pub(crate) ready: Vec<ReadyState>,
    pub(crate) tasks: Vec<TaskState>,
    pub(crate) verify: Option<verify::Verify>,
    pub(crate) failure: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct ReadyState {
    pub(crate) name: String,
    pub(crate) status: Status,
    pub(crate) tail: String,
}

/// No `observed` field: a learner sees the status and the message only
/// (T4 finding 2).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct TaskState {
    pub(crate) id: String,
    pub(crate) status: Status,
    pub(crate) message: String,
    pub(crate) passed_at_unix_ms: u64,
}

pub(crate) async fn main() -> anyhow::Result<()> {
    let bytes = std::fs::read(BOOT_PATH)
        .map_err(|error| anyhow::anyhow!("failed to read {BOOT_PATH}: {error}"))?;
    let boot: Boot = serde_json::from_slice(&bytes)
        .map_err(|error| anyhow::anyhow!("{BOOT_PATH} is invalid: {error}"))?;
    let (report, mut changes) = watch::channel(Report::default());
    tokio::spawn(async move {
        while changes.changed().await.is_ok() {
            if let Ok(line) = serde_json::to_string(&*changes.borrow_and_update()) {
                println!("{line}");
            }
        }
    });
    run(&boot, Path::new(SCRIPT_DIR), &report).await;
    // `kino init` is the guest supervisor: it stays up after its work.
    std::future::pending::<()>().await;
    Ok(())
}

pub(crate) async fn run(boot: &Boot, dir: &Path, report: &watch::Sender<Report>) {
    report.send_modify(|report| {
        report.ready = boot
            .ready
            .iter()
            .map(|ready| ReadyState {
                name: ready.name.clone(),
                ..ReadyState::default()
            })
            .collect();
        report.tasks = boot
            .tasks
            .iter()
            .map(|task| TaskState {
                id: task.id.clone(),
                ..TaskState::default()
            })
            .collect();
    });
    if !run_ready(&boot.ready, dir, report).await {
        report.send_modify(|report| {
            report.phase = Phase::Failed;
            if boot.mode == Mode::Verify {
                report.verify = Some(verify::Verify::failed());
            }
        });
        return;
    }
    // Tasks start only after READY (T4 finding 5).
    report.send_modify(|report| report.phase = Phase::Ready);
    match boot.mode {
        Mode::Learn => run_tasks(&boot.tasks, dir, report).await,
        Mode::Verify => verify::run(boot, dir, report).await,
    }
}

/// Each script every 2 s until it exits 0, all within 300 s.
async fn run_ready(scripts: &[ReadyScript], dir: &Path, report: &watch::Sender<Report>) -> bool {
    let deadline = Instant::now() + READY_TOTAL;
    for (index, script) in scripts.iter().enumerate() {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let outcome = exec::run(dir, &format!("ready-{index}"), &script.run, left).await;
            let passed = outcome.status == Status::Pass;
            let out_of_time = Instant::now() + READY_INTERVAL >= deadline;
            report.send_modify(|report| {
                let state = &mut report.ready[index];
                state.status = if passed || out_of_time {
                    outcome.status
                } else {
                    Status::Pending
                };
                state.tail = outcome.tail;
                if !passed && out_of_time {
                    report.failure = format!("ready '{}' did not pass", script.name);
                }
            });
            if passed {
                break;
            }
            if out_of_time {
                return false;
            }
            tokio::time::sleep(READY_INTERVAL).await;
        }
    }
    true
}

/// Run each unlatched task every 5 s; the first pass latches it. Returns once
/// every task is latched.
///
/// ponytail: tasks run one after another, so many slow checks stretch the 5 s
/// round; run them concurrently if a scenario needs that.
async fn run_tasks(tasks: &[Task], dir: &Path, report: &watch::Sender<Report>) {
    let mut latched = vec![false; tasks.len()];
    while latched.contains(&false) {
        for (index, task) in tasks.iter().enumerate() {
            if latched[index] {
                continue;
            }
            let outcome = exec::run(dir, &format!("task-{index}"), &task.run, CHECK_TIMEOUT).await;
            latched[index] = outcome.status == Status::Pass;
            let next = TaskState {
                id: task.id.clone(),
                status: outcome.status,
                message: outcome.message,
                passed_at_unix_ms: if latched[index] { unix_ms() } else { 0 },
            };
            report.send_if_modified(|report| {
                let changed = report.tasks[index] != next;
                report.tasks[index] = next;
                changed
            });
        }
        if latched.contains(&false) {
            tokio::time::sleep(TASK_INTERVAL).await;
        }
    }
}

fn unix_ms() -> u64 {
    crate::state::unix_time_ms(SystemTime::now())
}
