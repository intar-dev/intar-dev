#![allow(clippy::unwrap_used)]

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use super::{
    BUNDLE_CACHE_LOCK, bridge, classify_publish_error, cleanup_reported_build_attempt_artifacts,
    config, db, emit_build_report, ensure_preflight_report_ready, fetch_verified_bundle,
    local_bundle_rev, log_upload_warning, non_retryable_build_error, preflight,
    qemu_build_config_for_job, should_retry_build_error, unpacked_bundle_root, validate_job_config,
    validate_run_once_publish_target, validate_run_once_publish_token,
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
fn accepts_two_isolated_builder_workers_and_rejects_more() {
    let mut cfg = config::BuilderConfig::default();
    cfg.jobs.max_concurrent_builds = 2;
    validate_job_config(&cfg).expect("two isolated workers are supported");

    cfg.jobs.max_concurrent_builds = 3;
    let error = validate_job_config(&cfg).unwrap_err();

    assert!(format!("{error:#}").contains("must not exceed 2"));
}

#[test]
fn concurrent_build_ids_and_hashes_get_disjoint_paths() {
    let cfg = config::BuilderConfig::default();
    let build = |build_id: &str, content_hash: &str| intar_contracts::bridge::DesiredBuildV1 {
        build_id: build_id.to_string(),
        scenario_id: "broken-nginx".to_string(),
        arch: intar_contracts::catalog::ImageArchitecture::X86_64,
        rev: "revision-1".to_string(),
        content_hash: content_hash.to_string(),
        bundle_ref: "builds/bundles/revision-1.tar.gz".to_string(),
    };
    let first = qemu_build_config_for_job(&cfg, &build("build-a", &"a".repeat(64)));
    let second = qemu_build_config_for_job(&cfg, &build("build-b", &"b".repeat(64)));

    assert_ne!(first.work_root, second.work_root);
    assert_ne!(first.output_root, second.output_root);
}

#[tokio::test]
async fn cleans_only_reported_build_attempt_artifacts_idempotently() {
    let temporary = tempfile::tempdir().unwrap();
    let mut cfg = config::BuilderConfig::default();
    cfg.builder.work_root = temporary.path().join("work");
    cfg.builder.cache_root = temporary.path().join("cache");
    cfg.builder.state_db = temporary.path().join("builder.sqlite3");

    let build_id = "build-1";
    let build_work = cfg
        .builder
        .work_root
        .join("builds")
        .join(build_id)
        .join("content-hash");
    let build_output = cfg
        .builder
        .cache_root
        .join("outputs")
        .join(build_id)
        .join("content-hash");
    let other_work = cfg.builder.work_root.join("builds").join("other-build");
    let other_output = cfg.builder.cache_root.join("outputs").join("other-build");
    for path in [&build_work, &build_output, &other_work, &other_output] {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("artifact"), "data").unwrap();
    }

    cleanup_reported_build_attempt_artifacts(&cfg, build_id, "abc123").await;

    assert!(!build_work.parent().unwrap().exists());
    assert!(!build_output.parent().unwrap().exists());
    assert!(other_work.join("artifact").exists());
    assert!(other_output.join("artifact").exists());

    cleanup_reported_build_attempt_artifacts(&cfg, build_id, "abc123").await;

    assert!(other_work.join("artifact").exists());
    assert!(other_output.join("artifact").exists());

    cleanup_reported_build_attempt_artifacts(&cfg, "../other-build", "abc123").await;

    assert!(other_work.join("artifact").exists());
    assert!(other_output.join("artifact").exists());
}

/// A local bridge that serves one bundle archive and counts its downloads.
fn serve_bundle(archive: Vec<u8>) -> (String, Arc<AtomicUsize>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let downloads = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&downloads);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            counter.fetch_add(1, Ordering::SeqCst);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                archive.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&archive);
        }
    });
    (base_url, downloads)
}

struct BundleCacheFixture {
    _temporary: tempfile::TempDir,
    cfg: config::BuilderConfig,
    downloads: Arc<AtomicUsize>,
    content_hash: String,
}

impl BundleCacheFixture {
    const REV: &str = "abc123";

    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        crate::bundle::tests::write_bundle_fixture(&source);
        let content_hash = crate::bundle::inspect_bundle_build_input(
            &source,
            "broken-nginx",
            intar_contracts::catalog::ImageArchitecture::X86_64,
            Self::REV,
        )
        .unwrap()
        .build
        .content_hash;
        let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        archive.append_dir_all("", &source).unwrap();
        let archive = archive.into_inner().unwrap().finish().unwrap();

        let (base_url, downloads) = serve_bundle(archive);
        let mut cfg = config::BuilderConfig::default();
        cfg.bridge.base_url = base_url;
        cfg.builder.work_root = temporary.path().join("work");
        cfg.builder.cache_root = temporary.path().join("cache");
        cfg.builder.state_db = temporary.path().join("builder.sqlite3");
        Self {
            _temporary: temporary,
            cfg,
            downloads,
            content_hash,
        }
    }

    fn build(&self, build_id: &str) -> intar_contracts::bridge::DesiredBuildV1 {
        intar_contracts::bridge::DesiredBuildV1 {
            build_id: build_id.to_string(),
            scenario_id: "broken-nginx".to_string(),
            arch: intar_contracts::catalog::ImageArchitecture::X86_64,
            rev: Self::REV.to_string(),
            content_hash: self.content_hash.clone(),
            bundle_ref: format!("builds/bundles/{}.tar.gz", Self::REV),
        }
    }

    fn set_phase(&self, build_id: &str, phase: &str) {
        let db = db::BuilderDb::open(&self.cfg.builder.state_db).unwrap();
        db.upsert_build_job(&self.build(build_id), phase, 1, None, 1000)
            .unwrap();
    }

    async fn fetch(&self, build_id: &str) {
        fetch_verified_bundle(&self.cfg, "token", &self.build(build_id))
            .await
            .unwrap();
    }

    fn paths(&self) -> [PathBuf; 2] {
        [
            self.cfg
                .builder
                .cache_root
                .join("bundles")
                .join(format!("{}.tar.gz", Self::REV)),
            unpacked_bundle_root(&self.cfg.builder.cache_root, Self::REV),
        ]
    }

    fn cached(&self) -> bool {
        self.paths().iter().all(|path| path.exists())
    }

    fn evicted(&self) -> bool {
        self.paths().iter().all(|path| !path.exists())
    }

    fn downloads(&self) -> usize {
        self.downloads.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn evicts_a_revs_bundle_after_its_last_build() {
    let fixture = BundleCacheFixture::new();
    fixture.set_phase("build-a", "fetching_sources");
    fixture.set_phase("build-b", "queued");
    fixture.fetch("build-a").await;
    assert!(fixture.cached());
    assert_eq!(fixture.downloads(), 1);

    fixture.set_phase("build-a", "succeeded");
    cleanup_reported_build_attempt_artifacts(&fixture.cfg, "build-a", BundleCacheFixture::REV)
        .await;
    assert!(fixture.cached(), "a queued build still names the rev");

    // A tree left aside by an interrupted eviction does not block the next.
    let interrupted = fixture.paths()[1].with_file_name(".abc123.evicted");
    std::fs::create_dir_all(&interrupted).unwrap();
    std::fs::write(interrupted.join("partial"), "data").unwrap();
    fixture.set_phase("build-b", "failed");
    cleanup_reported_build_attempt_artifacts(&fixture.cfg, "build-b", BundleCacheFixture::REV)
        .await;
    assert!(fixture.evicted());
    assert!(!interrupted.exists());

    fixture.set_phase("build-c", "fetching_sources");
    fixture.fetch("build-c").await;
    assert!(fixture.cached());
    assert_eq!(
        fixture.downloads(),
        2,
        "a later build downloads the rev again"
    );
}

#[tokio::test]
async fn eviction_rechecks_builds_under_the_bundle_cache_lock() {
    let fixture = Arc::new(BundleCacheFixture::new());
    fixture.set_phase("build-a", "fetching_sources");
    fixture.fetch("build-a").await;
    fixture.set_phase("build-a", "succeeded");

    let fetching = BUNDLE_CACHE_LOCK.lock().await;
    let evicting = Arc::clone(&fixture);
    let mut eviction = tokio::spawn(async move {
        cleanup_reported_build_attempt_artifacts(&evicting.cfg, "build-a", BundleCacheFixture::REV)
            .await;
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut eviction)
            .await
            .is_err(),
        "eviction must wait for the bundle cache lock"
    );
    fixture.set_phase("build-b", "fetching_sources");
    drop(fetching);
    eviction.await.unwrap();

    assert!(
        fixture.cached(),
        "a build inserted while eviction waited keeps the bundle"
    );
}

#[tokio::test]
async fn a_build_fetching_during_an_eviction_downloads_the_bundle_again() {
    let fixture = Arc::new(BundleCacheFixture::new());
    fixture.set_phase("build-a", "fetching_sources");
    fixture.fetch("build-a").await;
    fixture.set_phase("build-a", "succeeded");

    // An eviction holds the lock and has found no unfinished build of the rev.
    let evicting = BUNDLE_CACHE_LOCK.lock().await;
    fixture.set_phase("build-b", "fetching_sources");
    let fetching = Arc::clone(&fixture);
    let mut fetch = tokio::spawn(async move { fetching.fetch("build-b").await });
    assert!(
        tokio::time::timeout(Duration::from_millis(300), &mut fetch)
            .await
            .is_err(),
        "a build must not use the bundle while an eviction runs"
    );
    std::fs::remove_file(&fixture.paths()[0]).unwrap();
    std::fs::remove_dir_all(&fixture.paths()[1]).unwrap();
    drop(evicting);
    fetch.await.unwrap();

    assert!(fixture.cached());
    assert_eq!(fixture.downloads(), 2);
}

#[tokio::test]
async fn closed_report_queue_keeps_persisted_build_state_replayable() {
    let temporary = tempfile::tempdir().unwrap();
    let mut cfg = config::BuilderConfig::default();
    cfg.builder.state_db = temporary.path().join("builder.sqlite3");
    let build = intar_contracts::bridge::DesiredBuildV1 {
        build_id: "build-1".to_string(),
        scenario_id: "broken-nginx".to_string(),
        arch: intar_contracts::catalog::ImageArchitecture::X86_64,
        rev: "abc123".to_string(),
        content_hash: "f".repeat(64),
        bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
    };
    let db = db::BuilderDb::open(&cfg.builder.state_db).unwrap();
    db.upsert_build_job(&build, "succeeded", 1, None, 1000)
        .unwrap();
    let (report_tx, report_rx) = tokio::sync::mpsc::channel(1);
    drop(report_rx);

    emit_build_report(&cfg, &report_tx, &build.build_id)
        .await
        .unwrap();

    assert_eq!(
        db.load_build_job(&build.build_id).unwrap().unwrap().phase,
        "succeeded"
    );
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
