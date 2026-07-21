use std::{borrow::Cow, collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use anyhow::Context;
use russh::{
    ChannelId, Disconnect, MethodKind, MethodSet, Preferred, cipher, compression, kex,
    keys::ssh_key::Algorithm,
    mac,
    server::{self, Auth, Msg, Server as _, Session},
};
use stargate_core::{RouteRecord, SessionKind};

use crate::{
    GatewayState, SessionLease,
    outbound::{
        BridgeEvent, ExecBridgeControl, PtyBridgeControl, PtyBridgeOptions, spawn_exec_bridge,
        spawn_pty_bridge,
    },
};

#[derive(Clone)]
pub struct SshProxyServer {
    state: GatewayState,
}

pub struct SshConnection {
    state: GatewayState,
    peer_addr: Option<SocketAddr>,
    route: Option<RouteRecord>,
    route_admission: Option<SessionLease>,
    connection_lease: Option<SessionLease>,
    channels: HashMap<ChannelId, ChannelState>,
}

enum ChannelState {
    Pending { pty: Option<PtySpec> },
    Active(ActiveBridge),
}

#[derive(Clone)]
struct PtySpec {
    term: String,
    cols: u16,
    rows: u16,
}

enum BridgeController {
    Exec(ExecBridgeControl),
    Pty(PtyBridgeControl),
}

struct ActiveBridge {
    controller: BridgeController,
    _lease: SessionLease,
}

pub async fn run_public_ssh_server(
    state: GatewayState,
    listener: tokio::net::TcpListener,
    host_key: russh::keys::PrivateKey,
) -> anyhow::Result<()> {
    let bind = listener
        .local_addr()
        .context("failed to read public ssh listener address")?;
    let mut config = server_config();
    config.keys.push(host_key);
    let config = Arc::new(config);
    let mut server = SshProxyServer { state };
    server
        .run_on_socket(config, &listener)
        .await
        .with_context(|| format!("public ssh server failed on {bind}"))?;
    Ok(())
}

impl server::Server for SshProxyServer {
    type Handler = SshConnection;

    fn new_client(&mut self, peer_addr: Option<SocketAddr>) -> Self::Handler {
        SshConnection {
            state: self.state.clone(),
            peer_addr,
            route: None,
            route_admission: None,
            connection_lease: None,
            channels: HashMap::new(),
        }
    }

    fn handle_session_error(&mut self, error: <Self::Handler as server::Handler>::Error) {
        tracing::warn!(error = %error, "ssh session error");
    }
}

impl server::Handler for SshConnection {
    type Error = anyhow::Error;

    async fn auth_publickey_offered(
        &mut self,
        user: &str,
        public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        self.clear_route_authorization();
        let Some((route, admission)) = self.load_route_with_admission(user).await? else {
            return Ok(Auth::reject());
        };
        if !route.allows_client_public_key(public_key)? {
            return Ok(Auth::reject());
        }
        if admission.token().is_cancelled() {
            return Ok(Auth::reject());
        }
        self.route = Some(route);
        self.route_admission = Some(admission);
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        let (route, admission) = match (self.route.clone(), self.route_admission.as_ref()) {
            (Some(route), Some(admission))
                if route.route_username == user && !admission.token().is_cancelled() =>
            {
                (route, None)
            }
            _ => {
                self.clear_route_authorization();
                let Some((route, admission)) = self.load_route_with_admission(user).await? else {
                    return Ok(Auth::reject());
                };
                (route, Some(admission))
            }
        };
        if !route.allows_client_public_key(public_key)? {
            return Ok(Auth::reject());
        }
        if let Some(admission) = admission {
            if admission.token().is_cancelled() {
                return Ok(Auth::reject());
            }
            self.route_admission = Some(admission);
        }
        if self
            .route_admission
            .as_ref()
            .is_none_or(|lease| lease.token().is_cancelled())
        {
            return Ok(Auth::reject());
        }
        self.route = Some(route);
        Ok(Auth::Accept)
    }

    async fn auth_succeeded(&mut self, session: &mut Session) -> Result<(), Self::Error> {
        let _ = self.peer_addr;
        let Some(route) = self.route.as_ref() else {
            session.disconnect(Disconnect::ByApplication, "route unavailable", "en-US")?;
            return Ok(());
        };
        let Some(admission) = self.route_admission.as_ref() else {
            session.disconnect(Disconnect::ByApplication, "route unavailable", "en-US")?;
            return Ok(());
        };
        if admission.token().is_cancelled() || route.is_expired_at(time::OffsetDateTime::now_utc())
        {
            session.disconnect(Disconnect::ByApplication, "route revoked", "en-US")?;
            return Ok(());
        }

        // Keep the pre-lookup admission registered until the connection lease
        // (which owns a disconnect handle) is visible in the same registry.
        // Route deletion therefore catches one of the two entries throughout
        // the auth-to-channel transition.
        let connection_lease = self.state.sessions.register(
            route.route_username.clone(),
            SessionKind::NativeSsh,
            Some(session.handle()),
        );
        if admission.token().is_cancelled() || connection_lease.token().is_cancelled() {
            connection_lease.terminate();
            session.disconnect(Disconnect::ByApplication, "route revoked", "en-US")?;
            return Ok(());
        }
        self.connection_lease = Some(connection_lease);
        self.route_admission = None;
        Ok(())
    }

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.connection_route_is_active() {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        if !self.channels.is_empty() {
            reply
                .reject(russh::ChannelOpenFailure::ResourceShortage)
                .await;
            return Ok(());
        }
        self.channels
            .insert(channel.id(), ChannelState::Pending { pty: None });
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let state = self
            .channels
            .get_mut(&channel)
            .ok_or_else(|| anyhow::anyhow!("channel {channel:?} not found"))?;
        match state {
            ChannelState::Pending { pty } => {
                *pty = Some(PtySpec {
                    term: term.to_owned(),
                    cols: col_width as u16,
                    rows: row_height as u16,
                });
                session.channel_success(channel)?;
            }
            ChannelState::Active(active) => {
                if let BridgeController::Pty(controller) = &active.controller {
                    controller.resize(col_width as u16, row_height as u16).await;
                    session.channel_success(channel)?;
                } else {
                    session.channel_failure(channel)?;
                }
            }
        }
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.connection_route_is_active() {
            session.channel_failure(channel)?;
            session.close(channel)?;
            return Ok(());
        }
        let route = self
            .route
            .clone()
            .ok_or_else(|| anyhow::anyhow!("route missing for shell request"))?;
        let pty = self.pty_for(channel);
        let handle = session.handle();
        let lease = self.state.sessions.register(
            route.route_username.clone(),
            SessionKind::NativeSsh,
            Some(handle.clone()),
        );
        let (controller, events) = spawn_pty_bridge(
            route,
            PtyBridgeOptions {
                term: pty.term,
                cols: pty.cols,
                rows: pty.rows,
                command: None,
            },
            lease.token(),
        )?;
        tokio::spawn(forward_bridge_events(handle, channel, events));
        self.channels.insert(
            channel,
            ChannelState::Active(ActiveBridge {
                controller: BridgeController::Pty(controller),
                _lease: lease,
            }),
        );
        session.channel_success(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.connection_route_is_active() {
            session.channel_failure(channel)?;
            session.close(channel)?;
            return Ok(());
        }
        let route = self
            .route
            .clone()
            .ok_or_else(|| anyhow::anyhow!("route missing for exec request"))?;
        let command = std::str::from_utf8(data)?.to_owned();
        let handle = session.handle();
        let lease = self.state.sessions.register(
            route.route_username.clone(),
            SessionKind::NativeSsh,
            Some(handle.clone()),
        );

        let active = if let Some(pty) = self.channels.get(&channel).and_then(|state| match state {
            ChannelState::Pending { pty } => pty.clone(),
            ChannelState::Active(_) => None,
        }) {
            let (controller, events) = spawn_pty_bridge(
                route,
                PtyBridgeOptions {
                    term: pty.term,
                    cols: pty.cols,
                    rows: pty.rows,
                    command: Some(command),
                },
                lease.token(),
            )?;
            tokio::spawn(forward_bridge_events(handle, channel, events));
            ActiveBridge {
                controller: BridgeController::Pty(controller),
                _lease: lease,
            }
        } else {
            let (controller, events) = spawn_exec_bridge(route, command, lease.token())?;
            tokio::spawn(forward_bridge_events(handle, channel, events));
            ActiveBridge {
                controller: BridgeController::Exec(controller),
                _lease: lease,
            }
        };

        self.channels.insert(channel, ChannelState::Active(active));
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(ChannelState::Active(active)) = self.channels.get(&channel) {
            match &active.controller {
                BridgeController::Exec(controller) => controller.send_input(data.to_vec()).await,
                BridgeController::Pty(controller) => controller.send_input(data.to_vec()).await,
            }
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(ChannelState::Active(active)) = self.channels.get(&channel) {
            match &active.controller {
                BridgeController::Exec(controller) => controller.send_eof().await,
                BridgeController::Pty(controller) => controller.send_eof().await,
            }
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(ChannelState::Active(active)) = self.channels.remove(&channel) {
            match active.controller {
                BridgeController::Exec(controller) => controller.terminate(),
                BridgeController::Pty(controller) => controller.terminate(),
            }
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(ChannelState::Active(active)) = self.channels.get(&channel)
            && let BridgeController::Pty(controller) = &active.controller
        {
            controller.resize(col_width as u16, row_height as u16).await;
        }
        Ok(())
    }

    async fn env_request(
        &mut self,
        _channel: ChannelId,
        _variable_name: &str,
        _variable_value: &str,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}

impl SshConnection {
    async fn load_route_with_admission(
        &self,
        username: &str,
    ) -> anyhow::Result<Option<(RouteRecord, SessionLease)>> {
        let admission =
            self.state
                .sessions
                .register(username.to_owned(), SessionKind::NativeSsh, None);
        let cancel = admission.token();
        let route = tokio::select! {
            _ = cancel.cancelled() => None,
            route = self.state.store.get_route(username) => route?,
        };
        let Some(route) = route else {
            return Ok(None);
        };
        if cancel.is_cancelled() || route.is_expired_at(time::OffsetDateTime::now_utc()) {
            return Ok(None);
        }
        Ok(Some((route, admission)))
    }

    fn clear_route_authorization(&mut self) {
        self.route = None;
        self.route_admission = None;
        self.connection_lease = None;
    }

    fn connection_route_is_active(&self) -> bool {
        self.route.as_ref().is_some_and(|route| {
            !route.is_expired_at(time::OffsetDateTime::now_utc())
                && self
                    .connection_lease
                    .as_ref()
                    .is_some_and(|lease| !lease.token().is_cancelled())
        })
    }

    fn pty_for(&self, channel: ChannelId) -> PtySpec {
        match self.channels.get(&channel) {
            Some(ChannelState::Pending { pty: Some(pty) }) => pty.clone(),
            _ => PtySpec {
                term: "xterm-256color".to_owned(),
                cols: 80,
                rows: 24,
            },
        }
    }
}

fn server_config() -> russh::server::Config {
    let mut config = russh::server::Config {
        server_id: russh::SshId::Standard("SSH-2.0-Stargate".into()),
        methods: MethodSet::from(&[MethodKind::PublicKey][..]),
        auth_rejection_time: Duration::from_millis(500),
        auth_rejection_time_initial: Some(Duration::from_millis(500)),
        max_auth_attempts: 3,
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 2,
        nodelay: true,
        ..Default::default()
    };
    config.preferred = Preferred {
        kex: Cow::Borrowed(&[kex::MLKEM768X25519_SHA256, kex::CURVE25519]),
        key: Cow::Borrowed(&[Algorithm::Ed25519]),
        cipher: Cow::Borrowed(&[cipher::CHACHA20_POLY1305, cipher::AES_256_GCM]),
        mac: Cow::Borrowed(&[mac::HMAC_SHA512_ETM, mac::HMAC_SHA256_ETM]),
        compression: Cow::Borrowed(&[compression::NONE]),
    };
    config
}

async fn forward_bridge_events(
    handle: server::Handle,
    channel: ChannelId,
    mut events: tokio::sync::mpsc::Receiver<BridgeEvent>,
) {
    while let Some(event) = events.recv().await {
        match event {
            BridgeEvent::Stdout(data) => {
                let _ = handle.data(channel, data).await;
            }
            BridgeEvent::Stderr(data) => {
                let _ = handle.extended_data(channel, 1, data).await;
            }
            BridgeEvent::Exit(exit_status) => {
                let _ = handle.exit_status_request(channel, exit_status).await;
                let _ = handle.close(channel).await;
                break;
            }
        }
    }
}
