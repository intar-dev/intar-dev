//! Outbound host transport. One SSH connection multiplexes guest SSH streams
//! over WSS. No public host address or per-client control-plane call is needed.

use std::{
    collections::HashMap,
    future::Future,
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context as TaskContext, Poll},
    time::Duration,
};

use anyhow::{Context, ensure};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use russh::{Channel, client, keys::ssh_key::PublicKey};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream},
    net::TcpStream,
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;

pub const RELAY_FRAME_BYTES: usize = 16 * 1024;
pub const RELAY_WINDOW_BYTES: u32 = 64 * 1024;
pub const RELAY_CHANNELS: usize = 64;
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

/// These streams contain complete SSH transports. SSH carries its own
/// channel EOF messages; a transport EOF closes both directions. Do not wait
/// for a silent peer to finish a TCP half-close and retain the stream permit.
pub async fn copy_relay<A, B>(left: &mut A, right: &mut B) -> io::Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let (mut lr, mut lw) = tokio::io::split(left);
    let (mut rr, mut rw) = tokio::io::split(right);
    tokio::select! {
        result = copy_direction(&mut lr, &mut rw) => { result?; },
        result = copy_direction(&mut rr, &mut lw) => { result?; },
    }
    Ok(())
}

async fn copy_direction<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    read: &mut R,
    write: &mut W,
) -> io::Result<()> {
    let mut buffer = [0; RELAY_FRAME_BYTES];
    loop {
        let n = read.read(&mut buffer).await?;
        if n == 0 {
            // For an isolated channel, shutdown waits for its outbound queue
            // to drain into SSH before sending EOF. Duplex flush cannot do so.
            return tokio::time::timeout(WRITE_TIMEOUT, write.shutdown()).await?;
        }
        tokio::time::timeout(WRITE_TIMEOUT, write.write_all(&buffer[..n])).await??;
    }
}

/// Cancellation closes pending reads and writes, including an SSH handshake.
/// Drop also cancels the task that owns the other end of a byte bridge.
pub struct RelayIo<S> {
    inner: S,
    cancel: CancellationToken,
    read_cancelled: Pin<Box<dyn Future<Output = ()> + Send>>,
    write_cancelled: Pin<Box<dyn Future<Output = ()> + Send>>,
    drained: Option<tokio::sync::oneshot::Receiver<()>>,
}

impl<S> RelayIo<S> {
    pub fn new(inner: S, cancel: CancellationToken) -> Self {
        Self {
            inner,
            read_cancelled: Box::pin(cancel.clone().cancelled_owned()),
            write_cancelled: Box::pin(cancel.clone().cancelled_owned()),
            cancel,
            drained: None,
        }
    }
    fn check(
        cancelled: &mut Pin<Box<dyn Future<Output = ()> + Send>>,
        cx: &mut TaskContext<'_>,
    ) -> io::Result<()> {
        if cancelled.as_mut().poll(cx).is_ready() {
            Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "relay closed",
            ))
        } else {
            Ok(())
        }
    }
}
impl<S> Drop for RelayIo<S> {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for RelayIo<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Self::check(&mut self.read_cancelled, cx)?;
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for RelayIo<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Self::check(&mut self.write_cancelled, cx)?;
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Self::check(&mut self.write_cancelled, cx)?;
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Self::check(&mut self.write_cancelled, cx)?;
        match Pin::new(&mut self.inner).poll_shutdown(cx) {
            Poll::Ready(Ok(())) => {}
            other => return other,
        }
        let Some(drained) = self.drained.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        match Pin::new(drained).poll(cx) {
            Poll::Ready(result) => {
                self.drained = None;
                if result.is_err() {
                    self.cancel.cancel();
                }
                Poll::Ready(result.map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "relay closed before drain")
                }))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

/// russh replenishes windows on receipt, not consumption. Always drain its
/// channel queue. If this stream's consumer fills its bounded delivery queue,
/// close this stream so the shared SSH loop can keep serving other clients.
pub fn isolated_channel<S>(channel: S, parent: &CancellationToken) -> RelayIo<DuplexStream>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let cancel = parent.child_token();
    let (stream, bridge) = tokio::io::duplex(RELAY_WINDOW_BYTES as usize);
    let (mut channel_read, mut channel_write) = tokio::io::split(channel);
    let (mut consumer_read, mut consumer_write) = tokio::io::split(bridge);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let task_cancel = cancel.clone();
    let (drained_tx, drained_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let receive = async move {
            loop {
                let mut data = vec![0; RELAY_FRAME_BYTES];
                let n = channel_read.read(&mut data).await?;
                if n == 0 {
                    return Ok::<_, anyhow::Error>(());
                }
                data.truncate(n);
                tx.try_send(data).context("relay consumer is too slow")?;
                tokio::task::yield_now().await;
            }
        };
        let deliver = async move {
            while let Some(data) = rx.recv().await {
                consumer_write.write_all(&data).await?;
            }
            consumer_write.shutdown().await?;
            Ok::<_, anyhow::Error>(())
        };
        let incoming = async { tokio::try_join!(receive, deliver) };
        let outgoing = async {
            tokio::io::copy(&mut consumer_read, &mut channel_write).await?;
            channel_write.shutdown().await?;
            let _ = drained_tx.send(());
            Ok::<_, anyhow::Error>(())
        };
        let transfer = async { tokio::try_join!(incoming, outgoing) };
        tokio::select! { biased; _ = task_cancel.cancelled() => {}, _ = transfer => {} }
    });
    let mut stream = RelayIo::new(stream, cancel);
    stream.drained = Some(drained_rx);
    stream
}

pub use intar_contracts::stargate::{HostRelayIdentity, RelayService, RelayTarget};

/// Convert bounded binary WebSocket messages into a byte stream. Both pumps
/// run at once: a full receive window must not prevent writes in the other
/// direction. Dropping the returned stream stops both pumps.
pub fn websocket_bytes<W, E>(socket: W) -> RelayIo<DuplexStream>
where
    W: Sink<Vec<u8>, Error = E> + Stream<Item = Result<Vec<u8>, E>> + Unpin + Send + 'static,
    E: Send + 'static,
{
    let (stream, bridge) = tokio::io::duplex(RELAY_WINDOW_BYTES as usize);
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let (mut read, mut write) = tokio::io::split(bridge);
    let (mut sink, mut source) = socket.split();
    let (drained_tx, drained_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let incoming = async {
            while let Some(Ok(data)) = source.next().await {
                if data.len() > RELAY_FRAME_BYTES || write.write_all(&data).await.is_err() {
                    break;
                }
            }
        };
        let outgoing = async {
            let mut data = vec![0; RELAY_FRAME_BYTES];
            while let Ok(n) = read.read(&mut data).await {
                if n == 0 {
                    if matches!(
                        tokio::time::timeout(WRITE_TIMEOUT, sink.flush()).await,
                        Ok(Ok(()))
                    ) {
                        let _ = drained_tx.send(());
                    }
                    return;
                }
                if !matches!(
                    tokio::time::timeout(WRITE_TIMEOUT, sink.send(data[..n].to_vec())).await,
                    Ok(Ok(()))
                ) {
                    return;
                }
            }
        };
        tokio::select! { biased; _ = task_cancel.cancelled() => {}, _ = incoming => {}, _ = outgoing => {} }
    });
    let mut stream = RelayIo::new(stream, cancel);
    stream.drained = Some(drained_rx);
    stream
}

/// A renewable deadline that wakes every active stream when shortened.
#[derive(Clone)]
pub struct RelayLease(tokio::sync::watch::Sender<tokio::time::Instant>);
impl RelayLease {
    pub fn new(expires: tokio::time::Instant) -> Self {
        Self(tokio::sync::watch::channel(expires).0)
    }
    pub fn deadline(&self) -> tokio::time::Instant {
        *self.0.borrow()
    }
    pub fn renew(&self, expires: tokio::time::Instant) {
        self.0.send_replace(expires);
    }
    pub async fn expired(&self) {
        let mut expiry = self.0.subscribe();
        loop {
            let deadline = *expiry.borrow_and_update();
            if deadline <= tokio::time::Instant::now() {
                return;
            }
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {},
                _ = expiry.changed() => {},
            }
        }
    }
}

struct LocalTarget {
    address: SocketAddr,
    expires: RelayLease,
    cancel: CancellationToken,
}

/// The VM manager supplies these addresses from its own live VM records. A
/// remote channel names an exact assignment; it never supplies an IP or port.
#[derive(Clone, Default)]
pub struct LocalRelayTargets(Arc<Mutex<HashMap<RelayTarget, LocalTarget>>>);

impl LocalRelayTargets {
    pub fn assign(
        &self,
        target: RelayTarget,
        address: SocketAddr,
        expires: tokio::time::Instant,
    ) -> anyhow::Result<()> {
        target.validate()?;
        ensure!(address.port() != 0, "invalid local guest SSH port");
        ensure!(
            expires > tokio::time::Instant::now(),
            "relay assignment expired"
        );
        let mut targets = self.0.lock().expect("relay targets lock");
        targets.retain(|_, old| {
            let live = old.expires.deadline() > tokio::time::Instant::now();
            if !live {
                old.cancel.cancel();
            }
            live
        });
        ensure!(
            targets.len() < RELAY_CHANNELS || targets.contains_key(&target),
            "too many relay assignments"
        );
        if let Some(old) = targets.get_mut(&target)
            && old.address == address
        {
            old.expires.renew(expires);
            return Ok(());
        }
        if let Some(old) = targets.insert(
            target,
            LocalTarget {
                address,
                expires: RelayLease::new(expires),
                cancel: CancellationToken::new(),
            },
        ) {
            old.cancel.cancel();
        }
        Ok(())
    }

    pub fn revoke(&self, target: &RelayTarget) {
        if let Some(old) = self.0.lock().expect("relay targets lock").remove(target) {
            old.cancel.cancel();
        }
    }

    pub fn retain(&self, live: &std::collections::HashSet<RelayTarget>) {
        self.0
            .lock()
            .expect("relay targets lock")
            .retain(|target, old| {
                let keep = live.contains(target);
                if !keep {
                    old.cancel.cancel();
                }
                keep
            });
    }

    pub fn clear(&self) {
        for (_, old) in self.0.lock().expect("relay targets lock").drain() {
            old.cancel.cancel();
        }
    }
}

pub struct HostRelayClient {
    identity: HostRelayIdentity,
    expected_gateway_key: PublicKey,
    targets: LocalRelayTargets,
    slots: Arc<Semaphore>,
    reply_slots: Arc<Semaphore>,
    cancel: CancellationToken,
}

/// The caller owns the session lifetime and cancels it on control disconnect,
/// credential replacement, or shutdown. WSS authenticates the gateway too;
/// the SSH key is pinned to the key returned by the control plane.
pub async fn connect_host_relay<S>(
    stream: S,
    identity: HostRelayIdentity,
    expected_gateway_key: PublicKey,
    targets: LocalRelayTargets,
    cancel: CancellationToken,
) -> anyhow::Result<client::Handle<HostRelayClient>>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let cancel = cancel.child_token();
    identity.validate()?;
    let config = client::Config {
        window_size: RELAY_WINDOW_BYTES,
        maximum_packet_size: RELAY_FRAME_BYTES as u32,
        channel_buffer_size: 4,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 2,
        ..Default::default()
    };
    let username = identity.host_id.clone();
    let setup_cancel = cancel.clone();
    let guard = cancel.clone().drop_guard();
    let mut session = tokio::select! {
      biased;
      _ = setup_cancel.cancelled() => anyhow::bail!("host relay cancelled"),
      result = tokio::time::timeout(Duration::from_secs(10), client::connect_stream(
        Arc::new(config),
        RelayIo::new(stream, cancel.clone()),
        HostRelayClient {
            identity,
            expected_gateway_key,
            targets,
            slots: Arc::new(Semaphore::new(RELAY_CHANNELS)),
            reply_slots: Arc::new(Semaphore::new(RELAY_CHANNELS)),
            cancel,
        },
    )) => result??,
    };
    tokio::select! {
      biased;
      _ = setup_cancel.cancelled() => anyhow::bail!("host relay cancelled"),
      result = tokio::time::timeout(Duration::from_secs(10), session.authenticate_none(username)) => ensure!(result??.success(), "relay connection rejected"),
    }
    guard.disarm();
    Ok(session)
}

impl HostRelayClient {
    fn reject_channel(&self, reply: client::ChannelOpenHandle) {
        let Ok(permit) = self.reply_slots.clone().try_acquire_owned() else {
            // A conforming gateway has at most 64 outstanding opens. Close a
            // peer that exceeds the bounded response budget.
            self.cancel.cancel();
            return;
        };
        tokio::spawn(async move {
            let _permit = permit;
            // Dropping a russh reply only uses try_send and can lose the
            // rejection when the shared queue is full. Own it until queued.
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
        });
    }
}

impl client::Handler for HostRelayClient {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> anyhow::Result<bool> {
        Ok(key.key_data() == self.expected_gateway_key.key_data())
    }

    async fn server_channel_open_direct_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        name: &str,
        port: u32,
        origin: &str,
        origin_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> anyhow::Result<()> {
        // This is an identity envelope, never a DNS name or a forwarding IP.
        if name.len() > 2048
            || port != 22
            || !origin.is_empty()
            || origin_port != 0
            || self.cancel.is_cancelled()
        {
            self.reject_channel(reply);
            return Ok(());
        }
        let Ok(target) = serde_json::from_str::<RelayTarget>(name) else {
            self.reject_channel(reply);
            return Ok(());
        };
        if target.validate().is_err() || target.host != self.identity {
            self.reject_channel(reply);
            return Ok(());
        }
        let Ok(permit) = self.slots.clone().try_acquire_owned() else {
            self.reject_channel(reply);
            return Ok(());
        };
        let assigned = self
            .targets
            .0
            .lock()
            .expect("relay targets lock")
            .get(&target)
            .map(|v| (v.address, v.expires.clone(), v.cancel.clone()));
        let Some((address, expires, assignment_cancel)) = assigned else {
            self.reject_channel(reply);
            return Ok(());
        };
        if expires.deadline() <= tokio::time::Instant::now() {
            self.reject_channel(reply);
            return Ok(());
        }
        let cancel = self.cancel.clone();
        // Never wait for a guest TCP dial in the SSH event loop. One missing
        // guest must not hold up other clients or the host's keepalive reply.
        tokio::spawn(async move {
            let _permit = permit;
            let guest = tokio::select! {
                biased;
                _ = cancel.cancelled() => None,
                _ = assignment_cancel.cancelled() => None,
                _ = expires.expired() => None,
                result = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(address)) => result.ok().and_then(Result::ok),
            };
            let Some(mut guest) = guest else {
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
                return;
            };
            if guest.set_nodelay(true).is_err() {
                reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                return;
            }
            // russh consumes its reply handle before queueing the response.
            // Always finish that queue operation, even after assignment revoke.
            reply.accept().await;
            let mut stream = isolated_channel(channel.into_stream(), &cancel);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {},
                _ = assignment_cancel.cancelled() => {},
                _ = expires.expired() => {},
                _ = copy_relay(&mut stream, &mut guest) => {},
            }
        });
        Ok(())
    }

    // russh accepts several server-initiated channel types by default. Reject
    // every type except the identity-bound SSH channel above.
    async fn server_channel_open_session(
        &mut self,
        _: Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> anyhow::Result<()> {
        self.reject_channel(reply);
        Ok(())
    }
    async fn server_channel_open_direct_streamlocal(
        &mut self,
        _: Channel<client::Msg>,
        _: &str,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> anyhow::Result<()> {
        self.reject_channel(reply);
        Ok(())
    }
    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        _: Channel<client::Msg>,
        _: &str,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> anyhow::Result<()> {
        self.reject_channel(reply);
        Ok(())
    }
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        _: Channel<client::Msg>,
        _: &str,
        _: u32,
        _: &str,
        _: u32,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> anyhow::Result<()> {
        self.reject_channel(reply);
        Ok(())
    }
    async fn server_channel_open_agent_forward(
        &mut self,
        _: Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> anyhow::Result<()> {
        self.reject_channel(reply);
        Ok(())
    }
    async fn server_channel_open_x11(
        &mut self,
        _: Channel<client::Msg>,
        _: &str,
        _: u32,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> anyhow::Result<()> {
        self.reject_channel(reply);
        Ok(())
    }
}

pub fn encode_target(target: &RelayTarget) -> anyhow::Result<String> {
    target.validate()?;
    serde_json::to_string(target).context("encode relay assignment")
}

/// Only the agent opens this connection. Authentication is in a protected
/// header, never in a URL, command argument, or WebSocket subprotocol.
pub async fn connect_websocket(
    url: &url::Url,
    bearer: &str,
) -> anyhow::Result<RelayIo<DuplexStream>> {
    use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
    let request = host_websocket_request(url, bearer)?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(RELAY_FRAME_BYTES))
        .max_frame_size(Some(RELAY_FRAME_BYTES))
        .write_buffer_size(0)
        .max_write_buffer_size(RELAY_FRAME_BYTES * 2);
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async_with_config(request, Some(config), true),
    )
    .await??;
    Ok(binary_websocket(socket))
}

fn host_websocket_request(
    url: &url::Url,
    bearer: &str,
) -> anyhow::Result<tokio_tungstenite::tungstenite::handshake::client::Request> {
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
    };
    ensure!(
        url.scheme() == "wss"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "host relay requires a WSS URL without credentials or query parameters"
    );
    let mut request = url.as_str().into_client_request()?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {bearer}"))?;
    authorization.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, authorization);
    Ok(request)
}

pub fn binary_websocket<S>(socket: tokio_tungstenite::WebSocketStream<S>) -> RelayIo<DuplexStream>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    use tokio_tungstenite::tungstenite::Message;
    let socket = socket
        .with(|data: Vec<u8>| {
            futures_util::future::ready(Ok::<_, tokio_tungstenite::tungstenite::Error>(
                Message::Binary(data.into()),
            ))
        })
        .filter_map(|message| {
            futures_util::future::ready(match message {
                Ok(Message::Binary(data)) => Some(Ok(data.to_vec())),
                Ok(Message::Ping(_) | Message::Pong(_)) => None,
                _ => Some(Err(tokio_tungstenite::tungstenite::Error::ConnectionClosed)),
            })
        });
    websocket_bytes(socket)
}

impl Drop for HostRelayClient {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn shortened_lease_wakes_all_existing_waiters() {
        let lease = super::RelayLease::new(
            tokio::time::Instant::now() + std::time::Duration::from_secs(60),
        );
        let first = lease.expired();
        let second = lease.expired();
        tokio::pin!(first, second);
        // Poll both timers before changing the deadline.
        assert!(futures_util::poll!(&mut first).is_pending());
        assert!(futures_util::poll!(&mut second).is_pending());
        lease.renew(tokio::time::Instant::now() + std::time::Duration::from_millis(10));
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(first, second);
        })
        .await
        .expect("shortened deadline must wake all waiters");
    }
    use super::*;

    #[tokio::test]
    async fn websocket_shutdown_drains_bytes_before_immediate_drop() {
        use tokio_tungstenite::{WebSocketStream, tungstenite::protocol::Role};
        let (client, server) = tokio::io::duplex(1024);
        let mut stream =
            binary_websocket(WebSocketStream::from_raw_socket(client, Role::Client, None).await);
        let mut peer = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        let payload = vec![42; RELAY_WINDOW_BYTES as usize / 2];
        stream.write_all(&payload).await.expect("buffered write");
        let sender = tokio::spawn(async move {
            stream.shutdown().await.expect("drained shutdown");
            drop(stream);
        });
        let mut received = Vec::new();
        while received.len() < payload.len() {
            let frame = tokio::time::timeout(Duration::from_secs(3), peer.next())
                .await
                .expect("receive timeout")
                .expect("frame")
                .expect("read frame");
            received.extend_from_slice(&frame.into_data());
        }
        sender.await.expect("sender task");
        assert_eq!(received, payload);
    }

    #[tokio::test]
    async fn blocked_websocket_writes_close_the_transport_and_fail_shutdown() {
        use tokio_tungstenite::{WebSocketStream, tungstenite::protocol::Role};
        let (client, _silent_peer) = tokio::io::duplex(1024);
        let stream =
            binary_websocket(WebSocketStream::from_raw_socket(client, Role::Client, None).await);
        let (mut read, mut write) = tokio::io::split(stream);
        let sender = async {
            write
                .write_all(&vec![42; RELAY_WINDOW_BYTES as usize / 2])
                .await
                .expect("buffered write");
            assert!(write.shutdown().await.is_err());
            assert!(write.shutdown().await.is_err());
        };
        let receiver = async {
            assert!(!matches!(read.read(&mut [0; 1]).await, Ok(1..)));
        };
        tokio::time::timeout(WRITE_TIMEOUT + Duration::from_secs(1), async {
            tokio::join!(sender, receiver);
        })
        .await
        .expect("stalled transport must close");
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)] // tungstenite's handshake callback fixes the error type.
    async fn runtime_trace_logging_cannot_expose_host_credentials() {
        struct Capture(Mutex<String>);
        impl log::Log for Capture {
            fn enabled(&self, _: &log::Metadata<'_>) -> bool {
                true
            }
            fn log(&self, record: &log::Record<'_>) {
                use std::fmt::Write;
                writeln!(self.0.lock().expect("log capture"), "{}", record.args())
                    .expect("capture log");
            }
            fn flush(&self) {}
        }
        static CAPTURE: Capture = Capture(Mutex::new(String::new()));
        log::set_logger(&CAPTURE).expect("test logger");
        log::set_max_level(log::LevelFilter::Trace);
        assert!(log::STATIC_MAX_LEVEL <= log::LevelFilter::Info);
        log::info!("capture enabled");
        let secret = "dummy-host-credential-must-not-be-logged";
        let request = host_websocket_request(
            &url::Url::parse("wss://example.test/relay").expect("URL"),
            secret,
        )
        .expect("request");
        let (client_io, server_io) = tokio::io::duplex(4096);
        let (client, server) = tokio::join!(
            tokio_tungstenite::client_async(request, client_io),
            tokio_tungstenite::accept_hdr_async(
                server_io,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(
                        request.headers()["authorization"],
                        format!("Bearer {secret}")
                    );
                    Ok(response)
                }
            )
        );
        let (mut client, _) = client.expect("client handshake");
        let mut server = server.expect("server handshake");
        client
            .send(tokio_tungstenite::tungstenite::Message::text(secret))
            .await
            .expect("frame write");
        assert_eq!(
            server
                .next()
                .await
                .expect("frame")
                .expect("read")
                .to_text()
                .expect("text"),
            secret
        );
        client
            .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: secret.into(),
            }))
            .await
            .expect("send close");
        assert!(
            server
                .next()
                .await
                .expect("close")
                .expect("read close")
                .is_close()
        );
        let (flushed, reply) = tokio::join!(server.flush(), client.next());
        flushed.expect("flush close reply");
        assert!(reply.expect("reply").expect("read reply").is_close());
        let logs = CAPTURE.0.lock().expect("logs");
        assert!(logs.contains("capture enabled"));
        assert!(!logs.contains(secret));
    }

    #[test]
    fn cancellation_wakes_both_split_io_tasks() {
        use std::{
            sync::atomic::{AtomicUsize, Ordering},
            task::{Wake, Waker},
        };
        struct CountWake(AtomicUsize);
        impl Wake for CountWake {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let reads = Arc::new(CountWake(AtomicUsize::new(0)));
        let writes = Arc::new(CountWake(AtomicUsize::new(0)));
        let read_waker = Waker::from(reads.clone());
        let write_waker = Waker::from(writes.clone());
        let mut read_cx = TaskContext::from_waker(&read_waker);
        let mut write_cx = TaskContext::from_waker(&write_waker);
        let (stream, _peer) = tokio::io::duplex(1);
        let cancel = CancellationToken::new();
        let mut stream = RelayIo::new(stream, cancel.clone());
        let mut data = [0; 1];
        assert!(
            Pin::new(&mut stream)
                .poll_read(&mut read_cx, &mut tokio::io::ReadBuf::new(&mut data))
                .is_pending()
        );
        assert!(
            Pin::new(&mut stream)
                .poll_write(&mut write_cx, &[1])
                .is_ready()
        );
        assert!(
            Pin::new(&mut stream)
                .poll_write(&mut write_cx, &[2])
                .is_pending()
        );
        cancel.cancel();
        assert!(reads.0.load(Ordering::SeqCst) > 0);
        assert!(writes.0.load(Ordering::SeqCst) > 0);
    }

    #[test]
    fn relay_envelope_requires_all_identity_fields_and_rejects_forwarding_destinations() {
        let good = serde_json::json!({
            "host": { "host_id": "host-a", "session_id": "session-a", "credential_generation": 1 },
            "owner_id": "owner-a", "execution_id": "execution-a", "execution_generation": 1,
            "vm_id": "vm-a", "service": "ssh"
        });
        assert!(
            serde_json::from_value::<RelayTarget>(good.clone())
                .expect("target")
                .validate()
                .is_ok()
        );
        for field in [
            "host",
            "owner_id",
            "execution_id",
            "execution_generation",
            "vm_id",
            "service",
        ] {
            let mut bad = good.clone();
            bad.as_object_mut().expect("object").remove(field);
            assert!(serde_json::from_value::<RelayTarget>(bad).is_err());
        }
        for field in ["host_id", "session_id", "credential_generation"] {
            let mut bad = good.clone();
            bad["host"].as_object_mut().expect("host").remove(field);
            assert!(serde_json::from_value::<RelayTarget>(bad).is_err());
        }
        let mut bad = good.clone();
        bad["destination"] = serde_json::json!("169.254.169.254:80");
        assert!(serde_json::from_value::<RelayTarget>(bad).is_err());
        let mut bad = good.clone();
        bad["service"] = serde_json::json!("tcp");
        assert!(serde_json::from_value::<RelayTarget>(bad).is_err());
        let mut bad = serde_json::from_value::<RelayTarget>(good).expect("target");
        bad.execution_generation = 0;
        assert!(bad.validate().is_err());
        bad.execution_generation = 1;
        bad.host.credential_generation = 0;
        assert!(bad.validate().is_err());
    }

    #[tokio::test]
    async fn host_connection_rejects_urls_that_can_expose_credentials() {
        for raw in [
            "ws://example.test/relay",
            "wss://secret@example.test/relay",
            "wss://example.test/relay?token=secret",
            "wss://example.test/relay#secret",
        ] {
            assert!(
                connect_websocket(&url::Url::parse(raw).expect("url"), "secret")
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn cancelling_an_ssh_handshake_closes_the_transport() {
        let (stream, mut silent_peer) = tokio::io::duplex(256);
        let identity = HostRelayIdentity {
            host_id: "host-a".into(),
            session_id: "session-a".into(),
            credential_generation: 1,
        };
        let key = russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .expect("key");
        let cancel = CancellationToken::new();
        let client_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            connect_host_relay(
                stream,
                identity,
                key.public_key().clone(),
                LocalRelayTargets::default(),
                client_cancel,
            )
            .await
        });
        let mut identification = [0; 8];
        silent_peer
            .read_exact(&mut identification)
            .await
            .expect("SSH identification");
        cancel.cancel();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .expect("cancel timeout")
                .expect("task")
                .is_err()
        );
    }

    #[test]
    fn expired_assignments_do_not_exhaust_the_local_limit() {
        let local = LocalRelayTargets::default();
        let target = RelayTarget {
            host: HostRelayIdentity {
                host_id: "host-a".into(),
                session_id: "session-a".into(),
                credential_generation: 1,
            },
            owner_id: "owner-a".into(),
            execution_id: "execution-a".into(),
            execution_generation: 1,
            vm_id: "vm-a".into(),
            service: RelayService::Ssh,
        };
        for n in 0..RELAY_CHANNELS {
            let mut target = target.clone();
            target.vm_id = format!("vm-{n}");
            local
                .assign(
                    target,
                    "127.0.0.1:22".parse().expect("address"),
                    tokio::time::Instant::now() + Duration::from_secs(60),
                )
                .expect("assignment");
        }
        for old in local.0.lock().expect("targets").values_mut() {
            old.expires
                .renew(tokio::time::Instant::now() - Duration::from_secs(1));
        }
        local
            .assign(
                target,
                "127.0.0.1:22".parse().expect("address"),
                tokio::time::Instant::now() + Duration::from_secs(60),
            )
            .expect("expired entries must be removed");
        assert_eq!(local.0.lock().expect("targets").len(), 1);
    }
}
