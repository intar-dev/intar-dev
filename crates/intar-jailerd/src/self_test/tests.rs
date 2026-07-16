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
        "boot_quota_transition_verified": true,
        "network_verified": true,
        "landlock_negative_access": true,
        "kvm_accounting_proven": true,
        "cloud_hypervisor_lifecycle_verified": true,
        "passed_at_unix_s": 1,
        "unexpected": true
    });
    assert!(serde_json::from_value::<SelfTestAttestationV2>(value).is_err());
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
    assert!(serde_json::from_value::<SelfTestAttestationV2>(value).is_err());
}
