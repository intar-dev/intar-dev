#![forbid(unsafe_code)]

mod bridge;
mod bundle;
mod config;
mod db;
mod jobs;
mod kino_release;
mod preflight;

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use clap::{Parser, Subcommand};
use intar_contracts::catalog::{ImageArchitecture, ImageKey};
use intar_image_build::{
    DirectBuildOutput, DirectBuildRequest, combine_scenario_manifests, ensure_base_rootfs,
    run_direct_build,
};
use intar_image_upload::{
    Error as ImageUploadError, ImageUploadConfig, ImageUploader, PublishArtifactFile,
    PublishBuildIdentity, PublishImageFile,
};
use tokio::sync::{mpsc, watch};
use tokio::time::{MissedTickBehavior, interval};
use tracing::{info, warn};

use crate::bridge::host_architecture;
use crate::bundle::{
    download_bundle_archive, inspect_bundle_build_input, unpack_bundle_archive,
    validate_bundle_rev, verify_bundle_for_build,
};

const FIRST_RETRY_DELAY_MS: i64 = 60_000;
const LATER_RETRY_DELAY_MS: i64 = 300_000;
const RUN_ONCE_PUBLISH_TOKEN_ENV: &str = "INTAR_REGISTRY_PUBLISH_TOKEN";

#[derive(Debug)]
struct NonRetryableBuildError {
    message: String,
}

impl fmt::Display for NonRetryableBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for NonRetryableBuildError {}

fn non_retryable_build_error(error: anyhow::Error) -> anyhow::Error {
    NonRetryableBuildError {
        message: format!("{error:#}"),
    }
    .into()
}

fn should_retry_build_error(error: &anyhow::Error, attempt: u32, max_attempts: u32) -> bool {
    error.downcast_ref::<NonRetryableBuildError>().is_none() && attempt < max_attempts
}

#[derive(Debug, Parser)]
#[command(name = "intar-builder")]
#[command(about = "Converge Intar image build jobs from bridge desired state")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Doctor(DoctorCommand),
    Run(RunCommand),
    RunOnce(RunOnceCommand),
}

#[derive(Debug, Parser)]
struct DoctorCommand {
    #[arg(long, value_name = "PATH")]
    config: PathBuf,
}

#[derive(Debug, Parser)]
struct RunCommand {
    #[arg(long, value_name = "PATH")]
    config: PathBuf,
}

#[derive(Debug, Parser)]
struct RunOnceCommand {
    #[arg(long, value_name = "PATH")]
    config: PathBuf,
    #[arg(long)]
    scenario: String,
    #[arg(
        long,
        value_name = "REV_OR_PATH",
        help = "Bundle revision to download, or path to a local bundle archive"
    )]
    bundle: String,
}

#[derive(Debug, Clone)]
struct BuildLogFile {
    title: String,
    path: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    match cli.command {
        Command::Doctor(args) => doctor(args),
        Command::Run(args) => run(args).await,
        Command::RunOnce(args) => run_once(args).await,
    }
}

fn doctor(args: DoctorCommand) -> Result<()> {
    let cfg = config::load(&args.config)?;
    let report = preflight::collect_preflight(&cfg);
    print_preflight_report(&report);
    if report.has_failures() {
        bail!(
            "builder host preflight failed with {} required failure(s)",
            report.failure_count()
        );
    }
    Ok(())
}

async fn run(args: RunCommand) -> Result<()> {
    let cfg = config::load(&args.config)?;
    validate_bridge_config(&cfg)?;
    if !cfg.bridge.enabled {
        bail!("intar-builder run requires bridge.enabled = true");
    }
    ensure_preflight_ready(&cfg, &args.config)?;
    let db = db::BuilderDb::open(&cfg.builder.state_db)?;
    let reset_jobs = db.reset_active_build_jobs(now_unix_ms())?;
    if reset_jobs > 0 {
        warn!(
            reset_jobs,
            "reset active builder jobs to queued after daemon startup"
        );
    }
    let (report_tx, report_rx) = mpsc::channel(128);
    let (desired_ready_tx, desired_ready_rx) = watch::channel(false);
    for worker_id in 0..cfg.jobs.max_concurrent_builds {
        let worker_cfg = cfg.clone();
        let worker_report_tx = report_tx.clone();
        let worker_desired_ready = desired_ready_rx.clone();
        tokio::spawn(async move {
            builder_worker_loop(
                worker_cfg,
                worker_report_tx,
                worker_desired_ready,
                worker_id,
            )
            .await;
        });
    }
    drop(report_tx);

    info!(
        host_id = %cfg.bridge.host_id,
        work_root = %cfg.builder.work_root.display(),
        cache_root = %cfg.builder.cache_root.display(),
        state_db = %cfg.builder.state_db.display(),
        workers = cfg.jobs.max_concurrent_builds,
        "builder daemon starting"
    );
    bridge::run(cfg, db, report_rx, desired_ready_tx).await
}

async fn run_once(args: RunOnceCommand) -> Result<()> {
    let cfg = config::load(&args.config)?;
    validate_job_config(&cfg)?;
    ensure_preflight_ready(&cfg, &args.config)?;
    // Validate and capture the operator credential before creating local job
    // state or spending time in QEMU. A malformed explicit token must fail
    // before the build starts, while an absent token keeps run-once local.
    let run_once_publish_token = optional_run_once_publish_token()?;
    validate_run_once_publish_target(&cfg, run_once_publish_token.as_deref())?;
    let build_config = cfg.qemu_build_config();
    let db = db::BuilderDb::open(&cfg.builder.state_db)?;
    let (bundle_archive, rev) = resolve_bundle_archive(&cfg, &args.bundle).await?;
    let bundle_root = unpacked_bundle_root(&cfg.builder.cache_root, &rev);
    if bundle_root.exists() {
        fs::remove_dir_all(&bundle_root)?;
    }
    unpack_bundle_archive(&bundle_archive, &bundle_root)?;
    let bundle_input =
        inspect_bundle_build_input(&bundle_root, &args.scenario, host_architecture(), &rev)?;
    let verification = verify_bundle_for_build(&bundle_root, &bundle_input.build)?;
    let kino = kino_release::resolve_kino_artifact(
        &cfg.builder,
        &bundle_input.build_tools.kino.version,
        &bundle_input.build.arch,
    )
    .await?;

    let now = now_unix_ms();
    db.upsert_build_job(&bundle_input.build, "building", 1, None, now)?;
    info!(
        scenario = %bundle_input.scenario.name,
        bundle = %bundle_archive.display(),
        rev = %bundle_input.build.rev,
        content_hash = %verification.content_hash,
        work_root = %cfg.builder.work_root.display(),
        qemu_binary = %build_config.qemu_binary.display(),
        mmdebstrap_binary = %build_config.mmdebstrap_binary.display(),
        kino_binary = %kino.binary_path.display(),
        "builder run-once starting direct image build"
    );

    let mut outputs = Vec::new();
    let mut log_files = Vec::new();
    let build_result = (|| -> Result<()> {
        for vm in &bundle_input.scenario.vms {
            log_files.extend(direct_build_log_files(
                &build_config,
                &bundle_input.scenario.name,
                &vm.name,
            ));

            let image = bundle_input
                .scenario
                .image_by_name(&vm.image)
                .ok_or_else(|| anyhow::anyhow!("image '{}' not found in scenario", vm.image))?;
            let base_image = bundle_input
                .base_catalog
                .base_image_by_name(&image.base)
                .ok_or_else(|| {
                    anyhow::anyhow!("base image '{}' not found in bundle", image.base)
                })?;
            let output = run_direct_build(&DirectBuildRequest {
                scenario_path: bundle_input.scenario_path.clone(),
                scenario: bundle_input.scenario.clone(),
                vm_name: vm.name.clone(),
                config: build_config.clone(),
                base_image: base_image.clone(),
                kino: kino.clone(),
            })?;
            info!(
                scenario = %output.rendered.scenario_name,
                vm = %output.rendered.vm.name,
                artifact = %output.artifact.raw_zstd_path.display(),
                sha256 = %output.artifact.image_sha256_hex,
                "builder run-once built VM image"
            );
            outputs.push(output);
        }
        Ok(())
    })();
    if let Err(error) = build_result {
        let error_message = format!("{error:#}");
        db.upsert_build_job(
            &bundle_input.build,
            "failed",
            1,
            Some(&error_message),
            now_unix_ms(),
        )?;
        upload_run_once_logs_after_failure(&cfg, &bundle_input.build.build_id, &log_files).await;
        return Err(error);
    }

    if let Some(access_token) = run_once_publish_token {
        db.upsert_build_job(&bundle_input.build, "publishing", 1, None, now_unix_ms())?;
        let publish_cfg = cfg.clone();
        let publish_token = access_token.clone();
        let publish_outputs = outputs.clone();
        let publish_build = bundle_input.build.clone();
        let publish_result = tokio::task::spawn_blocking(move || {
            publish_build_outputs(
                &publish_cfg,
                &publish_token,
                &publish_outputs,
                &publish_build,
            )
        })
        .await
        .context("run-once publish worker panicked")?;
        if let Err(error) = publish_result {
            let error_message = format!("{error:#}");
            db.upsert_build_job(
                &bundle_input.build,
                "failed",
                1,
                Some(&error_message),
                now_unix_ms(),
            )?;
            upload_run_once_logs_after_failure(&cfg, &bundle_input.build.build_id, &log_files)
                .await;
            return Err(error);
        }

        db.upsert_build_job(
            &bundle_input.build,
            "uploading_logs",
            1,
            None,
            now_unix_ms(),
        )?;
        let success_warning = match optional_builder_access_token(&cfg).await {
            Ok(Some(log_access_token)) => {
                if let Err(error) = upload_build_log(
                    &cfg,
                    &log_access_token,
                    &bundle_input.build.build_id,
                    &log_files,
                )
                .await
                {
                    warn!(
                        build_id = %bundle_input.build.build_id,
                        error = %error,
                        "image build published but build log upload failed"
                    );
                    Some(log_upload_warning(&error))
                } else {
                    None
                }
            }
            Ok(None) => None,
            Err(error) => {
                warn!(
                    build_id = %bundle_input.build.build_id,
                    error = %error,
                    "image build published but build log authentication failed"
                );
                Some(log_upload_warning(&error))
            }
        };

        db.upsert_build_job(
            &bundle_input.build,
            "succeeded",
            1,
            success_warning.as_deref(),
            now_unix_ms(),
        )?;
        return Ok(());
    } else {
        warn!(
            build_id = %bundle_input.build.build_id,
            env = RUN_ONCE_PUBLISH_TOKEN_ENV,
            "registry publish token is not configured; keeping run-once output local"
        );
    }

    db.upsert_build_job(&bundle_input.build, "succeeded", 1, None, now_unix_ms())?;
    Ok(())
}

fn optional_run_once_publish_token() -> Result<Option<String>> {
    match std::env::var(RUN_ONCE_PUBLISH_TOKEN_ENV) {
        Ok(value) => validate_run_once_publish_token(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            bail!("{RUN_ONCE_PUBLISH_TOKEN_ENV} must be valid UTF-8")
        }
    }
}

fn validate_run_once_publish_token(value: Option<String>) -> Result<Option<String>> {
    match value {
        Some(value) if value.trim().is_empty() => {
            bail!("{RUN_ONCE_PUBLISH_TOKEN_ENV} must not be empty")
        }
        value => Ok(value),
    }
}

fn validate_run_once_publish_target(
    cfg: &config::BuilderConfig,
    access_token: Option<&str>,
) -> Result<()> {
    if let Some(access_token) = access_token {
        image_uploader(cfg, access_token)?;
    }
    Ok(())
}

mod build_worker;
use build_worker::*;
fn validate_bridge_config(cfg: &config::BuilderConfig) -> Result<()> {
    validate_job_config(cfg)?;
    if cfg.bridge.enabled {
        if cfg.bridge.base_url.trim().is_empty() {
            bail!("bridge.base_url is required");
        }
        if cfg.bridge.host_id.trim().is_empty() {
            bail!("bridge.host_id is required");
        }
        if cfg.bridge.bootstrap_token.trim().is_empty() {
            bail!("bridge.bootstrap_token is required");
        }
    }
    Ok(())
}

fn validate_job_config(cfg: &config::BuilderConfig) -> Result<()> {
    if cfg.jobs.max_attempts == 0 {
        bail!("jobs.max_attempts must be greater than zero");
    }
    if cfg.jobs.max_concurrent_builds == 0 {
        bail!("jobs.max_concurrent_builds must be greater than zero");
    }
    if cfg.jobs.max_concurrent_builds != 1 {
        bail!("jobs.max_concurrent_builds greater than 1 is not supported yet");
    }
    Ok(())
}

fn ensure_preflight_ready(cfg: &config::BuilderConfig, config_path: &Path) -> Result<()> {
    let report = preflight::collect_preflight(cfg);
    warn_preflight_failures(&report);
    ensure_preflight_report_ready(&report, config_path)
}

fn ensure_preflight_report_ready(
    report: &preflight::PreflightReport,
    config_path: &Path,
) -> Result<()> {
    if !report.has_failures() {
        return Ok(());
    }

    bail!(
        "builder host preflight failed with {} required failure(s); run `intar-builder doctor --config {}` for details",
        report.failure_count(),
        config_path.display()
    )
}

fn warn_preflight_failures(report: &preflight::PreflightReport) {
    if !report.has_failures() {
        return;
    }

    for check in report
        .checks
        .iter()
        .filter(|check| check.status == preflight::PreflightStatus::Fail)
    {
        warn!(
            check = %check.name,
            detail = %check.detail,
            "builder host preflight failure"
        );
    }
}

fn print_preflight_report(report: &preflight::PreflightReport) {
    for check in &report.checks {
        let status = match check.status {
            preflight::PreflightStatus::Pass => "ok",
            preflight::PreflightStatus::Warn => "warn",
            preflight::PreflightStatus::Fail => "fail",
        };
        println!("[{status}] {}: {}", check.name, check.detail);
    }
}

async fn resolve_bundle_archive(
    cfg: &config::BuilderConfig,
    bundle_arg: &str,
) -> Result<(PathBuf, String)> {
    let bundle_path = PathBuf::from(bundle_arg);
    if bundle_path.is_file() {
        let rev = local_bundle_rev(&bundle_path)?;
        return Ok((bundle_path, rev));
    }

    validate_bridge_config(cfg)?;
    let access_token = bridge::bootstrap_builder_access_token(&cfg.bridge).await?;
    let archive = download_bundle_archive(
        &cfg.bridge.base_url,
        &access_token,
        bundle_arg,
        &cfg.builder.cache_root,
    )
    .await?;
    Ok((archive, bundle_arg.to_owned()))
}

async fn verify_bundle_or_drop_cached_archive(
    bundle_archive: &Path,
    bundle_root: &Path,
    desired_build: &intar_contracts::bridge::DesiredBuildV1,
) -> Result<()> {
    match verify_bundle_for_build(bundle_root, desired_build) {
        Ok(_) => Ok(()),
        Err(error) => {
            if let Err(remove_error) = tokio::fs::remove_file(bundle_archive).await
                && remove_error.kind() != std::io::ErrorKind::NotFound
            {
                warn!(
                    path = %bundle_archive.display(),
                    error = %remove_error,
                    "failed to remove cached bundle after verification failure"
                );
            }
            Err(error).with_context(|| {
                format!(
                    "cached bundle '{}' failed verification and will be refetched on retry",
                    bundle_archive.display()
                )
            })
        }
    }
}

fn unpacked_bundle_root(cache_root: &Path, rev: &str) -> PathBuf {
    cache_root.join("bundles-unpacked").join(rev)
}

fn local_bundle_rev(path: &Path) -> Result<String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            anyhow::anyhow!("bundle path '{}' has no UTF-8 file name", path.display())
        })?;
    let rev = file_name
        .strip_suffix(".tar.gz")
        .or_else(|| file_name.strip_suffix(".tgz"))
        .unwrap_or(file_name);
    if rev.is_empty() {
        bail!(
            "bundle path '{}' does not contain a revision",
            path.display()
        );
    }
    validate_bundle_rev(rev)
        .with_context(|| format!("bundle path '{}' has invalid revision", path.display()))?;
    Ok(rev.to_owned())
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn init_tracing() {
    let filter =
        std::env::var("RUST_LOG").unwrap_or_else(|_| "intar_builder=info,warn".to_string());
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
}

#[cfg(test)]
mod tests;
