//! One build: fetch the bundle, check it, build the image, push it, report.
//! The Worker owns retries: a failed build is reported failed, and a new
//! attempt arrives as a new desired build.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result, bail, ensure};
use flate2::read::GzDecoder;
use intar_contracts::bridge_v9::{BuildPhaseV2, BuildReportV2, BuildTargetV1, DesiredBuildV2};
use intar_contracts::oci::{IMAGE_FORMAT, OciDigest};
use intar_contracts::scenario::PLATFORM_BASE_IMAGE;
use intar_contracts::source::{MAX_SOURCE_BUNDLE_GZIP_BYTES, SourceBundleV2};
use intar_image_build::{
    BuildTarget, MachineBuildRequest, build_machine_image, plan_build, verify_machine_image,
};
use intar_image_upload::RegistryPusher;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
use tokio::sync::{mpsc, watch};
use tokio::time::{MissedTickBehavior, interval};
use tracing::{info, warn};

use crate::bridge::{bootstrap_builder_access_token, now_ms};
use crate::config::BuilderConfig;
use crate::db::{self, BuilderDb};

/// A decoded bundle may be this large; the gzip itself is capped by the
/// contract.
const MAX_BUNDLE_JSON_BYTES: u64 = 64 * 1024 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(300);
/// The most of each log a build uploads: its end, where a failure shows.
const LOG_UPLOAD_TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// Runs queued builds once the bridge applied a live desired state.
pub async fn worker_loop(
    cfg: BuilderConfig,
    reports: mpsc::Sender<BuildReportV2>,
    mut ready: watch::Receiver<u64>,
    worker_id: u16,
) {
    while *ready.borrow() == 0 {
        if ready.changed().await.is_err() {
            return;
        }
    }
    let mut poll = interval(Duration::from_secs(1));
    poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        loop {
            let claimed =
                BuilderDb::open(&cfg.builder.state_db).and_then(|mut db| db.claim_next(now_ms()));
            match claimed {
                Ok(Some(build)) => run_build(&cfg, &reports, &build).await,
                Ok(None) => break,
                Err(error) => {
                    warn!(worker_id, error = %format!("{error:#}"), "failed to claim a build");
                    break;
                }
            }
        }
        tokio::select! {
            changed = ready.changed() => if changed.is_err() { return },
            _ = poll.tick() => {}
        }
    }
}

async fn run_build(
    cfg: &BuilderConfig,
    reports: &mpsc::Sender<BuildReportV2>,
    build: &DesiredBuildV2,
) {
    let started = now_ms();
    info!(build_id = %build.build_id, attempt = build.attempt, key = %build.build_key.as_str(), "build starting");
    let (work_root, output_dir) = attempt_dirs(cfg, build);
    let result = build_and_push(cfg, reports, build, started, &work_root, &output_dir).await;
    let mut report = db::report(
        build,
        if result.is_ok() {
            BuildPhaseV2::Succeeded
        } else {
            BuildPhaseV2::Failed
        },
        now_ms(),
    );
    report.started_at_unix_ms = Some(started);
    report.finished_at_unix_ms = Some(report.observed_at_unix_ms);
    let error = match result {
        Ok(digest) => {
            info!(build_id = %build.build_id, image = %digest.as_str(), "build pushed");
            report.image_digest = Some(digest);
            None
        }
        Err(error) => {
            let message = format!("{error:#}");
            warn!(build_id = %build.build_id, error = %message, "build failed");
            report.error = Some(message.clone());
            Some(message)
        }
    };
    // A superseded attempt leaves the log and the report to the current one.
    if is_current(&cfg.builder.state_db, build) {
        upload_log(cfg, build, &work_root, error.as_deref()).await;
        publish(&cfg.builder.state_db, reports, report).await;
    }
    for path in [&work_root, &output_dir] {
        if let Err(error) = tokio::fs::remove_dir_all(path).await
            && error.kind() != std::io::ErrorKind::NotFound
        {
            warn!(path = %path.display(), error = %error, "failed to remove a build's files");
        }
    }
}

async fn build_and_push(
    cfg: &BuilderConfig,
    reports: &mpsc::Sender<BuildReportV2>,
    build: &DesiredBuildV2,
    started: i64,
    work_root: &Path,
    output_dir: &Path,
) -> Result<OciDigest> {
    let token = bootstrap_builder_access_token(&cfg.bridge).await?;
    let bundle = fetch_bundle(&cfg.bridge.base_url, &token, &build.bundle_rev).await?;
    let target = checked_target(&bundle, build)?;
    phase(cfg, reports, build, BuildPhaseV2::Building, started).await?;

    let mut config = cfg.qemu_build_config();
    config.work_root = work_root.to_owned();
    let request = MachineBuildRequest {
        bundle,
        target,
        expected_key: Some(build.build_key.clone()),
        config,
        output_dir: output_dir.to_owned(),
    };
    let output = tokio::task::spawn_blocking(move || build_machine_image(&request))
        .await
        .context("the build task panicked")??;
    let digest = output.image.manifest_digest;
    phase(cfg, reports, build, BuildPhaseV2::Pushing, started).await?;
    // A long build outlives its first token.
    let token = bootstrap_builder_access_token(&cfg.bridge).await?;
    push_verified(
        &cfg.bridge.base_url,
        &token,
        output_dir,
        &digest,
        &build.build_id,
    )
    .await?;
    Ok(digest)
}

/// Push the image in `dir` once it passes the checks a run host makes
/// before it boots one; an image that fails them is not pushed at all.
pub(crate) async fn push_verified(
    base_url: &str,
    token: &str,
    dir: &Path,
    digest: &OciDigest,
    build_id: &str,
) -> Result<()> {
    let (base_url, token, dir, digest, build_id) = (
        base_url.to_owned(),
        token.to_owned(),
        dir.to_owned(),
        digest.clone(),
        build_id.to_owned(),
    );
    tokio::task::spawn_blocking(move || {
        verify_machine_image(&dir, &digest).context("the built image fails verification")?;
        RegistryPusher::new(&base_url, &token)?
            .push_build(&dir, &digest, &build_id)
            .context("failed to push the image")
    })
    .await
    .context("the push task panicked")?
}

/// The work and output directories of this attempt of `build`: a new
/// attempt may start while an old one still runs.
pub(crate) fn attempt_dirs(cfg: &BuilderConfig, build: &DesiredBuildV2) -> (PathBuf, PathBuf) {
    let name = format!("{}.{}", build.build_id, build.attempt);
    (
        cfg.builder.work_root.join("builds").join(&name),
        cfg.builder.cache_root.join("outputs").join(name),
    )
}

/// Refuse a bundle of another image format, and a build whose key is not
/// the one the bundle builds: the Worker and this builder disagree about
/// the image, so building it would push the wrong thing.
pub(crate) fn checked_target(
    bundle: &SourceBundleV2,
    build: &DesiredBuildV2,
) -> Result<BuildTarget> {
    ensure!(
        bundle.image_format == IMAGE_FORMAT,
        "the bundle targets image format '{}'; this builder builds '{IMAGE_FORMAT}'",
        bundle.image_format
    );
    let target = match &build.target {
        BuildTargetV1::Image { name } if name == PLATFORM_BASE_IMAGE => BuildTarget::Base,
        BuildTargetV1::Image { name } => BuildTarget::Image(name.clone()),
        BuildTargetV1::Machine { scenario, machine } => BuildTarget::Machine {
            scenario: scenario.clone(),
            machine: machine.clone(),
        },
    };
    let plan = plan_build(bundle, &target, None)?;
    if plan.build_key != build.build_key {
        bail!(
            "desired build key mismatch for build '{}': the bundle builds {}, the desired build names {}",
            build.build_id,
            plan.build_key.as_str(),
            build.build_key.as_str()
        );
    }
    Ok(target)
}

/// GET the gzipped bundle of `rev`, within the contract's size cap.
async fn fetch_bundle(base_url: &str, token: &str, rev: &str) -> Result<SourceBundleV2> {
    let url = format!(
        "{}/agent/registry/bundles/{rev}",
        base_url.trim().trim_end_matches('/')
    );
    let response = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()?
        .get(&url)
        .bearer_auth(token.trim())
        .send()
        .await
        .with_context(|| format!("failed to fetch bundle {rev}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .context("failed to read the bundle")?;
    if !status.is_success() {
        bail!(
            "bundle {rev} fetch failed with HTTP {status}: {}",
            String::from_utf8_lossy(&bytes)
        );
    }
    decode_bundle(&bytes).with_context(|| format!("bundle {rev} is invalid"))
}

pub(crate) fn decode_bundle(gzipped: &[u8]) -> Result<SourceBundleV2> {
    ensure!(
        gzipped.len() <= MAX_SOURCE_BUNDLE_GZIP_BYTES,
        "the bundle is {} bytes gzipped, over the {MAX_SOURCE_BUNDLE_GZIP_BYTES} byte limit",
        gzipped.len()
    );
    let mut json = Vec::new();
    GzDecoder::new(gzipped)
        .take(MAX_BUNDLE_JSON_BYTES + 1)
        .read_to_end(&mut json)
        .context("the bundle is not gzip")?;
    ensure!(
        json.len() as u64 <= MAX_BUNDLE_JSON_BYTES,
        "the bundle expands beyond {MAX_BUNDLE_JSON_BYTES} bytes"
    );
    serde_json::from_slice(&json).context("the bundle is not a v2 bundle")
}

/// Record and send `phase`; a build that left the desired state stops.
async fn phase(
    cfg: &BuilderConfig,
    reports: &mpsc::Sender<BuildReportV2>,
    build: &DesiredBuildV2,
    phase: BuildPhaseV2,
    started: i64,
) -> Result<()> {
    let mut report = db::report(build, phase, now_ms());
    report.started_at_unix_ms = Some(started);
    if !publish(&cfg.builder.state_db, reports, report).await {
        bail!("build '{}' left the desired state", build.build_id);
    }
    Ok(())
}

/// Record `report` and hand it to the bridge; false when the build or this
/// attempt is no longer desired.
pub(crate) async fn publish(
    state_db: &Path,
    reports: &mpsc::Sender<BuildReportV2>,
    report: BuildReportV2,
) -> bool {
    match BuilderDb::open(state_db).and_then(|db| db.record(&report)) {
        Ok(true) => {
            // A closed channel only delays it: the bridge replays every report.
            let _ = reports.send(report).await;
            true
        }
        Ok(false) => false,
        Err(error) => {
            warn!(build_id = %report.build_id, error = %format!("{error:#}"), "failed to record a build report");
            false
        }
    }
}

pub(crate) fn is_current(state_db: &Path, build: &DesiredBuildV2) -> bool {
    BuilderDb::open(state_db)
        .and_then(|db| db.is_current(build))
        .unwrap_or_else(|error| {
            warn!(build_id = %build.build_id, error = %format!("{error:#}"), "failed to read the desired build");
            false
        })
}

/// PUT the end of the build and serial logs, best effort.
async fn upload_log(
    cfg: &BuilderConfig,
    build: &DesiredBuildV2,
    work_root: &Path,
    error: Option<&str>,
) {
    let log_path = intar_image_build::machine_build_log_path(work_root, &build.build_key);
    let serial_path = log_path.with_extension("serial.log");
    let mut log = String::new();
    if let Some(error) = error {
        log.push_str(&format!("== error ==\n{error}\n\n"));
    }
    for (title, path) in [("build log", &log_path), ("serial log", &serial_path)] {
        append_log(&mut log, title, path).await;
    }
    let result = async {
        let token = bootstrap_builder_access_token(&cfg.bridge).await?;
        let url = format!(
            "{}/agent/builds/{}/log",
            cfg.bridge.base_url.trim().trim_end_matches('/'),
            build.build_id
        );
        let response = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()?
            .put(&url)
            .bearer_auth(token.trim())
            .header("content-type", "text/plain; charset=utf-8")
            .body(log)
            .send()
            .await?;
        let status = response.status();
        ensure!(
            status.is_success(),
            "build log upload failed with HTTP {status}"
        );
        anyhow::Ok(())
    }
    .await;
    if let Err(error) = result {
        warn!(build_id = %build.build_id, error = %format!("{error:#}"), "failed to upload the build log");
    }
}

async fn append_log(log: &mut String, title: &str, path: &Path) {
    match read_log_tail(path, LOG_UPLOAD_TAIL_BYTES).await {
        Ok(content) => log.push_str(&format!("== {title} ==\n{content}\n")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log.push_str(&format!("== {title} ==\nunreadable: {error}\n")),
    }
}

/// The last `limit` bytes of `path` as text, any invalid UTF-8 replaced.
pub(crate) async fn read_log_tail(path: &Path, limit: u64) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let size = file.metadata().await?.len();
    let mut tail = Vec::new();
    if size > limit {
        file.seek(std::io::SeekFrom::Start(size - limit)).await?;
        tail.extend_from_slice(format!("[{} earlier bytes cut]\n", size - limit).as_bytes());
    }
    file.take(limit).read_to_end(&mut tail).await?;
    Ok(String::from_utf8_lossy(&tail).into_owned())
}

#[cfg(test)]
mod tests;
