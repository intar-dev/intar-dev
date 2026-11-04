//! Verify mode, single machine (§5.3 in #309): every pre-check before any
//! solve, then each task in dependency order: solve, then poll its check.
//!
//! Not here yet: `PeerTasks`. A task that needs a peer's task stops verify
//! with `waiting_for` set.

use super::{Boot, CHECK_TIMEOUT, Report, Status, exec};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::sync::watch;

const SOLVE_TIMEOUT: Duration = Duration::from_secs(600);
const POST_WINDOW: Duration = Duration::from_secs(120);
const POST_INTERVAL: Duration = Duration::from_secs(2);

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
    let passed = steps(boot, dir, report, &mut verify).await;
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

    for index in order {
        let task = &boot.tasks[index];
        let started = Instant::now();
        let waiting_for: Vec<String> = task
            .needs
            .iter()
            .filter(|need| local_need(need, &boot.machine).is_none())
            .cloned()
            .collect();
        if !waiting_for.is_empty() {
            verify.steps[index].waiting_for = waiting_for;
            return false;
        }
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
        step.duration_ms = crate::state::duration_millis_u64(started.elapsed());
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
