use std::{
    collections::{HashMap, HashSet},
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context as TaskContext, Poll},
    time::Duration,
};

use anyhow::{Context, ensure};
use russh::{keys::PrivateKey, server};
use stargate_core::relay::{
    HostRelayIdentity, RELAY_CHANNELS, RELAY_FRAME_BYTES, RELAY_WINDOW_BYTES, RelayIo, RelayLease,
    RelayTarget, encode_target, isolated_channel,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, DuplexStream},
    sync::{OwnedSemaphorePermit, Semaphore, oneshot},
};
use tokio_util::sync::CancellationToken;

/// Live, authenticated host connections only. Nothing is restored from disk:
/// after a Stargate restart a host must pass current authorization again.
#[derive(Clone)]
pub struct HostRelayRegistry(
    Arc<Mutex<HashMap<String, Arc<HostConnection>>>>,
    Arc<Semaphore>,
);
impl Default for HostRelayRegistry {
    fn default() -> Self {
        Self(
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Semaphore::new(1024)),
        )
    }
}

struct HostConnection {
    identity: HostRelayIdentity,
    authorization: Arc<RelayAuthorization>,
    handle: server::Handle,
    slots: Arc<Semaphore>,
    cancel: CancellationToken,
}

pub(crate) struct RelayAuthorization {
    pub identity: HostRelayIdentity,
    pub cancel: CancellationToken,
    lease: RelayLease,
    targets: Mutex<HashMap<RelayTarget, CancellationToken>>,
}
impl RelayAuthorization {
    pub fn new(
        identity: HostRelayIdentity,
        targets: HashSet<RelayTarget>,
        expires: tokio::time::Instant,
        cancel: CancellationToken,
    ) -> anyhow::Result<Self> {
        identity.validate()?;
        let authorization = Self {
            identity,
            cancel,
            lease: RelayLease::new(expires),
            targets: Mutex::new(HashMap::new()),
        };
        authorization.refresh(targets, expires)?;
        Ok(authorization)
    }
    pub fn refresh(
        &self,
        targets: HashSet<RelayTarget>,
        expires: tokio::time::Instant,
    ) -> anyhow::Result<()> {
        ensure!(
            targets.len() <= RELAY_CHANNELS && expires > tokio::time::Instant::now(),
            "invalid relay lease"
        );
        for target in &targets {
            target.validate()?;
            ensure!(target.host == self.identity, "relay host mismatch");
        }
        let mut state = self.targets.lock().expect("relay authorization lock");
        state.retain(|target, cancel| {
            let keep = targets.contains(target);
            if !keep {
                cancel.cancel();
            }
            keep
        });
        for target in targets {
            state
                .entry(target)
                .or_insert_with(|| self.cancel.child_token());
        }
        self.lease.renew(expires);
        Ok(())
    }
    pub fn matches_targets(&self, targets: &HashSet<RelayTarget>) -> bool {
        let state = self.targets.lock().expect("relay authorization lock");
        state.len() == targets.len() && targets.iter().all(|target| state.contains_key(target))
    }
    pub fn expires(&self) -> tokio::time::Instant {
        self.lease.deadline()
    }
    pub(crate) async fn expired(&self) {
        self.lease.expired().await;
    }
    fn target_cancel(&self, target: &RelayTarget) -> Option<CancellationToken> {
        let state = self.targets.lock().expect("relay authorization lock");
        if self.expires() <= tokio::time::Instant::now() || self.cancel.is_cancelled() {
            return None;
        }
        state.get(target).cloned()
    }
}

pub struct HostRelayStream {
    stream: RelayIo<DuplexStream>,
    _permit: OwnedSemaphorePermit,
    _global_permit: OwnedSemaphorePermit,
    _cancel_guard: tokio_util::sync::DropGuard,
}
impl AsyncRead for HostRelayStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl AsyncWrite for HostRelayStream {
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

struct HostHandler {
    host_id: String,
    authenticated: Option<oneshot::Sender<()>>,
}

struct Registration {
    registry: HostRelayRegistry,
    entry: Arc<HostConnection>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.entry.cancel.cancel();
        let mut hosts = self.registry.0.lock().expect("host relay lock");
        if hosts
            .get(&self.entry.identity.host_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.entry))
        {
            hosts.remove(&self.entry.identity.host_id);
        }
    }
}

impl server::Handler for HostHandler {
    type Error = anyhow::Error;
    async fn auth_none(&mut self, user: &str) -> anyhow::Result<server::Auth> {
        Ok(if user == self.host_id {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_succeeded(&mut self, _: &mut server::Session) -> anyhow::Result<()> {
        if let Some(tx) = self.authenticated.take() {
            let _ = tx.send(());
        }
        Ok(())
    }
    // Server defaults reject all client-initiated channels and forwards.
}

impl HostRelayRegistry {
    pub fn is_connected(&self, identity: &HostRelayIdentity) -> bool {
        self.0
            .lock()
            .expect("host relay lock")
            .get(&identity.host_id)
            .is_some_and(|host| {
                host.identity == *identity
                    && !host.cancel.is_cancelled()
                    && host.authorization.expires() > tokio::time::Instant::now()
            })
    }
    /// Called only AFTER fresh host authentication. The authorization source
    /// must bind this identity and target set to the current credential and
    /// control connection. `cancel` is the revocation signal from that source.
    /// This method does not accept host credentials or make auth decisions.
    pub async fn serve<S>(
        &self,
        stream: S,
        identity: HostRelayIdentity,
        targets: HashSet<RelayTarget>,
        key: PrivateKey,
        expires: tokio::time::Instant,
        cancel: CancellationToken,
    ) -> anyhow::Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let authorization = Arc::new(RelayAuthorization::new(identity, targets, expires, cancel)?);
        self.serve_authorized(stream, authorization, key).await
    }

    pub(crate) async fn serve_authorized<S>(
        &self,
        stream: S,
        authorization: Arc<RelayAuthorization>,
        key: PrivateKey,
    ) -> anyhow::Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let identity = authorization.identity.clone();
        let cancel = authorization.cancel.child_token();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let config = server::Config {
            keys: vec![key],
            window_size: RELAY_WINDOW_BYTES,
            maximum_packet_size: RELAY_FRAME_BYTES as u32,
            channel_buffer_size: 4,
            event_buffer_size: 16,
            max_auth_attempts: 1,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 2,
            ..Default::default()
        };
        let (tx, rx) = oneshot::channel();
        let mut running = tokio::select! {
            biased;
            _ = cancel.cancelled() => anyhow::bail!("host relay revoked"),
            _ = authorization.expired() => anyhow::bail!("host relay expired"),
            result = tokio::time::timeout(Duration::from_secs(10), server::run_stream(Arc::new(config), RelayIo::new(stream, cancel.clone()), HostHandler { host_id: identity.host_id.clone(), authenticated: Some(tx) })) => result??,
        };
        let handle = running.handle();
        let result = async {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => anyhow::bail!("host relay revoked"),
                _ = authorization.expired() => anyhow::bail!("host relay expired"),
                result = tokio::time::timeout(Duration::from_secs(10), rx) => { result??; },
            }
            let entry = Arc::new(HostConnection {
                identity: identity.clone(),
                authorization: authorization.clone(),
                handle: handle.clone(),
                slots: Arc::new(Semaphore::new(RELAY_CHANNELS)),
                cancel: cancel.clone(),
            });
            {
                let mut hosts = self.0.lock().expect("host relay lock");
                // A late handshake cannot replace an active host connection.
                ensure!(
                    !hosts.contains_key(&identity.host_id),
                    "host relay already connected"
                );
                ensure!(!cancel.is_cancelled(), "host relay revoked");
                hosts.insert(identity.host_id.clone(), entry.clone());
            }
            let _registration = Registration {
                registry: self.clone(),
                entry,
            };
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = authorization.expired() => {},
                _ = &mut running => {},
            }
            Ok(())
        }
        .await;
        cancel.cancel();
        // Bound the disconnect too: an unresponsive host cannot retain a task.
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            handle.disconnect(
                russh::Disconnect::ByApplication,
                "host relay ended".into(),
                "en".into(),
            ),
        )
        .await;
        result
    }

    pub fn revoke(&self, identity: &HostRelayIdentity) {
        let mut hosts = self.0.lock().expect("host relay lock");
        if hosts
            .get(&identity.host_id)
            .is_some_and(|current| current.identity == *identity)
            && let Some(old) = hosts.remove(&identity.host_id)
        {
            old.cancel.cancel();
        }
    }

    /// No socket address comes from the client or a route. The agent resolves
    /// the complete identity against its live local assignment list.
    pub async fn open(&self, target: &RelayTarget) -> anyhow::Result<HostRelayStream> {
        target.validate()?;
        let host = self
            .0
            .lock()
            .expect("host relay lock")
            .get(&target.host.host_id)
            .cloned()
            .context("personal server is offline")?;
        ensure!(
            host.identity == target.host
                && !host.cancel.is_cancelled()
                && host.authorization.expires() > tokio::time::Instant::now(),
            "relay assignment is not authorized"
        );
        let assignment_cancel = host
            .authorization
            .target_cancel(target)
            .context("relay assignment is not authorized")?;
        let permit = host
            .slots
            .clone()
            .try_acquire_owned()
            .context("personal server connection limit reached")?;
        let global_permit = self
            .1
            .clone()
            .try_acquire_owned()
            .context("gateway relay stream limit reached")?;
        let envelope = encode_target(target)?;
        let (tx, rx) = oneshot::channel();
        // Keep the SSH confirmation receiver and its permit alive if this
        // caller goes away. Dropping a pending receiver makes russh treat a
        // later rejection as a fatal session error.
        tokio::spawn(async move {
            let stream_cancel = host.cancel.child_token();
            let cancel_guard = stream_cancel.clone().drop_guard();
            let cancel_watch = stream_cancel.clone();
            tokio::spawn(async move {
                tokio::select! { _=cancel_watch.cancelled()=>{}, _=assignment_cancel.cancelled()=>{cancel_watch.cancel();} }
            });
            let open = async {
                tokio::select! {
                    biased;
                    _ = host.cancel.cancelled() => anyhow::bail!("host relay revoked"),
                    result = tokio::time::timeout(Duration::from_secs(10), host.handle.channel_open_direct_tcpip(envelope, 22, "", 0)) => match result {
                        Ok(result) => Ok(result?),
                        Err(_) => { host.cancel.cancel(); anyhow::bail!("host relay did not answer channel open"); }
                    },
                }
            }.await;
            let channel = match open {
                Ok(channel) => channel,
                Err(error) => {
                    let _ = tx.send(Err(error));
                    return;
                }
            };
            // Return the draining stream itself. An extra duplex bridge here
            // would acknowledge shutdown before its bytes reached SSH.
            let stream = HostRelayStream {
                stream: isolated_channel(channel.into_stream(), &stream_cancel),
                _permit: permit,
                _global_permit: global_permit,
                _cancel_guard: cancel_guard,
            };
            let _ = tx.send(Ok(stream));
        });
        rx.await.context("host relay open stopped")?
    }
}
