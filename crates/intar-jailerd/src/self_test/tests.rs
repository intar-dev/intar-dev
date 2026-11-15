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
fn only_a_boot_mismatch_is_classified_as_a_previous_boot() {
    let fingerprint = "a".repeat(64);
    let runtime = "b".repeat(64);
    let jailerd = "c".repeat(64);
    let jailer = "d".repeat(64);
    let host = CurrentHost {
        cloud_hypervisor_sha256: &runtime,
        intar_jailerd_sha256: &jailerd,
        intar_jailer_sha256: &jailer,
        config_runtime_fingerprint_sha256: &fingerprint,
        boot_id: "boot",
        kernel_version: "kernel",
        systemd_version: "systemd",
        now_unix_s: 100,
    };
    assert!(matches!(
        classify(current_attestation(), &host),
        Ok(AttestationStatus::Verified(_))
    ));
    let rebooted = CurrentHost {
        boot_id: "next-boot",
        ..host
    };
    let status = classify(current_attestation(), &rebooted).expect("previous boot");
    assert!(matches!(status, AttestationStatus::PreviousBoot));
    assert!(status.verified().is_none());

    let other = "e".repeat(64);
    let stale = [
        CurrentHost {
            cloud_hypervisor_sha256: &other,
            ..rebooted
        },
        CurrentHost {
            intar_jailerd_sha256: &other,
            ..rebooted
        },
        CurrentHost {
            intar_jailer_sha256: &other,
            ..rebooted
        },
        CurrentHost {
            config_runtime_fingerprint_sha256: &other,
            ..rebooted
        },
        CurrentHost {
            kernel_version: "other-kernel",
            ..rebooted
        },
        CurrentHost {
            systemd_version: "other-systemd",
            ..rebooted
        },
    ];
    for host in &stale {
        assert!(classify(current_attestation(), host).is_err());
    }
    // The same staleness stays an error on the boot that wrote it, too.
    let same_boot_kernel = CurrentHost {
        kernel_version: "other-kernel",
        ..host
    };
    assert!(classify(current_attestation(), &same_boot_kernel).is_err());
    let mut future = current_attestation();
    future.passed_at_unix_s = 1_000;
    assert!(classify(future, &rebooted).is_err());
}
