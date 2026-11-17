//! The host's reading of a `kino.v2` report (#310 §5.2). A guest is not
//! trusted: every string is cut again and every list is capped.

use std::collections::BTreeMap;

use intar_contracts::bridge_v9::{
    CheckStatus, LabState, VmLabV1, VmReadyV1, VmTaskV1, VmVerifyStepV1, VmVerifyV1,
};
use intar_contracts::guest::GUEST_CONTRACT;
use intar_contracts::scenario::{MAX_READY_PER_MACHINE, MAX_TASKS_PER_MACHINE};
use prost::Message as _;

use crate::kino_v2::{GuestFrame, MAX_FRAME_BYTES, Phase, Report, Status, guest_frame};

const MESSAGE_BYTES: usize = 512;
const READY_TAIL_BYTES: usize = 2048;
const STEP_TAIL_BYTES: usize = 4096;
const FAILURE_BYTES: usize = 1024;
const NAME_BYTES: usize = 64;
const HOST_KEY_BYTES: usize = 1024;
const MAX_HOST_KEYS: usize = 4;
const MAX_TIMINGS: usize = 64;
/// The key Kino sets in `timings_ms` when SSH is up.
const SSH_READY_TIMING: &str = "ssh_ready";

/// One report of this run's Kino.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuestReport {
    /// SSH is up: the VM is Ready and a terminal can open. Reports carry
    /// the latest phase only, so this also holds for every later phase.
    pub ssh_ready: bool,
    /// The guest failed before SSH was up: the VM failed.
    pub failed: Option<String>,
    pub ssh_host_keys_openssh: Vec<String>,
    pub lab: VmLabV1,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum DecodeError {
    #[error("guest frame of {0} bytes is over the limit")]
    Oversized(usize),
    #[error("guest frame is not a kino.v2 report: {0}")]
    Malformed(String),
    /// The VM fails and never becomes Ready.
    #[error("guest_contract_mismatch: Kino speaks guest contract {0}")]
    ContractMismatch(u32),
}

/// Read one frame's body.
pub fn decode(body: &[u8]) -> Result<GuestReport, DecodeError> {
    if body.len() > MAX_FRAME_BYTES {
        return Err(DecodeError::Oversized(body.len()));
    }
    let frame =
        GuestFrame::decode(body).map_err(|error| DecodeError::Malformed(error.to_string()))?;
    let Some(guest_frame::Frame::Report(report)) = frame.frame else {
        return Err(DecodeError::Malformed("no report".to_owned()));
    };
    if report.contract != GUEST_CONTRACT {
        return Err(DecodeError::ContractMismatch(report.contract));
    }
    Ok(read(report))
}

/// The frame a host answers every connection of a VM restored from a
/// snapshot with, length prefix included: a parked Kino takes its clock and
/// a seed for its random pool from it, any other Kino ignores it.
#[must_use]
pub fn wake_frame(unix_ms: u64, seed: Vec<u8>) -> Vec<u8> {
    use crate::kino_v2::{HostFrame, Wake, host_frame};
    let body = HostFrame {
        frame: Some(host_frame::Frame::Wake(Wake { unix_ms, seed })),
    }
    .encode_to_vec();
    let length = u32::try_from(body.len()).unwrap_or(u32::MAX);
    [length.to_be_bytes().as_slice(), &body].concat()
}

/// Whether a frame's body is the one report of a capture boot that parked.
#[must_use]
pub fn is_parked(body: &[u8]) -> bool {
    body.len() <= MAX_FRAME_BYTES
        && matches!(
            GuestFrame::decode(body),
            Ok(GuestFrame {
                frame: Some(guest_frame::Frame::Report(report)),
            }) if report.contract == GUEST_CONTRACT && report.phase() == Phase::Parked
        )
}

fn read(report: Report) -> GuestReport {
    let phase = report.phase();
    let failure = (!report.failure.is_empty()).then(|| cut(&report.failure, FAILURE_BYTES));
    let failed_phase = phase == Phase::Failed;
    let ssh_ready = match phase {
        Phase::SshReady | Phase::Preparing | Phase::Ready => true,
        Phase::Failed => report.timings_ms.contains_key(SSH_READY_TIMING),
        Phase::Unspecified | Phase::Booting | Phase::Parked => false,
    };
    let state = match phase {
        Phase::Ready => LabState::Ready,
        Phase::Failed => LabState::Failed,
        Phase::Unspecified
        | Phase::Booting
        | Phase::SshReady
        | Phase::Preparing
        | Phase::Parked => LabState::Preparing,
    };
    let timings_ms: BTreeMap<String, u64> = report
        .timings_ms
        .iter()
        .map(|(key, value)| (cut(key, NAME_BYTES), *value))
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .take(MAX_TIMINGS)
        .collect();
    GuestReport {
        ssh_ready,
        failed: (failed_phase && !ssh_ready).then(|| {
            failure
                .clone()
                .unwrap_or_else(|| "the guest failed to start".to_owned())
        }),
        ssh_host_keys_openssh: report
            .ssh_host_keys_openssh
            .iter()
            .take(MAX_HOST_KEYS)
            .map(|key| cut(key, HOST_KEY_BYTES))
            .collect(),
        lab: VmLabV1 {
            state,
            kino_version: cut(&report.kino_version, NAME_BYTES),
            ready: report
                .ready
                .iter()
                .take(MAX_READY_PER_MACHINE)
                .map(|ready| VmReadyV1 {
                    name: cut(&ready.name, NAME_BYTES),
                    status: status(ready.status()),
                    tail: tail(&ready.tail, READY_TAIL_BYTES),
                })
                .collect(),
            tasks: report
                .tasks
                .iter()
                .take(MAX_TASKS_PER_MACHINE)
                .map(|task| VmTaskV1 {
                    id: cut(&task.id, NAME_BYTES),
                    status: status(task.status()),
                    message: cut(&task.message, MESSAGE_BYTES),
                    passed_at_unix_ms: (task.passed_at_unix_ms > 0)
                        .then_some(task.passed_at_unix_ms),
                })
                .collect(),
            verify: report.verify.as_ref().map(|verify| VmVerifyV1 {
                steps: verify
                    .steps
                    .iter()
                    .take(MAX_TASKS_PER_MACHINE)
                    .map(|step| VmVerifyStepV1 {
                        task_id: cut(&step.task_id, NAME_BYTES),
                        pre: status(step.pre()),
                        solve_exit: step.solve_exit,
                        post: status(step.post()),
                        duration_ms: step.duration_ms,
                        tail: tail(&step.tail, STEP_TAIL_BYTES),
                        waiting_for: step
                            .waiting_for
                            .iter()
                            .take(MAX_TASKS_PER_MACHINE)
                            .map(|need| cut(need, 2 * NAME_BYTES))
                            .collect(),
                    })
                    .collect(),
                done: verify.done,
                passed: verify.passed,
                pre_done: verify.pre_done,
            }),
            timings_ms,
            failure,
        },
    }
}

fn status(status: Status) -> CheckStatus {
    match status {
        Status::Unspecified | Status::Pending => CheckStatus::Pending,
        Status::Pass => CheckStatus::Pass,
        Status::Fail => CheckStatus::Fail,
        Status::Error => CheckStatus::Error,
    }
}

/// The first `limit` bytes, at a character boundary.
fn cut(value: &str, limit: usize) -> String {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

/// The last `limit` bytes, at a character boundary.
fn tail(value: &str, limit: usize) -> String {
    let mut start = value.len().saturating_sub(limit);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kino_v2::{Ready, Step, Task, Verify};

    fn frame(report: Report) -> Vec<u8> {
        GuestFrame {
            frame: Some(guest_frame::Frame::Report(report)),
        }
        .encode_to_vec()
    }

    fn report(phase: Phase) -> Report {
        Report {
            contract: GUEST_CONTRACT,
            phase: phase as i32,
            ..Report::default()
        }
    }

    fn decoded(report: Report) -> GuestReport {
        match decode(&frame(report)) {
            Ok(report) => report,
            other => panic!("expected a report: {other:?}"),
        }
    }

    #[test]
    fn another_contract_fails_the_vm() {
        let mut other = report(Phase::Booting);
        other.contract = 4;
        assert_eq!(decode(&frame(other)), Err(DecodeError::ContractMismatch(4)));
        assert!(matches!(decode(&[0xff; 8]), Err(DecodeError::Malformed(_))));
        let huge = vec![0; MAX_FRAME_BYTES + 1];
        assert_eq!(
            decode(&huge),
            Err(DecodeError::Oversized(MAX_FRAME_BYTES + 1))
        );
    }

    #[test]
    fn phases_map_to_ready_and_the_lab_state() {
        let booting = decoded(report(Phase::Booting));
        assert!(!booting.ssh_ready && booting.failed.is_none());
        // SSH_READY itself may never be seen; later phases imply it.
        for (phase, state) in [
            (Phase::SshReady, LabState::Preparing),
            (Phase::Preparing, LabState::Preparing),
            (Phase::Ready, LabState::Ready),
        ] {
            let seen = decoded(report(phase));
            assert!(seen.ssh_ready && seen.failed.is_none());
            assert_eq!(seen.lab.state, state);
        }
        let mut early = report(Phase::Failed);
        early.failure = "no network".to_owned();
        let early = decoded(early);
        assert_eq!(
            (early.ssh_ready, early.failed.as_deref()),
            (false, Some("no network"))
        );
        // A failure after SSH is a lab failure: the VM stays Ready.
        let mut lab = report(Phase::Failed);
        lab.timings_ms.insert("ssh_ready".to_owned(), 6680);
        lab.failure = "ready 'node' did not pass".to_owned();
        let lab = decoded(lab);
        assert!(lab.ssh_ready && lab.failed.is_none());
        assert_eq!(lab.lab.state, LabState::Failed);
        assert_eq!(
            lab.lab.failure.as_deref(),
            Some("ready 'node' did not pass")
        );
    }

    #[test]
    fn a_hostile_report_is_cut_to_the_limits() {
        // Each over its own limit, all inside one frame.
        let text = |bytes: usize| "é".repeat(bytes / 2);
        let mut hostile = report(Phase::Ready);
        hostile.kino_version = text(200);
        hostile.failure = text(3000);
        hostile.ssh_host_keys_openssh = vec![text(1200); 6];
        hostile.ready = vec![
            Ready {
                name: text(200),
                status: 2,
                tail: text(3000)
            };
            17
        ];
        hostile.tasks = vec![
            Task {
                id: text(200),
                status: 2,
                message: text(700),
                passed_at_unix_ms: 5
            };
            33
        ];
        let step = |tail: usize| Step {
            task_id: text(200),
            tail: text(tail),
            waiting_for: vec!["m/t".to_owned(); 40],
            ..Step::default()
        };
        let mut steps = vec![step(10); 33];
        steps[0] = step(6000);
        hostile.verify = Some(Verify {
            steps,
            ..Verify::default()
        });
        hostile.timings_ms = (0..80).map(|n| (format!("{n}{}", text(100)), n)).collect();
        let seen = decoded(hostile);
        assert_eq!(seen.ssh_host_keys_openssh.len(), MAX_HOST_KEYS);
        assert!(seen.ssh_host_keys_openssh[0].len() <= HOST_KEY_BYTES);
        let lab = seen.lab;
        assert_eq!(
            (lab.ready.len(), lab.tasks.len()),
            (MAX_READY_PER_MACHINE, MAX_TASKS_PER_MACHINE)
        );
        assert!(
            lab.ready[0].tail.len() <= READY_TAIL_BYTES && lab.ready[0].name.len() <= NAME_BYTES
        );
        assert!(lab.tasks[0].message.len() <= MESSAGE_BYTES && lab.tasks[0].id.len() <= NAME_BYTES);
        assert_eq!(lab.tasks[0].passed_at_unix_ms, Some(5));
        let verify = lab.verify.unwrap_or_else(|| panic!("verify"));
        assert_eq!(verify.steps.len(), MAX_TASKS_PER_MACHINE);
        assert!(verify.steps[0].tail.len() <= STEP_TAIL_BYTES);
        assert_eq!(verify.steps[0].waiting_for.len(), MAX_TASKS_PER_MACHINE);
        assert!(lab.timings_ms.len() <= MAX_TIMINGS);
        assert!(
            lab.failure
                .is_some_and(|failure| failure.len() <= FAILURE_BYTES)
        );
        assert!(lab.kino_version.len() <= NAME_BYTES);
    }
}
