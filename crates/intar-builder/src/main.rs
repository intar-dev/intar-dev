#![forbid(unsafe_code)]

mod bridge;
mod config;
mod db;
mod preflight;
mod source_compile;
mod worker;

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use clap::{Parser, Subcommand};
use tokio::sync::{mpsc, watch};
use tracing::{info, warn};

#[derive(Debug, Parser)]
#[command(name = "intar-builder")]
#[command(about = "Build and push the machine images the Worker asks for")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Doctor(ConfigArgs),
    Run(ConfigArgs),
    /// Compiles one repository snapshot; `run` starts it as a child process.
    #[command(hide = true)]
    CompileSource(source_compile::CompileSourceCommand),
}

#[derive(Debug, Parser)]
struct ConfigArgs {
    #[arg(long, value_name = "PATH")]
    config: PathBuf,
}

fn main() -> Result<()> {
    // A wake build re-runs this binary in fresh namespaces; that child owns
    // its own runtime, so it starts before ours.
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let [child, job] = args.as_slice()
        && child == intar_image_build::WAKE_CHILD_ARG
    {
        return intar_image_build::run_wake_child(Path::new(job));
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(daemon())
}

async fn daemon() -> Result<()> {
    let _telemetry = intar_observability::init(
        "intar-builder",
        env!("CARGO_PKG_VERSION"),
        "intar_builder=info,warn",
        true,
    )?;
    match Cli::parse().command {
        Command::Doctor(args) => doctor(&args.config),
        Command::Run(args) => run(&args.config).await,
        Command::CompileSource(args) => source_compile::compile_source(&args),
    }
}

fn doctor(config_path: &Path) -> Result<()> {
    let cfg = config::load(config_path)?;
    let report = preflight::collect_preflight(&cfg);
    for check in &report.checks {
        let status = match check.status {
            preflight::PreflightStatus::Pass => "ok",
            preflight::PreflightStatus::Warn => "warn",
            preflight::PreflightStatus::Fail => "fail",
        };
        println!("[{status}] {}: {}", check.name, check.detail);
    }
    if report.has_failures() {
        bail!(
            "builder host preflight failed with {} required failure(s)",
            report.failure_count()
        );
    }
    Ok(())
}

async fn run(config_path: &Path) -> Result<()> {
    let cfg = config::load(config_path)?;
    if !cfg.bridge.enabled {
        bail!("intar-builder run requires bridge.enabled = true");
    }
    let report = preflight::collect_preflight(&cfg);
    if report.has_failures() {
        for check in report
            .checks
            .iter()
            .filter(|check| check.status == preflight::PreflightStatus::Fail)
        {
            warn!(check = %check.name, detail = %check.detail, "builder host preflight failure");
        }
        bail!(
            "builder host preflight failed with {} required failure(s); run `intar-builder doctor --config {}` for details",
            report.failure_count(),
            config_path.display()
        );
    }
    let db = db::BuilderDb::open(&cfg.builder.state_db)?;
    let requeued = db.requeue_running(bridge::now_ms())?;
    if requeued > 0 {
        warn!(
            requeued,
            "requeued the builds a stopped builder left running"
        );
    }
    let (report_tx, report_rx) = mpsc::channel(128);
    let (ready_tx, ready_rx) = watch::channel(0_u64);
    for worker_id in 0..cfg.jobs.max_concurrent_builds {
        tokio::spawn(worker::worker_loop(
            cfg.clone(),
            report_tx.clone(),
            ready_rx.clone(),
            worker_id,
        ));
    }
    drop(report_tx);
    let (source_compiles_tx, source_compiles_rx) = watch::channel(Vec::new());
    tokio::spawn(source_compile::run_supervisor(
        cfg.bridge.clone(),
        cfg.builder.work_root.join("source-compile"),
        builder_binary()?,
        source_compiles_rx,
    ));
    info!(
        host_id = %cfg.bridge.host_id,
        work_root = %cfg.builder.work_root.display(),
        cache_root = %cfg.builder.cache_root.display(),
        workers = cfg.jobs.max_concurrent_builds,
        "builder daemon starting"
    );
    bridge::run(
        cfg,
        db,
        report_rx,
        bridge::DesiredStateSenders {
            ready: ready_tx,
            source_compiles: source_compiles_tx,
        },
    )
    .await
}

/// The running binary, so a compile child always matches the compile digest
/// this process advertises. On Linux `/proc/self/exe` still names it after an
/// upgrade replaced the file on disk.
fn builder_binary() -> Result<PathBuf> {
    if cfg!(target_os = "linux") {
        return Ok(PathBuf::from("/proc/self/exe"));
    }
    std::env::current_exe().context("failed to locate the intar-builder binary")
}
