use super::*;

#[test]
fn artifact_validation_rejects_relative_paths_and_bad_hashes() {
    let artifact = VerifiedArtifact {
        path: PathBuf::from("relative"),
        sha256: "a".repeat(64),
    };
    let artifacts = SelfTestArtifacts {
        kernel: artifact.clone(),
        initrd: None,
        root_disk: artifact.clone(),
        runtime_disk: artifact.clone(),
        recording_disk: artifact,
    };
    assert!(artifacts.validate().is_err());

    let mut artifact = VerifiedArtifact {
        path: PathBuf::from("/absolute"),
        sha256: "a".repeat(63),
    };
    assert!(validate_sha256(&artifact.sha256).is_err());
    artifact.sha256.push('a');
    assert!(validate_sha256(&artifact.sha256).is_ok());
}

#[test]
fn attestation_rejects_unknown_fields() {
    let value = serde_json::json!({
        "version": ATTESTATION_VERSION,
        "config_runtime_fingerprint_sha256": "a".repeat(64),
        "cloud_hypervisor_sha256": "b".repeat(64),
        "intar_jailerd_sha256": "c".repeat(64),
        "intar_jailer_sha256": "d".repeat(64),
        "boot_id": "boot",
        "kernel_version": "kernel",
        "systemd_version": "systemd",
        "landlock_abi": 3,
        "quota_verified": true,
        "burst_verified": true,
        "startup_quota_verified": true,
        "network_verified": true,
        "landlock_negative_access": true,
        "kvm_accounting_proven": true,
        "cloud_hypervisor_lifecycle_verified": true,
        "passed_at_unix_s": 1,
        "unexpected": true
    });
    assert!(serde_json::from_value::<SelfTestAttestationV3>(value).is_err());
}

#[test]
fn legacy_attestation_without_boot_transition_proof_is_rejected() {
    let value = serde_json::json!({
        "version": 1,
        "config_runtime_fingerprint_sha256": "a".repeat(64),
        "cloud_hypervisor_sha256": "b".repeat(64),
        "intar_jailerd_sha256": "c".repeat(64),
        "intar_jailer_sha256": "d".repeat(64),
        "boot_id": "boot",
        "kernel_version": "kernel",
        "systemd_version": "systemd",
        "landlock_abi": 3,
        "quota_verified": true,
        "burst_verified": true,
        "network_verified": true,
        "landlock_negative_access": true,
        "kvm_accounting_proven": true,
        "cloud_hypervisor_lifecycle_verified": true,
        "passed_at_unix_s": 1
    });
    assert!(serde_json::from_value::<SelfTestAttestationV3>(value).is_err());
}

fn current_attestation() -> SelfTestAttestationV3 {
    SelfTestAttestationV3 {
        version: ATTESTATION_VERSION,
        config_runtime_fingerprint_sha256: "a".repeat(64),
        cloud_hypervisor_sha256: "b".repeat(64),
        intar_jailerd_sha256: "c".repeat(64),
        intar_jailer_sha256: "d".repeat(64),
        boot_id: "boot".to_owned(),
        kernel_version: "kernel".to_owned(),
        systemd_version: "systemd".to_owned(),
        landlock_abi: 3,
        quota_verified: true,
        burst_verified: true,
        startup_quota_verified: true,
        network_verified: true,
        landlock_negative_access: true,
        kvm_accounting_proven: true,
        cloud_hypervisor_lifecycle_verified: true,
        passed_at_unix_s: 1,
    }
}

#[test]
fn another_boot_is_a_previous_boot_whatever_else_is_stale() {
    let attestation = current_attestation();
    let previous =
        |kernel, systemd, now| match previous_boot(&attestation, "next-boot", kernel, systemd, now)
        {
            Some(AttestationStatus::PreviousBoot { stale }) => stale,
            other => panic!("expected a previous boot, got {other:?}"),
        };
    assert_eq!(previous(Some("kernel"), Some("systemd"), Some(100)), None);
    assert_eq!(
        previous(Some("other-kernel"), Some("other-systemd"), Some(100)),
        Some("kernel_version")
    );
    assert_eq!(
        previous(Some("kernel"), Some("other-systemd"), Some(100)),
        Some("systemd_version")
    );
    // The previous boot's clock ran ahead of this early-boot clock.
    let mut ahead = current_attestation();
    ahead.passed_at_unix_s = 1_000;
    assert!(matches!(
        previous_boot(
            &ahead,
            "next-boot",
            Some("kernel"),
            Some("systemd"),
            Some(100)
        ),
        Some(AttestationStatus::PreviousBoot {
            stale: Some("passed_at_unix_s")
        })
    ));
    // Unreadable platform values never turn a previous boot into an error.
    assert_eq!(previous(None, None, None), None);
    assert!(previous_boot(&attestation, "boot", None, None, None).is_none());
}

#[test]
fn a_stale_attestation_of_this_boot_is_an_error() {
    let fingerprint = "a".repeat(64);
    let runtime = "b".repeat(64);
    let jailerd = "c".repeat(64);
    let jailer = "d".repeat(64);
    let host = CurrentHost {
        cloud_hypervisor_sha256: &runtime,
        intar_jailerd_sha256: &jailerd,
        intar_jailer_sha256: &jailer,
        config_runtime_fingerprint_sha256: &fingerprint,
        kernel_version: "kernel",
        systemd_version: "systemd",
        now_unix_s: 100,
    };
    let status = classify(current_attestation(), &host).expect("verified");
    assert!(status.verified().is_some());

    let other = "e".repeat(64);
    let stale = [
        CurrentHost {
            cloud_hypervisor_sha256: &other,
            ..host
        },
        CurrentHost {
            intar_jailerd_sha256: &other,
            ..host
        },
        CurrentHost {
            intar_jailer_sha256: &other,
            ..host
        },
        CurrentHost {
            config_runtime_fingerprint_sha256: &other,
            ..host
        },
        CurrentHost {
            kernel_version: "other-kernel",
            ..host
        },
        CurrentHost {
            systemd_version: "other-systemd",
            ..host
        },
    ];
    for stale in &stale {
        assert!(classify(current_attestation(), stale).is_err());
    }
    let mut future = current_attestation();
    future.passed_at_unix_s = 1_000;
    assert!(classify(future, &host).is_err());
}
