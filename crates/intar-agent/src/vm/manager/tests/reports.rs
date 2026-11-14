//! Guest reports: kino.v2 frames read for one run's `boot.json`.

use intar_contracts::bridge_v9::{CheckStatus, LabState};
use intar_contracts::guest::GUEST_CONTRACT;
use intar_kino_proto::kino_v2::{GuestFrame, Phase, Report, Task, guest_frame};
use prost::Message as _;

use super::*;

const BOOT: &str = "b00t";

fn target() -> ReportTarget {
    ReportTarget {
        vm_name: "web".to_owned(),
        run_id: "run-1".to_owned(),
        jail_generation: "generation-1".to_owned(),
        boot_sha256: BOOT.to_owned(),
    }
}

fn frame(phase: Phase, boot_sha256: &str, contract: u32) -> Vec<u8> {
    GuestFrame {
        frame: Some(guest_frame::Frame::Report(Report {
            contract,
            boot_sha256: boot_sha256.to_owned(),
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

fn read(body: &[u8]) -> Option<GuestUpdate> {
    read_guest_frame(&target(), body, Some(11)).unwrap_or_else(|error| panic!("{error:#}"))
}

#[test]
fn a_report_for_another_boot_json_is_dropped() {
    assert_eq!(read(&frame(Phase::Ready, "other", GUEST_CONTRACT)), None);
    // Even one of another contract: the build's Kino may speak one.
    assert_eq!(
        read(&frame(Phase::Ready, "other", GUEST_CONTRACT + 1)),
        None
    );
}

#[test]
fn a_kino_of_another_contract_fails_the_vm() {
    let update = read(&frame(Phase::Ready, BOOT, GUEST_CONTRACT + 1))
        .unwrap_or_else(|| panic!("a mismatch is a failure, not a drop"));
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
    let mut body = GuestFrame::decode(frame(Phase::Failed, BOOT, GUEST_CONTRACT).as_slice())
        .unwrap_or_else(|error| panic!("{error}"));
    if let Some(guest_frame::Frame::Report(report)) = body.frame.as_mut() {
        report.failure = hostile.to_owned();
    }
    let update = read(&body.encode_to_vec()).unwrap_or_else(|| panic!("current report"));
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
    let booting = read(&frame(Phase::Booting, BOOT, GUEST_CONTRACT))
        .unwrap_or_else(|| panic!("current report"));
    assert!(!booting.ssh_ready && booting.failed.is_none());
    assert!(booting.ssh_host_keys_openssh.is_empty(), "keys before SSH");
    assert_eq!(booting.first_report_ms, Some(11));
    assert_eq!(
        ready_gate(&booting, "web", "run-1", "generation-1"),
        ReadyGate::Waiting
    );

    let up = read(&frame(Phase::SshReady, BOOT, GUEST_CONTRACT))
        .unwrap_or_else(|| panic!("current report"));
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
    let update = read(&frame(Phase::Ready, BOOT, GUEST_CONTRACT))
        .unwrap_or_else(|| panic!("current report"));
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
