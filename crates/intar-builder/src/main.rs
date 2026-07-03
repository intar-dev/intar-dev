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
use intar_image_upload::{ImageUploadConfig, ImageUploader, PublishArtifactFile, PublishImageFile};
use tokio::sync::mpsc;
use tokio::time::{MissedTickBehavior, interval};
use tracing::{info, warn};

use crate::bridge::host_architecture;
use crate::bundle::{
    download_bundle_archive, inspect_bundle_build_input, unpack_bundle_archive,
    validate_bundle_rev, verify_bundle_for_build,
};

const FIRST_RETRY_DELAY_MS: i64 = 60_000;
const LATER_RETRY_DELAY_MS: i64 = 300_000;

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
    for worker_id in 0..cfg.jobs.max_concurrent_builds {
        let worker_cfg = cfg.clone();
        let worker_report_tx = report_tx.clone();
        tokio::spawn(async move {
            builder_worker_loop(worker_cfg, worker_report_tx, worker_id).await;
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
    bridge::run(cfg, db, report_rx).await
}

async fn run_once(args: RunOnceCommand) -> Result<()> {
    let cfg = config::load(&args.config)?;
    validate_job_config(&cfg)?;
    ensure_preflight_ready(&cfg, &args.config)?;
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

    if let Some(access_token) = optional_builder_access_token(&cfg).await? {
        db.upsert_build_job(&bundle_input.build, "publishing", 1, None, now_unix_ms())?;
        let publish_cfg = cfg.clone();
        let publish_token = access_token.clone();
        let publish_outputs = outputs.clone();
        let publish_result = tokio::task::spawn_blocking(move || {
            publish_build_outputs(&publish_cfg, &publish_token, &publish_outputs)
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
            "bridge credentials are not configured; skipping run-once publish and log upload"
        );
    }

    db.upsert_build_job(&bundle_input.build, "succeeded", 1, None, now_unix_ms())?;
    Ok(())
}

async fn builder_worker_loop(
    cfg: config::BuilderConfig,
    report_tx: mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    worker_id: u16,
) {
    let mut tick = interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        match process_next_queued_build(&cfg, &report_tx).await {
            Ok(true) => {}
            Ok(false) => {}
            Err(error) => {
                warn!(worker_id, error = %error, "builder worker failed to process queued build");
            }
        }
    }
}

async fn process_next_queued_build(
    cfg: &config::BuilderConfig,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
) -> Result<bool> {
    let Some(job) = ({
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.claim_next_queued_build(now_unix_ms())?
    }) else {
        return Ok(false);
    };
    emit_build_report(cfg, report_tx, &job.build_id).await?;

    let result = run_claimed_build_job(cfg, &job, report_tx).await;
    if let Err(error) = result {
        let error_message = format!("{error:#}");
        let now = now_unix_ms();
        {
            let db = db::BuilderDb::open(&cfg.builder.state_db)?;
            if should_retry_build_error(&error, job.attempt, cfg.jobs.max_attempts) {
                let next_attempt_at_ms = now.saturating_add(retry_delay_ms(job.attempt));
                db.schedule_build_job_retry(
                    &job.build_id,
                    job.attempt,
                    &error_message,
                    next_attempt_at_ms,
                    now,
                )?;
                warn!(
                    build_id = %job.build_id,
                    attempt = job.attempt,
                    next_attempt_at_ms,
                    "scheduled builder job retry"
                );
            } else {
                db.update_build_job_phase(
                    &job.build_id,
                    "failed",
                    None,
                    job.attempt,
                    Some(&error_message),
                    now,
                )?;
            }
        }
        emit_build_report(cfg, report_tx, &job.build_id).await?;
        return Err(error);
    }

    Ok(true)
}

async fn run_claimed_build_job(
    cfg: &config::BuilderConfig,
    job: &db::BuildJobRow,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
) -> Result<()> {
    let desired_build = job.desired_build();
    let download_token = bridge::bootstrap_builder_access_token(&cfg.bridge)
        .await
        .context("failed to authenticate before bundle download")?;
    let bundle_archive = download_bundle_archive(
        &cfg.bridge.base_url,
        &download_token,
        &desired_build.rev,
        &cfg.builder.cache_root,
    )
    .await?;
    let bundle_root = unpacked_bundle_root(&cfg.builder.cache_root, &desired_build.rev);
    if bundle_root.exists() {
        fs::remove_dir_all(&bundle_root)
            .with_context(|| format!("failed to remove '{}'", bundle_root.display()))?;
    }
    unpack_bundle_archive(&bundle_archive, &bundle_root)?;
    if let Err(error) =
        verify_bundle_or_drop_cached_archive(&bundle_archive, &bundle_root, &desired_build).await
    {
        return Err(non_retryable_build_error(error));
    }
    let bundle_input = inspect_bundle_build_input(
        &bundle_root,
        &desired_build.scenario_id,
        desired_build.arch.clone(),
        &desired_build.rev,
    )?;
    let kino = kino_release::resolve_kino_artifact(
        &cfg.builder,
        &desired_build.kino_version,
        &desired_build.arch,
    )
    .await?;
    let build_config = cfg.qemu_build_config();

    let mut outputs = Vec::new();
    let mut log_files = Vec::new();
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
            .ok_or_else(|| anyhow::anyhow!("base image '{}' not found in bundle", image.base))?;

        {
            let db = db::BuilderDb::open(&cfg.builder.state_db)?;
            db.update_build_job_phase(
                &job.build_id,
                "building_base",
                Some(&vm.name),
                job.attempt,
                None,
                now_unix_ms(),
            )?;
        }
        emit_build_report(cfg, report_tx, &job.build_id).await?;
        let base_for_prepare = base_image.clone();
        let build_config_for_prepare = build_config.clone();
        tokio::task::spawn_blocking(move || {
            ensure_base_rootfs(&base_for_prepare, &build_config_for_prepare)
        })
        .await
        .context("base rootfs worker panicked")??;

        {
            let db = db::BuilderDb::open(&cfg.builder.state_db)?;
            db.update_build_job_phase(
                &job.build_id,
                "building",
                Some(&vm.name),
                job.attempt,
                None,
                now_unix_ms(),
            )?;
        }
        emit_build_report(cfg, report_tx, &job.build_id).await?;
        let request = DirectBuildRequest {
            scenario_path: bundle_input.scenario_path.clone(),
            scenario: bundle_input.scenario.clone(),
            vm_name: vm.name.clone(),
            config: build_config.clone(),
            base_image: base_image.clone(),
            kino: kino.clone(),
        };
        let output_result = tokio::task::spawn_blocking(move || run_direct_build(&request))
            .await
            .context("direct build worker panicked")?;
        let output = match output_result {
            Ok(output) => output,
            Err(error) => {
                upload_build_logs_with_fresh_token_best_effort(
                    cfg,
                    &job.build_id,
                    &log_files,
                    "direct build failure",
                )
                .await;
                return Err(error);
            }
        };
        info!(
            build_id = %job.build_id,
            scenario = %output.rendered.scenario_name,
            vm = %output.rendered.vm.name,
            artifact = %output.artifact.raw_zstd_path.display(),
            sha256 = %output.artifact.image_sha256_hex,
            "builder daemon built VM image"
        );
        outputs.push(output);
    }

    {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.update_build_job_phase(
            &job.build_id,
            "publishing",
            None,
            job.attempt,
            None,
            now_unix_ms(),
        )?;
    }
    emit_build_report(cfg, report_tx, &job.build_id).await?;
    let publish_token = bridge::bootstrap_builder_access_token(&cfg.bridge)
        .await
        .context("failed to authenticate before publishing image build")?;
    let publish_cfg = cfg.clone();
    let publish_outputs = outputs.clone();
    let publish_result = tokio::task::spawn_blocking(move || {
        publish_build_outputs(&publish_cfg, &publish_token, &publish_outputs)
    })
    .await
    .context("publish worker panicked")?;
    if let Err(error) = publish_result {
        upload_build_logs_with_fresh_token_best_effort(
            cfg,
            &job.build_id,
            &log_files,
            "publish failure",
        )
        .await;
        return Err(error);
    }

    {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.update_build_job_phase(
            &job.build_id,
            "uploading_logs",
            None,
            job.attempt,
            None,
            now_unix_ms(),
        )?;
    }
    emit_build_report(cfg, report_tx, &job.build_id).await?;
    let success_warning = match bridge::bootstrap_builder_access_token(&cfg.bridge).await {
        Ok(log_token) => {
            if let Err(error) = upload_build_log(cfg, &log_token, &job.build_id, &log_files).await {
                warn!(
                    build_id = %job.build_id,
                    error = %error,
                    "image build published but build log upload failed"
                );
                Some(log_upload_warning(&error))
            } else {
                None
            }
        }
        Err(error) => {
            warn!(
                build_id = %job.build_id,
                error = %error,
                "image build published but build log authentication failed"
            );
            Some(log_upload_warning(&error))
        }
    };

    {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.update_build_job_phase(
            &job.build_id,
            "succeeded",
            None,
            job.attempt,
            success_warning.as_deref(),
            now_unix_ms(),
        )?;
    }
    emit_build_report(cfg, report_tx, &job.build_id).await?;
    Ok(())
}

async fn emit_build_report(
    cfg: &config::BuilderConfig,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    build_id: &str,
) -> Result<()> {
    let report = {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.load_build_job(build_id)?
            .map(|row| bridge::build_report_from_job(&cfg.bridge.host_id, row))
    };
    if let Some(report) = report {
        report_tx
            .send(report)
            .await
            .context("failed to queue builder build report")?;
    }
    Ok(())
}

fn publish_build_outputs(
    cfg: &config::BuilderConfig,
    access_token: &str,
    outputs: &[DirectBuildOutput],
) -> Result<()> {
    let manifest =
        combine_scenario_manifests(outputs.iter().map(|output| &output.artifact.manifest))?;
    let images = outputs
        .iter()
        .map(|output| {
            let vm = output
                .artifact
                .manifest
                .vms
                .first()
                .ok_or_else(|| anyhow::anyhow!("direct build manifest has no vm"))?;
            PublishImageFile::new(
                &vm.name,
                &output.artifact.raw_zstd_path,
                image_filename(&vm.image_key),
            )
            .map_err(anyhow::Error::from)
        })
        .collect::<Result<Vec<_>>>()?;
    let artifacts = publish_artifacts_from_outputs(outputs)?;
    let publish_url = format!(
        "{}/registry/v1/publish",
        cfg.bridge.base_url.trim_end_matches('/')
    );
    let uploader = ImageUploader::new(ImageUploadConfig::new(publish_url, access_token))
        .map_err(anyhow::Error::from)?;
    let receipt = uploader
        .publish_manifest_with_artifacts(&manifest, &images, &artifacts)
        .map_err(anyhow::Error::from)?;
    info!(
        scenario = %receipt.scenario_id,
        images = receipt.images.len(),
        artifacts = receipt.artifacts.len(),
        "builder daemon published image build"
    );
    Ok(())
}

fn publish_artifacts_from_outputs(
    outputs: &[DirectBuildOutput],
) -> Result<Vec<PublishArtifactFile>> {
    let mut artifacts = BTreeMap::new();
    for output in outputs {
        artifacts.insert(
            output.artifact.kernel_sha256_hex.clone(),
            output.rendered.base_rootfs.paths.kernel_path.clone(),
        );
        artifacts.insert(
            output.artifact.initrd_sha256_hex.clone(),
            output.rendered.base_rootfs.paths.initrd_path.clone(),
        );
    }
    artifacts
        .into_iter()
        .map(|(sha256, path)| PublishArtifactFile::new(path, sha256).map_err(anyhow::Error::from))
        .collect()
}

async fn upload_build_log(
    cfg: &config::BuilderConfig,
    access_token: &str,
    build_id: &str,
    log_files: &[BuildLogFile],
) -> Result<()> {
    let mut log = String::new();
    for log_file in log_files {
        append_build_log_file(&mut log, &log_file.title, &log_file.path).await;
    }
    if log.is_empty() {
        log.push_str("builder completed without build log output\n");
    }

    let url = format!(
        "{}/agent/builds/{}/log",
        cfg.bridge.base_url.trim_end_matches('/'),
        build_id
    );
    let response = reqwest::Client::new()
        .put(&url)
        .bearer_auth(access_token.trim())
        .header("content-type", "text/plain; charset=utf-8")
        .body(log)
        .send()
        .await
        .with_context(|| format!("failed to upload build log to {url}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        bail!("build log upload failed with HTTP {status}: {body}");
    }
    Ok(())
}

async fn upload_build_logs_best_effort(
    cfg: &config::BuilderConfig,
    access_token: &str,
    build_id: &str,
    log_files: &[BuildLogFile],
    reason: &str,
) {
    if log_files.is_empty() {
        return;
    }
    if let Err(error) = upload_build_log(cfg, access_token, build_id, log_files).await {
        warn!(
            build_id,
            reason,
            error = %error,
            "failed to upload build logs after builder job error"
        );
    }
}

async fn upload_build_logs_with_fresh_token_best_effort(
    cfg: &config::BuilderConfig,
    build_id: &str,
    log_files: &[BuildLogFile],
    reason: &str,
) {
    if log_files.is_empty() {
        return;
    }
    match bridge::bootstrap_builder_access_token(&cfg.bridge).await {
        Ok(access_token) => {
            upload_build_logs_best_effort(cfg, &access_token, build_id, log_files, reason).await;
        }
        Err(error) => {
            warn!(
                build_id,
                reason,
                error = %error,
                "failed to authenticate before uploading builder job logs"
            );
        }
    }
}

fn direct_build_log_files(
    config: &intar_image_build::QemuBuildConfig,
    scenario_name: &str,
    vm_name: &str,
) -> Vec<BuildLogFile> {
    let work_root = config
        .work_root
        .join("qemu")
        .join(scenario_name)
        .join(vm_name);
    vec![
        BuildLogFile {
            title: format!("{scenario_name}:{vm_name} build log"),
            path: work_root.join("build.log"),
        },
        BuildLogFile {
            title: format!("{scenario_name}:{vm_name} serial log"),
            path: work_root.join("serial.log"),
        },
    ]
}

async fn append_build_log_file(log: &mut String, title: &str, path: &Path) {
    log.push_str(&format!("== {title} ==\n"));
    match tokio::fs::read_to_string(path).await {
        Ok(content) => log.push_str(&content),
        Err(error) => {
            log.push_str(&format!(
                "failed to read build log '{}': {error}\n",
                path.display()
            ));
        }
    }
    log.push('\n');
}

fn image_filename(image_key: &ImageKey) -> String {
    format!(
        "{}-{}-{}.raw.zst",
        image_key.scenario,
        image_key.vm,
        image_arch_slug(&image_key.arch)
    )
}

fn image_arch_slug(arch: &ImageArchitecture) -> &'static str {
    match arch {
        ImageArchitecture::X86_64 => "x86_64",
        ImageArchitecture::Aarch64 => "aarch64",
    }
}

fn retry_delay_ms(attempt: u32) -> i64 {
    if attempt <= 1 {
        FIRST_RETRY_DELAY_MS
    } else {
        LATER_RETRY_DELAY_MS
    }
}

fn log_upload_warning(error: &anyhow::Error) -> String {
    format!("image published, but build log upload failed: {error:#}")
}

async fn upload_run_once_logs_after_failure(
    cfg: &config::BuilderConfig,
    build_id: &str,
    log_files: &[BuildLogFile],
) {
    match optional_builder_access_token(cfg).await {
        Ok(Some(access_token)) => {
            upload_build_logs_best_effort(
                cfg,
                &access_token,
                build_id,
                log_files,
                "run-once build failure",
            )
            .await;
        }
        Ok(None) => {}
        Err(error) => {
            warn!(
                build_id,
                error = %error,
                "failed to authenticate for run-once failure log upload"
            );
        }
    }
}

async fn optional_builder_access_token(cfg: &config::BuilderConfig) -> Result<Option<String>> {
    if !cfg.bridge.enabled {
        return Ok(None);
    }

    let has_bridge_credentials = !cfg.bridge.base_url.trim().is_empty()
        || !cfg.bridge.host_id.trim().is_empty()
        || !cfg.bridge.bootstrap_token.trim().is_empty();
    if !has_bridge_credentials {
        return Ok(None);
    }

    validate_bridge_config(cfg)?;
    bridge::bootstrap_builder_access_token(&cfg.bridge)
        .await
        .map(Some)
}

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
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::Path;

    use super::{
        bridge, config, db, ensure_preflight_report_ready, local_bundle_rev, log_upload_warning,
        non_retryable_build_error, preflight, should_retry_build_error, validate_job_config,
        verify_bundle_or_drop_cached_archive,
    };

    #[test]
    fn derives_local_bundle_rev_from_archive_name() {
        assert_eq!(
            local_bundle_rev(Path::new("/tmp/abc123.tar.gz")).unwrap(),
            "abc123"
        );
        assert_eq!(
            local_bundle_rev(Path::new("/tmp/abc123.tgz")).unwrap(),
            "abc123"
        );
        assert_eq!(
            local_bundle_rev(Path::new("/tmp/abc123")).unwrap(),
            "abc123"
        );
    }

    #[test]
    fn rejects_unsafe_local_bundle_rev() {
        let error = local_bundle_rev(Path::new("/tmp/bad rev.tar.gz")).unwrap_err();
        assert!(format!("{error:#}").contains("invalid bundle rev"));
    }

    #[test]
    fn rejects_parallel_builder_workers_until_build_paths_are_isolated() {
        let mut cfg = config::BuilderConfig::default();
        cfg.jobs.max_concurrent_builds = 2;

        let error = validate_job_config(&cfg).unwrap_err();

        assert!(format!("{error:#}").contains("not supported yet"));
    }

    #[test]
    fn preflight_error_points_to_doctor_command() {
        let report = preflight::PreflightReport {
            checks: vec![
                preflight::PreflightCheck {
                    name: "kvm device".to_string(),
                    status: preflight::PreflightStatus::Fail,
                    detail: "'/dev/kvm' is missing".to_string(),
                },
                preflight::PreflightCheck {
                    name: "vhost-vsock device".to_string(),
                    status: preflight::PreflightStatus::Warn,
                    detail: "'/dev/vhost-vsock' is missing".to_string(),
                },
            ],
        };

        let error =
            ensure_preflight_report_ready(&report, Path::new("/etc/intar-builder/config.toml"))
                .unwrap_err();
        let message = format!("{error:#}");

        assert!(message.contains("1 required failure"));
        assert!(message.contains("intar-builder doctor --config /etc/intar-builder/config.toml"));
    }

    #[test]
    fn preflight_warnings_do_not_block_builder_commands() {
        let report = preflight::PreflightReport {
            checks: vec![preflight::PreflightCheck {
                name: "vhost-vsock device".to_string(),
                status: preflight::PreflightStatus::Warn,
                detail: "'/dev/vhost-vsock' is missing".to_string(),
            }],
        };

        ensure_preflight_report_ready(&report, Path::new("/etc/intar-builder/config.toml"))
            .unwrap();
    }

    #[test]
    fn verified_bad_bundle_errors_do_not_retry() {
        let retryable = anyhow::anyhow!("transient qemu failure");
        assert!(should_retry_build_error(&retryable, 1, 3));
        assert!(!should_retry_build_error(&retryable, 3, 3));

        let non_retryable =
            non_retryable_build_error(anyhow::anyhow!("desired build content hash mismatch"));

        assert!(!should_retry_build_error(&non_retryable, 1, 3));
        assert!(format!("{non_retryable:#}").contains("content hash mismatch"));
    }

    #[tokio::test]
    async fn drops_cached_bundle_after_verification_failure() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("abc123.tar.gz");
        std::fs::write(&archive, b"valid-enough-cache-key").unwrap();
        let bundle_root = temp.path().join("unpacked");
        std::fs::create_dir_all(&bundle_root).unwrap();
        let build = intar_contracts::bridge::DesiredBuildV1 {
            build_id: "build-1".to_string(),
            scenario_id: "broken-nginx".to_string(),
            arch: intar_contracts::catalog::ImageArchitecture::X86_64,
            rev: "abc123".to_string(),
            content_hash: "f".repeat(64),
            bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
            kino_version: "0.1.24".to_string(),
        };

        let error = verify_bundle_or_drop_cached_archive(&archive, &bundle_root, &build)
            .await
            .unwrap_err();

        assert!(format!("{error:#}").contains("will be refetched on retry"));
        assert!(!archive.exists());
    }

    #[test]
    fn log_upload_warning_keeps_published_build_successful() {
        let warning = log_upload_warning(&anyhow::anyhow!("HTTP 503"));

        assert_eq!(
            warning,
            "image published, but build log upload failed: HTTP 503"
        );
    }

    #[test]
    fn successful_build_report_can_include_log_upload_warning() {
        let db = db::BuilderDb::open_in_memory().unwrap();
        let build = intar_contracts::bridge::DesiredBuildV1 {
            build_id: "build-1".to_string(),
            scenario_id: "broken-nginx".to_string(),
            arch: intar_contracts::catalog::ImageArchitecture::X86_64,
            rev: "abc123".to_string(),
            content_hash: "f".repeat(64),
            bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
            kino_version: "0.1.24".to_string(),
        };
        db.upsert_build_job(&build, "uploading_logs", 1, None, 1000)
            .unwrap();
        db.update_build_job_phase(
            "build-1",
            "succeeded",
            None,
            1,
            Some("image published, but build log upload failed: HTTP 503"),
            2000,
        )
        .unwrap();

        let row = db.load_build_job("build-1").unwrap().unwrap();
        let report = bridge::build_report_from_job("builder-1", row);

        assert_eq!(report.phase, intar_contracts::bridge::BuildPhase::Succeeded);
        assert_eq!(
            report.error.as_deref(),
            Some("image published, but build log upload failed: HTTP 503")
        );
        assert_eq!(report.finished_at_unix_ms, Some(2000));
    }
}
