//! `kino init`: the guest supervisor of guest contract 3 (#309).
//!
//! The image's one unit mounts the run disk and executes this from it. It
//! applies `boot.json`, reports over `kino.v2`, releases the lab, runs the
//! `ready` scripts and then the tasks (learn) or verify.
//!
//! The state is the `kino.v2` `Report` itself; every change is sent to the
//! host, and the latest report again every 10 s.

mod boot;
mod exec;
mod park;
mod verify;
mod wire;

#[cfg(test)]
mod tests;

use intar_contracts::guest::{BOOT_JSON_FILENAME, GUEST_CONTRACT, GuestBootV3, RUN_DISK_MOUNT};
use intar_contracts::scenario::{MachineSpecV1, ScriptV1, SpecMode, SpecTaskV1};
use intar_kino_proto::kino_v2::{Phase, Ready, Report, Status, Task, Verify};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::watch;

/// Root-only, on tmpfs: the run disk is noexec.
const SCRIPT_DIR: &str = "/run/intar/scripts";

const READY_INTERVAL: Duration = Duration::from_millis(250);
/// One second under test, where a failing script should not take 300.
const READY_TOTAL: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 300 });
const TASK_INTERVAL: Duration = Duration::from_secs(2);
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a failure report gets to reach the host before the guest powers
/// off.
const FAILURE_LINGER: Duration = Duration::from_secs(3);
/// `Ready.tail` and `Report.failure` caps in `kino.v2`.
const READY_TAIL_BYTES: usize = 2048;
const FAILURE_BYTES: usize = 1024;

pub(crate) async fn main() -> anyhow::Result<()> {
    let (report, changes) = watch::channel(Report {
        contract: GUEST_CONTRACT,
        kino_version: env!("CARGO_PKG_VERSION").to_owned(),
        ..Report::default()
    });
    boot::mark(&report, Phase::Booting, "kino_started");
    let publisher = tokio::spawn(wire::publish(changes));

    let boot = match read_boot() {
        Ok(boot) => boot,
        Err(error) => return fail(&report, error).await,
    };
    if let Err(error) = boot::bring_up(&boot, &report).await {
        return fail(&report, error).await;
    }
    boot::release_lab(&report).await;
    run(
        &boot.spec,
        boot.mode,
        &peers_of(&boot),
        Path::new(SCRIPT_DIR),
        &report,
    )
    .await;
    if Path::new(RUN_DISK_MOUNT).join(CAPTURE_FILENAME).exists() {
        // The publisher would reconnect after a restore and repeat this
        // boot's report into another run.
        publisher.abort();
        let _ = publisher.await;
        let Err(error) = park::park(&boot).await;
        anyhow::bail!("park: {error}");
    }
    // The supervisor stays up after its work: the report stream is the VM's
    // heartbeat.
    std::future::pending::<()>().await;
    Ok(())
}

/// The other machines of the run, for verify's barrier.
fn peers_of(boot: &GuestBootV3) -> Vec<String> {
    boot.peers.keys().cloned().collect()
}

pub(crate) use park::parked;

/// On the run disk of a capture boot: this guest is snapshotted once it is
/// up and quiet, and every run of its image and shape starts from there.
const CAPTURE_FILENAME: &str = "capture";

/// A failure before `SSH_READY`: report it, then exit so the unit's
/// `FailureAction` powers the guest off.
async fn fail(report: &watch::Sender<Report>, error: String) -> anyhow::Result<()> {
    eprintln!("kino init: {error}");
    report.send_modify(|report| {
        report.set_phase(Phase::Failed);
        report.failure = head(&error, FAILURE_BYTES).to_owned();
    });
    tokio::time::sleep(FAILURE_LINGER).await;
    anyhow::bail!("{error}")
}

/// `boot.json`.
fn read_boot() -> Result<GuestBootV3, String> {
    let path = Path::new(RUN_DISK_MOUNT).join(BOOT_JSON_FILENAME);
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let boot: GuestBootV3 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is invalid: {error}", path.display()))?;
    if boot.contract != GUEST_CONTRACT {
        return Err(format!(
            "boot.json is guest contract {}, this Kino speaks {GUEST_CONTRACT}",
            boot.contract
        ));
    }
    Ok(boot)
}

pub(crate) async fn run(
    spec: &MachineSpecV1,
    mode: SpecMode,
    peers: &[String],
    dir: &Path,
    report: &watch::Sender<Report>,
) {
    report.send_modify(|report| {
        report.ready = spec
            .ready
            .iter()
            .map(|ready| Ready {
                name: ready.name.clone(),
                ..Ready::default()
            })
            .collect();
        report.tasks = spec
            .tasks
            .iter()
            .map(|task| Task {
                id: task.id.clone(),
                ..Task::default()
            })
            .collect();
    });
    if !run_ready(&spec.ready, &spec.env, dir, report).await {
        // After SSH_READY this is a lab failure: the VM stays up.
        report.send_modify(|report| {
            report.set_phase(Phase::Failed);
            if mode == SpecMode::Verify {
                report.verify = Some(Verify {
                    done: true,
                    ..Verify::default()
                });
            }
        });
        return;
    }
    // Tasks start only after READY.
    boot::mark(report, Phase::Ready, "ready");
    match mode {
        SpecMode::Learn => run_tasks(&spec.tasks, &spec.env, dir, report).await,
        SpecMode::Verify => verify::run(spec, peers, dir, report).await,
    }
}

/// Each script every 250 ms until it exits 0, all within 300 s.
async fn run_ready(
    scripts: &[ScriptV1],
    env: &BTreeMap<String, String>,
    dir: &Path,
    report: &watch::Sender<Report>,
) -> bool {
    let deadline = Instant::now() + READY_TOTAL;
    for (index, script) in scripts.iter().enumerate() {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let outcome =
                exec::run(dir, &format!("ready-{index}"), &script.script, env, left).await;
            let passed = outcome.status == Status::Pass;
            let out_of_time = Instant::now() + READY_INTERVAL >= deadline;
            // A retry that fails the same way is not news: a report per
            // attempt would queue up on the host ahead of the one that says
            // the script passed.
            report.send_if_modified(|report| {
                let mut next = report.ready[index].clone();
                next.set_status(if passed || out_of_time {
                    outcome.status
                } else {
                    Status::Pending
                });
                next.tail = tail(&outcome.tail, READY_TAIL_BYTES).to_owned();
                let failed = !passed && out_of_time;
                let changed = failed || report.ready[index] != next;
                report.ready[index] = next;
                if failed {
                    report.failure = format!("ready '{}' did not pass", script.name);
                }
                changed
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

/// Run the unlatched tasks together every 2 s; the first pass latches a
/// task. Returns once every task is latched.
async fn run_tasks(
    tasks: &[SpecTaskV1],
    env: &BTreeMap<String, String>,
    dir: &Path,
    report: &watch::Sender<Report>,
) {
    let mut latched = vec![false; tasks.len()];
    while latched.contains(&false) {
        let round = tasks
            .iter()
            .enumerate()
            .filter(|(index, _)| !latched[*index])
            .map(|(index, task)| async move {
                let name = format!("task-{index}");
                let outcome = exec::run(dir, &name, &task.check, env, CHECK_TIMEOUT).await;
                (index, outcome)
            });
        for (index, outcome) in futures_util::future::join_all(round).await {
            latched[index] = outcome.status == Status::Pass;
            let mut next = Task {
                id: tasks[index].id.clone(),
                message: outcome.message,
                passed_at_unix_ms: if latched[index] { unix_ms() } else { 0 },
                ..Task::default()
            };
            next.set_status(outcome.status);
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
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// The first `limit` bytes of `value`, cut at a character boundary.
pub(crate) fn head(value: &str, limit: usize) -> &str {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// The last `limit` bytes of `value`, cut at a character boundary.
pub(crate) fn tail(value: &str, limit: usize) -> &str {
    let mut start = value.len().saturating_sub(limit);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}
