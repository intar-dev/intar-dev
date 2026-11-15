use super::*;
use std::os::unix::fs::MetadataExt as _;

#[test]
fn drained_recording_export_keeps_a_successful_reflink_on_the_fast_path() {
    let mut source = tempfile::tempfile().expect("source recording");
    source
        .write_all(b"recording payload")
        .expect("write source");
    source.seek(SeekFrom::Start(0)).expect("rewind source");
    let mut output = tempfile::tempfile().expect("output recording");
    output
        .write_all(b"already reflinked payload")
        .expect("seed cloned output");

    let transfer = clone_or_copy_drained_recording_with(&mut source, &mut output, |_, _| Ok(()))
        .expect("successful reflink transfer");

    assert_eq!(transfer, RecordingExportTransfer::Reflinked);
    output.seek(SeekFrom::Start(0)).expect("rewind output");
    let mut bytes = Vec::new();
    output.read_to_end(&mut bytes).expect("read output");
    assert_eq!(bytes, b"already reflinked payload");
}

#[test]
fn drained_recording_export_copies_after_an_unavailable_reflink_route() {
    let mut source = tempfile::tempfile().expect("source recording");
    source
        .write_all(b"recording payload")
        .expect("write source");
    source.seek(SeekFrom::Start(0)).expect("rewind source");
    let mut output = tempfile::tempfile().expect("output recording");
    output
        .write_all(b"partial clone must not survive")
        .expect("seed partial output");

    let transfer = clone_or_copy_drained_recording_with(&mut source, &mut output, |_, _| {
        Err(rustix::io::Errno::XDEV)
    })
    .expect("copy fallback");

    assert_eq!(transfer, RecordingExportTransfer::Copied);
    output.seek(SeekFrom::Start(0)).expect("rewind output");
    let mut bytes = Vec::new();
    output.read_to_end(&mut bytes).expect("read output");
    assert_eq!(bytes, b"recording payload");
}

#[test]
fn drained_recording_export_is_idempotent_with_the_copy_fallback() {
    let mut source = tempfile::tempfile().expect("source recording");
    source
        .write_all(b"recording payload")
        .expect("write source");

    for _ in 0..2 {
        source.seek(SeekFrom::Start(0)).expect("rewind source");
        let mut output = tempfile::tempfile().expect("output recording");
        let transfer = clone_or_copy_drained_recording_with(&mut source, &mut output, |_, _| {
            Err(rustix::io::Errno::OPNOTSUPP)
        })
        .expect("copy fallback");
        assert_eq!(transfer, RecordingExportTransfer::Copied);
        output.seek(SeekFrom::Start(0)).expect("rewind output");
        let mut bytes = Vec::new();
        output.read_to_end(&mut bytes).expect("read output");
        assert_eq!(bytes, b"recording payload");
    }
}

#[test]
fn drained_recording_export_retries_with_the_full_publish_contract() {
    let jail = tempfile::tempdir().expect("jail root");
    let cache = tempfile::tempdir().expect("artifact cache");
    let mut config = lifecycle_test_config(jail.path());
    config.allowed_source_roots = vec![cache.path().to_path_buf()];
    config.agent_uid = unsafe_test_uid();
    config.agent_gid = unsafe_test_gid();
    let mut record = recovered_record(&config);
    record.uid = config.agent_uid;
    record.gid = config.agent_gid;
    record.request.artifacts.recording_disk = ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from("exports/recordings.vfat"),
        sha256: None,
        access: ArtifactAccess::ReadWrite,
    };
    let source_path = &record.paths.host_recording_disk;
    std::fs::create_dir_all(source_path.parent().expect("recording source parent"))
        .expect("create recording source parent");
    let mut source = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(source_path)
        .expect("create recording source");
    source
        .write_all(b"recording payload")
        .expect("write recording source");
    source.sync_all().expect("sync recording source");
    let export_parent = cache.path().join("exports");
    std::fs::create_dir_all(&export_parent).expect("create recording export parent");
    let exported = export_parent.join("recordings.vfat");

    export_recording_disk(&config, &record).expect("first recording export");
    export_recording_disk(&config, &record).expect("idempotent recording export");

    assert_eq!(
        std::fs::read(&exported).expect("read export"),
        b"recording payload"
    );
    let metadata = std::fs::metadata(&exported).expect("export metadata");
    assert_eq!(metadata.mode() & 0o777, 0o600);
    assert_eq!(metadata.uid(), config.agent_uid);
    assert_eq!(metadata.gid(), config.agent_gid);
    assert!(
        std::fs::read_dir(&export_parent)
            .expect("read export parent")
            .all(|entry| {
                !entry
                    .expect("export directory entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".recording-export-")
            }),
        "failed export temporaries must not survive"
    );
}

#[test]
fn drained_recording_export_does_not_fallback_after_an_unexpected_clone_error() {
    let mut source = tempfile::tempfile().expect("source recording");
    source
        .write_all(b"recording payload")
        .expect("write source");
    source.seek(SeekFrom::Start(0)).expect("rewind source");
    let mut output = tempfile::tempfile().expect("output recording");

    let error = clone_or_copy_drained_recording_with(&mut source, &mut output, |_, _| {
        Err(rustix::io::Errno::IO)
    })
    .expect_err("unexpected clone error must fail closed");

    assert!(
        error
            .to_string()
            .contains("exact-reflink drained recording export")
    );
}

#[test]
fn contained_vm_logs_are_published_bounded_and_only_from_regular_files() {
    let jail = tempfile::tempdir().expect("jail root");
    let cache = tempfile::tempdir().expect("artifact cache");
    let mut config = lifecycle_test_config(jail.path());
    config.allowed_source_roots = vec![cache.path().to_path_buf()];
    config.agent_uid = unsafe_test_uid();
    config.agent_gid = unsafe_test_gid();
    let mut record = recovered_record(&config);
    record.uid = config.agent_uid;
    record.gid = config.agent_gid;
    record.request.artifacts.recording_disk = ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from("spool/recordings.vfat"),
        sha256: None,
        access: ArtifactAccess::ReadWrite,
    };
    let artifacts = cache.path().join("spool/artifacts");
    std::fs::create_dir_all(&artifacts).expect("create artifacts directory");
    let logs = record
        .paths
        .host_console_log
        .parent()
        .expect("log directory");
    std::fs::create_dir_all(logs).expect("create log directory");
    // A flooded console: only its last bytes are published.
    let limit = usize::try_from(CONTAINED_VM_LOG_EXPORT_BYTES).expect("limit");
    let mut console = vec![b'x'; limit + 7];
    console[..7].copy_from_slice(b"dropped");
    console[limit..].copy_from_slice(b"the end");
    std::fs::write(&record.paths.host_console_log, &console).expect("write console log");
    // A FIFO in place of the stderr log.
    rustix::fs::mknodat(
        rustix::fs::CWD,
        &record.paths.host_stderr_log,
        rustix::fs::FileType::Fifo,
        Mode::RUSR | Mode::WUSR,
        0,
    )
    .expect("create FIFO");
    // The agent already published the serial log: it stays as it is.
    std::fs::write(&record.paths.host_serial_log, b"serial from the jail").expect("serial log");
    std::fs::write(artifacts.join("serial.log"), b"published by the agent")
        .expect("published serial log");

    let error = export_vm_logs(&config, &record).expect_err("FIFO refused");

    assert!(
        format!("{error:#}").contains("cloud-hypervisor.stderr.log"),
        "{error:#}"
    );
    let published = std::fs::read(artifacts.join("console.log")).expect("published console");
    assert_eq!(published.len(), limit);
    assert!(published.ends_with(b"the end") && !published.starts_with(b"dropped"));
    let metadata = std::fs::metadata(artifacts.join("console.log")).expect("metadata");
    assert_eq!(metadata.mode() & 0o777, 0o600);
    assert_eq!(metadata.uid(), config.agent_uid);
    assert!(!format!("{error:#}").contains("serial.log"), "{error:#}");
    assert_eq!(
        std::fs::read(artifacts.join("serial.log")).expect("serial log"),
        b"published by the agent"
    );
    assert!(!artifacts.join("cloud-hypervisor.stderr.log").exists());
    assert_eq!(
        std::fs::read_dir(&artifacts).expect("artifacts").count(),
        2,
        "no temporary survives"
    );

    // A missing log is skipped without error.
    std::fs::remove_file(&record.paths.host_serial_log).expect("remove serial source");
    std::fs::remove_file(artifacts.join("serial.log")).expect("remove published serial");
    let error = export_vm_logs(&config, &record).expect_err("FIFO still refused");
    assert!(!format!("{error:#}").contains("serial.log"), "{error:#}");
    assert!(!artifacts.join("serial.log").exists());
}
