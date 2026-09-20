//! One outbound relay per authenticated control session. Local VM records are
//! the only source of guest addresses; the gateway can only name an assignment.
use anyhow::{Context, ensure};
use intar_contracts::{bridge::HostRelayCredentials, stargate::RelayTarget};
use stargate_core::relay::{
    LocalRelayTargets, RELAY_CHANNELS, RelayLease, connect_host_relay, connect_websocket,
};
use std::{collections::HashSet, net::SocketAddr, time::Duration};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub struct RelayRunner {
    current: Option<Running>,
    status: tokio::sync::watch::Sender<bool>,
}
impl Default for RelayRunner {
    fn default() -> Self {
        Self {
            current: None,
            status: tokio::sync::watch::channel(false).0,
        }
    }
}
struct Running {
    credentials: HostRelayCredentials,
    expires: RelayLease,
    targets: LocalRelayTargets,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
impl RelayRunner {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<bool> {
        self.status.subscribe()
    }
    pub async fn apply(
        &mut self,
        credentials: Option<HostRelayCredentials>,
        assignments: Vec<(RelayTarget, SocketAddr, Instant)>,
    ) -> anyhow::Result<()> {
        let Some(credentials) = credentials else {
            self.close();
            return Ok(());
        };
        // Validation failures revoke the previous authorization too.
        if let Err(error) = self.apply_validated(credentials, assignments) {
            self.close();
            return Err(error);
        }
        Ok(())
    }
    fn apply_validated(
        &mut self,
        credentials: HostRelayCredentials,
        assignments: Vec<(RelayTarget, SocketAddr, Instant)>,
    ) -> anyhow::Result<()> {
        credentials.identity.validate()?;
        let remaining = credentials.expires_at_unix_ms
            - (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
        ensure!(
            remaining > 0 && remaining <= 125_000,
            "invalid relay credential expiry"
        );
        let expires = Instant::now() + Duration::from_millis(remaining as u64);
        let url: reqwest::Url = credentials
            .websocket_url
            .parse()
            .context("invalid relay URL")?;
        ensure!(
            url.scheme() == "wss"
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "relay requires WSS without URL credentials"
        );
        let key =
            russh::keys::ssh_key::PublicKey::from_openssh(&credentials.gateway_host_key_openssh)?;
        ensure!(
            key.algorithm() == russh::keys::ssh_key::Algorithm::Ed25519,
            "invalid relay gateway key algorithm"
        );
        ensure!(
            credentials.token.len() == 64
                && credentials.token.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid relay token"
        );
        ensure!(
            assignments.len() <= RELAY_CHANNELS,
            "too many relay assignments"
        );
        let mut live = HashSet::new();
        for (target, address, deadline) in &assignments {
            target.validate()?;
            ensure!(
                target.host == credentials.identity
                    && address.port() > 0
                    && *deadline > Instant::now(),
                "invalid local relay assignment"
            );
            ensure!(live.insert(target.clone()), "duplicate relay assignment");
        }
        let same = self.current.as_ref().is_some_and(|r| {
            r.credentials.identity == credentials.identity
                && r.credentials.token == credentials.token
                && r.credentials.websocket_url == credentials.websocket_url
                && r.credentials.gateway_host_key_openssh == credentials.gateway_host_key_openssh
                && !r.task.is_finished()
                && !r.cancel.is_cancelled()
        });
        if !same {
            self.close();
            let targets = LocalRelayTargets::default();
            let cancel = CancellationToken::new();
            let connected = self.status.clone();
            let expiry = RelayLease::new(expires);
            let task = tokio::spawn({
                let connected = connected.clone();
                let targets = targets.clone();
                let cancel = cancel.clone();
                let expiry = expiry.clone();
                let identity = credentials.identity.clone();
                let token = credentials.token.clone();
                async move {
                    let connect = async {
                        loop {
                            let result = async {
                                let stream = connect_websocket(&url, &token).await?;
                                let session = connect_host_relay(
                                    stream,
                                    identity.clone(),
                                    key.clone(),
                                    targets.clone(),
                                    cancel.clone(),
                                )
                                .await?;
                                connected.send_replace(true);
                                let result = session.await.context("relay session ended");
                                connected.send_replace(false);
                                result
                            }
                            .await;
                            // Do not log tokens, URLs, or frames from a transport error.
                            if result.is_err() {
                                tracing::warn!("host relay disconnected; retrying");
                            }
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                    };
                    tokio::select! {_=cancel.cancelled()=>{},_=expiry.expired()=>{},_=connect=>{}}
                    connected.send_replace(false);
                    cancel.cancel();
                    targets.clear();
                }
            });
            self.current = Some(Running {
                credentials,
                expires: expiry,
                targets,
                cancel,
                task,
            });
        }
        let current = self.current.as_ref().expect("relay started");
        current.expires.renew(expires);
        current.targets.retain(&live);
        for (target, address, deadline) in assignments {
            current.targets.assign(target, address, deadline)?;
        }
        Ok(())
    }
    pub fn close(&mut self) {
        if let Some(current) = self.current.take() {
            self.status.send_replace(false);
            current.cancel.cancel();
            current.targets.clear();
            current.task.abort();
        }
    }
}
impl Drop for RelayRunner {
    fn drop(&mut self) {
        self.close();
    }
}
