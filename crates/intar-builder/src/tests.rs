#![allow(clippy::unwrap_used)]

use std::path::Path;

use super::{
    bridge, classify_publish_error, config, db, ensure_preflight_report_ready, local_bundle_rev,
    log_upload_warning, non_retryable_build_error, preflight, should_retry_build_error,
    validate_job_config, validate_run_once_publish_target, validate_run_once_publish_token,
    verify_bundle_or_drop_cached_archive,
};

#[test]
fn derives_local_bundle_rev_from_archive_name() {
    assert_eq!(
        local_bundle_rev(Path::new("/tmp/abc123.tar.gz")).unwrap(),
        "abc123"
    );
    assert_eq!(
        local_bundle_rev(Path::new("/tmp/abc123.tgz")).unwrap(),
        "abc123"
    );
    assert_eq!(
        local_bundle_rev(Path::new("/tmp/abc123")).unwrap(),
        "abc123"
    );
}

#[test]
fn rejects_unsafe_local_bundle_rev() {
    let error = local_bundle_rev(Path::new("/tmp/bad rev.tar.gz")).unwrap_err();
    assert!(format!("{error:#}").contains("invalid bundle rev"));
}

#[test]
fn rejects_parallel_builder_workers_until_build_paths_are_isolated() {
    let mut cfg = config::BuilderConfig::default();
    cfg.jobs.max_concurrent_builds = 2;

    let error = validate_job_config(&cfg).unwrap_err();

    assert!(format!("{error:#}").contains("not supported yet"));
}

#[test]
fn preflight_error_points_to_doctor_command() {
    let report = preflight::PreflightReport {
        checks: vec![
            preflight::PreflightCheck {
                name: "kvm device".to_string(),
                status: preflight::PreflightStatus::Fail,
                detail: "'/dev/kvm' is missing".to_string(),
            },
            preflight::PreflightCheck {
                name: "vhost-vsock device".to_string(),
                status: preflight::PreflightStatus::Warn,
                detail: "'/dev/vhost-vsock' is missing".to_string(),
            },
        ],
    };

    let error = ensure_preflight_report_ready(&report, Path::new("/etc/intar-builder/config.toml"))
        .unwrap_err();
    let message = format!("{error:#}");

    assert!(message.contains("1 required failure"));
    assert!(message.contains("intar-builder doctor --config /etc/intar-builder/config.toml"));
}

#[test]
fn preflight_warnings_do_not_block_builder_commands() {
    let report = preflight::PreflightReport {
        checks: vec![preflight::PreflightCheck {
            name: "vhost-vsock device".to_string(),
            status: preflight::PreflightStatus::Warn,
            detail: "'/dev/vhost-vsock' is missing".to_string(),
        }],
    };

    ensure_preflight_report_ready(&report, Path::new("/etc/intar-builder/config.toml")).unwrap();
}

#[test]
fn verified_bad_bundle_errors_do_not_retry() {
    let retryable = anyhow::anyhow!("transient qemu failure");
    assert!(should_retry_build_error(&retryable, 1, 3));
    assert!(!should_retry_build_error(&retryable, 3, 3));

    let non_retryable =
        non_retryable_build_error(anyhow::anyhow!("desired build content hash mismatch"));

    assert!(!should_retry_build_error(&non_retryable, 1, 3));
    assert!(format!("{non_retryable:#}").contains("content hash mismatch"));
}

#[test]
fn superseded_publish_rejections_do_not_retry() {
    let withdrawn = classify_publish_error(intar_image_upload::Error::HttpStatus {
        status: reqwest::StatusCode::CONFLICT,
        body: "build is not active for this builder".to_string(),
    });
    assert!(!should_retry_build_error(&withdrawn, 1, 3));

    let transient = classify_publish_error(intar_image_upload::Error::HttpStatus {
        status: reqwest::StatusCode::SERVICE_UNAVAILABLE,
        body: "try again".to_string(),
    });
    assert!(should_retry_build_error(&transient, 1, 3));
}

#[test]
fn run_once_publish_requires_explicit_operator_token() {
    assert_eq!(validate_run_once_publish_token(None).unwrap(), None);
    assert_eq!(
        validate_run_once_publish_token(Some("publish-secret".to_string()))
            .unwrap()
            .as_deref(),
        Some("publish-secret")
    );
    assert!(validate_run_once_publish_token(Some("  ".to_string())).is_err());
}

#[test]
fn run_once_publish_target_is_validated_before_building() {
    let mut cfg = config::BuilderConfig::default();
    assert!(validate_run_once_publish_target(&cfg, None).is_ok());

    let error = validate_run_once_publish_target(&cfg, Some("publish-secret")).unwrap_err();
    assert!(format!("{error:#}").contains("relative URL"));

    cfg.bridge.base_url = "https://intar.test".to_string();
    validate_run_once_publish_target(&cfg, Some("publish-secret")).unwrap();
}

#[tokio::test]
async fn drops_cached_bundle_after_verification_failure() {
    let temp = tempfile::tempdir().unwrap();
    let archive = temp.path().join("abc123.tar.gz");
    std::fs::write(&archive, b"valid-enough-cache-key").unwrap();
    let bundle_root = temp.path().join("unpacked");
    std::fs::create_dir_all(&bundle_root).unwrap();
    let build = intar_contracts::bridge::DesiredBuildV1 {
        build_id: "build-1".to_string(),
        scenario_id: "broken-nginx".to_string(),
        arch: intar_contracts::catalog::ImageArchitecture::X86_64,
        rev: "abc123".to_string(),
        content_hash: "f".repeat(64),
        bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
        kino_version: "0.1.24".to_string(),
    };

    let error = verify_bundle_or_drop_cached_archive(&archive, &bundle_root, &build)
        .await
        .unwrap_err();

    assert!(format!("{error:#}").contains("will be refetched on retry"));
    assert!(!archive.exists());
}

#[test]
fn log_upload_warning_keeps_published_build_successful() {
    let warning = log_upload_warning(&anyhow::anyhow!("HTTP 503"));

    assert_eq!(
        warning,
        "image published, but build log upload failed: HTTP 503"
    );
}

#[test]
fn successful_build_report_can_include_log_upload_warning() {
    let db = db::BuilderDb::open_in_memory().unwrap();
    let build = intar_contracts::bridge::DesiredBuildV1 {
        build_id: "build-1".to_string(),
        scenario_id: "broken-nginx".to_string(),
        arch: intar_contracts::catalog::ImageArchitecture::X86_64,
        rev: "abc123".to_string(),
        content_hash: "f".repeat(64),
        bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
        kino_version: "0.1.24".to_string(),
    };
    db.upsert_build_job(&build, "uploading_logs", 1, None, 1000)
        .unwrap();
    db.update_build_job_phase(
        "build-1",
        "succeeded",
        None,
        1,
        Some("image published, but build log upload failed: HTTP 503"),
        2000,
    )
    .unwrap();

    let row = db.load_build_job("build-1").unwrap().unwrap();
    let report = bridge::build_report_from_job("builder-1", row);

    assert_eq!(report.phase, intar_contracts::bridge::BuildPhase::Succeeded);
    assert_eq!(
        report.error.as_deref(),
        Some("image published, but build log upload failed: HTTP 503")
    );
    assert_eq!(report.finished_at_unix_ms, Some(2000));
}
