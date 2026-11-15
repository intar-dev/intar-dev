use super::*;
use std::io::{Seek as _, SeekFrom, Write as _};

struct PartialThenFailReader {
    returned_partial: bool,
}

impl std::io::Read for PartialThenFailReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.returned_partial {
            return Err(std::io::Error::other("injected copy failure"));
        }

        let partial = b"partial";
        buffer[..partial.len()].copy_from_slice(partial);
        self.returned_partial = true;
        Ok(partial.len())
    }
}

fn artifact_temp_paths(artifacts_dir: &Path, destination_name: &str) -> Vec<PathBuf> {
    let prefix = format!(".{destination_name}.part.");
    std::fs::read_dir(artifacts_dir)
        .expect("read artifact directory")
        .map(|entry| entry.expect("read artifact entry").path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .collect()
}

fn write_recording_disk(recording_disk_path: &Path, file_name: &str, contents: &[u8]) {
    let mut image = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(recording_disk_path)
        .expect("create recording disk");
    image.set_len(1_048_576).expect("size recording disk image");
    fatfs::format_volume(&mut image, fatfs::FormatVolumeOptions::new())
        .expect("format recording disk image");
    image
        .seek(SeekFrom::Start(0))
        .expect("rewind recording disk image");
    {
        let fs = fatfs::FileSystem::new(&mut image, fatfs::FsOptions::new())
            .expect("open recording disk filesystem");
        let root = fs.root_dir();
        let mut recording = root
            .create_file(file_name)
            .expect("create raw recording in disk image");
        recording
            .write_all(contents)
            .expect("write raw recording in disk image");
        recording
            .flush()
            .expect("flush raw recording in disk image");
    }
    image.sync_all().expect("sync recording disk image");
}

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
fn failed_log_copy_leaves_no_partial_final_or_temporary_and_retry_is_complete() {
    let temp = tempdir().expect("temp dir");
    let artifacts_dir = temp.path().join("artifacts");
    std::fs::create_dir_all(&artifacts_dir).expect("create artifact dir");
    let destination = artifacts_dir.join("console.log");
    let source = temp.path().join("source-console.log");

    let error = copy_reader_to_artifact_atomically(
        &mut PartialThenFailReader {
            returned_partial: false,
        },
        &source,
        &destination,
    )
    .expect_err("injected copy failure must fail publication");
    assert!(format!("{error:#}").contains("injected copy failure"));
    assert!(
        !destination.exists(),
        "a failed copy must not expose a partial final artifact"
    );
    assert!(
        artifact_temp_paths(&artifacts_dir, "console.log").is_empty(),
        "a failed copy must clean its temporary artifact"
    );

    let crashed_temp = artifacts_dir.join(".console.log.part.crashed");
    std::fs::write(&crashed_temp, b"crash-left partial artifact")
        .expect("write crash-left temporary artifact");
    let mut retry = std::io::Cursor::new(b"complete console output".as_slice());
    copy_reader_to_artifact_atomically(&mut retry, &source, &destination)
        .expect("retry must publish the complete artifact");

    assert_eq!(
        std::fs::read(&destination).expect("read completed artifact"),
        b"complete console output"
    );
    assert!(
        artifact_temp_paths(&artifacts_dir, "console.log").is_empty(),
        "retry must clean a crash-left temporary artifact"
    );
}

#[tokio::test]
async fn existing_log_final_is_idempotent_after_its_source_is_removed() {
    let temp = tempdir().expect("temp dir");
    let vm_dir = temp.path().join("vm");
    let artifacts_dir = temp.path().join("artifacts");
    tokio::fs::create_dir_all(&vm_dir).await.expect("vm dir");
    tokio::fs::create_dir_all(&artifacts_dir)
        .await
        .expect("artifact dir");
    let destination = artifacts_dir.join("console.log");
    tokio::fs::write(&destination, b"already published")
        .await
        .expect("published final artifact");

    let mut vm = test_vm_status("vm", Some("run"));
    vm.details.as_mut().expect("details").root_disk_path =
        vm_dir.join("root.raw").display().to_string();

    copy_vm_log_to_spool(&vm, "console.log", &destination)
        .await
        .expect("existing final remains valid when the VM source is gone");
    assert_eq!(
        tokio::fs::read(&destination)
            .await
            .expect("read published final artifact"),
        b"already published"
    );
}

#[tokio::test]
async fn recording_extraction_atomically_publishes_krec_and_retries_after_source_removal() {
    let temp = tempdir().expect("temp dir");
    let artifacts_dir = temp.path().join("artifacts");
    std::fs::create_dir_all(&artifacts_dir).expect("create artifact dir");
    let recording_disk = temp.path().join("recordings.vfat");
    let recording_name = "ssh-session-0001.krec";
    write_recording_disk(&recording_disk, recording_name, b"complete raw recording");
    std::fs::write(
        artifacts_dir.join(".ssh-session-0001.krec.part.crashed"),
        b"crash-left partial recording",
    )
    .expect("write crash-left recording temporary");

    extract_recordings_to_spool(&recording_disk, &artifacts_dir)
        .await
        .expect("extract raw recording");

    let destination = artifacts_dir.join(recording_name);
    assert_eq!(
        std::fs::read(&destination).expect("read raw recording"),
        b"complete raw recording"
    );
    assert!(
        artifact_temp_paths(&artifacts_dir, recording_name).is_empty(),
        "extraction must not expose a stale or partial raw recording"
    );

    std::fs::remove_file(&recording_disk).expect("remove source recording disk");
    extract_recordings_to_spool(&recording_disk, &artifacts_dir)
        .await
        .expect("retry after source removal keeps the published recording");
    assert_eq!(
        std::fs::read(&destination).expect("read retained raw recording"),
        b"complete raw recording"
    );
}

#[test]
fn a_published_export_is_archived_whatever_jailerd_answered() {
    for probe in [
        MissingExportProbe::Stop {
            attempt: 1,
            succeeded: false,
            storage_exhausted: false,
        },
        MissingExportProbe::Stop {
            attempt: 1,
            succeeded: true,
            storage_exhausted: false,
        },
        MissingExportProbe::Stop {
            attempt: STOP_EXPORT_ATTEMPTS,
            succeeded: false,
            storage_exhausted: false,
        },
        MissingExportProbe::Inspect { tracked: true },
        MissingExportProbe::Inspect { tracked: false },
    ] {
        assert_eq!(missing_export_step(probe, true), MissingExportStep::Archive);
    }
}

#[test]
fn a_failing_stop_export_is_retried_before_the_destructive_inspect() {
    // A transient export failure on a tracked generation must not lose the
    // recording: StopVm is sent again, and only after the bound does the
    // delete fall back to InspectVm, which may contain the VM.
    for attempt in 1..STOP_EXPORT_ATTEMPTS {
        assert_eq!(
            missing_export_step(
                MissingExportProbe::Stop {
                    attempt,
                    succeeded: false,
                    storage_exhausted: false,
                },
                false
            ),
            MissingExportStep::StopAgain
        );
    }
    assert_eq!(
        missing_export_step(
            MissingExportProbe::Stop {
                attempt: STOP_EXPORT_ATTEMPTS,
                succeeded: false,
                storage_exhausted: false,
            },
            false
        ),
        MissingExportStep::Inspect
    );
}

#[test]
fn an_export_out_of_space_fails_the_delete_and_never_inspects() {
    // A nearly full spool clears once space is freed: the delete fails with
    // the generation still tracked, however often it repeats, and never
    // triggers the containment that would forget the recording.
    for attempt in 1..=STOP_EXPORT_ATTEMPTS + 5 {
        assert_eq!(
            missing_export_step(
                MissingExportProbe::Stop {
                    attempt,
                    succeeded: false,
                    storage_exhausted: true,
                },
                false
            ),
            MissingExportStep::Fail
        );
    }
}

#[test]
fn a_storage_exhausted_jailerd_answer_is_recognised_by_its_code() {
    let response = JailerResponse::Error(intar_jailer_protocol::ProtocolError::new(
        "storage_exhausted",
        "copy drained recording export: No space left on device (os error 28)",
    ));
    let error = classify_jailer_identity_response(JailerIdentityOperation::Stop, response)
        .expect_err("a failed export is an error");
    assert_eq!(
        error
            .downcast_ref::<JailerdError>()
            .map(|error| error.0.code.as_str()),
        Some("storage_exhausted")
    );
    assert!(error.to_string().starts_with("jailerd storage_exhausted: "));
}

#[test]
fn a_stop_that_succeeds_without_an_export_means_the_generation_is_gone() {
    // A tracked StopVm answers Ok only after publishing the export.
    assert!(matches!(
        missing_export_step(
            MissingExportProbe::Stop {
                attempt: 1,
                succeeded: true,
                storage_exhausted: false,
            },
            false
        ),
        MissingExportStep::Skip(_)
    ));
}

#[test]
fn missing_export_stays_fatal_while_jailerd_still_tracks_the_generation() {
    // The case the old pinned test guarded: never lose a recording while
    // jailerd can still publish it.
    assert_eq!(
        missing_export_step(MissingExportProbe::Inspect { tracked: true }, false),
        MissingExportStep::Fail
    );
    assert!(matches!(
        missing_export_step(MissingExportProbe::Inspect { tracked: false }, false),
        MissingExportStep::Skip(_)
    ));
}

#[test]
fn only_a_running_vm_on_the_lost_generation_is_failed() {
    let mut vm = test_vm_status("vm", Some("run"));
    vm.state = VmLifecycleState::Running;
    vm.details.as_mut().expect("details").jail_generation = Some("generation".to_string());
    assert!(is_running_with_jail_generation(&vm, "generation"));
    assert!(!is_running_with_jail_generation(&vm, "other"));
    for state in [
        VmLifecycleState::BootingVm,
        VmLifecycleState::DeletingVm,
        VmLifecycleState::ArchivingArtifacts,
        VmLifecycleState::DeleteFailed,
        VmLifecycleState::Failed,
    ] {
        vm.state = state;
        assert!(!is_running_with_jail_generation(&vm, "generation"));
    }
}
