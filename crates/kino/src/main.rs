mod config;
mod host_keys;
mod http;
mod init;
mod lab_release;
mod probe;
mod proto;
mod ready_push;
mod recording;
mod run_cli;
mod run_cli_control;
mod run_cli_pending;
mod run_cli_wire;
mod scheduler;
mod startup;
mod state;

use anyhow::Context;
use clap::{Parser, Subcommand, ValueEnum};
use std::future::IntoFuture;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Parser)]
#[command(name = "kino")]
#[command(about = "Probe service and in-VM SSH recorder for ephemeral VM validation")]
struct Cli {
    #[command(subcommand)]
    command: Option<CliCommand>,
    #[arg(long, value_name = "PATH")]
    config: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ShellStartupModeArg {
    Login,
    Interactive,
}

impl From<ShellStartupModeArg> for recording::ShellStartupMode {
    fn from(value: ShellStartupModeArg) -> Self {
        match value {
            ShellStartupModeArg::Login => Self::Login,
            ShellStartupModeArg::Interactive => Self::Interactive,
        }
    }
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// The guest supervisor of guest contract 3.
    Init,
    RecordSsh {
        #[arg(long, value_name = "PATH")]
        config: Option<PathBuf>,
        #[command(flatten)]
        recording: RecordingArgs,
        #[arg(long, value_name = "COMMAND")]
        command: Option<String>,
        #[arg(long, value_enum, default_value_t = ShellStartupModeArg::Login)]
        shell_startup: ShellStartupModeArg,
    },
    RecordCommand {
        #[arg(long, value_name = "PATH")]
        config: Option<PathBuf>,
        #[command(flatten)]
        recording: RecordingArgs,
        #[arg(long, value_name = "COMMAND")]
        command: String,
    },
}

/// The recorder's settings. Guest contract 3 passes none and takes the
/// defaults; `--config` is the baked HCL file of the old guest.
#[derive(Debug, clap::Args)]
struct RecordingArgs {
    #[arg(long, default_value = "/var/lib/kino-recordings")]
    output_dir: PathBuf,
    #[arg(long, default_value = "/bin/bash")]
    real_shell: PathBuf,
}

impl RecordingArgs {
    fn resolve(self, config: Option<&std::path::Path>) -> anyhow::Result<config::RecordingConfig> {
        let Some(path) = config else {
            return Ok(config::RecordingConfig {
                output_dir: self.output_dir,
                real_shell: self.real_shell,
            });
        };
        config::load_from_file(path)
            .with_context(|| format!("failed to load config from {}", path.display()))?
            .recording
            .context("recording configuration is required for the recorders")
    }
}

/// What a login as `kino-shell` runs. The image's sshd forces this name on
/// every session of the learner, so it must record whatever was asked for.
#[derive(Debug, Eq, PartialEq)]
enum ShellSession {
    /// A recorded terminal, optionally running one command in it.
    Terminal(Option<String>),
    /// A recorded command without a terminal.
    Command(String),
}

/// `original` is `SSH_ORIGINAL_COMMAND`; `args` are the arguments after the
/// program name (a login shell is called as `-c <command>`).
fn shell_session(original: Option<String>, args: &[String], terminal: bool) -> ShellSession {
    let command = original
        .filter(|command| !command.is_empty())
        .or_else(|| match args {
            [flag, command, ..] if flag == "-c" => Some(command.clone()),
            _ => None,
        });
    match command {
        Some(command) if !terminal => ShellSession::Command(command),
        command => ShellSession::Terminal(command),
    }
}

fn run_kino_shell() -> anyhow::Result<i32> {
    use std::io::IsTerminal as _;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let terminal = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    // Guest contract 3 has no recorder config: the defaults are the contract.
    let recording = RecordingArgs {
        output_dir: PathBuf::from("/var/lib/kino-recordings"),
        real_shell: PathBuf::from("/bin/bash"),
    }
    .resolve(None)?;
    match shell_session(std::env::var("SSH_ORIGINAL_COMMAND").ok(), &args, terminal) {
        ShellSession::Terminal(command) => recording::record_ssh(
            &recording,
            command.as_deref(),
            recording::ShellStartupMode::Interactive,
        ),
        ShellSession::Command(command) => recording::record_command(&recording, &command),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let kino_started_at = Instant::now();

    let invoked_as = std::env::args_os().next().and_then(|argv0| {
        PathBuf::from(argv0)
            .file_name()
            .map(std::ffi::OsStr::to_owned)
    });
    if invoked_as.as_deref() == Some(std::ffi::OsStr::new("kino-shell")) {
        std::process::exit(run_kino_shell()?);
    }
    if std::env::args_os()
        .next()
        .is_some_and(|argv0| run_cli::invoked_as_intar(&argv0))
    {
        std::process::exit(run_cli::run_from_environment().await);
    }

    let cli = Cli::parse();

    match cli.command {
        Some(CliCommand::Init) => init::main().await,
        Some(CliCommand::RecordSsh {
            config,
            recording,
            command,
            shell_startup,
        }) => {
            let recording_config = recording.resolve(config.as_deref())?;
            let exit_code =
                recording::record_ssh(&recording_config, command.as_deref(), shell_startup.into())?;
            std::process::exit(exit_code);
        }
        Some(CliCommand::RecordCommand {
            config,
            recording,
            command,
        }) => {
            let recording_config = recording.resolve(config.as_deref())?;
            let exit_code = recording::record_command(&recording_config, &command)?;
            std::process::exit(exit_code);
        }
        None => {
            let config_path = cli
                .config
                .as_ref()
                .context("--config is required when running the probe service")?;
            let app_config = config::load_from_file(config_path)
                .with_context(|| format!("failed to load config from {}", config_path.display()))?;
            run_probe_service(app_config, kino_started_at).await
        }
    }
}

async fn run_probe_service(
    app_config: config::AppConfig,
    kino_started_at: Instant,
) -> anyhow::Result<()> {
    let built_probes = probe::build_probes(&app_config.probes)
        .await
        .context("failed to build probes")?;

    let shared_probes = built_probes
        .into_iter()
        .map(Arc::new)
        .collect::<Vec<Arc<probe::ProbeDefinition>>>();

    let store = state::ProbeStore::new(&shared_probes);
    let probe_executor = scheduler::ProbeExecutor::new(&shared_probes);
    let router = http::build_router(store.clone());
    let service_socket_path = match &app_config.server_bind {
        config::ServerBind::Unix(path) => Some(path.clone()),
        config::ServerBind::Tcp(_) | config::ServerBind::Vsock { .. } => None,
    };
    let server = match app_config.server_bind {
        config::ServerBind::Tcp(addr) => {
            let listener = tokio::net::TcpListener::bind(addr)
                .await
                .with_context(|| format!("failed to bind to {addr}"))?;

            eprintln!("kino listening on {addr}");
            axum::serve(listener, router).into_future()
        }
        config::ServerBind::Unix(path) => {
            #[cfg(unix)]
            {
                if let Some(parent) = path.parent()
                    && !parent.as_os_str().is_empty()
                {
                    tokio::fs::create_dir_all(parent).await.with_context(|| {
                        format!(
                            "failed to create parent directories for unix socket {}",
                            path.display()
                        )
                    })?;
                }

                match tokio::fs::remove_file(&path).await {
                    Ok(()) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(error).with_context(|| {
                            format!("failed to remove existing unix socket {}", path.display())
                        });
                    }
                }

                let listener = tokio::net::UnixListener::bind(&path)
                    .with_context(|| format!("failed to bind unix socket {}", path.display()))?;

                eprintln!("kino listening on unix socket {}", path.display());
                axum::serve(listener, router).into_future()
            }
            #[cfg(not(unix))]
            {
                anyhow::bail!(
                    "unix socket binding is not supported on this platform: {}",
                    path.display()
                );
            }
        }
        config::ServerBind::Vsock { cid, port } => {
            #[cfg(target_os = "linux")]
            {
                let listener =
                    tokio_vsock::VsockListener::bind(tokio_vsock::VsockAddr::new(cid, port))
                        .with_context(|| format!("failed to bind vsock://{cid}:{port}"))?;

                eprintln!("kino listening on vsock://{cid}:{port}");
                axum::serve(listener, router).into_future()
            }
            #[cfg(not(target_os = "linux"))]
            {
                anyhow::bail!("vsock binding is only supported on Linux: vsock://{cid}:{port}");
            }
        }
    };

    let control_socket = match run_cli_control::start(probe_executor.clone(), store.clone()).await {
        Ok(socket) => socket,
        Err(error) => {
            if let Some(path) = service_socket_path {
                let _ = tokio::fs::remove_file(path).await;
            }
            return Err(error).context("failed to start the Kino run CLI control socket");
        }
    };
    let ready_push_task = ready_push::spawn_ready_push_task(
        &store,
        ready_push::NativeReadyTimings::capture(kino_started_at),
    );
    let probe_tasks = scheduler::spawn_probe_tasks(shared_probes, &store, probe_executor);

    // Run the server as its own task, then give the runtime one turn so the
    // task reaches its first accept before the ACK goes out. The ACK therefore
    // means "this process accepts connections", not only "the socket exists".
    let mut server_task = tokio::spawn(server);
    tokio::task::yield_now().await;
    startup::publish_ready().context("failed to publish the Kino startup ACK")?;

    let server_result = tokio::select! {
        result = &mut server_task => Some(result),
        () = shutdown_signal() => None,
    };
    server_task.abort();

    for task in probe_tasks {
        task.abort();
    }
    if let Some(task) = ready_push_task {
        task.abort();
    }
    control_socket.shutdown().await;

    if let Some(result) = server_result {
        result
            .context("http server task stopped unexpectedly")?
            .context("http server terminated unexpectedly")?;
    }

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        let signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());

        if let Ok(mut stream) = signal {
            let _ = stream.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::run_probe_service;
    use super::{ShellSession, shell_session};

    #[test]
    fn kino_shell_records_every_kind_of_session() {
        let own = |text: &str| Some(text.to_owned());
        let args = |list: &[&str]| list.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
        // A plain login.
        assert_eq!(shell_session(None, &[], true), ShellSession::Terminal(None));
        assert_eq!(
            shell_session(own(""), &[], true),
            ShellSession::Terminal(None)
        );
        // `ssh host command`, with and without a terminal.
        assert_eq!(
            shell_session(own("ls"), &[], true),
            ShellSession::Terminal(own("ls"))
        );
        assert_eq!(
            shell_session(own("ls"), &[], false),
            ShellSession::Command("ls".to_owned())
        );
        // Called as a login shell.
        assert_eq!(
            shell_session(None, &args(&["-c", "id"]), false),
            ShellSession::Command("id".to_owned())
        );
        // The forced command wins over what the shell was called with.
        assert_eq!(
            shell_session(own("ls"), &args(&["-c", "id"]), false),
            ShellSession::Command("ls".to_owned())
        );
        // Without a terminal and without a command there is still a session.
        assert_eq!(
            shell_session(None, &[], false),
            ShellSession::Terminal(None)
        );
    }

    use crate::config::{AppConfig, ServerBind};
    use crate::ready_push::{ready_push_start_count, reset_ready_push_start_count};
    use std::net::TcpListener;
    use std::time::Instant;

    #[tokio::test]
    async fn service_bind_failure_does_not_start_readiness_push() {
        let occupied = TcpListener::bind("127.0.0.1:0").expect("reserve TCP port");
        let app_config = AppConfig {
            server_bind: ServerBind::Tcp(occupied.local_addr().expect("TCP address")),
            recording: None,
            probes: Vec::new(),
        };
        reset_ready_push_start_count();

        assert!(run_probe_service(app_config, Instant::now()).await.is_err());
        assert_eq!(ready_push_start_count(), 0);
    }
}
