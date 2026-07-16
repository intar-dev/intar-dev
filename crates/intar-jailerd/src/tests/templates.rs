use super::*;

#[test]
fn staging_acls_are_one_fd_pinned_interleaved_helper_batch() {
    let proc_path = |fd: u32| PathBuf::from(format!("/proc/4242/fd/{fd}"));
    let edits = agent_acl_edits(
        (10..14).map(proc_path).collect(),
        proc_path(20),
        proc_path(21),
        (30..33).map(proc_path).collect(),
        1_001,
        20_001,
    );
    assert_eq!(edits.len(), 5, "each distinct ACL must remain explicit");

    let arguments = setfacl_batch_arguments(&edits).expect("encode ACL helper batch");
    let expected = [
        "--modify",
        "u:1001:--x,m::--x",
        "/proc/4242/fd/10",
        "/proc/4242/fd/11",
        "/proc/4242/fd/12",
        "/proc/4242/fd/13",
        "--modify",
        "u:1001:rwx,m::rwx",
        "/proc/4242/fd/20",
        "/proc/4242/fd/21",
        "--modify",
        "d:u:1001:rwx,d:u:20001:rwx,d:m::rwx",
        "/proc/4242/fd/20",
        "--modify",
        "d:u:1001:rwx,d:m::rwx",
        "/proc/4242/fd/21",
        "--modify",
        "u:1001:rw-,m::rw-",
        "/proc/4242/fd/30",
        "/proc/4242/fd/31",
        "/proc/4242/fd/32",
    ]
    .map(OsString::from)
    .to_vec();
    assert_eq!(arguments, expected);
    assert_eq!(
        arguments
            .iter()
            .filter(|argument| argument.as_os_str() == "--modify")
            .count(),
        5
    );
}

#[test]
fn staging_acl_batch_rejects_unpinned_paths() {
    let error = setfacl_batch_arguments(&[SetfaclEdit {
        acl: "u:1001:--x,m::--x".to_owned(),
        paths: vec![PathBuf::from("/srv/intar/jails")],
    }])
    .expect_err("path-based ACL batch must fail closed");
    assert!(error.to_string().contains("fd-pinned procfs"));
}

#[test]
fn blank_recording_template_is_deterministic_256_mib_intarrec_vfat() {
    let mut first = tempfile::tempfile().expect("first recording template");
    let first_digest = format_blank_recording(&mut first).expect("format first template");
    assert_eq!(
        first.metadata().expect("first metadata").len(),
        BLANK_RECORDING_BYTES
    );
    first
        .seek(SeekFrom::Start(0))
        .expect("rewind first template");
    let filesystem = fatfs::FileSystem::new(first, fatfs::FsOptions::new())
        .expect("open formatted recording template");
    assert_eq!(filesystem.volume_id(), BLANK_RECORDING_VOLUME_ID);
    assert_eq!(
        filesystem.volume_label_as_bytes(),
        BLANK_RECORDING_DISPLAY_LABEL
    );
    assert_eq!(
        filesystem
            .read_volume_label_from_root_dir_as_bytes()
            .expect("read root volume label"),
        Some(BLANK_RECORDING_LABEL)
    );

    let mut second = tempfile::tempfile().expect("second recording template");
    let second_digest = format_blank_recording(&mut second).expect("format second template");
    assert_eq!(first_digest, second_digest);
}

#[test]
fn pinned_template_identity_detects_in_place_change() {
    let mut file = tempfile::tempfile().expect("template file");
    file.write_all(b"runtime").expect("write template");
    let before = source_file_identity(&file.metadata().expect("before metadata"));
    file.set_len(before.bytes + 1).expect("tamper template");
    let after = source_file_identity(&file.metadata().expect("after metadata"));
    assert_ne!(before, after);
}

#[test]
fn pinned_template_rejects_hardlink_aliases() {
    let directory = tempfile::tempdir().expect("template directory");
    let source = directory.path().join("runtime");
    std::fs::write(&source, b"runtime").expect("write runtime");
    let before = std::fs::metadata(&source).expect("source metadata");
    let artifact = HostTemplateArtifactV2 {
        sha256: Sha256Digest::parse("a".repeat(64)).expect("digest"),
        identity: source_file_identity(&before),
    };
    std::fs::hard_link(&source, directory.path().join("runtime-alias"))
        .expect("create hardlink alias");
    let error = validate_host_template_artifact_metadata(
        &std::fs::metadata(&source).expect("aliased metadata"),
        &artifact,
        "test runtime",
    )
    .expect_err("hardlinked template must fail validation");
    assert!(error.to_string().contains("link count"));
}

#[test]
fn restart_rotation_accepts_atomic_package_replacement_but_rejects_in_place_mutation() {
    let mut old = tempfile::tempfile().expect("old package inode");
    old.write_all(b"runtime-v1").expect("write old runtime");
    let old_identity = source_file_identity(&old.metadata().expect("old metadata"));

    let mut replacement = tempfile::tempfile().expect("replacement package inode");
    replacement
        .write_all(b"runtime-v2")
        .expect("write replacement runtime");
    let replacement_identity =
        source_file_identity(&replacement.metadata().expect("replacement metadata"));
    assert!(
        source_was_atomically_replaced(&replacement_identity, &old_identity, "test runtime")
            .expect("atomic replacement is eligible for rotation")
    );

    old.set_len(old_identity.bytes + 1)
        .expect("mutate old inode in place");
    let mutated_identity = source_file_identity(&old.metadata().expect("mutated metadata"));
    assert!(
        source_was_atomically_replaced(&mutated_identity, &old_identity, "test runtime")
            .expect_err("same-inode mutation must fail closed")
            .to_string()
            .contains("changed in place")
    );
}

#[test]
fn host_template_bundle_identity_binds_every_artifact_digest() {
    let cloud = Sha256Digest::parse("a".repeat(64)).expect("cloud digest");
    let jailer = Sha256Digest::parse("b".repeat(64)).expect("jailer digest");
    let recording = Sha256Digest::parse("c".repeat(64)).expect("recording digest");
    let changed = Sha256Digest::parse("d".repeat(64)).expect("changed digest");
    let expected = host_template_bundle_sha256(&cloud, &jailer, &recording);
    assert_ne!(
        expected,
        host_template_bundle_sha256(&changed, &jailer, &recording)
    );
    assert_ne!(
        expected,
        host_template_bundle_sha256(&cloud, &changed, &recording)
    );
    assert_ne!(
        expected,
        host_template_bundle_sha256(&cloud, &jailer, &changed)
    );
}

#[test]
fn exact_template_clone_never_falls_back_to_copy() {
    let source_directory = tempfile::tempdir().expect("source directory");
    let destination_directory = tempfile::tempdir().expect("destination directory");
    let destination = destination_directory.path().join("clone");
    let source = File::open(source_directory.path()).expect("open source directory");
    assert!(stage_prepared_template_source_file(source, &destination, 0o400).is_err());
    assert!(!destination.exists());
}

#[test]
fn exact_reflink_attestation_requires_every_configured_source_root() {
    let mut config = test_config();
    config.allowed_source_roots = vec![PathBuf::from("/source-a"), PathBuf::from("/source-b")];
    let identity = TrustedDirectoryIdentity {
        device: 7,
        inode: 11,
    };
    let mut attestation = FastTemplateStoreAttestation {
        template_store: identity,
        generation_store: identity,
        allowed_source_roots: vec![identity],
    };
    assert!(!attestation.covers_allowed_source_roots(&config));
    attestation.allowed_source_roots.push(identity);
    assert!(attestation.covers_allowed_source_roots(&config));
    attestation.allowed_source_roots.push(identity);
    assert!(!attestation.covers_allowed_source_roots(&config));
}
