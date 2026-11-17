//! Verify mode (§5.3 in #309): every pre-check before any solve, then each
//! task in dependency order: solve, then poll its check.
//!
//! With peers, `PeerTasks` from the host drives a pre barrier (no machine
//! solves before every machine's pre-checks ran), the waits on a peer's
//! tasks, and the end of this machine's verify when a peer failed. Without
//! peers both waits are no-ops.

use super::{CHECK_TIMEOUT, Report, Status, exec};
use intar_contracts::scenario::MachineSpecV1;
use intar_kino_proto::kino_v2::{PeerTasks, Step, Verify};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::watch;

const SOLVE_TIMEOUT: Duration = Duration::from_secs(600);
const POST_WINDOW: Duration = Duration::from_secs(120);
const POST_INTERVAL: Duration = Duration::from_secs(2);
const PEER_WAIT: Duration = Duration::from_secs(900);

/// ponytail: one process-wide channel; a test or a second run would share it.
fn peers() -> &'static watch::Sender<PeerTasks> {
    static PEERS: OnceLock<watch::Sender<PeerTasks>> = OnceLock::new();
    PEERS.get_or_init(|| watch::channel(PeerTasks::default()).0)
}

#[cfg_attr(
    not(target_os = "linux"),
    allow(dead_code, reason = "used by the Linux guest only")
)]
pub(crate) fn set_peers(peer_tasks: PeerTasks) {
    peers().send_replace(peer_tasks);
}

fn need_passed(peers: &PeerTasks, need: &str) -> bool {
    need.split_once('/').is_some_and(|(machine, task)| {
        peers
            .passed
            .get(machine)
            .is_some_and(|tasks| tasks.ids.iter().any(|id| id == task))
    })
}

async fn wait_peers(test: impl FnMut(&PeerTasks) -> bool) -> bool {
    let mut rx = peers().subscribe();
    matches!(
        tokio::time::timeout(PEER_WAIT, rx.wait_for(test)).await,
        Ok(Ok(_))
    )
}

pub(crate) async fn run(
    spec: &MachineSpecV1,
    peer_machines: &[String],
    dir: &Path,
    report: &watch::Sender<Report>,
) {
    let mut verify = Verify {
        steps: spec
            .tasks
            .iter()
            .map(|task| Step {
                task_id: task.id.clone(),
                ..Step::default()
            })
            .collect(),
        ..Verify::default()
    };
    let passed = if peer_machines.is_empty() {
        steps(spec, peer_machines, dir, report, &mut verify).await
    } else {
        let mut failed_peer = None;
        let passed = tokio::select! {
            passed = steps(spec, peer_machines, dir, report, &mut verify) => passed,
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
    spec: &MachineSpecV1,
    peer_machines: &[String],
    dir: &Path,
    report: &watch::Sender<Report>,
    verify: &mut Verify,
) -> bool {
    let publish = |verify: &Verify| {
        let verify = verify.clone();
        report.send_modify(|report| report.verify = Some(verify));
    };
    let order = match topo_order(spec) {
        Ok(order) => order,
        Err(error) => {
            report.send_modify(|report| report.failure = error);
            return false;
        }
    };

    // Pre: a task with a solve must not pass before it. Implied tasks skip it.
    for (index, task) in spec.tasks.iter().enumerate() {
        if task.solve.is_none() {
            continue;
        }
        let name = format!("check-{index}");
        let pre = exec::run(dir, &name, &task.check, &spec.env, CHECK_TIMEOUT).await;
        let step = &mut verify.steps[index];
        step.set_pre(pre.status);
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
    if !peer_machines.is_empty()
        && !wait_peers(|peers| {
            peer_machines
                .iter()
                .all(|peer| peers.pre_done.contains(peer))
        })
        .await
    {
        report.send_modify(|report| report.failure = "peers did not finish pre-checks".into());
        return false;
    }

    for index in order {
        let task = &spec.tasks[index];
        let waiting_for: Vec<String> = task
            .needs
            .iter()
            .filter(|need| local_need(need, &spec.machine).is_none())
            .cloned()
            .collect();
        if !waiting_for.is_empty() {
            verify.steps[index].waiting_for.clone_from(&waiting_for);
            if peer_machines.is_empty() {
                return false;
            }
            publish(verify);
            if !wait_peers(|peers| waiting_for.iter().all(|need| need_passed(peers, need))).await {
                return false;
            }
            verify.steps[index].waiting_for.clear();
        }
        let started = Instant::now();
        if let Some(solve) = &task.solve {
            let name = format!("solve-{index}");
            let run = exec::run(dir, &name, solve, &spec.env, SOLVE_TIMEOUT).await;
            let step = &mut verify.steps[index];
            // -1: the solve did not run to an exit (signal, timeout).
            step.solve_exit = run.exit.unwrap_or(-1);
            step.tail = run.tail;
            if run.status != Status::Pass {
                return false;
            }
        }
        let post = poll_check(dir, index, spec).await;
        let step = &mut verify.steps[index];
        step.set_post(post.status);
        step.duration_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
        if post.status != Status::Pass {
            step.tail = post.tail;
            return false;
        }
        publish(verify);
    }
    true
}

async fn poll_check(dir: &Path, index: usize, spec: &MachineSpecV1) -> exec::Outcome {
    let deadline = Instant::now() + POST_WINDOW;
    let (name, check) = (format!("check-{index}"), &spec.tasks[index].check);
    loop {
        let outcome = exec::run(dir, &name, check, &spec.env, CHECK_TIMEOUT).await;
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

/// Task indices in dependency order; ties keep the spec's order.
///
/// ponytail: O(n²) scan, fine for the 32 tasks a machine may have.
pub(crate) fn topo_order(spec: &MachineSpecV1) -> Result<Vec<usize>, String> {
    let index_of = |id: &str| spec.tasks.iter().position(|task| task.id == id);
    let mut deps = Vec::with_capacity(spec.tasks.len());
    for (index, task) in spec.tasks.iter().enumerate() {
        if index_of(&task.id) != Some(index) {
            return Err(format!("task id '{}' is duplicated", task.id));
        }
        let mut task_deps = Vec::new();
        for need in &task.needs {
            if let Some(local) = local_need(need, &spec.machine) {
                task_deps
                    .push(index_of(local).ok_or_else(|| {
                        format!("task '{}' needs unknown task '{need}'", task.id)
                    })?);
            }
        }
        deps.push(task_deps);
    }
    let mut done = vec![false; spec.tasks.len()];
    let mut order = Vec::with_capacity(spec.tasks.len());
    while order.len() < spec.tasks.len() {
        let next = (0..spec.tasks.len())
            .find(|&index| !done[index] && deps[index].iter().all(|&dep| done[dep]))
            .ok_or_else(|| "tasks have a dependency cycle".to_owned())?;
        done[next] = true;
        order.push(next);
    }
    Ok(order)
}
