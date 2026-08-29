//! Root-owned Unix broker for the learner-facing `intar` command.
//!
//! The learner may send a bounded, safe action request over this socket, but
//! never receives the workspace generation report credential. The reporting
//! loop owns that credential and returns only the control plane's safe CLI
//! projection through the one-shot response channel.

use intar_contracts::run_cli::{
    RUN_CLI_FRAME_HEADER_BYTES, RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliErrorCodeV1,
    RunCliErrorV1, RunCliFrameError, RunCliRequestV1, RunCliResponseV1, RunCliResultV1,
    RunCliViewV1, decode_run_cli_frame, encode_run_cli_frame, run_cli_frame_payload_len,
};
use nix::unistd::{Gid, Uid, User, chown};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio::time::timeout_at;

pub(crate) const RUN_CLI_SOCKET_PATH: &str = "/run/intar-workspace-agent/run-cli.sock";

const REQUEST_QUEUE_CAPACITY: usize = 32;
const CONNECTION_CAPACITY: usize = 16;
// Keep one connection slot available after normal command connections have
// filled their bounded set. A completion request then still reads its local
// cache while the state-owning loop is busy with a report or command.
const COMMAND_CONNECTION_CAPACITY: usize = CONNECTION_CAPACITY - 1;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const COMPLETION_DEADLINE: Duration = Duration::from_millis(200);
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);
const SOCKET_MODE: u32 = 0o660;

/// A deliberately narrow cache for shell completion. It never retains a run
/// view, hint title or body, probe ID, retry scope, or report credential.
///
/// Readers take a short synchronous lock only to clone a pre-built alias list;
/// writers build and validate the list before replacing it. The local broker
/// never awaits the reporting loop or the control plane for `completion`.
#[derive(Clone)]
pub(crate) struct CompletionCache {
    entries: Arc<RwLock<Option<CompletionCacheEntry>>>,
    lifetime: Duration,
}

#[derive(Clone)]
struct CompletionCacheEntry {
    expires_at: Instant,
    aliases: Arc<[String]>,
}

impl CompletionCache {
    pub(crate) fn new(lifetime: Duration) -> Self {
        Self {
            entries: Arc::new(RwLock::new(None)),
            lifetime,
        }
    }

    /// Remove a possibly stale result before an authoritative report, a
    /// state-changing command, or a generation-fence failure.
    pub(crate) fn invalidate(&self) {
        if let Ok(mut entries) = self.entries.write() {
            *entries = None;
        }
    }

    /// Publish the narrow response returned by the authoritative completion
    /// action. Invalid values fail closed instead of becoming shell output.
    pub(crate) fn replace_aliases(&self, aliases: Vec<String>) -> bool {
        let validation = RunCliResponseV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "completion-cache".to_owned(),
            result: RunCliResultV1::Completion {
                aliases: aliases.clone(),
            },
        };
        if validation
            .validate_for_action(&RunCliActionV1::Completion)
            .is_err()
        {
            self.invalidate();
            return false;
        }
        self.store_aliases(aliases)
    }

    fn store_aliases(&self, aliases: Vec<String>) -> bool {
        let entry = CompletionCacheEntry {
            expires_at: Instant::now() + self.lifetime,
            aliases: Arc::from(aliases),
        };
        match self.entries.write() {
            Ok(mut entries) => {
                *entries = Some(entry);
                true
            }
            // A poisoned cache must never keep exposing an old result.
            Err(_) => false,
        }
    }

    /// Extract only currently allowed public aliases from a validated normal
    /// CLI view. No other part of the view is copied into the cache.
    pub(crate) fn replace_from_view(&self, view: &RunCliViewV1) -> bool {
        let aliases = view
            .hint_groups
            .iter()
            .filter(|group| group.can_reveal)
            .map(|group| group.alias.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        self.replace_aliases(aliases)
    }

    pub(crate) fn response(&self, request_id: &str) -> RunCliResponseV1 {
        let aliases = self
            .entries
            .read()
            .ok()
            .and_then(|entries| entries.as_ref().cloned())
            .filter(|entry| Instant::now() < entry.expires_at)
            .map(|entry| entry.aliases.as_ref().to_vec())
            .unwrap_or_default();
        RunCliResponseV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: request_id.to_owned(),
            result: RunCliResultV1::Completion { aliases },
        }
    }
}

/// Keeps state-changing and full-view commands out of the command queue while
/// the workspace agent is still booting. Completion deliberately bypasses
/// this gate and returns the empty cache until authoritative state is ready.
#[derive(Clone)]
pub(crate) struct RunCliCommandGate {
    open: Arc<AtomicBool>,
}

impl RunCliCommandGate {
    pub(crate) fn closed() -> Self {
        Self {
            open: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn open(&self) {
        self.open.store(true, Ordering::Release);
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
}

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
        completion_cache: CompletionCache,
        command_gate: RunCliCommandGate,
    ) -> Result<(Self, mpsc::Receiver<RunCliCommand>), RunCliBrokerError> {
        let learner = LearnerAccount::lookup(learner_name)?;
        Self::start_at(
            PathBuf::from(RUN_CLI_SOCKET_PATH),
            learner,
            0,
            true,
            completion_cache,
            command_gate,
        )
        .await
    }

    async fn start_at(
        socket_path: PathBuf,
        learner: LearnerAccount,
        socket_owner_uid: u32,
        validate_parent: bool,
        completion_cache: CompletionCache,
        command_gate: RunCliCommandGate,
    ) -> Result<(Self, mpsc::Receiver<RunCliCommand>), RunCliBrokerError> {
        let listener = bind_listener(&socket_path, learner, socket_owner_uid, validate_parent)?;
        let (commands, receiver) = mpsc::channel(REQUEST_QUEUE_CAPACITY);
        let task = tokio::spawn(serve(
            listener,
            learner.uid,
            completion_cache,
            command_gate,
            commands,
        ));
        Ok((Self { socket_path, task }, receiver))
    }

    #[cfg(test)]
    async fn start_for_test(
        socket_path: PathBuf,
        learner: LearnerAccount,
    ) -> Result<(Self, mpsc::Receiver<RunCliCommand>), RunCliBrokerError> {
        Self::start_at(
            socket_path,
            learner,
            learner.uid,
            false,
            CompletionCache::new(Duration::from_secs(60)),
            open_gate(),
        )
        .await
    }

    #[cfg(test)]
    async fn start_for_test_with_cache(
        socket_path: PathBuf,
        learner: LearnerAccount,
        completion_cache: CompletionCache,
    ) -> Result<(Self, mpsc::Receiver<RunCliCommand>), RunCliBrokerError> {
        Self::start_at(
            socket_path,
            learner,
            learner.uid,
            false,
            completion_cache,
            open_gate(),
        )
        .await
    }

    #[cfg(test)]
    async fn start_for_test_with_gate(
        socket_path: PathBuf,
        learner: LearnerAccount,
        completion_cache: CompletionCache,
        command_gate: RunCliCommandGate,
    ) -> Result<(Self, mpsc::Receiver<RunCliCommand>), RunCliBrokerError> {
        Self::start_at(
            socket_path,
            learner,
            learner.uid,
            false,
            completion_cache,
            command_gate,
        )
        .await
    }
}

#[cfg(test)]
fn open_gate() -> RunCliCommandGate {
    let gate = RunCliCommandGate::closed();
    gate.open();
    gate
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

async fn serve(
    listener: UnixListener,
    learner_uid: u32,
    completion_cache: CompletionCache,
    command_gate: RunCliCommandGate,
    commands: mpsc::Sender<RunCliCommand>,
) {
    let read_permits = Arc::new(Semaphore::new(CONNECTION_CAPACITY));
    let command_permits = Arc::new(Semaphore::new(COMMAND_CONNECTION_CAPACITY));
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(connection) => connection,
            Err(_) => return,
        };
        let Ok(read_permit) = read_permits.clone().try_acquire_owned() else {
            // Refuse excess requests without letting a local process turn the
            // broker into an unbounded task or memory queue.
            drop(stream);
            continue;
        };
        let commands = commands.clone();
        let command_permits = command_permits.clone();
        let completion_cache = completion_cache.clone();
        let command_gate = command_gate.clone();
        tokio::spawn(async move {
            handle_connection(
                stream,
                learner_uid,
                completion_cache,
                command_gate,
                commands,
                read_permit,
                command_permits,
            )
            .await;
        });
    }
}

async fn handle_connection(
    mut stream: UnixStream,
    learner_uid: u32,
    completion_cache: CompletionCache,
    command_gate: RunCliCommandGate,
    commands: mpsc::Sender<RunCliCommand>,
    read_permit: tokio::sync::OwnedSemaphorePermit,
    command_permits: Arc<Semaphore>,
) {
    let Ok(credential) = stream.peer_cred() else {
        return;
    };
    if !peer_is_authorized(learner_uid, credential.uid()) {
        return;
    }

    let deadline = tokio::time::Instant::now() + COMPLETION_DEADLINE;
    let request = match timeout_at(deadline, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        Ok(Err(_)) | Err(_) => return,
    };
    if request.validate().is_err() {
        // Do not echo a partially validated request ID. The shared contract
        // owns its token grammar, and invalid local frames fail closed.
        return;
    }

    if matches!(request.action, RunCliActionV1::Completion) {
        // Hold the accepted-connection permit until the complete framed
        // response is written. Completion never enters the command queue.
        let response = completion_cache.response(&request.request_id);
        let _ = write_response_until(&mut stream, &response, deadline).await;
        drop(read_permit);
        return;
    }

    let command_permit = match command_permits.try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            // Keep the accepted-connection permit through the response write.
            // This bounds rejected normal connections while reserved capacity
            // remains available for local completion.
            let response = local_error(
                &request.request_id,
                RunCliErrorCodeV1::Unavailable,
                "The Intar service is unavailable. Try again.",
                true,
            );
            let _ = write_response(&mut stream, &response).await;
            drop(read_permit);
            return;
        }
    };
    // A normal command now holds its own bounded permit through its complete
    // response write, freeing the reader reserve for completion requests.
    drop(read_permit);
    let _command_permit = command_permit;

    if !command_gate.is_open() {
        let response = local_error(
            &request.request_id,
            RunCliErrorCodeV1::Unavailable,
            "This workspace is still starting. Try again.",
            true,
        );
        let _ = write_response(&mut stream, &response).await;
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

async fn write_response_until(
    stream: &mut UnixStream,
    response: &RunCliResponseV1,
    deadline: tokio::time::Instant,
) -> Result<(), RunCliBrokerError> {
    let frame = encode_run_cli_frame(response).map_err(RunCliBrokerError::Frame)?;
    timeout_at(deadline, async {
        stream.write_all(&frame).await?;
        stream.flush().await
    })
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
    if response.request_id == request.request_id
        && response.validate_for_action(&request.action).is_ok()
    {
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
        COMMAND_CONNECTION_CAPACITY, CompletionCache, LearnerAccount, RUN_CLI_FRAME_HEADER_BYTES,
        RunCliBroker, RunCliCommandGate, SOCKET_MODE, local_error, peer_is_authorized,
        read_request,
    };
    use intar_contracts::run_cli::{
        RUN_CLI_MAX_FRAME_BYTES, RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliErrorCodeV1,
        RunCliRequestV1, RunCliResultV1, decode_run_cli_frame, encode_run_cli_frame,
    };
    use nix::unistd::{getegid, geteuid};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::io::AsyncWriteExt;
    use tokio::net::UnixStream;
    use tokio::sync::mpsc::error::TryRecvError;

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

    #[tokio::test]
    async fn completion_is_alias_only_and_bypasses_the_command_queue() {
        let directory = TempDir::new().expect("temporary directory");
        let socket_path = directory.path().join("run-cli.sock");
        let cache = CompletionCache::new(Duration::from_secs(60));
        assert!(cache.replace_aliases(vec!["check-3".to_owned(), "general".to_owned(),]));
        let (broker, mut commands) =
            RunCliBroker::start_for_test_with_cache(socket_path.clone(), learner(), cache)
                .await
                .expect("start test broker");

        // Saturate every normal-command permit. Each sender stays alive so
        // the state loop remains unavailable while completion still responds.
        let mut _normal_clients = Vec::new();
        for index in 0..COMMAND_CONNECTION_CAPACITY {
            let request = RunCliRequestV1 {
                protocol_version: RUN_CLI_PROTOCOL_VERSION,
                request_id: format!("normal-{}", index + 1),
                action: RunCliActionV1::Status,
            };
            let mut normal = UnixStream::connect(&socket_path)
                .await
                .expect("normal learner connects");
            normal
                .write_all(&encode_run_cli_frame(&request).expect("normal frame"))
                .await
                .expect("write normal request");
            _normal_clients.push(normal);
        }
        let mut _queued_responses = Vec::new();
        for _ in 0..COMMAND_CONNECTION_CAPACITY {
            let queued = tokio::time::timeout(Duration::from_secs(1), commands.recv())
                .await
                .expect("normal command arrives")
                .expect("normal command queued");
            _queued_responses.push(queued.response);
        }

        let completion_request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "completion-1".to_owned(),
            action: RunCliActionV1::Completion,
        };
        let mut completion = UnixStream::connect(&socket_path)
            .await
            .expect("completion learner connects");
        completion
            .write_all(&encode_run_cli_frame(&completion_request).expect("completion frame"))
            .await
            .expect("write completion request");
        let response = tokio::time::timeout(
            Duration::from_millis(250),
            read_response_for_test(&mut completion),
        )
        .await
        .expect("completion response meets shell budget")
        .expect("read completion response");
        assert_eq!(response.request_id, "completion-1");
        assert_eq!(
            response.result,
            RunCliResultV1::Completion {
                aliases: vec!["check-3".to_owned(), "general".to_owned()],
            }
        );
        assert!(matches!(commands.try_recv(), Err(TryRecvError::Empty)));

        let serialized = serde_json::to_string(&response).expect("serialize completion");
        assert!(!serialized.contains("probe_id"));
        assert!(!serialized.contains("body_markdown"));
        assert!(!serialized.contains("retry_scope"));
        drop(broker);
    }

    #[tokio::test]
    async fn empty_completion_is_available_during_slow_agent_boot() {
        let directory = TempDir::new().expect("temporary directory");
        let socket_path = directory.path().join("run-cli.sock");
        let cache = CompletionCache::new(Duration::from_secs(60));
        let gate = RunCliCommandGate::closed();
        let (broker, mut commands) =
            RunCliBroker::start_for_test_with_gate(socket_path.clone(), learner(), cache, gate)
                .await
                .expect("start test broker");

        let completion_request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "completion-boot".to_owned(),
            action: RunCliActionV1::Completion,
        };
        let mut completion = UnixStream::connect(&socket_path)
            .await
            .expect("completion learner connects");
        completion
            .write_all(&encode_run_cli_frame(&completion_request).expect("completion frame"))
            .await
            .expect("write completion request");
        let response = tokio::time::timeout(
            Duration::from_millis(250),
            read_response_for_test(&mut completion),
        )
        .await
        .expect("empty completion response meets shell budget")
        .expect("read empty completion response");
        assert_eq!(
            response.result,
            RunCliResultV1::Completion {
                aliases: Vec::new()
            }
        );

        let mut normal = UnixStream::connect(&socket_path)
            .await
            .expect("normal learner connects");
        normal
            .write_all(&encode_run_cli_frame(&request()).expect("normal frame"))
            .await
            .expect("write normal request");
        let response = read_response_for_test(&mut normal)
            .await
            .expect("read boot-gated normal response");
        assert!(matches!(response.result, RunCliResultV1::Error { .. }));
        assert!(matches!(commands.try_recv(), Err(TryRecvError::Empty)));
        drop(broker);
    }

    #[test]
    fn expired_completion_cache_fails_closed_to_no_aliases() {
        let cache = CompletionCache::new(Duration::ZERO);
        assert!(cache.replace_aliases(vec!["general".to_owned()]));
        assert_eq!(
            cache.response("completion-1").result,
            RunCliResultV1::Completion {
                aliases: Vec::new()
            }
        );
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
