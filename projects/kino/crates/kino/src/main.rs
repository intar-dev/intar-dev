mod config;
mod http;
mod probe;
mod proto;
mod recording;
mod scheduler;
mod state;

use anyhow::Context;
use clap::{Parser, Subcommand, ValueEnum};
use std::future::IntoFuture;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Parser)]
#[command(name = "kino")]
#[command(about = "Probe service and in-VM SSH recorder for ephemeral VM validation")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
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
enum Command {
    RecordSsh {
        #[arg(long, value_name = "PATH")]
        config: PathBuf,
        #[arg(long, value_name = "COMMAND")]
        command: Option<String>,
        #[arg(long, value_enum, default_value_t = ShellStartupModeArg::Login)]
        shell_startup: ShellStartupModeArg,
    },
    RecordCommand {
        #[arg(long, value_name = "PATH")]
        config: PathBuf,
        #[arg(long, value_name = "COMMAND")]
        command: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Some(Command::RecordSsh {
            config: config_path,
            command,
            shell_startup,
        }) => {
            let app_config = config::load_from_file(&config_path)
                .with_context(|| format!("failed to load config from {}", config_path.display()))?;
            let recording_config = app_config
                .recording
                .as_ref()
                .context("recording configuration is required for 'record-ssh'")?;
            let exit_code =
                recording::record_ssh(recording_config, command.as_deref(), shell_startup.into())?;
            std::process::exit(exit_code);
        }
        Some(Command::RecordCommand {
            config: config_path,
            command,
        }) => {
            let app_config = config::load_from_file(&config_path)
                .with_context(|| format!("failed to load config from {}", config_path.display()))?;
            let recording_config = app_config
                .recording
                .as_ref()
                .context("recording configuration is required for 'record-command'")?;
            let exit_code = recording::record_command(recording_config, &command)?;
            std::process::exit(exit_code);
        }
        None => {
            let config_path = cli
                .config
                .as_ref()
                .context("--config is required when running the probe service")?;
            let app_config = config::load_from_file(config_path)
                .with_context(|| format!("failed to load config from {}", config_path.display()))?;
            run_probe_service(app_config).await
        }
    }
}

async fn run_probe_service(app_config: config::AppConfig) -> anyhow::Result<()> {
    let built_probes = probe::build_probes(&app_config.probes)
        .await
        .context("failed to build probes")?;

    let shared_probes = built_probes
        .into_iter()
        .map(Arc::new)
        .collect::<Vec<Arc<probe::ProbeDefinition>>>();

    let store = state::ProbeStore::new(&shared_probes);
    let probe_tasks = scheduler::spawn_probe_tasks(shared_probes, &store);

    let router = http::build_router(store);
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

    tokio::pin!(server);

    let server_result = tokio::select! {
        result = &mut server => Some(result),
        () = shutdown_signal() => None,
    };

    for task in probe_tasks {
        task.abort();
    }

    if let Some(result) = server_result {
        result.context("http server terminated unexpectedly")?;
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
