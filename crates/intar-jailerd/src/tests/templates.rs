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

#[test]
fn chunked_template_metadata_is_bounded_separately_from_protocol_frames() {
    let digest = Sha256Digest::parse("a".repeat(64)).expect("digest");
    let artifact = ImageTemplateArtifactV2 {
        sha256: digest.clone(),
        bytes: 8 * 1024 * 1024 * 1024,
        device: 7,
        inode: 11,
    };
    let metadata = ImageTemplateMetadataV2 {
        schema_version: IMAGE_TEMPLATE_METADATA_V3,
        image_sha256: digest.clone(),
        chunk_manifest_sha256: Some(digest.clone()),
        chunk_raw_sha256s: vec![digest; 1_300],
        virtual_size_bytes: artifact.bytes,
        root_disk: artifact.clone(),
        kernel: artifact.clone(),
        initrd: Some(artifact),
    };
    let bytes = serde_json::to_vec(&metadata).expect("encode template metadata");
    assert!(bytes.len() > intar_jailer_protocol::MAX_FRAME_BYTES);
    assert!(bytes.len() <= MAX_IMAGE_TEMPLATE_METADATA_BYTES);
    assert_eq!(
        decode_template_metadata(&bytes).expect("decode large template metadata"),
        metadata
    );

    let oversized = vec![b' '; MAX_IMAGE_TEMPLATE_METADATA_BYTES + 1];
    assert!(
        decode_template_metadata(&oversized)
            .expect_err("oversized metadata must fail closed")
            .to_string()
            .contains("exceeds bounded size")
    );
}

mod machine_image {
    use crate::chunked_templates::verified_image;
    use intar_contracts::oci::{MachineConfigV1, OciManifestV1};

    const MIB: u64 = 1024 * 1024;

    fn hex(digit: &str) -> String {
        digit.repeat(64)
    }

    /// A 10 MiB disk: chunk 0 full, chunk 1 a zero hole, chunk 2 the 2 MiB
    /// tail; both chunks in one layer (identical content is stored once).
    fn image() -> (serde_json::Value, serde_json::Value) {
        let layer = |media: &str, digit: &str, size: u64| serde_json::json!({"mediaType": media, "digest": format!("sha256:{}", hex(digit)), "size": size});
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "artifactType": "application/vnd.intar.machine.v1",
            "config": layer("application/vnd.intar.machine.config.v1+json", "c", 300),
            "layers": [
                layer("application/vnd.intar.kernel.v1", "1", 11 * MIB),
                layer("application/vnd.intar.initrd.v1", "2", 3 * MIB),
                layer("application/vnd.intar.disk.chunk.v1+zstd", "3", 1000),
            ],
        });
        let machine = serde_json::json!({
            "guest_contract": 3, "image_format": "intar-image-3",
            "build_key": format!("sha256:{}", hex("b")),
            "boot": {"cmdline": "root=LABEL=INTARROOT"},
            "disk": {"size_bytes": 10 * MIB, "chunk_size": 4 * MIB,
                     "chunks": [[0, 2, hex("d")], [2, 2, hex("e")]]},
        });
        (manifest, machine)
    }

    fn verify(
        manifest: &serde_json::Value,
        machine: &serde_json::Value,
    ) -> Result<Vec<(u32, u32)>, String> {
        let manifest: OciManifestV1 =
            serde_json::from_value(manifest.clone()).map_err(|error| error.to_string())?;
        let machine: MachineConfigV1 =
            serde_json::from_value(machine.clone()).map_err(|error| error.to_string())?;
        verified_image(
            &manifest,
            &machine,
            300,
            &hex("c"),
            10 * MIB,
            Some(&hex("1")),
            Some(&hex("2")),
        )
        .map(|image| {
            assert_eq!(image.virtual_size_bytes, 10 * MIB);
            image
                .chunks
                .iter()
                .map(|chunk| (chunk.index, chunk.raw_size_bytes))
                .collect()
        })
        .map_err(|error| format!("{error:#}"))
    }

    #[test]
    fn a_sound_image_yields_its_chunks_with_a_short_tail() {
        let (manifest, machine) = image();
        assert_eq!(
            verify(&manifest, &machine),
            Ok(vec![(0, 4 << 20), (2, 2 << 20)])
        );
    }

    #[test]
    fn every_break_in_the_chain_is_refused() {
        type Break = fn(&mut serde_json::Value, &mut serde_json::Value);
        let broken: [(&str, Break); 12] = [
            ("not a machine image", |m, _| {
                m["artifactType"] = "application/vnd.intar.kino.v1".into()
            }),
            ("not the one the image manifest names", |m, _| {
                m["config"]["size"] = 301.into()
            }),
            ("not the one the image manifest names", |m, _| {
                m["config"]["digest"] = format!("sha256:{}", "f".repeat(64)).into();
            }),
            ("kernel is not the one", |m, _| {
                m["layers"][0]["digest"] = format!("sha256:{}", "f".repeat(64)).into();
            }),
            ("initrd is not the one", |m, _| {
                m["layers"][1]["digest"] = format!("sha256:{}", "f".repeat(64)).into();
            }),
            ("kernel is not the one", |m, _| {
                m["layers"][1]["mediaType"] = "application/vnd.intar.kernel.v1".into()
            }),
            ("disk geometry", |_, c| {
                c["disk"]["chunk_size"] = 4096.into()
            }),
            ("disk geometry", |_, c| {
                c["disk"]["size_bytes"] = (11 * MIB).into()
            }),
            ("out of order or outside the disk", |_, c| {
                c["disk"]["chunks"][1][0] = 0.into()
            }),
            ("out of order or outside the disk", |_, c| {
                c["disk"]["chunks"][1][0] = 3.into()
            }),
            ("names no chunk layer", |_, c| {
                c["disk"]["chunks"][0][1] = 0.into()
            }),
            ("implausible encoded size", |m, _| {
                m["layers"][2]["size"] = (9 * MIB).into()
            }),
        ];
        for (expected, change) in broken {
            let (mut manifest, mut machine) = image();
            change(&mut manifest, &mut machine);
            let error = verify(&manifest, &machine).expect_err(expected);
            assert!(
                error.contains(expected),
                "expected `{expected}` in `{error}`"
            );
        }
        // A raw digest that is not hex never reaches a file name.
        let (manifest, mut machine) = image();
        machine["disk"]["chunks"][0][2] = "../../etc/shadow".into();
        assert!(verify(&manifest, &machine).is_err());
    }
}
