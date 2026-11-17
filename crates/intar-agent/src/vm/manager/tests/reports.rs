//! Guest reports: kino.v2 frames read for one run's VM.

use intar_contracts::bridge_v9::{CheckStatus, LabState};
use intar_contracts::guest::GUEST_CONTRACT;
use intar_kino_proto::kino_v2::{GuestFrame, Phase, Report, Task, guest_frame};
use prost::Message as _;

use super::*;

fn target() -> ReportTarget {
    ReportTarget {
        vm_name: "web".to_owned(),
        run_id: "run-1".to_owned(),
        jail_generation: "generation-1".to_owned(),
    }
}

fn frame(phase: Phase, contract: u32) -> Vec<u8> {
    GuestFrame {
        frame: Some(guest_frame::Frame::Report(Report {
            contract,
            phase: phase as i32,
            ssh_host_keys_openssh: vec!["ssh-ed25519 AAAAHOST web".to_owned()],
            tasks: vec![Task {
                id: "nginx".to_owned(),
                status: intar_kino_proto::kino_v2::Status::Pass as i32,
                message: String::new(),
                passed_at_unix_ms: 7,
            }],
            ..Report::default()
        })),
    }
    .encode_to_vec()
}

fn read(body: &[u8]) -> GuestUpdate {
    read_guest_frame(&target(), body, Some(11)).unwrap_or_else(|error| panic!("{error:#}"))
}

#[test]
fn a_kino_of_another_contract_fails_the_vm() {
    let update = read(&frame(Phase::Ready, GUEST_CONTRACT + 1));
    let failed = update.failed.clone().unwrap_or_default();
    assert!(failed.starts_with("guest_contract_mismatch"), "{failed}");
    assert!(!update.ssh_ready && update.ssh_host_keys_openssh.is_empty());
    assert_eq!(update.lab.state, LabState::Failed);
    assert_eq!(
        ready_gate(&update, "web", "run-1", "generation-1"),
        ReadyGate::Failed(failed)
    );
}

#[test]
fn a_guest_failure_text_stays_out_of_the_vm_error() {
    let hostile = "<script>steal()</script> /etc/shadow";
    let mut body = GuestFrame::decode(frame(Phase::Failed, GUEST_CONTRACT).as_slice())
        .unwrap_or_else(|error| panic!("{error}"));
    if let Some(guest_frame::Frame::Report(report)) = body.frame.as_mut() {
        report.failure = hostile.to_owned();
    }
    let update = read(&body.encode_to_vec());
    assert_eq!(update.failed.as_deref(), Some(GUEST_FAILED_BEFORE_SSH));
    let ReadyGate::Failed(error) = ready_gate(&update, "web", "run-1", "generation-1") else {
        panic!("a guest failure fails the VM");
    };
    assert!(!error.contains(hostile), "{error}");
    assert_eq!(
        update.lab.failure.as_deref(),
        Some(hostile),
        "admin-only copy"
    );
}

#[test]
fn a_malformed_frame_is_an_error() {
    assert!(read_guest_frame(&target(), b"\xff\xff not protobuf", None).is_err());
}

#[test]
fn ready_waits_for_ssh_and_takes_host_keys_only_then() {
    let booting = read(&frame(Phase::Booting, GUEST_CONTRACT));
    assert!(!booting.ssh_ready && booting.failed.is_none());
    assert!(booting.ssh_host_keys_openssh.is_empty(), "keys before SSH");
    assert_eq!(booting.first_report_ms, Some(11));
    assert_eq!(
        ready_gate(&booting, "web", "run-1", "generation-1"),
        ReadyGate::Waiting
    );

    let up = read(&frame(Phase::SshReady, GUEST_CONTRACT));
    assert!(up.ssh_ready);
    assert_eq!(up.ssh_host_keys_openssh, vec!["ssh-ed25519 AAAAHOST web"]);
    assert_eq!(
        ready_gate(&up, "web", "run-1", "generation-1"),
        ReadyGate::Ready
    );
    assert_eq!(
        ready_gate(&up, "web", "run-1", "generation-2"),
        ReadyGate::OtherVm
    );
    assert_eq!(
        ready_gate(&up, "db", "run-1", "generation-1"),
        ReadyGate::OtherVm
    );
}

#[test]
fn the_persisted_lab_is_the_reported_lab_as_strict_json() -> Result<()> {
    let update = read(&frame(Phase::Ready, GUEST_CONTRACT));
    let row = lab_row(&update)?;
    assert_eq!(
        (
            row.vm_name.as_str(),
            row.run_id.as_str(),
            row.jail_generation.as_str()
        ),
        ("web", "run-1", "generation-1")
    );
    assert_eq!(row.first_report_ms, Some(11));
    let lab: VmLabV1 = serde_json::from_str(&row.lab_json)?;
    assert_eq!(lab, update.lab);
    assert_eq!(lab.tasks[0].status, CheckStatus::Pass);
    assert_eq!(lab.tasks[0].passed_at_unix_ms, Some(7));
    Ok(())
}

fn report_at(received_at_ms: i64, generation: &str, task: CheckStatus) -> GuestUpdate {
    let mut update = read(&frame(Phase::Ready, GUEST_CONTRACT));
    update.received_at_ms = received_at_ms;
    generation.clone_into(&mut update.jail_generation);
    for state in &mut update.lab.tasks {
        state.status = task;
    }
    update
}

#[test]
fn the_ready_commit_persists_the_newest_report_of_its_generation() {
    let ready = report_at(10, "generation-1", CheckStatus::Pending);
    let newer = report_at(12, "generation-1", CheckStatus::Fail);
    // A report kept while the commit waited wins over the waiter's older one.
    assert_eq!(newest_report(&ready, Some(&newer)).lab, newer.lab);
    assert_eq!(newest_report(&ready, Some(&ready)).lab, ready.lab);
    // Nothing newer kept: the waiter's report.
    assert_eq!(newest_report(&ready, None).lab, ready.lab);
    // One of another generation, or older than the waiter's, is not this lab.
    let other = report_at(12, "generation-2", CheckStatus::Fail);
    assert_eq!(newest_report(&ready, Some(&other)).lab, ready.lab);
    let older = report_at(9, "generation-1", CheckStatus::Fail);
    assert_eq!(newest_report(&ready, Some(&older)).lab, ready.lab);
}

#[test]
fn a_report_after_the_ready_commit_takes_the_committed_path() {
    let mut vm = test_vm_status("web", Some("run-1"));
    // Before the commit the report is kept for it.
    assert!(!ready_committed(&vm));
    vm.state = VmLifecycleState::Running;
    let quota = CpuQuota::from_millis(500).expect("quota");
    let details = vm.details.as_mut().expect("details");
    details.cpu_millis = Some(500);
    details.cpu_runtime = Some(VmCpuRuntimeState {
        quota,
        attestation: Some(CpuQuotaAttestation {
            quota,
            cpu_max: quota.cpu_max(),
            cpu_max_burst: 0,
            verified_at_unix_ms: 1,
        }),
    });
    // After it, the report is persisted and projected on its own, not kept.
    assert!(ready_committed(&vm));
}

#[test]
fn a_recovered_committed_vm_keeps_the_lab_its_reports_persisted() {
    let ready = report_at(10, "generation-1", CheckStatus::Pending);
    let newer = report_at(12, "generation-1", CheckStatus::Fail);
    // A fresh launch writes the newest lab.
    assert_eq!(
        ready_lab(false, &ready, Some(&newer)).map(|update| &update.lab),
        Some(&newer.lab)
    );
    // A VM restored as running already persisted its reports: no lab.
    assert!(ready_lab(true, &ready, Some(&newer)).is_none());
    assert!(ready_lab(true, &ready, None).is_none());
}

#[test]
fn a_cleaned_up_vm_leaves_no_kept_report() {
    let reports = std::sync::Mutex::new(BTreeMap::from([
        (
            "web".to_owned(),
            report_at(1, "generation-1", CheckStatus::Pending),
        ),
        (
            "db".to_owned(),
            report_at(1, "generation-1", CheckStatus::Pending),
        ),
    ]));
    forget_kept_report(&reports, "web");
    let left = reports.lock().expect("lock");
    assert_eq!(left.keys().collect::<Vec<_>>(), ["db"]);
}
