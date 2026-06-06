use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        mpsc::{self, Sender},
    },
};

use anyhow::Context;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use stargate_core::RouteRecord;
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::mpsc as tokio_mpsc,
};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub enum BridgeEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Exit(u32),
}

#[derive(Clone)]
pub struct ExecBridgeControl {
    tx: tokio_mpsc::UnboundedSender<ExecInput>,
    cancel: CancellationToken,
    _guard: Arc<PreparedSshTarget>,
}

#[derive(Clone)]
pub struct PtyBridgeControl {
    tx: Sender<PtyInput>,
    cancel: CancellationToken,
    _guard: Arc<PreparedSshTarget>,
}

pub struct PtyBridgeOptions {
    pub term: String,
    pub cols: u16,
    pub rows: u16,
    pub command: Option<String>,
}

enum ExecInput {
    Data(Vec<u8>),
    Eof,
}

enum PtyInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Eof,
}

pub fn spawn_exec_bridge(
    route: RouteRecord,
    ssh_binary: &Path,
    target_ssh_key_path: &Path,
    command: String,
    cancel: CancellationToken,
) -> anyhow::Result<(
    ExecBridgeControl,
    tokio_mpsc::UnboundedReceiver<BridgeEvent>,
)> {
    let prepared = Arc::new(PreparedSshTarget::new(&route, target_ssh_key_path)?);
    let (events_tx, events_rx) = tokio_mpsc::unbounded_channel();
    let (input_tx, mut input_rx) = tokio_mpsc::unbounded_channel();

    let mut process = Command::new(ssh_binary);
    for arg in base_ssh_args(&route, &prepared, target_ssh_key_path, false) {
        process.arg(arg);
    }
    process.arg(command);
    process.stdin(std::process::Stdio::piped());
    process.stdout(std::process::Stdio::piped());
    process.stderr(std::process::Stdio::piped());

    let mut child = process.spawn().context("failed to spawn ssh")?;
    let mut stdin = child.stdin.take().context("ssh stdin missing")?;
    let mut stdout = child.stdout.take().context("ssh stdout missing")?;
    let mut stderr = child.stderr.take().context("ssh stderr missing")?;

    tokio::spawn(async move {
        while let Some(message) = input_rx.recv().await {
            match message {
                ExecInput::Data(data) => {
                    if stdin.write_all(&data).await.is_err() {
                        break;
                    }
                }
                ExecInput::Eof => {
                    let _ = stdin.shutdown().await;
                    break;
                }
            }
        }
    });

    let stdout_tx = events_tx.clone();
    tokio::spawn(async move {
        let mut buffer = [0_u8; 8192];
        loop {
            match stdout.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    let _ = stdout_tx.send(BridgeEvent::Stdout(buffer[..read].to_vec()));
                }
                Err(_) => break,
            }
        }
    });

    let stderr_tx = events_tx.clone();
    tokio::spawn(async move {
        let mut buffer = [0_u8; 8192];
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    let _ = stderr_tx.send(BridgeEvent::Stderr(buffer[..read].to_vec()));
                }
                Err(_) => break,
            }
        }
    });

    let cancel_wait = cancel.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = cancel_wait.cancelled() => {
                let _ = child.kill().await;
                let status = child.wait().await.ok();
                let code = status.and_then(|value| value.code()).unwrap_or(255) as u32;
                let _ = events_tx.send(BridgeEvent::Exit(code));
            }
            result = child.wait() => {
                let code = result.ok().and_then(|value| value.code()).unwrap_or(255) as u32;
                let _ = events_tx.send(BridgeEvent::Exit(code));
            }
        }
    });

    Ok((
        ExecBridgeControl {
            tx: input_tx,
            cancel,
            _guard: prepared,
        },
        events_rx,
    ))
}

pub fn spawn_pty_bridge(
    route: RouteRecord,
    ssh_binary: &Path,
    target_ssh_key_path: &Path,
    options: PtyBridgeOptions,
    cancel: CancellationToken,
) -> anyhow::Result<(PtyBridgeControl, tokio_mpsc::UnboundedReceiver<BridgeEvent>)> {
    let prepared = Arc::new(PreparedSshTarget::new(&route, target_ssh_key_path)?);
    let (events_tx, events_rx) = tokio_mpsc::unbounded_channel();
    let (control_tx, control_rx) = mpsc::channel();

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: options.rows,
        cols: options.cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut builder = CommandBuilder::new(ssh_binary);
    for arg in base_ssh_args(&route, &prepared, target_ssh_key_path, true) {
        builder.arg(arg);
    }
    if let Some(command) = options.command {
        builder.arg(command);
    }
    builder.env("TERM", &options.term);

    let mut child = pair.slave.spawn_command(builder)?;
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let killer = child.clone_killer();

    let reader_tx = events_tx.clone();
    tokio::task::spawn_blocking(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let _ = reader_tx.send(BridgeEvent::Stdout(buffer[..read].to_vec()));
                }
                Err(_) => break,
            }
        }
    });

    tokio::task::spawn_blocking(move || {
        let master = pair.master;
        while let Ok(message) = control_rx.recv() {
            match message {
                PtyInput::Data(data) => {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
                PtyInput::Resize { cols, rows } => {
                    let _ = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                PtyInput::Eof => break,
            }
        }
    });

    let wait_tx = events_tx.clone();
    tokio::task::spawn_blocking(move || {
        let status = child.wait().ok();
        let code = status.map(|value| value.exit_code()).unwrap_or(255);
        let _ = wait_tx.send(BridgeEvent::Exit(code));
    });

    let cancel_wait = cancel.clone();
    tokio::spawn(async move {
        let killer = killer;
        cancel_wait.cancelled().await;
        let _ = tokio::task::spawn_blocking(move || {
            let mut killer = killer;
            let _ = killer.kill();
        })
        .await;
    });

    Ok((
        PtyBridgeControl {
            tx: control_tx,
            cancel,
            _guard: prepared,
        },
        events_rx,
    ))
}

impl ExecBridgeControl {
    pub fn send_input(&self, data: Vec<u8>) {
        let _ = self.tx.send(ExecInput::Data(data));
    }

    pub fn send_eof(&self) {
        let _ = self.tx.send(ExecInput::Eof);
    }

    pub fn terminate(&self) {
        self.cancel.cancel();
    }
}

impl PtyBridgeControl {
    pub fn send_input(&self, data: Vec<u8>) {
        let _ = self.tx.send(PtyInput::Data(data));
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.tx.send(PtyInput::Resize { cols, rows });
    }

    pub fn send_eof(&self) {
        let _ = self.tx.send(PtyInput::Eof);
    }

    pub fn terminate(&self) {
        self.cancel.cancel();
    }
}

struct PreparedSshTarget {
    _temp_dir: TempDir,
    known_hosts_path: PathBuf,
}

impl PreparedSshTarget {
    fn new(route: &RouteRecord, target_ssh_key_path: &Path) -> anyhow::Result<Self> {
        let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
        let known_hosts_path = temp_dir.path().join("known_hosts");
        let metadata = std::fs::metadata(target_ssh_key_path)
            .with_context(|| format!("failed to stat {}", target_ssh_key_path.display()))?;
        if !metadata.is_file() {
            anyhow::bail!(
                "target ssh key {} is not a file",
                target_ssh_key_path.display()
            );
        }
        let host = if route.target_port == 22 {
            route.target_ip.clone()
        } else {
            format!("[{}]:{}", route.target_ip, route.target_port)
        };
        std::fs::write(
            &known_hosts_path,
            format!("{host} {}\n", route.target_host_key_openssh),
        )?;
        Ok(Self {
            _temp_dir: temp_dir,
            known_hosts_path,
        })
    }
}

fn base_ssh_args(
    route: &RouteRecord,
    prepared: &PreparedSshTarget,
    target_ssh_key_path: &Path,
    force_tty: bool,
) -> Vec<String> {
    let mut args = vec![
        "-F".to_owned(),
        "/dev/null".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        "IdentitiesOnly=yes".to_owned(),
        "-o".to_owned(),
        "StrictHostKeyChecking=yes".to_owned(),
        "-o".to_owned(),
        format!("UserKnownHostsFile={}", prepared.known_hosts_path.display()),
        "-o".to_owned(),
        "GlobalKnownHostsFile=/dev/null".to_owned(),
        "-o".to_owned(),
        "LogLevel=ERROR".to_owned(),
        "-i".to_owned(),
        target_ssh_key_path.display().to_string(),
        "-p".to_owned(),
        route.target_port.to_string(),
        "-l".to_owned(),
        route.target_username.clone(),
    ];
    args.push(if force_tty { "-tt" } else { "-T" }.to_owned());
    args.push(route.target_ip.clone());
    args
}
