#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::thread;

use anyhow::{Context as _, Result, bail};
use clap::{Parser, Subcommand};
use intar_workshop_builder::{
    KvmWorkshopBackend, WorkshopBuilderConfig, WorkshopExecutionBackend, WorkshopRegistryClient,
    cleanup_stale_staging_directories, load, preflight_runtime_bundle_signing,
    process_next_until_cancelled, run_forever_until_cancelled,
};
use tokio_util::sync::CancellationToken;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "intar-workshop-builder")]
#[command(about = "Build immutable Intar workshop checkpoints on a trusted KVM host")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate trusted binaries, KVM, work roots, and every configured image.
    Doctor(ConfigArgs),
    /// Poll the workshop registry and process publications until terminated.
    Run(ConfigArgs),
    /// Claim and process at most one publication, then exit.
    RunOnce(ConfigArgs),
}

#[derive(Debug, Parser)]
struct ConfigArgs {
    #[arg(long, value_name = "PATH")]
    config: PathBuf,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    init_tracing();
    match Cli::parse().command {
        Command::Doctor(args) => doctor(args),
        Command::Run(args) => run(args).await,
        Command::RunOnce(args) => run_once(args).await,
    }
}

fn doctor(args: ConfigArgs) -> Result<()> {
    let config = load(&args.config)?;
    KvmWorkshopBackend::preflight(&config.execution, true)?;
    KvmWorkshopBackend::preflight_bundle_work_root(&config.worker.work_root, true)?;
    preflight_runtime_bundle_signing(&config.worker)?;
    info!(
        images = config.execution.images.len(),
        work_root = %config.execution.work_root.display(),
        "workshop builder host preflight passed"
    );
    Ok(())
}

async fn run(args: ConfigArgs) -> Result<()> {
    let config = load(&args.config)?;
    prepare_run_host(&config)?;
    run_worker(config, WorkerMode::Forever).await
}

async fn run_once(args: ConfigArgs) -> Result<()> {
    let config = load(&args.config)?;
    prepare_run_host(&config)?;
    run_worker(config, WorkerMode::Once).await
}

fn prepare_run_host(config: &WorkshopBuilderConfig) -> Result<()> {
    // Preflight and stale cleanup happen before authentication and therefore
    // before a new publication can be claimed.
    KvmWorkshopBackend::preflight(&config.execution, true)?;
    KvmWorkshopBackend::preflight_bundle_work_root(&config.worker.work_root, true)?;
    preflight_runtime_bundle_signing(&config.worker)?;
    for root in [&config.execution.work_root, &config.worker.work_root] {
        let removed = cleanup_stale_staging_directories(root)?;
        if removed > 0 {
            info!(
                root = %root.display(),
                removed,
                "removed validated stale workshop staging directories"
            );
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum WorkerMode {
    Forever,
    Once,
}

async fn run_worker(config: WorkshopBuilderConfig, mode: WorkerMode) -> Result<()> {
    let cancellation = CancellationToken::new();
    let worker_cancellation = cancellation.clone();
    let thread = thread::Builder::new()
        .name("intar-workshop-worker".to_owned())
        .spawn(move || run_worker_thread(config, mode, worker_cancellation))
        .context("failed to start dedicated workshop builder worker")?;
    let mut joined = tokio::task::spawn_blocking(move || match thread.join() {
        Ok(result) => result,
        Err(_) => bail!("dedicated workshop builder worker panicked"),
    });

    tokio::select! {
        result = &mut joined => result.context("failed to join workshop builder worker")?,
        signal = shutdown_signal() => {
            let signal = signal;
            if signal.is_ok() {
                info!("workshop builder received shutdown signal; cancelling active work");
            }
            cancellation.cancel();
            let worker_result = (&mut joined)
                .await
                .context("failed to join workshop builder worker after shutdown")?;
            signal?;
            info!("workshop builder cleaned active state");
            worker_result
        }
    }
}

fn run_worker_thread(
    config: WorkshopBuilderConfig,
    mode: WorkerMode,
    cancellation: CancellationToken,
) -> Result<()> {
    // The outer process runtime remains dedicated to signal handling. This
    // separate multi-thread runtime owns registry I/O and the synchronous
    // QEMU/image lifecycle; blocking guest operations use `block_in_place`
    // without starving cancellation delivery.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("intar-workshop-runtime")
        .enable_all()
        .build()
        .context("failed to create dedicated workshop worker runtime")?;
    let mut backend =
        KvmWorkshopBackend::new_with_cancellation(config.execution.clone(), cancellation.clone());
    let result = runtime.block_on(async {
        let client = WorkshopRegistryClient::new(&config.registry)?;
        match mode {
            WorkerMode::Forever => {
                run_forever_until_cancelled(
                    &client,
                    &mut backend,
                    &config.worker,
                    cancellation.clone(),
                )
                .await
            }
            WorkerMode::Once => {
                let registry = tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Ok(()),
                    result = client.authenticate() => result?,
                };
                let outcome = match process_next_until_cancelled(
                    &registry,
                    &mut backend,
                    &config.worker,
                    &cancellation,
                )
                .await
                {
                    Ok(outcome) => outcome,
                    Err(_) if cancellation.is_cancelled() => {
                        backend.abort();
                        return Ok(());
                    }
                    Err(error) => return Err(error),
                };
                info!(?outcome, "workshop builder run-once completed");
                Ok(())
            }
        }
    });
    backend.abort();
    result
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .context("failed to register SIGTERM handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.context("failed to wait for SIGINT")?;
            }
            _ = terminate.recv() => {}
        }
        Ok(())
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .context("failed to wait for shutdown signal")
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}
