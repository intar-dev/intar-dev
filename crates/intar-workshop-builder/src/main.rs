#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::thread;

use anyhow::{Context as _, Result, bail};
use clap::{Parser, Subcommand};
use intar_workshop_builder::{
    BuilderExecutionMode, DirectProviderOnlyBackend, KvmWorkshopBackend, WorkshopBuilderConfig,
    WorkshopExecutionBackend, WorkshopRegistryClient, cleanup_stale_staging_directories, load,
    preflight_runtime_bundle_signing, preflight_staging_root, prepare_authored_image,
    process_next_until_cancelled, run_forever_until_cancelled,
};
use tokio_util::sync::CancellationToken;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "intar-workshop-builder")]
#[command(about = "Build immutable Intar workshop checkpoint artifacts")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate the configured publication mode and its trusted inputs.
    Doctor(ConfigArgs),
    /// Poll the workshop registry and process publications until terminated.
    Run(ConfigArgs),
    /// Claim and process at most one publication, then exit.
    RunOnce(ConfigArgs),
    /// Build and atomically promote the configured authored workshop base.
    PrepareAuthoredImage(ConfigArgs),
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
        Command::PrepareAuthoredImage(args) => prepare_authored(args).await,
    }
}

fn doctor(args: ConfigArgs) -> Result<()> {
    let config = load(&args.config)?;
    match config.execution_mode {
        BuilderExecutionMode::AgentKvm => {
            KvmWorkshopBackend::preflight(&config.execution, true)?;
            KvmWorkshopBackend::preflight_bundle_work_root(&config.worker.work_root, true)?;
            preflight_runtime_bundle_signing(&config.worker)?;
            info!(
                execution_mode = "agent_kvm",
                images = config.execution.images.len(),
                work_root = %config.execution.work_root.display(),
                "workshop builder host preflight passed"
            );
        }
        BuilderExecutionMode::DirectProviderOnly => {
            preflight_staging_root(&config.worker.work_root, true)?;
            preflight_runtime_bundle_signing(&config.worker)?;
            info!(
                execution_mode = "direct_provider_only",
                work_root = %config.worker.work_root.display(),
                "workshop builder host preflight passed without local VM dependencies"
            );
        }
    }
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

async fn prepare_authored(args: ConfigArgs) -> Result<()> {
    let config = load(&args.config)?;
    if config.execution_mode != BuilderExecutionMode::AgentKvm {
        bail!("prepare-authored-image is unavailable in direct_provider_only execution mode");
    }
    let cancellation = CancellationToken::new();
    let worker_cancellation = cancellation.clone();
    let thread = thread::Builder::new()
        .name("intar-authored-image".to_owned())
        .spawn(move || prepare_authored_image(&config, worker_cancellation))
        .context("failed to start dedicated authored-image worker")?;
    let mut joined = tokio::task::spawn_blocking(move || match thread.join() {
        Ok(result) => result,
        Err(_) => bail!("dedicated authored-image worker panicked"),
    });

    tokio::select! {
        result = &mut joined => {
            let provenance = result
                .context("failed to join authored-image worker")??;
            info!(
                image = %provenance.image_name,
                workshop = %provenance.workshop_slug,
                disk_sha256 = %provenance.output_disk_sha256,
                "authored-image preparation completed"
            );
            Ok(())
        }
        signal = shutdown_signal() => {
            if signal.is_ok() {
                info!("authored-image preparation received shutdown signal; cancelling");
            }
            cancellation.cancel();
            let worker_result = (&mut joined)
                .await
                .context("failed to join authored-image worker after shutdown")?;
            signal?;
            worker_result?;
            Ok(())
        }
    }
}

fn prepare_run_host(config: &WorkshopBuilderConfig) -> Result<()> {
    // Preflight and stale cleanup happen before authentication and therefore
    // before a new publication can be claimed.
    let roots = match config.execution_mode {
        BuilderExecutionMode::AgentKvm => {
            KvmWorkshopBackend::preflight(&config.execution, true)?;
            KvmWorkshopBackend::preflight_bundle_work_root(&config.worker.work_root, true)?;
            preflight_runtime_bundle_signing(&config.worker)?;
            vec![&config.execution.work_root, &config.worker.work_root]
        }
        BuilderExecutionMode::DirectProviderOnly => {
            preflight_staging_root(&config.worker.work_root, true)?;
            preflight_runtime_bundle_signing(&config.worker)?;
            vec![&config.worker.work_root]
        }
    };
    for root in roots {
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
    // separate multi-thread runtime owns registry I/O and, in agent_kvm mode,
    // the synchronous QEMU/image lifecycle. Blocking operations use
    // `block_in_place` without starving cancellation delivery.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("intar-workshop-runtime")
        .enable_all()
        .build()
        .context("failed to create dedicated workshop worker runtime")?;
    match config.execution_mode {
        BuilderExecutionMode::AgentKvm => {
            let mut backend = KvmWorkshopBackend::new_with_cancellation(
                config.execution.clone(),
                cancellation.clone(),
            );
            let result =
                run_worker_with_backend(&runtime, &config, mode, &cancellation, &mut backend);
            backend.abort();
            result
        }
        BuilderExecutionMode::DirectProviderOnly => {
            let mut backend = DirectProviderOnlyBackend::new();
            let result =
                run_worker_with_backend(&runtime, &config, mode, &cancellation, &mut backend);
            backend.abort();
            result
        }
    }
}

fn run_worker_with_backend<B>(
    runtime: &tokio::runtime::Runtime,
    config: &WorkshopBuilderConfig,
    mode: WorkerMode,
    cancellation: &CancellationToken,
    backend: &mut B,
) -> Result<()>
where
    B: WorkshopExecutionBackend,
{
    runtime.block_on(async {
        let client = WorkshopRegistryClient::new_with_execution_mode(
            &config.registry,
            config.execution_mode,
        )?;
        match mode {
            WorkerMode::Forever => {
                run_forever_until_cancelled(&client, backend, &config.worker, cancellation.clone())
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
                    backend,
                    &config.worker,
                    cancellation,
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
    })
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
