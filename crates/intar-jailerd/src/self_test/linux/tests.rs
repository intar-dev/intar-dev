use super::*;

#[test]
fn trusted_ip_binary_selects_a_regular_non_symlink() {
    let path = trusted_ip_binary().expect("trusted ip binary");
    let metadata = std::fs::symlink_metadata(&path).expect("stat trusted ip binary");
    assert!(metadata.is_file());
    assert!(!metadata.file_type().is_symlink());
}

#[test]
fn landlock_denial_accepts_only_the_exact_pinned_v53_chain() {
    let exact = serde_json::json!([
        "Error from API",
        "The disk could not be added to the VM",
        "Error from device manager",
        "Cannot open disk path",
        "I/O error (path=/run/landlock-api-canary op=open)",
        "Permission denied (os error 13)"
    ])
    .to_string();
    validate_v53_landlock_denial(500, &exact).expect("exact v53 EACCES chain");

    assert!(validate_v53_landlock_denial(400, &exact).is_err());
    assert!(validate_v53_landlock_denial(500, "not-json").is_err());
    let wrong_path = exact.replace("/run/landlock-api-canary", "/run/a-different-file");
    assert!(validate_v53_landlock_denial(500, &wrong_path).is_err());
    let wrong_errno = exact.replace(
        "Permission denied (os error 13)",
        "Operation not permitted (os error 1)",
    );
    assert!(validate_v53_landlock_denial(500, &wrong_errno).is_err());
}

#[test]
fn lifecycle_accepts_only_pinned_v53_shutdown_and_delete_results() {
    let created = VmInfo {
        config: VmConfig::default(),
        state: VmState::Created,
        memory_actual_size: None,
    };
    validate_v53_post_shutdown_state(&created).expect("v53 retained configuration");
    for state in [VmState::Running, VmState::Paused, VmState::Shutdown] {
        let info = VmInfo {
            state,
            ..created.clone()
        };
        assert!(validate_v53_post_shutdown_state(&info).is_err());
    }

    let exact_body = serde_json::json!([
        "Error from API",
        "The VM info is not available",
        "VM is not created"
    ])
    .to_string();
    validate_v53_post_delete_info(Err(CloudHypervisorError::HttpStatus {
        status: 404,
        body: exact_body.clone(),
    }))
    .expect("v53 deleted configuration");
    assert!(
        validate_v53_post_delete_info(Err(CloudHypervisorError::HttpStatus {
            status: 500,
            body: exact_body,
        }))
        .is_err()
    );
    assert!(
        validate_v53_post_delete_info(Err(CloudHypervisorError::HttpStatus {
            status: 404,
            body: "[]".to_owned(),
        }))
        .is_err()
    );
    assert!(
        validate_v53_post_delete_info(Err(CloudHypervisorError::HttpStatus {
            status: 404,
            body: "not-json".to_owned(),
        }))
        .is_err()
    );
    assert!(validate_v53_post_delete_info(Ok(created)).is_err());
}

#[test]
fn delete_outcome_is_accepted_only_when_the_resource_is_absent() {
    accept_delete_outcome(Err::<(), _>(anyhow::anyhow!("ENODEV")), false, "veth")
        .expect("already-absent veth");
    accept_delete_outcome(Ok(()), false, "veth").expect("deleted veth");
    assert!(accept_delete_outcome(Err::<(), _>(anyhow::anyhow!("EPERM")), true, "veth").is_err());
    assert!(accept_delete_outcome(Ok(()), true, "veth").is_err());
}

#[test]
fn path_entry_existence_is_fallible_and_does_not_follow_the_entry() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let missing = temporary.path().join("missing");
    assert!(!path_entry_exists(&missing).expect("inspect missing entry"));
    std::os::unix::fs::symlink("missing", temporary.path().join("link"))
        .expect("create dangling link");
    assert!(path_entry_exists(&temporary.path().join("link")).expect("inspect link"));
}

#[test]
fn cpu_stat_parser_is_exact() {
    let values = parse_cpu_stat(
        "usage_usec 42\nuser_usec 21\nsystem_usec 21\nnr_periods 9\nnr_throttled 3\nthrottled_usec 7\n",
    );
    assert_eq!(values.get("usage_usec"), Some(&42));
    assert_eq!(values.get("nr_throttled"), Some(&3));
}

#[test]
fn busy_guest_sample_accepts_each_independent_125_millicore_ceiling() {
    let elapsed = Duration::from_secs(30);
    for usage_offset in [0, 500_000] {
        validate_busy_guest_cpu_sample(
            BusyGuestCpuSample {
                usage_usec: usage_offset,
                nr_throttled: 10,
            },
            BusyGuestCpuSample {
                usage_usec: usage_offset + 3_750_000,
                nr_throttled: 11,
            },
            elapsed,
        )
        .expect("independently capped busy VM");
    }
}

#[test]
fn busy_guest_sample_rejects_overuse_missing_throttle_and_counter_rollback() {
    let elapsed = Duration::from_secs(30);
    let before = BusyGuestCpuSample {
        usage_usec: 1_000,
        nr_throttled: 10,
    };
    assert!(
        validate_busy_guest_cpu_sample(
            before,
            BusyGuestCpuSample {
                usage_usec: before.usage_usec + 4_200_001,
                nr_throttled: 11,
            },
            elapsed,
        )
        .is_err()
    );
    assert!(
        validate_busy_guest_cpu_sample(
            before,
            BusyGuestCpuSample {
                usage_usec: before.usage_usec + 3_750_000,
                nr_throttled: before.nr_throttled,
            },
            elapsed,
        )
        .is_err()
    );
    assert!(
        validate_busy_guest_cpu_sample(
            before,
            BusyGuestCpuSample {
                usage_usec: before.usage_usec - 1,
                nr_throttled: 11,
            },
            elapsed,
        )
        .is_err()
    );
}

#[test]
fn worker_paths_must_share_disposable_root() {
    let root = Path::new("/var/lib/intar/jails/self-test/abc");
    assert_eq!(
        validate_worker_paths(
            &root.join("allowed/report.json"),
            &root.join("allowed"),
            &root.join("denied-marker"),
        )
        .expect("valid paths"),
        root
    );
    assert!(
        validate_worker_paths(
            Path::new("/tmp/report"),
            &root.join("allowed"),
            &root.join("denied-marker"),
        )
        .is_err()
    );
}

#[test]
fn cleanup_lookup_rejects_symlinks() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    std::fs::write(temporary.path().join("target"), b"target").expect("write target");
    std::os::unix::fs::symlink("target", temporary.path().join("link")).expect("create symlink");
    let parent = open(
        temporary.path(),
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .expect("open temporary directory");
    assert!(open_cleanup_entry(&parent, "link").is_err());
}

#[test]
fn cleanup_identity_check_rejects_path_substitution() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let first = File::create(temporary.path().join("first")).expect("create first file");
    let second = File::create(temporary.path().join("second")).expect("create second file");
    let first = rustix::fs::fstat(&first).expect("stat first file");
    let second = rustix::fs::fstat(&second).expect("stat second file");
    assert!(ensure_same_cleanup_object(&first, &second).is_err());
}

fn cleanup_test_path(suffix: &[&str]) -> Vec<Vec<u8>> {
    [
        "cloud-hypervisor-lifecycle",
        "jails",
        "quarantine",
        "generation-one",
        "root",
    ]
    .into_iter()
    .chain(suffix.iter().copied())
    .map(|component| component.as_bytes().to_vec())
    .collect()
}

#[test]
fn cleanup_policy_binds_vm_owner_to_its_reserved_generation() {
    let mut policy = CleanupPolicy::default();
    policy
        .vm_owners
        .insert("generation-one".to_owned(), (200_000, 200_000));
    assert_eq!(
        policy.expected_vm_owner(&cleanup_test_path(&["logs", "serial.log"])),
        Some((200_000, 200_000))
    );
    let mut wrong = cleanup_test_path(&["logs", "serial.log"]);
    wrong[3] = b"generation-two".to_vec();
    assert_eq!(policy.expected_vm_owner(&wrong), None);
    assert_eq!(
        policy.expected_vm_owner(&[
            b"cloud-hypervisor-lifecycle".to_vec(),
            b"jails".to_vec(),
            b"quarantine".to_vec(),
            b"generation-one".to_vec(),
            b"metadata-v2.json".to_vec(),
        ]),
        None
    );
}

#[test]
fn cleanup_device_and_socket_allowlists_are_path_exact() {
    assert_eq!(
        expected_cleanup_device(&cleanup_test_path(&["dev", "kvm"])),
        Some(CleanupDevice {
            major: 10,
            minor: 232,
            mode: 0o600,
        })
    );
    assert_eq!(
        expected_cleanup_device(&cleanup_test_path(&["dev", "net", "tun"])),
        Some(CleanupDevice {
            major: 10,
            minor: 200,
            mode: 0o600,
        })
    );
    assert_eq!(
        expected_cleanup_device(&cleanup_test_path(&["dev", "urandom"])),
        Some(CleanupDevice {
            major: 1,
            minor: 9,
            mode: 0o400,
        })
    );
    assert_eq!(
        expected_cleanup_device(&cleanup_test_path(&["dev", "null"])),
        Some(CleanupDevice {
            major: 1,
            minor: 3,
            mode: 0o600,
        })
    );
    assert!(expected_cleanup_device(&cleanup_test_path(&["dev", "vhost-vsock"])).is_none());
    assert!(cleanup_socket_allowed(&cleanup_test_path(&[
        "run",
        "cloud-hypervisor.sock"
    ])));
    assert!(cleanup_socket_allowed(&cleanup_test_path(&[
        "run",
        "kino.vsock"
    ])));
    assert!(!cleanup_socket_allowed(&cleanup_test_path(&[
        "run",
        "unexpected.sock"
    ])));
}

#[test]
fn cleanup_leaf_rejects_a_hardlinked_vm_file() {
    if rustix::process::geteuid() == rustix::process::Uid::ROOT {
        return;
    }
    let temporary = tempfile::tempdir().expect("temporary directory");
    let file_path = temporary.path().join("root.raw");
    std::fs::write(&file_path, b"fixture").expect("write cleanup fixture");
    let file = File::open(&file_path).expect("open cleanup fixture");
    let stat = rustix::fs::fstat(&file).expect("stat cleanup fixture");
    let mut policy = CleanupPolicy::default();
    policy
        .vm_owners
        .insert("generation-one".to_owned(), (stat.st_uid, stat.st_gid));
    let relative = cleanup_test_path(&["disks", "root.raw"]);
    validate_cleanup_leaf(&stat, &relative, &policy).expect("one-link VM file is cleanup-safe");

    std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o666))
        .expect("make cleanup fixture other-writable");
    let writable = rustix::fs::fstat(&file).expect("restat writable fixture");
    assert!(validate_cleanup_leaf(&writable, &relative, &policy).is_err());
    std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o600))
        .expect("restore private cleanup fixture mode");

    std::fs::hard_link(&file_path, temporary.path().join("outside-link"))
        .expect("create cleanup hardlink attack");
    let linked = rustix::fs::fstat(&file).expect("restat hardlinked fixture");
    assert!(validate_cleanup_leaf(&linked, &relative, &policy).is_err());
}

#[test]
fn cloud_hypervisor_argv_contract_is_api_only() {
    let exact = EXPECTED_API_ONLY_VMM_ARGV.join("\0") + "\0";
    validate_api_only_vmm_argv(exact.as_bytes()).expect("exact API-only argv");
    assert!(
        validate_api_only_vmm_argv(
            b"/cloud-hypervisor\0--api-socket\0/run/cloud-hypervisor.sock\0--landlock\0--seccomp\0true\0"
        )
        .is_err()
    );
    assert!(
        validate_api_only_vmm_argv(
            b"/cloud-hypervisor\0--api-socket\0/run/cloud-hypervisor.sock\0--seccomp\0true\0--kernel\0/boot/kernel\0"
        )
        .is_err()
    );
}

#[test]
fn current_executable_link_must_be_absolute_normal_and_live() {
    validate_current_exe_link(Path::new("/usr/lib/intar/intar-jailerd"))
        .expect("valid installed executable path");
    assert!(validate_current_exe_link(Path::new("relative/intar-jailerd")).is_err());
    assert!(validate_current_exe_link(Path::new("/usr/lib/../tmp/intar-jailerd")).is_err());
    assert!(
        validate_current_exe_link(Path::new("/usr/lib/intar/intar-jailerd (deleted)")).is_err()
    );
}

#[test]
fn attestation_and_absolute_lookups_reject_symlinks() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    std::fs::write(temporary.path().join("target"), b"attestation").expect("write target");
    std::os::unix::fs::symlink("target", temporary.path().join(ATTESTATION_FILE))
        .expect("create attestation symlink");
    let parent = File::open(temporary.path()).expect("open temporary directory");
    assert!(open_attestation_file(&parent).is_err());

    std::fs::create_dir(temporary.path().join("real")).expect("create real directory");
    std::fs::create_dir(temporary.path().join("real/child")).expect("create real child");
    open_absolute_nofollow(
        &temporary.path().join("real/child"),
        OFlags::RDONLY | OFlags::DIRECTORY,
    )
    .expect("open real child without symlinks");
    std::os::unix::fs::symlink("real", temporary.path().join("alias"))
        .expect("create directory symlink");
    assert!(
        open_absolute_nofollow(
            &temporary.path().join("alias/child"),
            OFlags::RDONLY | OFlags::DIRECTORY,
        )
        .is_err()
    );
}

#[test]
fn smoke_artifacts_must_share_one_parent() {
    let digest = "a".repeat(64);
    let kernel = VerifiedArtifact {
        path: PathBuf::from("/var/lib/intar/self-test-assets/runs/one/kernel"),
        sha256: digest.clone(),
    };
    let root_disk = VerifiedArtifact {
        path: PathBuf::from("/var/lib/intar/self-test-assets/runs/one/root.raw"),
        sha256: digest.clone(),
    };
    assert_eq!(
        shared_artifact_parent(&[&kernel, &root_disk]).expect("shared parent"),
        Path::new("/var/lib/intar/self-test-assets/runs/one")
    );

    let other = VerifiedArtifact {
        path: PathBuf::from("/var/lib/intar/self-test-assets/runs/two/runtime.raw"),
        sha256: digest,
    };
    assert!(shared_artifact_parent(&[&kernel, &other]).is_err());
}

#[test]
fn trusted_file_mode_is_normalized_through_the_open_fd() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let path = temporary.path().join("canary");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .expect("create private canary");

    set_exact_file_mode(&file, 0o444).expect("normalize canary permissions");

    assert_eq!(file.metadata().expect("stat canary").mode() & 0o777, 0o444);
    assert!(set_exact_file_mode(&file, 0o10_444).is_err());
    assert_eq!(
        file.metadata().expect("restat canary").mode() & 0o777,
        0o444
    );
}

#[test]
fn isolated_smoke_root_does_not_replace_production_source_root() {
    let production_root = PathBuf::from("/var/cache/intar-agent");
    let smoke_root = PathBuf::from("/var/lib/intar/self-test-assets/runs/fresh");
    let mut config = JailerdConfig {
        allowed_source_roots: vec![production_root.clone()],
        ..JailerdConfig::default()
    };
    config.allowed_source_roots.push(smoke_root.clone());
    let artifact = VerifiedArtifact {
        path: smoke_root.join("kernel"),
        sha256: "a".repeat(64),
    };
    let source = protocol_artifact(&config, &artifact, ArtifactAccess::ReadOnly)
        .expect("smoke artifact source");
    assert_eq!(source.source_root, 1);
    assert_eq!(source.relative_path, Path::new("kernel"));
    assert_eq!(config.allowed_source_roots[0], production_root);
}

#[test]
fn saturation_smoke_requests_have_unique_typed_topology() {
    let root = PathBuf::from("/var/lib/intar/self-test-assets/runs/fresh");
    let digest = "a".repeat(64);
    let artifact = |name: &str| VerifiedArtifact {
        path: root.join(name),
        sha256: digest.clone(),
    };
    let artifacts = SelfTestArtifacts {
        kernel: artifact("kernel"),
        initrd: None,
        root_disk: artifact("root.raw"),
        runtime_disk: artifact("runtime.raw"),
        recording_disk: artifact("recordings.vfat"),
    };
    let config = JailerdConfig {
        allowed_source_roots: vec![root],
        ..JailerdConfig::default()
    };
    let run_id = ValidatedId::parse("selftest-fixed").expect("run ID");
    let suffix = "0123456789abcdef0123456789abcdef";
    let image_sha256 = Sha256Digest::parse("b".repeat(64)).expect("image digest");
    let artifact_sha256 = Sha256Digest::parse(digest).expect("artifact digest");
    let prepared_image = PreparedImageV2Result {
        image_sha256: image_sha256.clone(),
        virtual_size_bytes: 4 * 1024 * 1024 * 1024,
        root_disk: crate::template_artifact_source(
            &image_sha256,
            "root.raw",
            &artifact_sha256,
            ArtifactAccess::ReadWrite,
        ),
        kernel: crate::template_artifact_source(
            &image_sha256,
            "kernel",
            &artifact_sha256,
            ArtifactAccess::ReadOnly,
        ),
        initrd: None,
        fast_template_store: true,
    };
    let requests = (0..=SELF_TEST_SATURATION_VM_COUNT)
        .map(|index| {
            smoke_launch_request(
                &config,
                &artifacts,
                &prepared_image,
                &run_id,
                suffix,
                u8::try_from(index).expect("request index"),
            )
            .expect("saturation smoke request")
        })
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 9);
    assert!(
        requests
            .iter()
            .all(|request| request.launch.run_id == run_id)
    );
    assert!(
        requests
            .iter()
            .all(|request| request.image_sha256 == image_sha256)
    );
    assert_eq!(
        requests
            .iter()
            .take(SELF_TEST_SATURATION_VM_COUNT)
            .map(|request| u64::from(request.launch.cpu_millis))
            .sum::<u64>(),
        SELF_TEST_SATURATION_CPU_MILLIS
    );
    assert_eq!(
        requests
            .iter()
            .map(|request| request.launch.vm_id.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
        requests.len()
    );
    assert_eq!(
        requests
            .iter()
            .map(|request| request.launch.tap_name.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
        requests.len()
    );
    assert_eq!(
        requests
            .iter()
            .map(|request| request.launch.mac_address.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
        requests.len()
    );
    assert_eq!(
        requests
            .iter()
            .map(|request| request.launch.guest_ip_cidr.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
        requests.len()
    );
    assert_eq!(
        requests
            .iter()
            .map(|request| request.launch.vsock_cid)
            .collect::<BTreeSet<_>>()
            .len(),
        requests.len()
    );
    assert!(
        smoke_launch_request(&config, &artifacts, &prepared_image, &run_id, suffix, 9,).is_err(),
        "only the eight saturation VMs and ninth rejection probe are valid"
    );
}

#[test]
fn attestation_requires_every_proof() {
    let mut attestation = SelfTestAttestationV2 {
        version: ATTESTATION_VERSION,
        config_runtime_fingerprint_sha256: "a".repeat(64),
        cloud_hypervisor_sha256: "b".repeat(64),
        intar_jailerd_sha256: "c".repeat(64),
        intar_jailer_sha256: "d".repeat(64),
        boot_id: "boot".to_owned(),
        kernel_version: "6.2".to_owned(),
        systemd_version: "252".to_owned(),
        landlock_abi: 3,
        quota_verified: true,
        burst_verified: true,
        boot_quota_transition_verified: true,
        network_verified: true,
        landlock_negative_access: true,
        kvm_accounting_proven: true,
        cloud_hypervisor_lifecycle_verified: true,
        passed_at_unix_s: 1,
    };
    validate_attestation(&attestation).expect("complete attestation");
    attestation.boot_quota_transition_verified = false;
    assert!(validate_attestation(&attestation).is_err());
    attestation.boot_quota_transition_verified = true;
    attestation.kvm_accounting_proven = false;
    assert!(validate_attestation(&attestation).is_err());
}
