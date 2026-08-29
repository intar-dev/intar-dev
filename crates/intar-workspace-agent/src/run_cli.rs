//! Root-owned Unix broker for the learner-facing `intar` command.
//!
//! The learner may send a bounded, safe action request over this socket, but
//! never receives the workspace generation report credential. The reporting
//! loop owns that credential and returns only the control plane's safe CLI
//! projection through the one-shot response channel.

use intar_contracts::run_cli::{
    RUN_CLI_FRAME_HEADER_BYTES, RUN_CLI_PROTOCOL_VERSION, RunCliErrorCodeV1, RunCliErrorV1,
    RunCliFrameError, RunCliRequestV1, RunCliResponseV1, RunCliResultV1, decode_run_cli_frame,
    encode_run_cli_frame, run_cli_frame_payload_len,
};
use nix::unistd::{Gid, Uid, User, chown};
use std::fs;
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Semaphore, mpsc, oneshot};

pub(crate) const RUN_CLI_SOCKET_PATH: &str = "/run/intar-workspace-agent/run-cli.sock";

const REQUEST_QUEUE_CAPACITY: usize = 32;
const CONNECTION_CAPACITY: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);
const SOCKET_MODE: u32 = 0o660;

/// A valid local CLI request awaiting execution by the state-owning agent
/// loop. It deliberately does not contain an execution identity or any
/// credential: those values are attached only by the agent that owns state.
pub(crate) struct RunCliCommand {
    pub(crate) request: RunCliRequestV1,
    pub(crate) response: oneshot::Sender<RunCliResponseV1>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LearnerAccount {
    uid: u32,
    gid: u32,
}

impl LearnerAccount {
    fn lookup(user_name: &str) -> Result<Self, RunCliBrokerError> {
        let user = User::from_name(user_name)
            .map_err(RunCliBrokerError::LookupLearner)?
            .ok_or_else(|| RunCliBrokerError::UnknownLearner(user_name.to_owned()))?;
        Ok(Self {
            uid: user.uid.as_raw(),
            gid: user.gid.as_raw(),
        })
    }
}

/// Owns the listener task and removes the root-owned socket when the agent
/// exits. Dropping this value cannot expose the report credential because the
/// listener task has only an action channel.
pub(crate) struct RunCliBroker {
    socket_path: PathBuf,
    task: tokio::task::JoinHandle<()>,
}

impl RunCliBroker {
    pub(crate) async fn start(
        learner_name: &str,
    ) -> Result<(Self, mpsc::Receiver<RunCliCommand>), RunCliBrokerError> {
        let learner = LearnerAccount::lookup(learner_name)?;
        Self::start_at(PathBuf::from(RUN_CLI_SOCKET_PATH), learner, 0, true).await
    }

    async fn start_at(
        socket_path: PathBuf,
        learner: LearnerAccount,
        socket_owner_uid: u32,
        validate_parent: bool,
    ) -> Result<(Self, mpsc::Receiver<RunCliCommand>), RunCliBrokerError> {
        let listener = bind_listener(&socket_path, learner, socket_owner_uid, validate_parent)?;
        let (commands, receiver) = mpsc::channel(REQUEST_QUEUE_CAPACITY);
        let task = tokio::spawn(serve(listener, learner.uid, commands));
        Ok((Self { socket_path, task }, receiver))
    }

    #[cfg(test)]
    async fn start_for_test(
        socket_path: PathBuf,
        learner: LearnerAccount,
    ) -> Result<(Self, mpsc::Receiver<RunCliCommand>), RunCliBrokerError> {
        Self::start_at(socket_path, learner, learner.uid, false).await
    }
}

impl Drop for RunCliBroker {
    fn drop(&mut self) {
        self.task.abort();
        remove_socket_if_present(&self.socket_path);
    }
}

fn bind_listener(
    socket_path: &Path,
    learner: LearnerAccount,
    socket_owner_uid: u32,
    validate_parent: bool,
) -> Result<UnixListener, RunCliBrokerError> {
    let parent = socket_path
        .parent()
        .ok_or_else(|| RunCliBrokerError::InvalidSocketPath(socket_path.to_path_buf()))?;
    let parent_metadata =
        fs::symlink_metadata(parent).map_err(|source| RunCliBrokerError::SocketParent {
            path: parent.to_path_buf(),
            source,
        })?;
    if !parent_metadata.file_type().is_dir() {
        return Err(RunCliBrokerError::InsecureSocketParent(
            parent.to_path_buf(),
        ));
    }
    if validate_parent {
        validate_socket_parent(parent, &parent_metadata, learner)?;
    }
    remove_stale_socket(socket_path, socket_owner_uid, learner.gid)?;

    let listener = UnixListener::bind(socket_path).map_err(|source| RunCliBrokerError::Bind {
        path: socket_path.to_path_buf(),
        source,
    })?;
    if let Err(error) = set_socket_access(socket_path, socket_owner_uid, learner.gid) {
        drop(listener);
        remove_socket_if_present(socket_path);
        return Err(error);
    }
    Ok(listener)
}

fn validate_socket_parent(
    path: &Path,
    metadata: &fs::Metadata,
    learner: LearnerAccount,
) -> Result<(), RunCliBrokerError> {
    let mode = metadata.permissions().mode();
    if metadata.uid() != 0
        || metadata.gid() != learner.gid
        || mode & 0o022 != 0
        || mode & 0o010 == 0
    {
        return Err(RunCliBrokerError::InsecureSocketParent(path.to_path_buf()));
    }
    Ok(())
}

fn remove_stale_socket(
    socket_path: &Path,
    expected_uid: u32,
    expected_gid: u32,
) -> Result<(), RunCliBrokerError> {
    let metadata = match fs::symlink_metadata(socket_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(RunCliBrokerError::SocketMetadata {
                path: socket_path.to_path_buf(),
                source,
            });
        }
    };
    if !metadata.file_type().is_socket()
        || metadata.uid() != expected_uid
        || metadata.gid() != expected_gid
    {
        return Err(RunCliBrokerError::UnsafeExistingSocket(
            socket_path.to_path_buf(),
        ));
    }
    fs::remove_file(socket_path).map_err(|source| RunCliBrokerError::RemoveSocket {
        path: socket_path.to_path_buf(),
        source,
    })
}

fn set_socket_access(
    socket_path: &Path,
    owner_uid: u32,
    learner_gid: u32,
) -> Result<(), RunCliBrokerError> {
    chown(
        socket_path,
        Some(Uid::from_raw(owner_uid)),
        Some(Gid::from_raw(learner_gid)),
    )
    .map_err(|source| RunCliBrokerError::SetSocketOwner {
        path: socket_path.to_path_buf(),
        source,
    })?;
    fs::set_permissions(socket_path, fs::Permissions::from_mode(SOCKET_MODE)).map_err(|source| {
        RunCliBrokerError::SetSocketPermissions {
            path: socket_path.to_path_buf(),
            source,
        }
    })
}

fn remove_socket_if_present(socket_path: &Path) {
    if fs::symlink_metadata(socket_path)
        .ok()
        .is_some_and(|metadata| metadata.file_type().is_socket())
    {
        let _ = fs::remove_file(socket_path);
    }
}

async fn serve(listener: UnixListener, learner_uid: u32, commands: mpsc::Sender<RunCliCommand>) {
    let permits = Arc::new(Semaphore::new(CONNECTION_CAPACITY));
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(connection) => connection,
            Err(_) => return,
        };
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            // Refuse excess requests without letting a local process turn the
            // broker into an unbounded task or memory queue.
            drop(stream);
            continue;
        };
        let commands = commands.clone();
        tokio::spawn(async move {
            let _permit = permit;
            handle_connection(stream, learner_uid, commands).await;
        });
    }
}

async fn handle_connection(
    mut stream: UnixStream,
    learner_uid: u32,
    commands: mpsc::Sender<RunCliCommand>,
) {
    let Ok(credential) = stream.peer_cred() else {
        return;
    };
    if !peer_is_authorized(learner_uid, credential.uid()) {
        return;
    }

    let request = match read_request(&mut stream).await {
        Ok(request) => request,
        Err(_) => return,
    };
    if request.validate().is_err() {
        // Do not echo a partially validated request ID. The shared contract
        // owns its token grammar, and invalid local frames fail closed.
        return;
    }

    let (response_sender, response_receiver) = oneshot::channel();
    let command = RunCliCommand {
        request: request.clone(),
        response: response_sender,
    };
    let response = match tokio::time::timeout(DISPATCH_TIMEOUT, commands.send(command)).await {
        Ok(Ok(())) => match tokio::time::timeout(RESPONSE_TIMEOUT, response_receiver).await {
            Ok(Ok(response)) => valid_response_or_internal(&request, response),
            Ok(Err(_)) | Err(_) => local_error(
                &request.request_id,
                RunCliErrorCodeV1::Unavailable,
                "The Intar service is unavailable. Try again.",
                true,
            ),
        },
        Ok(Err(_)) | Err(_) => local_error(
            &request.request_id,
            RunCliErrorCodeV1::Unavailable,
            "The Intar service is unavailable. Try again.",
            true,
        ),
    };
    let _ = write_response(&mut stream, &response).await;
}

fn peer_is_authorized(expected_uid: u32, actual_uid: u32) -> bool {
    expected_uid == actual_uid
}

async fn read_request(stream: &mut UnixStream) -> Result<RunCliRequestV1, RunCliBrokerError> {
    let mut header = [0_u8; RUN_CLI_FRAME_HEADER_BYTES];
    read_exact_with_timeout(stream, &mut header).await?;
    let payload_length = run_cli_frame_payload_len(header).map_err(RunCliBrokerError::Frame)?;
    let mut frame = Vec::with_capacity(RUN_CLI_FRAME_HEADER_BYTES + payload_length);
    frame.extend_from_slice(&header);
    frame.resize(RUN_CLI_FRAME_HEADER_BYTES + payload_length, 0);
    read_exact_with_timeout(stream, &mut frame[RUN_CLI_FRAME_HEADER_BYTES..]).await?;
    decode_run_cli_frame(&frame).map_err(RunCliBrokerError::Frame)
}

async fn write_response(
    stream: &mut UnixStream,
    response: &RunCliResponseV1,
) -> Result<(), RunCliBrokerError> {
    let frame = encode_run_cli_frame(response).map_err(RunCliBrokerError::Frame)?;
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&frame))
        .await
        .map_err(|_| RunCliBrokerError::IoTimedOut)?
        .map_err(RunCliBrokerError::Io)?;
    tokio::time::timeout(IO_TIMEOUT, stream.flush())
        .await
        .map_err(|_| RunCliBrokerError::IoTimedOut)?
        .map_err(RunCliBrokerError::Io)
}

async fn read_exact_with_timeout(
    stream: &mut UnixStream,
    buffer: &mut [u8],
) -> Result<(), RunCliBrokerError> {
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(buffer))
        .await
        .map_err(|_| RunCliBrokerError::IoTimedOut)?
        .map(|_| ())
        .map_err(RunCliBrokerError::Io)
}

fn valid_response_or_internal(
    request: &RunCliRequestV1,
    response: RunCliResponseV1,
) -> RunCliResponseV1 {
    if response.request_id == request.request_id && response.validate().is_ok() {
        response
    } else {
        local_error(
            &request.request_id,
            RunCliErrorCodeV1::Internal,
            "The Intar service returned an invalid response. Try again.",
            true,
        )
    }
}

pub(crate) fn local_error(
    request_id: &str,
    code: RunCliErrorCodeV1,
    message: &str,
    retryable: bool,
) -> RunCliResponseV1 {
    RunCliResponseV1 {
        protocol_version: RUN_CLI_PROTOCOL_VERSION,
        request_id: request_id.to_owned(),
        result: RunCliResultV1::Error {
            error: RunCliErrorV1 {
                code,
                message: message.to_owned(),
                retryable,
            },
        },
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum RunCliBrokerError {
    #[error("configured learner account could not be looked up")]
    LookupLearner(#[source] nix::Error),
    #[error("configured learner account is unavailable")]
    UnknownLearner(String),
    #[error("run CLI socket path is invalid")]
    InvalidSocketPath(PathBuf),
    #[error("run CLI socket parent is unavailable")]
    SocketParent {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("run CLI socket parent has unsafe ownership or permissions")]
    InsecureSocketParent(PathBuf),
    #[error("run CLI socket metadata could not be read")]
    SocketMetadata {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("run CLI socket path is occupied by an unsafe file")]
    UnsafeExistingSocket(PathBuf),
    #[error("failed to remove stale run CLI socket")]
    RemoveSocket {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to bind run CLI socket")]
    Bind {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to set run CLI socket owner")]
    SetSocketOwner {
        path: PathBuf,
        #[source]
        source: nix::Error,
    },
    #[error("failed to set run CLI socket permissions")]
    SetSocketPermissions {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("run CLI frame is invalid: {0}")]
    Frame(RunCliFrameError),
    #[error("run CLI socket I/O timed out")]
    IoTimedOut,
    #[error("run CLI socket I/O failed")]
    Io(#[source] io::Error),
}

#[cfg(test)]
mod tests {
    use super::{
        LearnerAccount, RUN_CLI_FRAME_HEADER_BYTES, RunCliBroker, SOCKET_MODE, local_error,
        peer_is_authorized, read_request,
    };
    use intar_contracts::run_cli::{
        RUN_CLI_MAX_FRAME_BYTES, RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliErrorCodeV1,
        RunCliRequestV1, decode_run_cli_frame, encode_run_cli_frame,
    };
    use nix::unistd::{getegid, geteuid};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use tempfile::TempDir;
    use tokio::io::AsyncWriteExt;
    use tokio::net::UnixStream;

    fn learner() -> LearnerAccount {
        LearnerAccount {
            uid: geteuid().as_raw(),
            gid: getegid().as_raw(),
        }
    }

    fn request() -> RunCliRequestV1 {
        RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "request-1".to_owned(),
            action: RunCliActionV1::Status,
        }
    }

    #[test]
    fn peer_authorization_accepts_only_the_configured_learner() {
        assert!(peer_is_authorized(1001, 1001));
        assert!(!peer_is_authorized(1001, 0));
        assert!(!peer_is_authorized(1001, 1002));
    }

    #[tokio::test]
    async fn socket_is_bounded_root_equivalent_and_learner_connectable() {
        let directory = TempDir::new().expect("temporary directory");
        let socket_path = directory.path().join("run-cli.sock");
        let learner = learner();
        let (broker, mut commands) = RunCliBroker::start_for_test(socket_path.clone(), learner)
            .await
            .expect("start test broker");

        let metadata = std::fs::metadata(&socket_path).expect("socket metadata");
        assert_eq!(metadata.uid(), learner.uid);
        assert_eq!(metadata.gid(), learner.gid);
        assert_eq!(metadata.permissions().mode() & 0o777, SOCKET_MODE);

        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("learner connects to socket");
        let frame = encode_run_cli_frame(&request()).expect("frame");
        client.write_all(&frame).await.expect("write request");
        let command = commands.recv().await.expect("broker forwards action");
        command
            .response
            .send(local_error(
                &command.request.request_id,
                RunCliErrorCodeV1::Unavailable,
                "The Intar service is unavailable. Try again.",
                true,
            ))
            .expect("send response");
        let response = read_response_for_test(&mut client)
            .await
            .expect("read response");
        assert_eq!(response.request_id, "request-1");

        drop(broker);
        assert!(!socket_path.exists());
    }

    #[tokio::test]
    async fn frame_length_is_checked_before_payload_allocation() {
        let (mut client, mut server) = UnixStream::pair().expect("Unix stream pair");
        let oversized = u32::try_from(RUN_CLI_MAX_FRAME_BYTES + 1)
            .expect("test frame size fits u32")
            .to_be_bytes();
        client.write_all(&oversized).await.expect("write header");
        let error = read_request(&mut server)
            .await
            .expect_err("oversized frame must fail");
        let rendered = error.to_string();
        assert!(rendered.contains("frame"));
        assert!(!rendered.contains("request-1"));
    }

    #[test]
    fn local_errors_do_not_retain_or_render_secret_input() {
        let secret = "generation-report-credential";
        let response = local_error(
            "request-1",
            RunCliErrorCodeV1::Internal,
            "The Intar service is unavailable. Try again.",
            true,
        );
        let serialized = serde_json::to_string(&response).expect("serialize response");
        assert!(!serialized.contains(secret));
    }

    async fn read_response_for_test(
        stream: &mut UnixStream,
    ) -> Result<intar_contracts::run_cli::RunCliResponseV1, std::io::Error> {
        let mut header = [0_u8; RUN_CLI_FRAME_HEADER_BYTES];
        tokio::io::AsyncReadExt::read_exact(stream, &mut header).await?;
        let length = u32::from_be_bytes(header) as usize;
        let mut frame = Vec::with_capacity(RUN_CLI_FRAME_HEADER_BYTES + length);
        frame.extend_from_slice(&header);
        frame.resize(RUN_CLI_FRAME_HEADER_BYTES + length, 0);
        tokio::io::AsyncReadExt::read_exact(stream, &mut frame[RUN_CLI_FRAME_HEADER_BYTES..])
            .await?;
        decode_run_cli_frame(&frame).map_err(std::io::Error::other)
    }
}
