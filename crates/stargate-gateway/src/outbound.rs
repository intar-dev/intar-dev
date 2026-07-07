use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, bail};
use bytes::Bytes;
use std::borrow::Cow;

use russh::{
    ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect, Preferred,
    client::{self, Msg},
    kex,
    keys::{PrivateKeyWithHashAlg, ssh_key::PublicKey},
};
use stargate_core::RouteRecord;
use tokio::sync::mpsc as tokio_mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub enum BridgeEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Exit(u32),
}

#[derive(Clone)]
pub struct ExecBridgeControl {
    tx: tokio_mpsc::UnboundedSender<BridgeInput>,
    cancel: CancellationToken,
}

#[derive(Clone)]
pub struct PtyBridgeControl {
    tx: tokio_mpsc::UnboundedSender<BridgeInput>,
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
) -> anyhow::Result<(
    ExecBridgeControl,
    tokio_mpsc::UnboundedReceiver<BridgeEvent>,
)> {
    let target = PreparedSshTarget::new(&route)?;
    let (events_tx, events_rx) = tokio_mpsc::unbounded_channel();
    let (input_tx, input_rx) = tokio_mpsc::unbounded_channel();

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
) -> anyhow::Result<(PtyBridgeControl, tokio_mpsc::UnboundedReceiver<BridgeEvent>)> {
    let target = PreparedSshTarget::new(&route)?;
    let (events_tx, events_rx) = tokio_mpsc::unbounded_channel();
    let (input_tx, input_rx) = tokio_mpsc::unbounded_channel();

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
    pub fn send_input(&self, data: Vec<u8>) {
        let _ = self.tx.send(BridgeInput::Data(data));
    }

    pub fn send_eof(&self) {
        let _ = self.tx.send(BridgeInput::Eof);
    }

    pub fn terminate(&self) {
        self.cancel.cancel();
    }
}

impl PtyBridgeControl {
    pub fn send_input(&self, data: Vec<u8>) {
        let _ = self.tx.send(BridgeInput::Data(data));
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.tx.send(BridgeInput::Resize { cols, rows });
    }

    pub fn send_eof(&self) {
        let _ = self.tx.send(BridgeInput::Eof);
    }

    pub fn terminate(&self) {
        self.cancel.cancel();
    }
}

struct PreparedSshTarget {
    addr: SocketAddr,
    expected_host_key: PublicKey,
    private_key: Arc<russh::keys::PrivateKey>,
}

impl PreparedSshTarget {
    fn new(route: &RouteRecord) -> anyhow::Result<Self> {
        let ip = route
            .target_ip
            .parse::<IpAddr>()
            .with_context(|| format!("target_ip '{}' is not a literal IP", route.target_ip))?;
        let expected_host_key = route.target_host_key().context("invalid target host key")?;
        let private_key = russh::keys::decode_secret_key(&route.target_private_key_openssh, None)
            .context("invalid target private key")?;

        Ok(Self {
            addr: SocketAddr::new(ip, route.target_port),
            expected_host_key,
            private_key: Arc::new(private_key),
        })
    }
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
        Ok(server_public_key == &self.expected)
    }
}

async fn run_bridge(
    route: RouteRecord,
    target: PreparedSshTarget,
    mode: BridgeMode,
    input_rx: tokio_mpsc::UnboundedReceiver<BridgeInput>,
    events_tx: tokio_mpsc::UnboundedSender<BridgeEvent>,
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
                let _ = events_tx.send(BridgeEvent::Stderr(
                    format!("stargate outbound ssh bridge failed: {error:#}\n").into_bytes(),
                ));
                255
            }
        };

    let _ = events_tx.send(BridgeEvent::Exit(exit_status));
}

async fn run_bridge_inner(
    route: RouteRecord,
    target: PreparedSshTarget,
    mode: BridgeMode,
    input_rx: tokio_mpsc::UnboundedReceiver<BridgeInput>,
    events_tx: &tokio_mpsc::UnboundedSender<BridgeEvent>,
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
    mut read_half: ChannelReadHalf,
    write_half: ChannelWriteHalf<Msg>,
    mut input_rx: tokio_mpsc::UnboundedReceiver<BridgeInput>,
    events_tx: &tokio_mpsc::UnboundedSender<BridgeEvent>,
    cancel: &CancellationToken,
) -> anyhow::Result<u32> {
    let mut exit_status = None;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = write_half.close().await;
                return Ok(255);
            }
            input = input_rx.recv() => {
                let Some(input) = input else {
                    let _ = write_half.close().await;
                    return Ok(exit_status.unwrap_or(0));
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
            message = read_half.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) => {
                        let _ = events_tx.send(BridgeEvent::Stdout(data.to_vec()));
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = events_tx.send(BridgeEvent::Stderr(data.to_vec()));
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
