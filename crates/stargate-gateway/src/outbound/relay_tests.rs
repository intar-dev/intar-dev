use super::*;
use crate::HostRelayRegistry;
use russh::{
    Channel, ChannelId,
    server::{self, Auth, Session},
};
use stargate_core::relay::{
    HostRelayIdentity, LocalRelayTargets, RelayService, RelayTarget, binary_websocket,
    connect_host_relay,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::protocol::{Role, WebSocketConfig},
};

fn key() -> russh::keys::PrivateKey {
    russh::keys::PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519)
        .expect("test key")
}

fn target() -> RelayTarget {
    RelayTarget {
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
    }
}

struct Harness {
    registry: HostRelayRegistry,
    local: LocalRelayTargets,
    target: RelayTarget,
    cancel: CancellationToken,
    _client: client::Handle<stargate_core::relay::HostRelayClient>,
    server: tokio::task::JoinHandle<anyhow::Result<()>>,
}

// Once paused, keep the socket open but stop reading the outer WebSocket bytes.
struct HostReadGate {
    stream: tokio::io::DuplexStream,
    paused: Arc<AtomicBool>,
}

impl AsyncRead for HostReadGate {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.paused.load(Ordering::SeqCst) {
            return Poll::Pending;
        }
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for HostReadGate {
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

impl Harness {
    async fn start(address: SocketAddr) -> anyhow::Result<Self> {
        Self::start_with_host_read_gate(address, Arc::new(AtomicBool::new(false))).await
    }

    async fn start_with_host_read_gate(
        address: SocketAddr,
        paused: Arc<AtomicBool>,
    ) -> anyhow::Result<Self> {
        let target = target();
        let gateway_key = key();
        let local = LocalRelayTargets::default();
        let expires = tokio::time::Instant::now() + Duration::from_secs(60);
        local.assign(target.clone(), address, expires)?;
        let registry = HostRelayRegistry::default();
        // Actual binary WebSocket framing in both directions. The in-memory
        // link makes it impossible for Stargate to open a host TCP listener.
        let (outbound, inbound) = tokio::io::duplex(4096);
        let outbound = HostReadGate {
            stream: outbound,
            paused,
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(16 * 1024))
            .max_frame_size(Some(16 * 1024));
        let outbound = WebSocketStream::from_raw_socket(outbound, Role::Client, Some(config)).await;
        let inbound = WebSocketStream::from_raw_socket(inbound, Role::Server, Some(config)).await;
        let cancel = CancellationToken::new();
        let server = tokio::spawn({
            let registry = registry.clone();
            let identity = target.host.clone();
            let missing = RelayTarget {
                vm_id: "missing-vm".into(),
                ..target.clone()
            };
            let targets = [target.clone(), missing].into();
            let key = gateway_key.clone();
            let cancel = cancel.clone();
            async move {
                registry
                    .serve(
                        binary_websocket(inbound),
                        identity,
                        targets,
                        key,
                        expires,
                        cancel,
                    )
                    .await
            }
        });
        let client = connect_host_relay(
            binary_websocket(outbound),
            target.host.clone(),
            gateway_key.public_key().clone(),
            local.clone(),
            CancellationToken::new(),
        )
        .await?;
        // Auth replies and registry insertion are distinct SSH events.
        tokio::time::timeout(Duration::from_secs(2), async {
            while !registry.is_connected(&target.host) {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        Ok(Self {
            registry,
            local,
            target,
            cancel,
            _client: client,
            server,
        })
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.local.clear();
        self.server.abort();
    }
}

#[tokio::test]
async fn relay_forwards_bounded_streams_and_rejects_foreign_or_stale_assignments()
-> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let echo = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = socket.into_split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    let h = Harness::start(address).await?;
    for index in 0..6 {
        let mut bad = h.target.clone();
        match index {
            0 => bad.owner_id = "owner-b".into(),
            1 => bad.execution_generation += 1,
            2 => bad.host.credential_generation += 1,
            3 => bad.host.session_id = "old-session".into(),
            4 => bad.vm_id = "vm-b".into(),
            _ => bad.execution_id = "execution-b".into(),
        }
        assert!(h.registry.open(&bad).await.is_err());
    }
    let mut stream = h.registry.open(&h.target).await?;
    let payload = vec![42; 512 * 1024];
    let (mut read, mut write) = tokio::io::split(&mut stream);
    let mut received = vec![0; payload.len()];
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::try_join!(write.write_all(&payload), read.read_exact(&mut received))?;
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    assert_eq!(received, payload);
    // Local revocation stops an already-open channel and blocks a new one,
    // even before the gateway has received a control-plane revocation event.
    h.local.revoke(&h.target);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), stream.read_u8())
            .await?
            .expect_err("revoked stream must close")
            .kind(),
        io::ErrorKind::UnexpectedEof
    );
    assert!(h.registry.open(&h.target).await.is_err());
    h.registry.revoke(&h.target.host);
    assert!(h.registry.open(&h.target).await.is_err());
    echo.abort();
    Ok(())
}

struct Guest {
    allowed: PublicKey,
}

#[tokio::test]
async fn rejection_bursts_during_data_flow_do_not_disconnect_the_host() -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let guest = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = socket.into_split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    let h = Harness::start(address).await?;
    let mut active = h.registry.open(&h.target).await?;
    let missing = RelayTarget {
        vm_id: "missing-vm".into(),
        ..h.target.clone()
    };
    for _ in 0..4 {
        let data = vec![17; 32 * 1024];
        active.write_all(&data).await?;
        let opens = (0..63).map(|_| h.registry.open(&missing));
        let results = tokio::time::timeout(
            Duration::from_secs(3),
            futures_util::future::join_all(opens),
        )
        .await?;
        assert!(results.into_iter().all(|result| result.is_err()));
        let mut received = vec![0; data.len()];
        tokio::time::timeout(Duration::from_secs(1), active.read_exact(&mut received)).await??;
        assert_eq!(received, data);
        assert!(h.registry.is_connected(&h.target.host));
    }
    guest.abort();
    Ok(())
}

#[tokio::test]
async fn final_guest_bytes_are_drained_before_fin() -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let payload = vec![37; 128 * 1024];
    let guest_payload = payload.clone();
    let guest = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let payload = guest_payload.clone();
            tokio::spawn(async move {
                socket.write_all(&payload).await.expect("final payload");
                socket.shutdown().await.expect("FIN");
            });
        }
    });
    let h = Harness::start(address).await?;
    for _ in 0..16 {
        let mut stream = h.registry.open(&h.target).await?;
        let mut received = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut received)).await??;
        assert_eq!(received, payload);
    }
    guest.abort();
    Ok(())
}

#[tokio::test]
async fn gateway_shutdown_drains_final_bytes_before_immediate_drop() -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let guest = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut data = Vec::new();
                socket.read_to_end(&mut data).await.expect("guest input");
                let _ = tx.send(data).await;
            });
        }
    });
    let h = Harness::start(address).await?;
    let payload = vec![73; 128 * 1024];
    for _ in 0..16 {
        let mut stream = h.registry.open(&h.target).await?;
        stream.write_all(&payload).await?;
        stream.shutdown().await?;
        drop(stream);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await?
                .expect("payload"),
            payload
        );
    }
    guest.abort();
    Ok(())
}

#[tokio::test]
async fn failed_setup_does_not_cancel_shared_authorization() -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let h = Harness::start(listener.local_addr()?).await?;
    let (stream, _peer) = tokio::io::duplex(1);
    let mut bad = h.target.host.clone();
    bad.credential_generation = 0;
    assert!(
        h.registry
            .serve(
                stream,
                bad,
                [].into(),
                key(),
                tokio::time::Instant::now() + Duration::from_secs(10),
                h.cancel.clone()
            )
            .await
            .is_err()
    );
    let (stream, peer) = tokio::io::duplex(1);
    drop(peer);
    assert!(
        connect_host_relay(
            stream,
            h.target.host.clone(),
            key().public_key().clone(),
            h.local.clone(),
            h.cancel.clone()
        )
        .await
        .is_err()
    );
    assert!(!h.cancel.is_cancelled());
    assert!(h.registry.is_connected(&h.target.host));
    Ok(())
}

#[tokio::test]
async fn blocked_guest_writes_release_the_local_slot_after_channel_close() -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let guest = tokio::spawn(async move {
        let mut sockets = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            sockets.push(socket);
        }
    });
    let h = Harness::start(address).await?;
    let mut idle = Vec::new();
    for _ in 0..63 {
        idle.push(h.registry.open(&h.target).await?);
    }
    let mut blocked = h.registry.open(&h.target).await?;
    let mut writer =
        tokio::spawn(async move { blocked.write_all(&vec![7; 32 * 1024 * 1024]).await });
    let _ = tokio::time::timeout(Duration::from_millis(100), &mut writer).await;
    writer.abort();
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            if let Ok(stream) = h.registry.open(&h.target).await {
                drop(stream);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    assert!(h.registry.is_connected(&h.target.host));
    guest.abort();
    Ok(())
}

#[tokio::test]
async fn cancelled_open_consumes_late_rejection_without_killing_host() -> anyhow::Result<()> {
    struct DelayedReject {
        seen: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }
    impl client::Handler for DelayedReject {
        type Error = anyhow::Error;
        async fn check_server_key(&mut self, _: &PublicKey) -> anyhow::Result<bool> {
            Ok(true)
        }
        async fn server_channel_open_direct_tcpip(
            &mut self,
            _: Channel<client::Msg>,
            _: &str,
            _: u32,
            _: &str,
            _: u32,
            reply: client::ChannelOpenHandle,
            _: &mut client::Session,
        ) -> anyhow::Result<()> {
            self.seen.notify_one();
            let release = self.release.clone();
            tokio::spawn(async move {
                release.notified().await;
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
            });
            Ok(())
        }
    }
    let seen = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let registry = HostRelayRegistry::default();
    let target = target();
    let cancel = CancellationToken::new();
    let (outbound, inbound) = tokio::io::duplex(4096);
    let server = tokio::spawn({
        let registry = registry.clone();
        let target = target.clone();
        let cancel = cancel.clone();
        async move {
            registry
                .serve(
                    inbound,
                    target.host.clone(),
                    [target].into(),
                    key(),
                    tokio::time::Instant::now() + Duration::from_secs(10),
                    cancel,
                )
                .await
        }
    });
    let mut client = client::connect_stream(
        Arc::new(client::Config::default()),
        outbound,
        DelayedReject {
            seen: seen.clone(),
            release: release.clone(),
        },
    )
    .await?;
    assert!(client.authenticate_none("host-a").await?.success());
    tokio::time::timeout(Duration::from_secs(1), async {
        while !registry.is_connected(&target.host) {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    let first = tokio::spawn({
        let registry = registry.clone();
        let target = target.clone();
        async move { registry.open(&target).await }
    });
    tokio::time::timeout(Duration::from_secs(1), seen.notified()).await?;
    first.abort();
    let _ = first.await;
    release.notify_one();
    let second = tokio::spawn({
        let registry = registry.clone();
        let target = target.clone();
        async move { registry.open(&target).await }
    });
    tokio::time::timeout(Duration::from_secs(1), seen.notified()).await?;
    release.notify_one();
    assert!(
        tokio::time::timeout(Duration::from_secs(1), second)
            .await??
            .is_err()
    );
    assert!(registry.is_connected(&target.host));
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(1), server).await???;
    Ok(())
}

#[tokio::test]
async fn dropped_streams_release_slots_and_aborted_host_tasks_remove_authorization()
-> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let guests = tokio::spawn(async move {
        let mut sockets = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            sockets.push(socket);
        }
    });
    let h = Harness::start(address).await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        for _ in 0..128 {
            drop(h.registry.open(&h.target).await?);
            tokio::task::yield_now().await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let mut stream = h.registry.open(&h.target).await?;
    h.server.abort();
    tokio::time::timeout(Duration::from_secs(2), async {
        while h.registry.is_connected(&h.target.host) {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    assert!(h.registry.open(&h.target).await.is_err());
    assert!(
        tokio::time::timeout(Duration::from_secs(2), stream.read_u8())
            .await?
            .is_err()
    );
    guests.abort();
    Ok(())
}

#[tokio::test]
async fn stalled_host_websocket_removes_registration_and_fails_existing_streams()
-> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let guests = tokio::spawn(async move {
        let mut sockets = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            sockets.push(socket);
        }
    });
    let paused = Arc::new(AtomicBool::new(false));
    let h = Harness::start_with_host_read_gate(address, paused.clone()).await?;
    let mut idle = h.registry.open(&h.target).await?;
    let mut streams = Vec::new();
    for _ in 0..4 {
        streams.push(h.registry.open(&h.target).await?);
    }
    assert!(h.registry.is_connected(&h.target.host));

    // Authentication and channel opens are complete. Stop reads below WebSocket
    // framing, then fill more than one channel window so the outer 64 KiB
    // bridge and 4 KiB wire buffer both fill. Keep every stream and the host
    // handle alive; no revoke, drop, new open, or expiry can cause cleanup.
    paused.store(true, Ordering::SeqCst);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    let payload = vec![7; 1024 * 1024];
    let flood =
        futures_util::future::join_all(streams.iter_mut().map(|stream| stream.write_all(&payload)));
    tokio::pin!(flood);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut flood)
            .await
            .is_err(),
        "writes must be blocked before the transport timeout"
    );
    assert!(h.registry.is_connected(&h.target.host));
    tokio::time::timeout_at(deadline, async {
        let (results, read) = tokio::join!(&mut flood, idle.read_u8());
        assert!(results.into_iter().all(|result| result.is_err()));
        assert!(read.is_err());
        while !h.server.is_finished() {
            tokio::task::yield_now().await;
        }
        assert!(!h.registry.is_connected(&h.target.host));
        assert!(idle.write_all(b"closed").await.is_err());
        assert!(idle.shutdown().await.is_err());
        let error = h
            .registry
            .open(&h.target)
            .await
            .err()
            .expect("offline host");
        assert_eq!(error.to_string(), "personal server is offline");
    })
    .await
    .context("stalled outer transport must remove the host and fail its streams")?;
    guests.abort();
    Ok(())
}

#[tokio::test]
async fn slow_client_does_not_block_another_channel_and_host_channels_are_limited()
-> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let echo = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = socket.into_split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    let h = Harness::start(address).await?;
    let mut streams = Vec::new();
    for _ in 0..stargate_core::relay::RELAY_CHANNELS {
        streams.push(h.registry.open(&h.target).await?);
    }
    assert!(
        h.registry
            .open(&h.target)
            .await
            .err()
            .expect("host must enforce its stream limit")
            .to_string()
            .contains("connection limit")
    );
    let mut slow = streams.pop().expect("slow stream");
    let mut fast = streams.pop().expect("fast stream");
    let mut flood = tokio::spawn(async move {
        // Never read the echoes. Eventually both bounded windows fill.
        slow.write_all(&vec![1; 4 * 1024 * 1024]).await
    });
    let _ = tokio::time::timeout(Duration::from_millis(100), &mut flood).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        fast.write_all(b"still usable").await?;
        let mut response = [0; 12];
        fast.read_exact(&mut response).await?;
        assert_eq!(&response, b"still usable");
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    h.registry.revoke(&h.target.host);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !h.server.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    flood.abort();
    echo.abort();
    Ok(())
}
impl server::Handler for Guest {
    type Error = anyhow::Error;
    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> anyhow::Result<Auth> {
        Ok(
            if user == "learner" && key.key_data() == self.allowed.key_data() {
                Auth::Accept
            } else {
                Auth::reject()
            },
        )
    }
    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> anyhow::Result<()> {
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> anyhow::Result<()> {
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> anyhow::Result<()> {
        session.channel_success(channel)?;
        session.data(channel, "browser shell\n")?;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _: &[u8],
        session: &mut Session,
    ) -> anyhow::Result<()> {
        session.channel_success(channel)?;
        session.data(channel, "native exec\n")?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }
}

#[tokio::test]
async fn browser_pty_and_native_exec_keep_guest_host_key_verification_over_relay()
-> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let guest_key = key();
    let access_key = key();
    let server_key = guest_key.clone();
    let allowed = access_key.public_key().clone();
    let guest = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = Arc::new(server::Config {
                keys: vec![server_key.clone()],
                ..Default::default()
            });
            let allowed = allowed.clone();
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, socket, Guest { allowed }).await {
                    let _ = session.await;
                }
            });
        }
    });
    let h = Harness::start(address).await?;
    let prepared = |host_key: PublicKey| PreparedSshTarget {
        // An unreachable address proves this path uses the relay stream.
        transport: stargate_core::SshTargetTransport::Direct {
            host: "192.0.2.1".into(),
            port: 22,
        },
        relays: HostRelayRegistry::default(),
        expected_host_key: host_key,
        private_key: Arc::new(access_key.clone()),
    };
    let session = connect_authenticated_stream(
        prepared(guest_key.public_key().clone()),
        "learner",
        h.registry.open(&h.target).await?,
    )
    .await?;
    for (mode, expected) in [
        (
            BridgeMode::Pty(PtyBridgeOptions {
                term: "xterm".into(),
                cols: 80,
                rows: 24,
                command: None,
            }),
            "browser shell\n",
        ),
        (
            BridgeMode::Exec {
                command: "id".into(),
            },
            "native exec\n",
        ),
    ] {
        let mut channel = session.channel_open_session().await?;
        configure_channel(&channel, mode).await?;
        let output = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(ChannelMsg::Data { data }) = channel.wait().await {
                    break data;
                }
            }
        })
        .await?;
        assert_eq!(&output[..], expected.as_bytes());
        channel.close().await?;
    }
    assert!(
        connect_authenticated_stream(
            prepared(key().public_key().clone()),
            "learner",
            h.registry.open(&h.target).await?
        )
        .await
        .is_err()
    );
    h.registry.revoke(&h.target.host);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !session.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    assert!(h.registry.open(&h.target).await.is_err());
    guest.abort();
    Ok(())
}
