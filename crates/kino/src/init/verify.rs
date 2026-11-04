//! Verify mode, single machine (§5.3 in #309): every pre-check before any
//! solve, then each task in dependency order: solve, then poll its check.
//!
//! T13 spike: multi-machine verify with `PeerTasks` from the host (§5.3): a
//! pre barrier over `boot.peers`, peer needs waited on with `waiting_for`
//! set, and a peer in `failed` ends this machine's verify. Without `peers`, a
//! task that needs a peer's task stops verify with `waiting_for` set.

use super::{Boot, CHECK_TIMEOUT, Report, Status, exec};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::watch;

const SOLVE_TIMEOUT: Duration = Duration::from_secs(600);
const POST_WINDOW: Duration = Duration::from_secs(120);
const POST_INTERVAL: Duration = Duration::from_secs(2);
const PEER_WAIT: Duration = Duration::from_secs(900);

/// `kino.v2` `PeerTasks`, as a JSON host frame `{"peer_tasks": {...}}`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub(crate) struct PeerTasks {
    pub(crate) passed: BTreeMap<String, Vec<String>>,
    pub(crate) pre_done: Vec<String>,
    pub(crate) failed: Vec<String>,
}

#[derive(Deserialize)]
struct HostFrame {
    peer_tasks: PeerTasks,
}

/// ponytail: one process-wide channel; a test or a second run would share it.
fn peers() -> &'static watch::Sender<PeerTasks> {
    static PEERS: OnceLock<watch::Sender<PeerTasks>> = OnceLock::new();
    PEERS.get_or_init(|| watch::channel(PeerTasks::default()).0)
}

pub(crate) fn set_peers(peer_tasks: PeerTasks) {
    peers().send_replace(peer_tasks);
}

/// Read JSON host frames off the report connection.
pub(crate) async fn read_host_frames(read: impl tokio::io::AsyncRead + Unpin) {
    use tokio::io::AsyncBufReadExt as _;
    let mut lines = tokio::io::BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(frame) = serde_json::from_str::<HostFrame>(&line) {
            set_peers(frame.peer_tasks);
        }
    }
}

fn need_passed(peers: &PeerTasks, need: &str) -> bool {
    need.split_once('/').is_some_and(|(machine, task)| {
        peers
            .passed
            .get(machine)
            .is_some_and(|ids| ids.iter().any(|id| id == task))
    })
}

async fn wait_peers(test: impl FnMut(&PeerTasks) -> bool) -> bool {
    let mut rx = peers().subscribe();
    matches!(
        tokio::time::timeout(PEER_WAIT, rx.wait_for(test)).await,
        Ok(Ok(_))
    )
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct Verify {
    pub(crate) steps: Vec<Step>,
    pub(crate) done: bool,
    pub(crate) passed: bool,
    pub(crate) pre_done: bool,
}

impl Verify {
    pub(crate) fn failed() -> Self {
        Self {
            done: true,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct Step {
    pub(crate) task_id: String,
    pub(crate) pre: Status,
    pub(crate) solve_exit: Option<i32>,
    pub(crate) post: Status,
    pub(crate) duration_ms: u64,
    /// Admin-only.
    pub(crate) tail: String,
    pub(crate) waiting_for: Vec<String>,
    /// When the solve (or, for an implied task, the check) began.
    pub(crate) started_unix_ms: u64,
}

pub(crate) async fn run(boot: &Boot, dir: &Path, report: &watch::Sender<Report>) {
    let mut verify = Verify {
        steps: boot
            .tasks
            .iter()
            .map(|task| Step {
                task_id: task.id.clone(),
                ..Step::default()
            })
            .collect(),
        ..Verify::default()
    };
    let passed = if boot.peers.is_empty() {
        steps(boot, dir, report, &mut verify).await
    } else {
        let mut failed_peer = None;
        let passed = tokio::select! {
            passed = steps(boot, dir, report, &mut verify) => passed,
            _ = async {
                let mut rx = peers().subscribe();
                rx.wait_for(|peers| {
                    failed_peer = peers.failed.first().cloned();
                    failed_peer.is_some()
                })
                .await
                .map(|_| ())
            } => false,
        };
        if let Some(peer) = failed_peer {
            report.send_modify(|report| report.failure = format!("peer '{peer}' failed verify"));
        }
        passed
    };
    verify.done = true;
    verify.passed = passed;
    report.send_modify(|report| report.verify = Some(verify));
}

async fn steps(
    boot: &Boot,
    dir: &Path,
    report: &watch::Sender<Report>,
    verify: &mut Verify,
) -> bool {
    let publish = |verify: &Verify| {
        let verify = verify.clone();
        report.send_modify(|report| report.verify = Some(verify));
    };
    let order = match topo_order(boot) {
        Ok(order) => order,
        Err(error) => {
            report.send_modify(|report| report.failure = error);
            return false;
        }
    };

    // Pre: a task with a solve must not pass before it. Implied tasks skip it.
    for (index, task) in boot.tasks.iter().enumerate() {
        if task.solve.is_none() {
            continue;
        }
        let pre = exec::run(dir, &format!("check-{index}"), &task.run, CHECK_TIMEOUT).await;
        let step = &mut verify.steps[index];
        step.pre = pre.status;
        if pre.status != Status::Fail {
            step.tail = match pre.status {
                Status::Pass => "passes before solve".to_owned(),
                _ => pre.tail,
            };
            return false;
        }
    }
    verify.pre_done = true;
    publish(verify);
    // The pre barrier: no machine solves before every machine's pre-checks ran.
    if !boot.peers.is_empty()
        && !wait_peers(|peers| boot.peers.iter().all(|peer| peers.pre_done.contains(peer))).await
    {
        report.send_modify(|report| report.failure = "peers did not finish pre-checks".into());
        return false;
    }

    for index in order {
        let task = &boot.tasks[index];
        let waiting_for: Vec<String> = task
            .needs
            .iter()
            .filter(|need| local_need(need, &boot.machine).is_none())
            .cloned()
            .collect();
        if !waiting_for.is_empty() {
            verify.steps[index].waiting_for = waiting_for.clone();
            if boot.peers.is_empty() {
                return false;
            }
            publish(verify);
            if !wait_peers(|peers| waiting_for.iter().all(|need| need_passed(peers, need))).await {
                return false;
            }
            verify.steps[index].waiting_for.clear();
        }
        let started = Instant::now();
        verify.steps[index].started_unix_ms = super::unix_ms();
        publish(verify);
        if let Some(solve) = &task.solve {
            let run = exec::run(dir, &format!("solve-{index}"), solve, SOLVE_TIMEOUT).await;
            let step = &mut verify.steps[index];
            step.solve_exit = run.exit;
            step.tail = run.tail;
            if run.status != Status::Pass {
                return false;
            }
        }
        let post = poll_check(dir, index, &task.run).await;
        let step = &mut verify.steps[index];
        step.post = post.status;
        step.duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        if post.status != Status::Pass {
            step.tail = post.tail;
            return false;
        }
        publish(verify);
    }
    true
}

async fn poll_check(dir: &Path, index: usize, script: &str) -> exec::Outcome {
    let deadline = Instant::now() + POST_WINDOW;
    loop {
        let outcome = exec::run(dir, &format!("check-{index}"), script, CHECK_TIMEOUT).await;
        if outcome.status == Status::Pass || Instant::now() + POST_INTERVAL >= deadline {
            return outcome;
        }
        tokio::time::sleep(POST_INTERVAL).await;
    }
}

/// The local task id a need names, or `None` for a peer's task.
pub(crate) fn local_need<'a>(need: &'a str, machine: &str) -> Option<&'a str> {
    match need.split_once('/') {
        None => Some(need),
        Some((owner, task)) if owner == machine => Some(task),
        Some(_) => None,
    }
}

/// Task indices in dependency order; ties keep `boot.json` order.
///
/// ponytail: O(n²) scan, fine for the handful of tasks a machine has.
pub(crate) fn topo_order(boot: &Boot) -> Result<Vec<usize>, String> {
    let index_of = |id: &str| boot.tasks.iter().position(|task| task.id == id);
    let mut deps = Vec::with_capacity(boot.tasks.len());
    for (index, task) in boot.tasks.iter().enumerate() {
        if index_of(&task.id) != Some(index) {
            return Err(format!("task id '{}' is duplicated", task.id));
        }
        let mut task_deps = Vec::new();
        for need in &task.needs {
            if let Some(local) = local_need(need, &boot.machine) {
                task_deps
                    .push(index_of(local).ok_or_else(|| {
                        format!("task '{}' needs unknown task '{need}'", task.id)
                    })?);
            }
        }
        deps.push(task_deps);
    }
    let mut done = vec![false; boot.tasks.len()];
    let mut order = Vec::with_capacity(boot.tasks.len());
    while order.len() < boot.tasks.len() {
        let next = (0..boot.tasks.len())
            .find(|&index| !done[index] && deps[index].iter().all(|&dep| done[dep]))
            .ok_or_else(|| "tasks have a dependency cycle".to_owned())?;
        done[next] = true;
        order.push(next);
    }
    Ok(order)
}
