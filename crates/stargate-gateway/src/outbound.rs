use std::{
    future::Future,
    io,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::Arc,
    task::{Context as TaskContext, Poll},
    time::Duration,
};

use anyhow::{Context, bail};
use bytes::Bytes;
use dashmap::{DashMap, mapref::entry::Entry};
use sha2::{Digest as _, Sha256};
use std::borrow::Cow;

use russh::{
    ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect, Preferred,
    client::{self, Msg},
    kex,
    keys::{PrivateKeyWithHashAlg, ssh_key::PublicKey},
};
use stargate_core::{RouteRecord, WorkspaceAppRouteRecord};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc as tokio_mpsc};
use tokio_util::sync::CancellationToken;

const BRIDGE_INPUT_CAPACITY: usize = 32;
const BRIDGE_EVENT_CAPACITY: usize = 32;
const WORKSPACE_APP_CHANNELS_PER_ROUTE: usize = 64;

#[derive(Debug)]
pub enum BridgeEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Exit(u32),
}

#[derive(Clone)]
pub struct ExecBridgeControl {
    tx: tokio_mpsc::Sender<BridgeInput>,
    cancel: CancellationToken,
}

#[derive(Clone)]
pub struct PtyBridgeControl {
    tx: tokio_mpsc::Sender<BridgeInput>,
    cancel: CancellationToken,
}

pub struct PtyBridgeOptions {
    pub term: String,
    pub cols: u16,
    pub rows: u16,
    pub command: Option<String>,
}

enum BridgeInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Eof,
}

enum BridgeMode {
    Exec { command: String },
    Pty(PtyBridgeOptions),
}

pub fn spawn_exec_bridge(
    route: RouteRecord,
    command: String,
    cancel: CancellationToken,
) -> anyhow::Result<(ExecBridgeControl, tokio_mpsc::Receiver<BridgeEvent>)> {
    let target = PreparedSshTarget::new(&route)?;
    let (events_tx, events_rx) = tokio_mpsc::channel(BRIDGE_EVENT_CAPACITY);
    let (input_tx, input_rx) = tokio_mpsc::channel(BRIDGE_INPUT_CAPACITY);

    tokio::spawn(run_bridge(
        route,
        target,
        BridgeMode::Exec { command },
        input_rx,
        events_tx,
        cancel.clone(),
    ));

    Ok((
        ExecBridgeControl {
            tx: input_tx,
            cancel,
        },
        events_rx,
    ))
}

pub fn spawn_pty_bridge(
    route: RouteRecord,
    options: PtyBridgeOptions,
    cancel: CancellationToken,
) -> anyhow::Result<(PtyBridgeControl, tokio_mpsc::Receiver<BridgeEvent>)> {
    let target = PreparedSshTarget::new(&route)?;
    let (events_tx, events_rx) = tokio_mpsc::channel(BRIDGE_EVENT_CAPACITY);
    let (input_tx, input_rx) = tokio_mpsc::channel(BRIDGE_INPUT_CAPACITY);

    tokio::spawn(run_bridge(
        route,
        target,
        BridgeMode::Pty(options),
        input_rx,
        events_tx,
        cancel.clone(),
    ));

    Ok((
        PtyBridgeControl {
            tx: input_tx,
            cancel,
        },
        events_rx,
    ))
}

impl ExecBridgeControl {
    pub async fn send_input(&self, data: Vec<u8>) {
        send_bridge_input(&self.tx, &self.cancel, BridgeInput::Data(data)).await;
    }

    pub async fn send_eof(&self) {
        send_bridge_input(&self.tx, &self.cancel, BridgeInput::Eof).await;
    }

    pub fn terminate(&self) {
        self.cancel.cancel();
    }
}

impl PtyBridgeControl {
    pub async fn send_input(&self, data: Vec<u8>) {
        send_bridge_input(&self.tx, &self.cancel, BridgeInput::Data(data)).await;
    }

    pub async fn resize(&self, cols: u16, rows: u16) {
        send_bridge_input(&self.tx, &self.cancel, BridgeInput::Resize { cols, rows }).await;
    }

    pub async fn send_eof(&self) {
        send_bridge_input(&self.tx, &self.cancel, BridgeInput::Eof).await;
    }

    pub fn terminate(&self) {
        self.cancel.cancel();
    }
}

async fn send_bridge_input(
    tx: &tokio_mpsc::Sender<BridgeInput>,
    cancel: &CancellationToken,
    input: BridgeInput,
) {
    tokio::select! {
        _ = cancel.cancelled() => {}
        _ = tx.send(input) => {}
    }
}

struct PreparedSshTarget {
    addr: SocketAddr,
    expected_host_key: PublicKey,
    private_key: Arc<russh::keys::PrivateKey>,
}

/// An SSH direct-tcpip stream opened on a route-scoped authenticated session.
/// The channel permit is held for exactly as long as Hyper owns this stream.
pub struct DirectTcpIpTunnel {
    _session: Arc<client::Handle<StrictHostKey>>,
    _channel_permit: OwnedSemaphorePermit,
    stream: russh::ChannelStream<Msg>,
}

#[derive(Clone, Default)]
pub(crate) struct WorkspaceAppTunnelPool {
    routes: Arc<DashMap<String, Arc<PooledWorkspaceAppTarget>>>,
}

struct PooledWorkspaceAppTarget {
    target_fingerprint: [u8; 32],
    session: Mutex<Option<Arc<client::Handle<StrictHostKey>>>>,
    channel_slots: Arc<Semaphore>,
}

impl AsyncRead for DirectTcpIpTunnel {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for DirectTcpIpTunnel {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

pub async fn open_workspace_app_tunnel(
    pool: &WorkspaceAppTunnelPool,
    route: &WorkspaceAppRouteRecord,
) -> anyhow::Result<DirectTcpIpTunnel> {
    pool.open(route).await
}

impl WorkspaceAppTunnelPool {
    async fn open(&self, route: &WorkspaceAppRouteRecord) -> anyhow::Result<DirectTcpIpTunnel> {
        let pooled_target = self.target_for(route).await;
        let channel_permit = pooled_target
            .channel_slots
            .clone()
            .acquire_owned()
            .await
            .context("workspace app route channel limiter closed")?;

        // A long-lived SSH transport can disappear between the liveness check
        // and the channel-open request. Discard it and reconnect once so an
        // ordinary guest sshd restart does not turn an asset burst into a page
        // full of failed requests.
        let mut last_error = None;
        for _ in 0..2 {
            let session = pooled_target.session(route).await?;
            match session
                .channel_open_direct_tcpip(
                    "127.0.0.1",
                    u32::from(route.target_app_port),
                    "127.0.0.1",
                    0,
                )
                .await
            {
                Ok(channel) => {
                    return Ok(DirectTcpIpTunnel {
                        _session: session,
                        _channel_permit: channel_permit,
                        stream: channel.into_stream(),
                    });
                }
                Err(error) => {
                    pooled_target.discard_session(&session).await;
                    last_error = Some(error);
                }
            }
        }

        let error = last_error.expect("workspace app SSH channel was attempted");
        Err(error).with_context(|| {
            format!(
                "failed opening guest direct-tcpip channel to port {}",
                route.target_app_port
            )
        })
    }

    async fn target_for(&self, route: &WorkspaceAppRouteRecord) -> Arc<PooledWorkspaceAppTarget> {
        let fingerprint = workspace_app_target_fingerprint(route);
        let replacement = Arc::new(PooledWorkspaceAppTarget::new(fingerprint));
        let (target, replaced) = match self.routes.entry(route.route_id.clone()) {
            Entry::Occupied(mut entry) if entry.get().target_fingerprint != fingerprint => {
                let replaced = entry.insert(replacement.clone());
                (replacement, Some(replaced))
            }
            Entry::Occupied(entry) => (entry.get().clone(), None),
            Entry::Vacant(entry) => {
                entry.insert(replacement.clone());
                (replacement, None)
            }
        };
        if let Some(replaced) = replaced {
            replaced.disconnect().await;
        }
        target
    }

    pub(crate) async fn invalidate(&self, route_id: &str) {
        if let Some((_, target)) = self.routes.remove(route_id) {
            target.disconnect().await;
        }
    }
}

impl PooledWorkspaceAppTarget {
    fn new(target_fingerprint: [u8; 32]) -> Self {
        Self {
            target_fingerprint,
            session: Mutex::new(None),
            channel_slots: Arc::new(Semaphore::new(WORKSPACE_APP_CHANNELS_PER_ROUTE)),
        }
    }

    async fn session(
        &self,
        route: &WorkspaceAppRouteRecord,
    ) -> anyhow::Result<Arc<client::Handle<StrictHostKey>>> {
        let mut pooled = self.session.lock().await;
        if let Some(session) = pooled.as_ref()
            && !session.is_closed()
        {
            return Ok(session.clone());
        }

        let target = PreparedSshTarget::from_parts(
            &route.target_ip,
            route.target_ssh_port,
            &route.target_host_key_openssh,
            &route.target_private_key_openssh,
        )?;
        let session = Arc::new(connect_authenticated_target(target, &route.target_username).await?);
        *pooled = Some(session.clone());
        Ok(session)
    }

    async fn discard_session(&self, stale: &Arc<client::Handle<StrictHostKey>>) {
        let removed = {
            let mut pooled = self.session.lock().await;
            match pooled.as_ref() {
                Some(current) if Arc::ptr_eq(current, stale) => pooled.take(),
                _ => None,
            }
        };
        if let Some(session) = removed {
            disconnect_workspace_app_session(&session).await;
        }
    }

    async fn disconnect(&self) {
        let session = self.session.lock().await.take();
        if let Some(session) = session {
            disconnect_workspace_app_session(&session).await;
        }
    }
}

async fn disconnect_workspace_app_session(session: &client::Handle<StrictHostKey>) {
    let _ = session
        .disconnect(
            Disconnect::ByApplication,
            "workspace app route invalidated",
            "en-US",
        )
        .await;
}

fn workspace_app_target_fingerprint(route: &WorkspaceAppRouteRecord) -> [u8; 32] {
    let mut digest = Sha256::new();
    for value in [route.target_username.as_bytes(), route.target_ip.as_bytes()] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value);
    }
    digest.update(route.target_ssh_port.to_be_bytes());
    for value in [
        route.target_host_key_openssh.as_bytes(),
        route.target_private_key_openssh.as_bytes(),
    ] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value);
    }
    digest.finalize().into()
}

impl PreparedSshTarget {
    fn new(route: &RouteRecord) -> anyhow::Result<Self> {
        Self::from_parts(
            &route.target_ip,
            route.target_port,
            &route.target_host_key_openssh,
            &route.target_private_key_openssh,
        )
    }

    fn from_parts(
        target_ip: &str,
        target_port: u16,
        target_host_key_openssh: &str,
        target_private_key_openssh: &str,
    ) -> anyhow::Result<Self> {
        let ip = target_ip
            .parse::<IpAddr>()
            .with_context(|| format!("target_ip '{target_ip}' is not a literal IP"))?;
        let expected_host_key =
            PublicKey::from_openssh(target_host_key_openssh).context("invalid target host key")?;
        let private_key = russh::keys::decode_secret_key(target_private_key_openssh, None)
            .context("invalid target private key")?;

        Ok(Self {
            addr: SocketAddr::new(ip, target_port),
            expected_host_key,
            private_key: Arc::new(private_key),
        })
    }
}

async fn connect_authenticated_target(
    target: PreparedSshTarget,
    target_username: &str,
) -> anyhow::Result<client::Handle<StrictHostKey>> {
    let mut session = client::connect(
        client_config(),
        target.addr,
        StrictHostKey {
            expected: target.expected_host_key,
        },
    )
    .await
    .with_context(|| format!("failed connecting to target {}", target.addr))?;
    let rsa_hash_alg = session
        .best_supported_rsa_hash()
        .await
        .context("failed to negotiate target public-key hash algorithms")?
        .flatten();
    let auth_result = session
        .authenticate_publickey(
            target_username,
            PrivateKeyWithHashAlg::new(target.private_key, rsa_hash_alg),
        )
        .await
        .context("target public-key authentication failed")?;
    if !auth_result.success() {
        bail!("target public-key authentication was rejected");
    }
    Ok(session)
}

struct StrictHostKey {
    expected: PublicKey,
}

impl client::Handler for StrictHostKey {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // Compare only the key material. PublicKey equality also compares the
        // OpenSSH comment, and the expected key is derived from the guest's
        // `.pub` file (which carries a `root@host` comment) while the key the
        // server presents over the wire has none — so full-value equality
        // always rejected a correct host key.
        Ok(server_public_key.key_data() == self.expected.key_data())
    }
}

async fn run_bridge(
    route: RouteRecord,
    target: PreparedSshTarget,
    mode: BridgeMode,
    input_rx: tokio_mpsc::Receiver<BridgeInput>,
    events_tx: tokio_mpsc::Sender<BridgeEvent>,
    cancel: CancellationToken,
) {
    let exit_status =
        match run_bridge_inner(route, target, mode, input_rx, &events_tx, &cancel).await {
            Ok(status) => status,
            Err(error) => {
                // Log and surface the full anyhow cause chain: the outermost
                // context alone ("failed connecting to target …") hides the
                // underlying russh/auth failure that operators need.
                tracing::warn!(error = ?error, "outbound ssh bridge failed");
                send_bridge_event(
                    &events_tx,
                    &cancel,
                    BridgeEvent::Stderr(
                        format!("stargate outbound ssh bridge failed: {error:#}\n").into_bytes(),
                    ),
                )
                .await;
                255
            }
        };

    send_bridge_event(&events_tx, &cancel, BridgeEvent::Exit(exit_status)).await;
}

async fn send_bridge_event(
    tx: &tokio_mpsc::Sender<BridgeEvent>,
    cancel: &CancellationToken,
    event: BridgeEvent,
) -> bool {
    tokio::select! {
        _ = cancel.cancelled() => false,
        result = tx.send(event) => result.is_ok(),
    }
}

async fn run_bridge_inner(
    route: RouteRecord,
    target: PreparedSshTarget,
    mode: BridgeMode,
    input_rx: tokio_mpsc::Receiver<BridgeInput>,
    events_tx: &tokio_mpsc::Sender<BridgeEvent>,
    cancel: &CancellationToken,
) -> anyhow::Result<u32> {
    let mut session = client::connect(
        client_config(),
        target.addr,
        StrictHostKey {
            expected: target.expected_host_key,
        },
    )
    .await
    .with_context(|| format!("failed connecting to target {}", target.addr))?;

    let rsa_hash_alg = session
        .best_supported_rsa_hash()
        .await
        .context("failed to negotiate target public-key hash algorithms")?
        .flatten();
    let auth_result = session
        .authenticate_publickey(
            route.target_username,
            PrivateKeyWithHashAlg::new(target.private_key, rsa_hash_alg),
        )
        .await
        .context("target public-key authentication failed")?;
    if !auth_result.success() {
        bail!("target public-key authentication was rejected");
    }

    let channel = session
        .channel_open_session()
        .await
        .context("failed opening target session channel")?;
    configure_channel(&channel, mode).await?;
    let (read_half, write_half) = channel.split();
    let status = bridge_channel(read_half, write_half, input_rx, events_tx, cancel).await;

    let _ = session
        .disconnect(Disconnect::ByApplication, "", "en")
        .await;

    status
}

async fn configure_channel(channel: &russh::Channel<Msg>, mode: BridgeMode) -> anyhow::Result<()> {
    match mode {
        BridgeMode::Exec { command } => {
            channel
                .exec(true, command)
                .await
                .context("failed executing target command")?;
        }
        BridgeMode::Pty(options) => {
            channel
                .request_pty(
                    true,
                    &options.term,
                    u32::from(options.cols.max(1)),
                    u32::from(options.rows.max(1)),
                    0,
                    0,
                    &[],
                )
                .await
                .context("failed requesting target pty")?;
            match options.command {
                Some(command) => channel
                    .exec(true, command)
                    .await
                    .context("failed executing target pty command")?,
                None => channel
                    .request_shell(true)
                    .await
                    .context("failed requesting target shell")?,
            }
        }
    }
    Ok(())
}

async fn bridge_channel(
    read_half: ChannelReadHalf,
    write_half: ChannelWriteHalf<Msg>,
    input_rx: tokio_mpsc::Receiver<BridgeInput>,
    events_tx: &tokio_mpsc::Sender<BridgeEvent>,
    cancel: &CancellationToken,
) -> anyhow::Result<u32> {
    drive_bridge_pumps(
        pump_bridge_input(write_half, input_rx, cancel),
        pump_bridge_output(read_half, events_tx, cancel),
    )
    .await
}

async fn drive_bridge_pumps(
    input: impl Future<Output = anyhow::Result<u32>>,
    output: impl Future<Output = anyhow::Result<u32>>,
) -> anyhow::Result<u32> {
    tokio::pin!(input);
    tokio::pin!(output);

    tokio::select! {
        result = &mut input => result,
        result = &mut output => result,
    }
}

async fn pump_bridge_input(
    write_half: ChannelWriteHalf<Msg>,
    mut input_rx: tokio_mpsc::Receiver<BridgeInput>,
    cancel: &CancellationToken,
) -> anyhow::Result<u32> {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = write_half.close().await;
                return Ok(255);
            }
            input = input_rx.recv() => {
                let Some(input) = input else {
                    let _ = write_half.close().await;
                    return Ok(0);
                };
                match input {
                    BridgeInput::Data(data) => {
                        write_half
                            .data_bytes(Bytes::from(data))
                            .await
                            .context("failed forwarding data to target")?;
                    }
                    BridgeInput::Resize { cols, rows } => {
                        write_half
                            .window_change(u32::from(cols.max(1)), u32::from(rows.max(1)), 0, 0)
                            .await
                            .context("failed forwarding target window size")?;
                    }
                    BridgeInput::Eof => {
                        write_half.eof().await.context("failed sending target eof")?;
                    }
                }
            }
        }
    }
}

async fn pump_bridge_output(
    mut read_half: ChannelReadHalf,
    events_tx: &tokio_mpsc::Sender<BridgeEvent>,
    cancel: &CancellationToken,
) -> anyhow::Result<u32> {
    let mut exit_status = None;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(255),
            message = read_half.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) => {
                        if !send_bridge_event(
                            events_tx,
                            cancel,
                            BridgeEvent::Stdout(data.to_vec()),
                        ).await {
                            return Ok(255);
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if !send_bridge_event(
                            events_tx,
                            cancel,
                            BridgeEvent::Stderr(data.to_vec()),
                        ).await {
                            return Ok(255);
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status: status }) => {
                        exit_status = Some(status);
                    }
                    Some(ChannelMsg::ExitSignal { .. }) => {
                        exit_status = Some(255);
                    }
                    Some(ChannelMsg::Close) | None => {
                        return Ok(exit_status.unwrap_or(0));
                    }
                    Some(ChannelMsg::Eof) => {}
                    Some(_) => {}
                }
            }
        }
    }
}

fn client_config() -> Arc<client::Config> {
    // russh's default KEX order prefers mlkem768x25519-sha256, which does not
    // interoperate with the post-quantum KEX in the OpenSSH 10 servers our
    // guest images ship, so the outbound handshake fails before auth. Pin the
    // curve25519 KEX both sides implement compatibly.
    let preferred = Preferred {
        kex: Cow::Borrowed(&[kex::CURVE25519, kex::CURVE25519_PRE_RFC_8731]),
        ..Preferred::DEFAULT
    };
    Arc::new(client::Config {
        client_id: russh::SshId::Standard("SSH-2.0-Stargate".into()),
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 2,
        nodelay: true,
        preferred,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use std::{future::pending, task::Poll, time::Duration};

    use futures_util::{pin_mut, poll};
    use russh::client::Handler as _;
    use russh::keys::ssh_key::PublicKey;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    use super::{
        BridgeEvent, BridgeInput, ExecBridgeControl, StrictHostKey, drive_bridge_pumps,
        send_bridge_event,
    };

    #[tokio::test]
    async fn bridge_input_applies_backpressure_at_capacity() {
        let (tx, mut rx) = mpsc::channel(1);
        let controller = ExecBridgeControl {
            tx,
            cancel: CancellationToken::new(),
        };
        controller.send_input(vec![1]).await;

        let blocked_send = controller.send_input(vec![2]);
        pin_mut!(blocked_send);
        assert!(matches!(poll!(blocked_send.as_mut()), Poll::Pending));

        let Some(BridgeInput::Data(first)) = rx.recv().await else {
            panic!("expected first data message");
        };
        assert_eq!(first, vec![1]);
        blocked_send.await;
        let Some(BridgeInput::Data(second)) = rx.recv().await else {
            panic!("expected second data message");
        };
        assert_eq!(second, vec![2]);
    }

    #[tokio::test]
    async fn simultaneous_bidirectional_saturation_makes_progress() {
        let cancel = CancellationToken::new();
        let (input_tx, mut input_rx) = mpsc::channel(1);
        let controller = ExecBridgeControl {
            tx: input_tx,
            cancel: cancel.clone(),
        };
        let (event_tx, mut event_rx) = mpsc::channel(1);

        controller.send_input(vec![1]).await;
        assert!(send_bridge_event(&event_tx, &cancel, BridgeEvent::Stdout(vec![10]),).await);

        let input_pump = async move {
            let Some(BridgeInput::Data(first)) = input_rx.recv().await else {
                anyhow::bail!("expected first input message");
            };
            if first != vec![1] {
                anyhow::bail!("unexpected first input message");
            }

            let Some(BridgeInput::Data(second)) = input_rx.recv().await else {
                anyhow::bail!("expected second input message");
            };
            if second != vec![2] {
                anyhow::bail!("unexpected second input message");
            }

            pending::<anyhow::Result<u32>>().await
        };
        let output_cancel = cancel.clone();
        let output_pump = async move {
            if !send_bridge_event(&event_tx, &output_cancel, BridgeEvent::Stdout(vec![20])).await {
                anyhow::bail!("second output message was not accepted");
            }
            Ok(0)
        };
        let browser = async move {
            controller.send_input(vec![2]).await;

            let Some(BridgeEvent::Stdout(first)) = event_rx.recv().await else {
                anyhow::bail!("expected first output message");
            };
            if first != vec![10] {
                anyhow::bail!("unexpected first output message");
            }

            let Some(BridgeEvent::Stdout(second)) = event_rx.recv().await else {
                anyhow::bail!("expected second output message");
            };
            if second != vec![20] {
                anyhow::bail!("unexpected second output message");
            }

            Ok::<(), anyhow::Error>(())
        };

        tokio::time::timeout(Duration::from_secs(1), async {
            let (bridge_result, browser_result) =
                tokio::join!(drive_bridge_pumps(input_pump, output_pump), browser,);
            bridge_result?;
            browser_result
        })
        .await
        .expect("independent bridge pumps must not deadlock")
        .expect("saturated bridge should keep making progress");
    }

    // The guest reports its host key from the `.pub` file with a `root@host`
    // comment; the key presented over the wire has none. The strict check
    // must accept the key regardless of the comment, and still reject a
    // genuinely different key.
    #[tokio::test]
    async fn accepts_matching_key_ignoring_comment_and_rejects_others() {
        let base =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBklzf1Qy77LwsjmDlGvCAhBpCkhpti25927fAnOMEIR";
        let expected = PublicKey::from_openssh(&format!("{base} root@pair-ping-db-1"))
            .expect("expected host key parses");
        let wire_key = PublicKey::from_openssh(base).expect("wire host key parses");
        let other = PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA8ax6Yk1ZMSRpAkk8cIriNXtVufy6mxst2stQk66n+d",
        )
        .expect("other host key parses");

        let mut handler = StrictHostKey {
            expected: expected.clone(),
        };
        assert!(handler.check_server_key(&wire_key).await.expect("check ok"));

        let mut handler = StrictHostKey { expected };
        assert!(!handler.check_server_key(&other).await.expect("check ok"));
    }
}
