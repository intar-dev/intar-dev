use super::*;

#[test]
fn jailed_log_permission_denied_is_best_effort_but_agent_owned_is_actionable() {
    let source = Path::new("/var/lib/intar/jails/generation/root/logs/console.log");
    let destination = Path::new("/var/cache/intar-agent/run-spool/run/vm/console.log");

    handle_vm_log_source_open_error(
        VmLogSourceOwnership::JailOwned,
        source,
        destination,
        std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected denial"),
    )
    .expect("an unreadable jail-owned diagnostic log must not block cleanup");

    let error = handle_vm_log_source_open_error(
        VmLogSourceOwnership::AgentOwned,
        source,
        destination,
        std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected denial"),
    )
    .expect_err("agent-owned source failures must remain actionable");
    let message = error.to_string();
    assert!(message.contains("failed to copy"));
    assert!(message.contains("injected denial"));
}

#[tokio::test]
async fn agent_owned_log_destination_error_is_actionable() {
    let temp = tempdir().expect("temp dir");
    let vm_dir = temp.path().join("vm");
    tokio::fs::create_dir_all(&vm_dir).await.expect("vm dir");
    tokio::fs::write(vm_dir.join("console.log"), b"console output")
        .await
        .expect("console log");
    let mut vm = test_vm_status("vm", Some("run"));
    vm.details.as_mut().expect("details").root_disk_path =
        vm_dir.join("root.raw").display().to_string();
    let destination = temp.path().join("missing-parent").join("console.log");

    let error = copy_vm_log_to_spool(&vm, "console.log", &destination)
        .await
        .expect_err("agent-owned destination errors must fail artifact preparation");
    let message = error.to_string();
    assert!(message.contains("failed to create"));
    assert!(message.contains(&destination.display().to_string()));
}

#[test]
fn missing_jailed_recording_export_remains_fatal() {
    let temp = tempdir().expect("temp dir");
    let missing_export = temp.path().join("recordings.vfat");
    let mut vm = test_vm_status("vm", Some("run"));
    let details = vm.details.as_mut().expect("details");
    details.jail_generation = Some("generation".to_string());
    details.recording_disk_path = Some(missing_export.display().to_string());

    let error = recording_export_path_for_cleanup(details)
        .expect_err("missing jailerd recording export must remain fatal");
    assert!(
        error
            .to_string()
            .contains("jailerd did not publish the drained recording export")
    );
}
