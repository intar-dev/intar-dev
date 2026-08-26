use super::*;
use std::io::Read as _;
use tempfile::tempdir;

fn test_archive_job(run_id: &str, vm_name: &str) -> ArchiveJobRow {
    ArchiveJobRow {
        run_id: run_id.to_string(),
        vm_name: vm_name.to_string(),
        vm_created_at_ms: 1,
        delete_requested_at_ms: 2,
        deleted_at_ms: 3,
        artifacts_dir: format!("/tmp/{run_id}/{vm_name}/artifacts"),
        next_attempt_at_ms: 4,
        retry_count: 0,
        last_error: None,
        created_at_ms: 5,
        updated_at_ms: 6,
    }
}

fn test_local_artifact(
    ordinal: u32,
    kind: &str,
    filename: String,
    path: std::path::PathBuf,
) -> LocalArtifact {
    LocalArtifact {
        ordinal,
        kind: kind.to_string(),
        filename,
        content_type: "application/octet-stream".to_string(),
        size_bytes: 1,
        sha256: "0".repeat(64),
        path,
    }
}

fn test_raw_recording_artifact(ordinal: u32, path: std::path::PathBuf) -> LocalArtifact {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("test raw recording path has a UTF-8 filename")
        .to_string();
    test_local_artifact(ordinal, "ssh_recording_raw", filename, path)
}

#[test]
fn archive_stage_wire_values_are_stable_and_learner_safe() {
    assert_eq!(
        serde_json::to_string(&RunArchiveStageRequest {
            stage: ArchiveStage::RawFilesSaved,
        })
        .expect("serialize raw-files stage"),
        r#"{"stage":"raw_files_saved"}"#,
    );
    assert_eq!(
        serde_json::to_string(&RunArchiveStageRequest {
            stage: ArchiveStage::ReplayPrepared,
        })
        .expect("serialize replay-ready stage"),
        r#"{"stage":"replay_prepared"}"#,
    );
    assert_eq!(
        serde_json::to_string(&RunArchiveStageRequest {
            stage: ArchiveStage::ReplaySkipped,
        })
        .expect("serialize replay-skipped stage"),
        r#"{"stage":"replay_skipped"}"#,
    );
}

#[test]
fn begin_response_enables_granular_callbacks_only_for_version_one() {
    assert!(archive_progress_acknowledged(
        r#"{"runId":"run","vmName":"vm","archiveProgressVersion":1}"#,
    ));
    assert!(!archive_progress_acknowledged(
        r#"{"runId":"run","vmName":"vm","archiveProgressVersion":2}"#,
    ));
    assert!(!archive_progress_acknowledged(
        r#"{"runId":"run","vmName":"vm","archiveProgressVersion":"1"}"#,
    ));
}

#[test]
fn old_web_begin_response_keeps_granular_callbacks_disabled() {
    assert!(!archive_progress_acknowledged(
        r#"{"runId":"run","vmName":"vm"}"#,
    ));
    assert!(!archive_progress_acknowledged("not-json"));
}

#[test]
fn replay_stage_capability_is_latched_to_the_initial_raw_begin() {
    assert!(replay_stage_reporting_enabled(true, true));
    assert!(
        !replay_stage_reporting_enabled(false, true),
        "a replay begin must not upgrade a legacy raw upload"
    );
    assert!(
        !replay_stage_reporting_enabled(true, false),
        "a later legacy response must suppress the replay stage"
    );
    assert!(!replay_stage_reporting_enabled(false, false));

    let mut trace = ArchiveRemoteOrder::new();
    for event in [
        ArchiveRemoteEvent::RawUploadComplete,
        ArchiveRemoteEvent::RawFilesStage,
        ArchiveRemoteEvent::CastRegistration,
        ArchiveRemoteEvent::CastUploadComplete,
        ArchiveRemoteEvent::TimelineSubmitted,
        ArchiveRemoteEvent::Complete,
    ] {
        trace
            .observe(event)
            .expect("a suppressed replay stage must still allow completion");
    }
}

#[test]
fn replay_render_limit_keeps_500_raw_sessions_and_skips_501() {
    assert_eq!(MAX_REPLAY_RAW_SESSION_COUNT, 500);
    let raw_artifact = |ordinal: u32| LocalArtifact {
        ordinal,
        kind: "ssh_recording_raw".to_string(),
        filename: format!("ssh-session-{ordinal}.krec"),
        content_type: "application/x-kino-raw-event-log; charset=utf-8".to_string(),
        size_bytes: 1,
        sha256: "0".repeat(64),
        path: std::path::PathBuf::from(format!("/tmp/session-{ordinal}.krec")),
    };
    let mut artifacts = (0..MAX_REPLAY_RAW_SESSION_COUNT)
        .map(|ordinal| raw_artifact(ordinal as u32))
        .collect::<Vec<_>>();
    artifacts.push(LocalArtifact {
        ordinal: u32::MAX,
        kind: "console_log".to_string(),
        filename: "console.log".to_string(),
        content_type: "text/plain; charset=utf-8".to_string(),
        size_bytes: 1,
        sha256: "1".repeat(64),
        path: std::path::PathBuf::from("/tmp/console.log"),
    });

    assert_eq!(
        replay_raw_session_count(&artifacts),
        MAX_REPLAY_RAW_SESSION_COUNT
    );
    assert!(replay_render_is_supported(replay_raw_session_count(
        &artifacts
    )));

    artifacts.push(raw_artifact(MAX_REPLAY_RAW_SESSION_COUNT as u32));
    assert_eq!(
        replay_raw_session_count(&artifacts),
        MAX_REPLAY_RAW_SESSION_COUNT + 1
    );
    assert!(!replay_render_is_supported(replay_raw_session_count(
        &artifacts
    )));
    assert_eq!(
        archive_stage_after_replay(false, false),
        ArchiveStage::ReplaySkipped
    );
}

#[tokio::test]
async fn oversized_raw_manifest_bundles_every_recording_deterministically() {
    assert_eq!(MAX_INITIAL_ARCHIVE_ARTIFACTS, 1024);
    let spool = tempdir().expect("create artifact spool");
    let mut expected = std::collections::BTreeMap::new();
    let mut artifacts = vec![
        test_local_artifact(
            1,
            "console_log",
            "console.log".to_string(),
            spool.path().join("console.log"),
        ),
        test_local_artifact(
            2,
            "serial_log",
            "serial.log".to_string(),
            spool.path().join("serial.log"),
        ),
        test_local_artifact(
            3,
            "cloud_hypervisor_stderr_log",
            "cloud-hypervisor.stderr.log".to_string(),
            spool.path().join("cloud-hypervisor.stderr.log"),
        ),
    ];
    for index in (0..1022_u32).rev() {
        let filename = format!("ssh-session-{index:04}.krec");
        let bytes = format!("recording-{index}").into_bytes();
        let path = spool.path().join(&filename);
        tokio::fs::write(&path, &bytes)
            .await
            .expect("write raw recording");
        expected.insert(filename, bytes);
        artifacts.push(test_raw_recording_artifact(
            u32::try_from(artifacts.len() + 1).expect("test ordinal fits"),
            path,
        ));
    }
    let retry_input = artifacts.clone();
    assert_eq!(artifacts.len(), 1025);

    assert!(
        bundle_raw_recordings_when_manifest_exceeds_limit(spool.path(), &mut artifacts)
            .await
            .expect("bundle oversized raw manifest")
    );
    assert_eq!(artifacts.len(), 4);
    assert!(artifacts.len() <= MAX_INITIAL_ARCHIVE_ARTIFACTS);
    assert!(
        artifacts
            .iter()
            .enumerate()
            .all(|(index, artifact)| artifact.ordinal == (index + 1) as u32)
    );
    assert_eq!(replay_raw_session_count(&artifacts), 0);
    let bundle = artifacts
        .iter()
        .find(|artifact| artifact.kind == RAW_RECORDINGS_TAR_KIND)
        .expect("raw tar descriptor");
    assert_eq!(bundle.filename, RAW_RECORDINGS_TAR_FILENAME);
    assert_eq!(bundle.content_type, RAW_RECORDINGS_TAR_CONTENT_TYPE);
    let first_tar_bytes = tokio::fs::read(&bundle.path)
        .await
        .expect("read first raw tar bundle");

    let mut archive =
        tar::Archive::new(std::fs::File::open(&bundle.path).expect("open raw tar bundle"));
    let mut names = Vec::new();
    for entry in archive.entries().expect("iterate raw tar entries") {
        let mut entry = entry.expect("read raw tar entry");
        assert!(entry.header().entry_type().is_file());
        assert_eq!(entry.header().mode().expect("tar mode"), 0o644);
        assert_eq!(entry.header().uid().expect("tar uid"), 0);
        assert_eq!(entry.header().gid().expect("tar gid"), 0);
        assert_eq!(entry.header().mtime().expect("tar mtime"), 0);
        let name = entry
            .path()
            .expect("read tar entry path")
            .into_owned()
            .to_string_lossy()
            .into_owned();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).expect("read tar entry bytes");
        assert_eq!(expected.get(&name), Some(&bytes));
        names.push(name);
    }
    assert_eq!(names.len(), expected.len());
    assert!(names.windows(2).all(|pair| pair[0] < pair[1]));

    let mut retry_artifacts = retry_input;
    assert!(
        bundle_raw_recordings_when_manifest_exceeds_limit(spool.path(), &mut retry_artifacts)
            .await
            .expect("reuse raw tar bundle on retry")
    );
    let retry_bundle = retry_artifacts
        .iter()
        .find(|artifact| artifact.kind == RAW_RECORDINGS_TAR_KIND)
        .expect("retry raw tar descriptor");
    assert_eq!(retry_bundle.sha256, bundle.sha256);
    assert_eq!(retry_bundle.size_bytes, bundle.size_bytes);
    assert_eq!(
        tokio::fs::read(&retry_bundle.path)
            .await
            .expect("read retry raw tar bundle"),
        first_tar_bytes,
        "a retry must reuse the same deterministic bundle bytes"
    );
}

#[tokio::test]
async fn raw_manifest_at_worker_limit_keeps_individual_recording_descriptors() {
    let spool = tempdir().expect("create artifact spool");
    let mut artifacts = vec![
        test_local_artifact(
            1,
            "console_log",
            "console.log".to_string(),
            spool.path().join("console.log"),
        ),
        test_local_artifact(
            2,
            "serial_log",
            "serial.log".to_string(),
            spool.path().join("serial.log"),
        ),
        test_local_artifact(
            3,
            "cloud_hypervisor_stderr_log",
            "cloud-hypervisor.stderr.log".to_string(),
            spool.path().join("cloud-hypervisor.stderr.log"),
        ),
    ];
    for index in 0..1021_u32 {
        artifacts.push(test_raw_recording_artifact(
            u32::try_from(artifacts.len() + 1).expect("test ordinal fits"),
            spool.path().join(format!("ssh-session-{index:04}.krec")),
        ));
    }
    let before = artifacts.clone();
    assert_eq!(artifacts.len(), MAX_INITIAL_ARCHIVE_ARTIFACTS);

    assert!(
        !bundle_raw_recordings_when_manifest_exceeds_limit(spool.path(), &mut artifacts)
            .await
            .expect("keep manifest at worker limit")
    );
    assert_eq!(artifacts.len(), MAX_INITIAL_ARCHIVE_ARTIFACTS);
    assert_eq!(replay_raw_session_count(&artifacts), 1021);
    assert_eq!(
        artifacts
            .iter()
            .map(|artifact| &artifact.filename)
            .collect::<Vec<_>>(),
        before
            .iter()
            .map(|artifact| &artifact.filename)
            .collect::<Vec<_>>()
    );
    assert!(
        !spool.path().join(RAW_RECORDINGS_TAR_FILENAME).exists(),
        "the normal individual-artifact path must not create a tar"
    );
}

#[tokio::test]
async fn stage_enabled_client_trace_keeps_remote_order_when_render_finishes_first() {
    let (release_raw_upload, raw_upload_release) = tokio::sync::oneshot::channel::<()>();
    let raw_upload = tokio::spawn(async move {
        raw_upload_release
            .await
            .expect("test must release the raw upload");
    });
    let render = tokio::spawn(async { "render complete" });

    assert_eq!(
        render.await.expect("renderer task must not panic"),
        "render complete"
    );
    assert!(
        !raw_upload.is_finished(),
        "the renderer must be able to finish while raw upload is still blocked"
    );

    release_raw_upload
        .send(())
        .expect("blocked raw upload task must be waiting");
    raw_upload.await.expect("raw upload task must not panic");

    let mut trace = ArchiveRemoteOrder::new();
    for event in [
        ArchiveRemoteEvent::RawUploadComplete,
        ArchiveRemoteEvent::RawFilesStage,
        ArchiveRemoteEvent::CastRegistration,
        ArchiveRemoteEvent::CastUploadComplete,
        ArchiveRemoteEvent::TimelineSubmitted,
        ArchiveRemoteEvent::ReplayStage,
        ArchiveRemoteEvent::Complete,
    ] {
        trace
            .observe(event)
            .expect("stage-enabled archive operation must follow client order");
    }

    assert_eq!(
        trace.events(),
        [
            ArchiveRemoteEvent::RawUploadComplete,
            ArchiveRemoteEvent::RawFilesStage,
            ArchiveRemoteEvent::CastRegistration,
            ArchiveRemoteEvent::CastUploadComplete,
            ArchiveRemoteEvent::TimelineSubmitted,
            ArchiveRemoteEvent::ReplayStage,
            ArchiveRemoteEvent::Complete,
        ]
    );
}

#[test]
fn archive_wait_duration_never_moves_backwards_when_clocks_skew() {
    assert_eq!(elapsed_since_unix_ms(10_000, 9_999), 0);
    assert_eq!(elapsed_since_unix_ms(10_000, 10_250), 250);
}

#[test]
fn full_archive_batch_schedules_an_immediate_follow_up_scan() {
    assert!(!archive_batch_needs_follow_up(ARCHIVE_JOB_BATCH_SIZE - 1));
    assert!(archive_batch_needs_follow_up(ARCHIVE_JOB_BATCH_SIZE));
}

#[test]
fn archive_job_lanes_keep_due_order_within_each_run() {
    let lanes = archive_job_lanes(vec![
        test_archive_job("run-a", "vm-2"),
        test_archive_job("run-b", "vm-1"),
        test_archive_job("run-a", "vm-3"),
        test_archive_job("run-c", "vm-1"),
    ]);

    let lane_names = lanes
        .iter()
        .map(|lane| {
            lane.iter()
                .map(|job| format!("{}/{}", job.run_id, job.vm_name))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        lane_names,
        vec![
            vec!["run-a/vm-2", "run-a/vm-3"],
            vec!["run-b/vm-1"],
            vec!["run-c/vm-1"],
        ]
    );
}

#[tokio::test]
async fn archive_job_lanes_overlap_distinct_runs_but_serialize_one_run() {
    #[derive(Clone)]
    struct TestJob {
        id: &'static str,
        synchronise_start: bool,
    }

    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
    let events = std::sync::Arc::new(Mutex::new(Vec::new()));
    let processor = {
        let barrier = std::sync::Arc::clone(&barrier);
        let events = std::sync::Arc::clone(&events);
        move |job: TestJob| {
            let barrier = std::sync::Arc::clone(&barrier);
            let events = std::sync::Arc::clone(&events);
            async move {
                events.lock().await.push(format!("start:{}", job.id));
                if job.synchronise_start {
                    barrier.wait().await;
                }
                events.lock().await.push(format!("finish:{}", job.id));
                Ok(ArchiveJobProcessOutcome::Completed)
            }
        }
    };

    let results = timeout(
        Duration::from_millis(250),
        process_archive_job_lanes(
            vec![
                vec![
                    TestJob {
                        id: "a-1",
                        synchronise_start: true,
                    },
                    TestJob {
                        id: "a-2",
                        synchronise_start: false,
                    },
                ],
                vec![TestJob {
                    id: "b-1",
                    synchronise_start: true,
                }],
            ],
            2,
            processor,
        ),
    )
    .await
    .expect("independent archive lanes must not deadlock")
    .into_iter()
    .collect::<Result<Vec<_>>>();
    assert!(results.is_ok());

    let events = events.lock().await;
    let position = |event: &str| {
        events
            .iter()
            .position(|item| item == event)
            .expect("expected archive lane event")
    };
    assert!(position("start:b-1") < position("finish:a-1"));
    assert!(position("start:a-1") < position("finish:b-1"));
    assert!(position("finish:a-1") < position("start:a-2"));
}

#[tokio::test]
async fn archive_job_lanes_cap_distinct_run_concurrency() {
    #[derive(Clone)]
    struct TestJob(&'static str);

    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let release = std::sync::Arc::new(Semaphore::new(0));
    let processor = {
        let release = std::sync::Arc::clone(&release);
        move |job: TestJob| {
            let release = std::sync::Arc::clone(&release);
            let started_tx = started_tx.clone();
            async move {
                started_tx.send(job.0).expect("test receiver remains open");
                let _permit = release
                    .acquire()
                    .await
                    .expect("test semaphore remains open");
                Ok(ArchiveJobProcessOutcome::Completed)
            }
        }
    };

    let task = tokio::spawn(process_archive_job_lanes(
        vec![
            vec![TestJob("run-a")],
            vec![TestJob("run-b")],
            vec![TestJob("run-c")],
        ],
        2,
        processor,
    ));

    let mut started = [
        timeout(Duration::from_millis(250), started_rx.recv())
            .await
            .expect("first archive lane must start")
            .expect("start channel remains open"),
        timeout(Duration::from_millis(250), started_rx.recv())
            .await
            .expect("second archive lane must start")
            .expect("start channel remains open"),
    ];
    started.sort_unstable();
    assert_eq!(started.len(), 2);
    assert!(
        timeout(Duration::from_millis(25), started_rx.recv())
            .await
            .is_err(),
        "a third run must wait for one of the two archive lanes"
    );

    release.add_permits(2);
    let third = timeout(Duration::from_millis(250), started_rx.recv())
        .await
        .expect("third archive lane must start after a slot frees")
        .expect("start channel remains open");
    assert!(matches!(third, "run-a" | "run-b" | "run-c"));
    release.add_permits(1);

    let results = task
        .await
        .expect("archive lane task must not panic")
        .into_iter()
        .collect::<Result<Vec<_>>>();
    assert!(results.is_ok());
}

#[tokio::test]
async fn retry_scheduled_archive_job_blocks_later_work_for_that_run() {
    #[derive(Clone)]
    struct TestJob(&'static str);

    let ran = std::sync::Arc::new(Mutex::new(Vec::new()));
    let processor = {
        let ran = std::sync::Arc::clone(&ran);
        move |job: TestJob| {
            let ran = std::sync::Arc::clone(&ran);
            async move {
                ran.lock().await.push(job.0);
                if job.0 == "run-a-first" {
                    return Ok(ArchiveJobProcessOutcome::RetryScheduled);
                }
                Ok(ArchiveJobProcessOutcome::Completed)
            }
        }
    };

    let results = process_archive_job_lanes(
        vec![
            vec![TestJob("run-a-first"), TestJob("run-a-later")],
            vec![TestJob("run-b-only")],
        ],
        2,
        processor,
    )
    .await;

    assert!(results.iter().all(Result::is_ok));
    assert!(
        results
            .iter()
            .any(|result| { matches!(result, Ok(ArchiveJobProcessOutcome::RetryScheduled)) })
    );
    let ran = ran.lock().await;
    assert!(ran.contains(&"run-a-first"));
    assert!(ran.contains(&"run-b-only"));
    assert!(
        !ran.contains(&"run-a-later"),
        "a later same-run job must wait for the failed job's durable retry"
    );
}

#[tokio::test]
async fn retryable_archive_failure_detaches_private_renderer_before_retry_final_paths() {
    let spool = tempdir().expect("create recording spool");
    let old_output_dir = create_replay_render_output_dir(spool.path())
        .await
        .expect("reserve old renderer output");
    let old_cast_path = old_output_dir.join("session-01.cast");
    let (release_old_renderer, old_renderer_release) = std::sync::mpsc::channel();
    let old_task: JoinHandle<ReplayRenderResult> = tokio::spawn(async move {
        tokio::task::spawn_blocking(move || -> Result<()> {
            old_renderer_release
                .recv()
                .map_err(|error| anyhow::anyhow!("old renderer release failed: {error}"))?;
            std::fs::write(&old_cast_path, "old renderer output")
                .map_err(|error| anyhow::anyhow!("write old private cast: {error}"))?;
            Ok(())
        })
        .await
        .map_err(|error| anyhow::anyhow!("old renderer task panicked: {error}"))??;
        Ok(None)
    });
    let old_render = replay_render_task_for_test(old_output_dir.clone(), old_task);
    let retry_final_cast = spool.path().join("session-01.cast");

    let (cleanup_tx, cleanup_rx) = tokio::sync::oneshot::channel();
    timeout(Duration::from_millis(250), async {
        let cleanup = detach_replay_render_after_early_failure(
            old_render,
            "vm-1".to_string(),
            "run-1".to_string(),
        );
        tokio::fs::write(&retry_final_cast, "retry renderer output")
            .await
            .expect("retry must publish without waiting for the old renderer");
        cleanup_tx
            .send(cleanup)
            .expect("test must retain detached renderer cleanup task");
    })
    .await
    .expect("raw failure must return before the blocking renderer finishes");
    let cleanup = cleanup_rx
        .await
        .expect("test must receive detached renderer cleanup task");

    release_old_renderer
        .send(())
        .expect("old renderer must still be waiting for release");
    cleanup.await.expect("detached renderer cleanup task");

    assert_eq!(
        tokio::fs::read_to_string(&retry_final_cast)
            .await
            .expect("read retry final cast"),
        "retry renderer output",
        "an old detached renderer must never overwrite a retry final path"
    );
    assert!(
        !old_output_dir.exists(),
        "the old attempt-private output must be cleaned only after its renderer stops"
    );
}

#[tokio::test]
async fn completed_replay_publishes_stable_paths_before_describing_casts() {
    let spool = tempdir().expect("create recording spool");
    tokio::fs::write(
        spool.path().join("ssh-session-1700000000000-10.krec"),
        concat!(
            "{\"type\":\"header\",\"format\":\"kino.raw-event-log\",\"version\":1,",
            "\"width\":80,\"height\":24,\"start_timestamp_ms\":1700000000000}\n",
            "{\"type\":\"event\",\"offset_ms\":0,\"event\":\"o\",\"data_b64\":\"eA==\"}\n"
        ),
    )
    .await
    .expect("write session recording");

    let mut render = start_replay_render(spool.path().to_path_buf(), 7)
        .await
        .expect("start private renderer");
    let private_output_dir = replay_render_output_dir_for_test(&render).to_path_buf();
    let rendered = await_replay_render(&mut render)
        .await
        .expect("render session media")
        .expect("rendered session media");
    assert!(private_output_dir.join("session-01.cast").is_file());
    assert!(
        !spool.path().join("session-01.cast").exists(),
        "private rendering must not publish final casts"
    );

    let (casts, timeline) = publish_replay_artifacts(spool.path(), 7, rendered)
        .await
        .expect("publish replay casts before describing them");

    assert_eq!(casts.len(), 1);
    assert_eq!(casts[0].ordinal, 7);
    assert_eq!(casts[0].filename, "session-01.cast");
    assert_eq!(casts[0].path, spool.path().join("session-01.cast"));
    assert!(casts[0].path.is_file());
    assert_eq!(timeline.sessions[0].cast_filename, casts[0].filename);
    assert!(
        !private_output_dir.join("session-01.cast").exists(),
        "descriptor creation must use the published stable path, not a private attempt path"
    );
}

#[tokio::test]
async fn archive_notification_queued_before_waiter_is_not_lost() {
    let notification = Notify::new();
    notification.notify_one();

    timeout(
        Duration::from_millis(250),
        wait_for_archive_worker_signal(&notification),
    )
    .await
    .expect("a durable queue signal before the wait must retain its permit");
}

#[tokio::test]
async fn rejected_archive_stage_response_returns_an_error() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    crate::tls_provider::ensure_ring_provider().expect("install test TLS provider");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind archive-stage test server");
    let address = listener.local_addr().expect("read test server address");
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept stage request");
        let mut request = [0_u8; 4096];
        let read = stream.read(&mut request).await.expect("read stage request");
        assert!(read > 0, "archive-stage request must not be empty");
        stream
            .write_all(
                b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 4\r\nconnection: close\r\n\r\nnope",
            )
            .await
            .expect("write rejected stage response");
    });

    let stage_url = format!("http://{address}/agent/runs/run/vms/vm/archive-stage");
    let error = post_archive_stage(
        &HttpClient::new(),
        &stage_url,
        ArchiveStage::RawFilesSaved,
        "test-access-token",
    )
    .await
    .expect_err("a rejected stage response must keep the archive job retryable");

    assert!(error.to_string().contains("503 Service Unavailable"));
    server.await.expect("stage test server task");
}

#[tokio::test]
async fn empty_recording_spool_maps_to_replay_skipped_before_completion() {
    let spool = tempdir().expect("create empty recording spool");
    let rendered = render_replay_artifacts(spool.path(), spool.path())
        .await
        .expect("an empty spool is a valid no-replay result");

    assert!(rendered.is_none());
    assert_eq!(
        archive_stage_after_replay(rendered.is_some(), false),
        ArchiveStage::ReplaySkipped,
    );
}
