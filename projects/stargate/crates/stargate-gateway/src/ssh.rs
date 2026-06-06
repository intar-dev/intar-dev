use std::{borrow::Cow, collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use anyhow::Context;
use russh::{
    ChannelId, CryptoVec, MethodKind, MethodSet, Preferred, cipher, compression, kex,
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
    bind: SocketAddr,
    host_key: russh::keys::PrivateKey,
) -> anyhow::Result<()> {
    let mut config = server_config();
    config.keys.push(host_key);
    let config = Arc::new(config);
    let mut server = SshProxyServer { state };
    server
        .run_on_address(config, bind)
        .await
        .with_context(|| format!("failed to bind public ssh listener on {bind}"))?;
    Ok(())
}

impl server::Server for SshProxyServer {
    type Handler = SshConnection;

    fn new_client(&mut self, peer_addr: Option<SocketAddr>) -> Self::Handler {
        SshConnection {
            state: self.state.clone(),
            peer_addr,
            route: None,
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
        let route = self.state.store.get_route(user).await?;
        let Some(route) = route else {
            return Ok(Auth::reject());
        };
        if !route.allows_client_public_key(public_key)? {
            return Ok(Auth::reject());
        }
        self.route = Some(route);
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        let route = match self.route.clone() {
            Some(route) => route,
            None => match self.state.store.get_route(user).await? {
                Some(route) => route,
                None => return Ok(Auth::reject()),
            },
        };
        if !route.allows_client_public_key(public_key)? {
            return Ok(Auth::reject());
        }
        self.route = Some(route);
        Ok(Auth::Accept)
    }

    async fn auth_succeeded(&mut self, _session: &mut Session) -> Result<(), Self::Error> {
        let _ = self.peer_addr;
        Ok(())
    }

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if !self.channels.is_empty() {
            return Ok(false);
        }
        self.channels
            .insert(channel.id(), ChannelState::Pending { pty: None });
        Ok(true)
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
                    controller.resize(col_width as u16, row_height as u16);
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
            &self.state.ssh_binary,
            &self.state.target_ssh_key_path,
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
                &self.state.ssh_binary,
                &self.state.target_ssh_key_path,
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
            let (controller, events) = spawn_exec_bridge(
                route,
                &self.state.ssh_binary,
                &self.state.target_ssh_key_path,
                command,
                lease.token(),
            )?;
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
                BridgeController::Exec(controller) => controller.send_input(data.to_vec()),
                BridgeController::Pty(controller) => controller.send_input(data.to_vec()),
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
                BridgeController::Exec(controller) => controller.send_eof(),
                BridgeController::Pty(controller) => controller.send_eof(),
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
            controller.resize(col_width as u16, row_height as u16);
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
        server_id: russh::SshId::Standard("SSH-2.0-Stargate".to_owned()),
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
    mut events: tokio::sync::mpsc::UnboundedReceiver<BridgeEvent>,
) {
    while let Some(event) = events.recv().await {
        match event {
            BridgeEvent::Stdout(data) => {
                let _ = handle.data(channel, CryptoVec::from(data)).await;
            }
            BridgeEvent::Stderr(data) => {
                let _ = handle
                    .extended_data(channel, 1, CryptoVec::from(data))
                    .await;
            }
            BridgeEvent::Exit(exit_status) => {
                let _ = handle.exit_status_request(channel, exit_status).await;
                let _ = handle.close(channel).await;
                break;
            }
        }
    }
}
