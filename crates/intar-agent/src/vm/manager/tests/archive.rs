use super::*;
use tempfile::tempdir;

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
fn archive_wait_duration_never_moves_backwards_when_clocks_skew() {
    assert_eq!(elapsed_since_unix_ms(10_000, 9_999), 0);
    assert_eq!(elapsed_since_unix_ms(10_000, 10_250), 250);
}

#[test]
fn full_archive_batch_schedules_an_immediate_follow_up_scan() {
    assert!(!archive_batch_needs_follow_up(ARCHIVE_JOB_BATCH_SIZE - 1));
    assert!(archive_batch_needs_follow_up(ARCHIVE_JOB_BATCH_SIZE));
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
    let rendered = render_replay_artifacts(spool.path(), 1)
        .await
        .expect("an empty spool is a valid no-replay result");

    assert!(rendered.is_none());
    assert_eq!(
        archive_stage_after_replay(rendered.is_some(), false),
        ArchiveStage::ReplaySkipped,
    );
}
