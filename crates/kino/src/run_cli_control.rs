//! Learner-connectable, local-only Kino control socket.
//!
//! The socket accepts one bounded list of internal probe IDs and returns only
//! pass/fail/unknown plus timing. It has no run, hint, or solution authority:
//! the guest is a single-user/sudo environment, and the broker remains the
//! source of learner-safe guidance and run state.

use crate::probe::ProbeStatus;
use crate::run_cli_wire::{read_message, write_message};
use crate::scheduler::ProbeExecutor;
use crate::state::ProbeStore;
use anyhow::Context as _;
use intar_contracts::run_cli::{
    RUN_CLI_PROTOCOL_VERSION, RunCliCheckStatusV1, RunCliProbeCheckEventKindV1,
    RunCliProbeCheckEventV1, RunCliProbeCheckRequestV1, RunCliProbeCheckResultV1,
};
use std::env;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt as _, PermissionsExt as _};

pub(crate) const ENV_KINO_CONTROL_SOCKET: &str = "KINO_CONTROL_SOCKET";
pub(crate) const DEFAULT_KINO_CONTROL_SOCKET: &str = "/run/intar/kino-control.sock";

const MAX_CONCURRENT_CONTROL_CONNECTIONS: usize = 8;
const CONTROL_RESULT_CHANNEL_CAPACITY: usize = 16;
const CONTROL_READ_TIMEOUT: Duration = Duration::from_secs(5);
const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
// Config rejects individual probe timeouts above 120 seconds. A manual check
// may wait for one in-flight scheduled run and then run once itself (240
// seconds total); manual batches fail busy rather than queue, leaving room
// inside this 300-second control cap for framing and scheduling overhead.
const CONTROL_EXECUTION_TIMEOUT: Duration = Duration::from_secs(300);

pub(crate) struct ControlSocket {
    path: PathBuf,
    task: JoinHandle<()>,
}

/// A control request owns a spawned manual batch. If the request times out,
/// disconnects, or is cancelled, dropping this guard aborts the task instead
/// of detaching it while it holds the batch-wide manual lock.
struct AbortOnDrop<T> {
    task: JoinHandle<T>,
}

impl<T> AbortOnDrop<T> {
    fn new(task: JoinHandle<T>) -> Self {
        Self { task }
    }
}

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl ControlSocket {
    pub(crate) async fn shutdown(self) {
        self.task.abort();
        let _ = self.task.await;
        let _ = remove_socket_if_socket(&self.path);
    }
}

pub(crate) fn configured_socket_path() -> PathBuf {
    env::var_os(ENV_KINO_CONTROL_SOCKET)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_KINO_CONTROL_SOCKET))
}

pub(crate) async fn start(
    executor: ProbeExecutor,
    store: ProbeStore,
) -> anyhow::Result<ControlSocket> {
    start_at(configured_socket_path(), executor, store).await
}

pub(crate) async fn start_at(
    path: PathBuf,
    executor: ProbeExecutor,
    store: ProbeStore,
) -> anyhow::Result<ControlSocket> {
    if !path.is_absolute() {
        anyhow::bail!("Kino control socket path must be absolute");
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await.with_context(|| {
            format!(
                "failed to create Kino control socket parent {}",
                parent.display()
            )
        })?;
    }

    remove_socket_if_socket(&path)?;
    let listener = UnixListener::bind(&path)
        .with_context(|| format!("failed to bind Kino control socket {}", path.display()))?;
    set_learner_socket_mode(&path)?;

    let task = tokio::spawn(async move {
        run_control_loop(listener, executor, store).await;
    });
    Ok(ControlSocket { path, task })
}

async fn run_control_loop(listener: UnixListener, executor: ProbeExecutor, store: ProbeStore) {
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_CONTROL_CONNECTIONS));
    loop {
        let accepted = listener.accept().await;
        let Ok((stream, _address)) = accepted else {
            // A listener error cannot expose useful learner-facing detail. The
            // service lifecycle owns restart/recovery, and clients receive a
            // generic unavailable error after the connection closes.
            return;
        };

        let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
            // Do not queue unbounded unauthenticated local connections.
            drop(stream);
            continue;
        };
        let executor = executor.clone();
        let store = store.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = handle_connection(stream, executor, store).await;
        });
    }
}

async fn handle_connection(
    mut stream: UnixStream,
    executor: ProbeExecutor,
    store: ProbeStore,
) -> anyhow::Result<()> {
    let request = tokio::time::timeout(
        CONTROL_READ_TIMEOUT,
        read_message::<RunCliProbeCheckRequestV1, _>(&mut stream),
    )
    .await
    .context("Kino control request timed out")??;
    request.validate().context("invalid Kino control request")?;

    tokio::time::timeout(
        CONTROL_EXECUTION_TIMEOUT,
        stream_manual_results(&mut stream, request, executor, store),
    )
    .await
    .context("Kino manual probe execution timed out")??;
    Ok(())
}

async fn stream_manual_results(
    stream: &mut UnixStream,
    request: RunCliProbeCheckRequestV1,
    executor: ProbeExecutor,
    store: ProbeStore,
) -> anyhow::Result<()> {
    let (sender, mut receiver) = tokio::sync::mpsc::channel(CONTROL_RESULT_CHANNEL_CAPACITY);
    let probe_ids = request.probe_ids.clone();
    let mut execution = AbortOnDrop::new(tokio::spawn(async move {
        executor.run_manual_stream(&probe_ids, &store, sender).await
    }));
    let mut completed_count = 0_u16;
    async {
        loop {
            let result = tokio::select! {
                result = receiver.recv() => result,
                peer = wait_for_peer_close(&*stream) => {
                    peer?;
                    return Ok(());
                }
            };
            let Some(result) = result else {
                break;
            };
            completed_count = completed_count
                .checked_add(1)
                .context("Kino emitted too many manual probe results")?;
            let event = RunCliProbeCheckEventV1 {
                protocol_version: RUN_CLI_PROTOCOL_VERSION,
                request_id: request.request_id.clone(),
                event: RunCliProbeCheckEventKindV1::Probe {
                    check: manual_result_event(result),
                },
            };
            event.validate().context("invalid Kino probe event")?;
            tokio::time::timeout(CONTROL_WRITE_TIMEOUT, write_message(stream, &event))
                .await
                .context("Kino probe event write timed out")??;
        }
        (&mut execution.task)
            .await
            .context("Kino manual probe task stopped")??;
        let complete = RunCliProbeCheckEventV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: request.request_id,
            event: RunCliProbeCheckEventKindV1::Complete { completed_count },
        };
        complete
            .validate()
            .context("invalid Kino completion event")?;
        tokio::time::timeout(CONTROL_WRITE_TIMEOUT, write_message(stream, &complete))
            .await
            .context("Kino completion event write timed out")??;
        Ok(())
    }
    .await
}

/// Once the request frame is complete, the client sends no further bytes.
/// Wait for EOF in parallel with slow probes so a disconnect cancels the
/// abort-on-drop manual batch immediately rather than at the next result.
async fn wait_for_peer_close(stream: &UnixStream) -> anyhow::Result<()> {
    let mut byte = [0_u8; 1];
    loop {
        stream
            .readable()
            .await
            .context("wait for Kino peer close")?;
        match stream.try_read(&mut byte) {
            Ok(0) => return Ok(()),
            Ok(_) => anyhow::bail!("Kino control client sent unexpected extra data"),
            Err(error) if error.kind() == ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error).context("read Kino peer close"),
        }
    }
}

fn manual_result_event(result: crate::scheduler::ManualProbeResult) -> RunCliProbeCheckResultV1 {
    RunCliProbeCheckResultV1 {
        probe_id: result.id,
        status: match result.status {
            ProbeStatus::Pass => RunCliCheckStatusV1::Pass,
            ProbeStatus::Fail => RunCliCheckStatusV1::Fail,
            ProbeStatus::Unknown => RunCliCheckStatusV1::Unknown,
        },
        duration_ms: result.duration_ms,
    }
}

fn remove_socket_if_socket(path: &Path) -> anyhow::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => std::fs::remove_file(path)
            .with_context(|| format!("failed to remove Kino control socket {}", path.display())),
        Ok(_) => anyhow::bail!(
            "refusing to replace non-socket Kino control path {}",
            path.display()
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error)
            .with_context(|| format!("failed to inspect Kino control socket {}", path.display())),
    }
}

fn set_learner_socket_mode(path: &Path) -> anyhow::Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect Kino control socket {}", path.display()))?;
    anyhow::ensure!(
        metadata.file_type().is_socket(),
        "Kino control path is not a socket: {}",
        path.display()
    );
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o666);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("failed to set Kino control socket mode {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{remove_socket_if_socket, start_at};
    use crate::config::{IntarProbeMetadata, ProbeConfig, ProbeKindConfig};
    use crate::probe::build_probes;
    use crate::run_cli_wire::{read_message, write_message};
    use crate::scheduler::ProbeExecutor;
    use crate::state::ProbeStore;
    use intar_contracts::run_cli::{
        RUN_CLI_PROTOCOL_VERSION, RunCliCheckStatusV1, RunCliProbeCheckEventKindV1,
        RunCliProbeCheckEventV1, RunCliProbeCheckRequestV1, RunCliProbeCheckStreamValidatorV1,
    };
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::net::UnixStream;

    async fn test_server(path: &Path) -> super::ControlSocket {
        let config = ProbeConfig {
            id: "internal-probe".to_owned(),
            every: Duration::from_secs(60),
            timeout: Duration::from_secs(1),
            intar: IntarProbeMetadata::default(),
            kind: ProbeKindConfig::FileExists {
                path: "/dev/null".into(),
            },
        };
        let probes = build_probes(&[config])
            .await
            .expect("build probe")
            .into_iter()
            .map(Arc::new)
            .collect::<Vec<_>>();
        let store = ProbeStore::new(&probes);
        start_at(path.to_path_buf(), ProbeExecutor::new(&probes), store)
            .await
            .expect("start control socket")
    }

    #[tokio::test]
    async fn local_control_socket_runs_a_fresh_bounded_check() {
        let temp = tempfile::tempdir().expect("tempdir");
        let socket_path = temp.path().join("kino-control.sock");
        let server = test_server(&socket_path).await;
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&socket_path)
                .expect("socket metadata")
                .permissions()
                .mode()
                & 0o777,
            0o666
        );

        let mut client = UnixStream::connect(&socket_path).await.expect("connect");
        let request = RunCliProbeCheckRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "check-1".to_owned(),
            probe_ids: vec!["internal-probe".to_owned()],
        };
        write_message(&mut client, &request)
            .await
            .expect("write request");
        let mut validator = RunCliProbeCheckStreamValidatorV1::new(&request).expect("validator");
        let mut saw_probe = false;
        while !validator.is_complete() {
            let event = read_message::<RunCliProbeCheckEventV1, _>(&mut client)
                .await
                .expect("read event");
            if let RunCliProbeCheckEventKindV1::Probe { check } = &event.event {
                saw_probe = true;
                assert_eq!(check.probe_id, "internal-probe");
                assert_eq!(check.status, RunCliCheckStatusV1::Pass);
                assert!(check.duration_ms < 10_000);
            }
            validator.observe(&event).expect("valid event");
        }
        validator.finish().expect("complete event");
        assert!(saw_probe);
        server.shutdown().await;
        assert!(!socket_path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_stream_emits_a_fast_probe_before_a_slow_probe_finishes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let socket_path = temp.path().join("kino-control.sock");
        let configs = vec![
            ProbeConfig {
                id: "fast".to_owned(),
                every: Duration::from_secs(60),
                timeout: Duration::from_secs(1),
                intar: IntarProbeMetadata::default(),
                kind: ProbeKindConfig::FileExists {
                    path: "/dev/null".into(),
                },
            },
            ProbeConfig {
                id: "slow".to_owned(),
                every: Duration::from_secs(60),
                timeout: Duration::from_secs(2),
                intar: IntarProbeMetadata::default(),
                kind: ProbeKindConfig::CommandJsonPath {
                    argv: vec![
                        "/bin/sh".to_owned(),
                        "-c".to_owned(),
                        "sleep 0.7; printf '{\"passed\":true}'".to_owned(),
                    ],
                    json_path: "$.passed".to_owned(),
                    expected: Some(serde_json::json!(true)),
                },
            },
        ];
        let probes = build_probes(&configs)
            .await
            .expect("build probes")
            .into_iter()
            .map(Arc::new)
            .collect::<Vec<_>>();
        let server = start_at(
            socket_path.clone(),
            ProbeExecutor::new(&probes),
            ProbeStore::new(&probes),
        )
        .await
        .expect("start control socket");
        let mut client = UnixStream::connect(&socket_path).await.expect("connect");
        let request = RunCliProbeCheckRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "stream-1".to_owned(),
            probe_ids: vec!["fast".to_owned(), "slow".to_owned()],
        };
        write_message(&mut client, &request)
            .await
            .expect("write request");

        let first = tokio::time::timeout(
            Duration::from_millis(300),
            read_message::<RunCliProbeCheckEventV1, _>(&mut client),
        )
        .await
        .expect("fast event arrives before slow probe")
        .expect("read first event");
        match &first.event {
            RunCliProbeCheckEventKindV1::Probe { check } => {
                assert_eq!(check.probe_id, "fast");
                assert_eq!(check.status, RunCliCheckStatusV1::Pass);
            }
            RunCliProbeCheckEventKindV1::Complete { .. } => {
                panic!("completion arrived before a probe event")
            }
        }

        let mut validator = RunCliProbeCheckStreamValidatorV1::new(&request).expect("validator");
        validator.observe(&first).expect("first event");
        while !validator.is_complete() {
            let event = read_message::<RunCliProbeCheckEventV1, _>(&mut client)
                .await
                .expect("read remaining event");
            validator.observe(&event).expect("valid event");
        }
        validator.finish().expect("complete event");
        server.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disconnect_during_a_slow_probe_releases_the_manual_batch_for_the_next_check() {
        let temp = tempfile::tempdir().expect("tempdir");
        let socket_path = temp.path().join("kino-control.sock");
        let started_path = temp.path().join("slow-started");
        let slow_command = format!(
            "printf started > '{}'; sleep 2; printf '{{\"passed\":true}}'",
            started_path.display()
        );
        let configs = vec![
            ProbeConfig {
                id: "slow".to_owned(),
                every: Duration::from_secs(60),
                timeout: Duration::from_secs(5),
                intar: IntarProbeMetadata::default(),
                kind: ProbeKindConfig::CommandJsonPath {
                    argv: vec!["/bin/sh".to_owned(), "-c".to_owned(), slow_command],
                    json_path: "$.passed".to_owned(),
                    expected: Some(serde_json::json!(true)),
                },
            },
            ProbeConfig {
                id: "fast".to_owned(),
                every: Duration::from_secs(60),
                timeout: Duration::from_secs(1),
                intar: IntarProbeMetadata::default(),
                kind: ProbeKindConfig::FileExists {
                    path: "/dev/null".into(),
                },
            },
        ];
        let probes = build_probes(&configs)
            .await
            .expect("build probes")
            .into_iter()
            .map(Arc::new)
            .collect::<Vec<_>>();
        let server = start_at(
            socket_path.clone(),
            ProbeExecutor::new(&probes),
            ProbeStore::new(&probes),
        )
        .await
        .expect("start control socket");
        let mut first = UnixStream::connect(&socket_path)
            .await
            .expect("connect first");
        let slow_request = RunCliProbeCheckRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "slow-request".to_owned(),
            probe_ids: vec!["slow".to_owned()],
        };
        write_message(&mut first, &slow_request)
            .await
            .expect("write slow request");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !started_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("slow probe starts");
        drop(first);

        let mut second = UnixStream::connect(&socket_path)
            .await
            .expect("connect second");
        let fast_request = RunCliProbeCheckRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "fast-request".to_owned(),
            probe_ids: vec!["fast".to_owned()],
        };
        write_message(&mut second, &fast_request)
            .await
            .expect("write fast request");
        let event = tokio::time::timeout(
            Duration::from_millis(500),
            read_message::<RunCliProbeCheckEventV1, _>(&mut second),
        )
        .await
        .expect("fast request is not blocked by disconnected slow request")
        .expect("read fast event");
        match event.event {
            RunCliProbeCheckEventKindV1::Probe { check } => {
                assert_eq!(check.probe_id, "fast");
                assert_eq!(check.status, RunCliCheckStatusV1::Pass);
            }
            RunCliProbeCheckEventKindV1::Complete { .. } => {
                panic!("fast check completed without a result")
            }
        }
        let complete = read_message::<RunCliProbeCheckEventV1, _>(&mut second)
            .await
            .expect("read complete event");
        assert!(matches!(
            complete.event,
            RunCliProbeCheckEventKindV1::Complete { completed_count: 1 }
        ));
        server.shutdown().await;
    }

    #[test]
    fn refuses_to_replace_a_regular_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("not-a-socket");
        std::fs::write(&path, "keep me").expect("fixture");
        assert!(remove_socket_if_socket(&path).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).expect("read fixture"),
            "keep me"
        );
    }
}
