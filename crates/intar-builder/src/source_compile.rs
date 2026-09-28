//! Compiles pull-mode repository snapshots in one killable child process.
//!
//! The supervisor runs at most one `compile-source` child at a time. It kills
//! the child after [`COMPILE_TIMEOUT`], or at once when the compile leaves the
//! desired state, and removes the snapshot and the unpacked tree only after
//! the child has exited. The child does all the parsing of tenant bytes, so a
//! parser crash ends only that compile.

use std::fs;
use std::io::{self, Read as _};
use std::ops::ControlFlow;
use std::path::{Component, Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow, bail};
use clap::Parser;
use flate2::read::GzDecoder;
use intar_contracts::bridge::{
    DesiredSourceCompileV1, SourceCompileErrorV1, SourceCompileFailureV1,
};
use intar_contracts::source::{
    AGENT_SOURCES_PATH, SOURCE_BUNDLE_FIELD, SOURCE_META_FIELD, SourceCompileErrorCode,
    SourceRefusalV1,
};
use intar_image_build::source_bundle::{
    IntarManifestV1, SourceCompileError, compile_source_tree, parse_intar_manifest,
};
use reqwest::StatusCode;
use reqwest::header::{CONTENT_TYPE, RETRY_AFTER};
use reqwest::multipart::{Form, Part};
use tokio::process::Command;
use tokio::sync::watch;
use tracing::{info, warn};

use crate::bridge::bootstrap_builder_access_token;
use crate::bundle::{agent_http_client, builder_arch};
use crate::config::BridgeConfig;

const COMPILE_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(3)
} else {
    Duration::from_secs(5 * 60)
};
const RETRY_DELAY: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_secs(10)
};
/// The maintenance fence answers 503 without `Retry-After`.
const UNAVAILABLE_RETRY_DELAY: Duration = Duration::from_secs(60);
/// The expanded size of the kept files, the source bundle's own cap.
const MAX_KEPT_BYTES: u64 = 4 * 1024 * 1024;
const MANIFEST_PATH: &str = "intar.yaml";
const GITMODULES_PATH: &str = ".gitmodules";
const SNAPSHOT_FILE: &str = "source.tar.gz";
const TREE_DIR: &str = "tree";
const META_FILE: &str = "meta.json";
const BUNDLE_FILE: &str = "bundle.tar.gz";
const ERRORS_FILE: &str = "errors.json";

/// The hidden child entry: unpacks one repository snapshot into `<out>/tree`
/// and compiles it. It writes `meta.json` and `bundle.tar.gz`, or the
/// refusal as `errors.json`, to `<out>`.
#[derive(Debug, Parser)]
pub(crate) struct CompileSourceCommand {
    #[arg(long, value_name = "PATH")]
    snapshot: PathBuf,
    #[arg(long, value_name = "DIR")]
    out: PathBuf,
    #[arg(long)]
    rev: String,
    #[arg(long)]
    arch: String,
}

pub(crate) fn compile_source(args: &CompileSourceCommand) -> Result<()> {
    let root = args.out.join(TREE_DIR);
    match unpack_snapshot(&args.snapshot, &root)
        .and_then(|()| compile_source_tree(&root, &args.rev, &args.arch))
    {
        Ok(compiled) => {
            fs::write(
                args.out.join(META_FILE),
                serde_json::to_vec(&compiled.meta)?,
            )
            .context("failed to write the bundle meta")?;
            fs::write(args.out.join(BUNDLE_FILE), &compiled.archive)
                .context("failed to write the bundle archive")?;
        }
        Err(error) => {
            // Diagnostics name repository paths, never this builder's.
            let root = root.display().to_string();
            let message = format!("{:#}", error.error)
                .replace(&format!("{root}/"), "")
                .replace(&root, ".");
            let errors = [SourceCompileErrorV1 {
                path: None,
                line: None,
                code: error.code,
                message,
            }];
            fs::write(args.out.join(ERRORS_FILE), serde_json::to_vec(&errors)?)
                .context("failed to write the compile errors")?;
        }
    }
    Ok(())
}

/// Unpacks `intar.yaml`, `.gitmodules` and the courses root of a GitHub
/// repository archive into `root`, below the archive's top-level directory.
fn unpack_snapshot(snapshot: &Path, root: &Path) -> Result<(), SourceCompileError> {
    let failed = |error| SourceCompileError {
        code: SourceCompileErrorCode::CompileFailed,
        error,
    };
    let manifest = read_snapshot_manifest(snapshot)?;
    let courses_root = Path::new(&manifest.courses_root);
    let mut kept_bytes = 0_u64;
    for_each_snapshot_entry(snapshot, |path, entry| {
        if path != Path::new(MANIFEST_PATH)
            && path != Path::new(GITMODULES_PATH)
            && !path.starts_with(courses_root)
        {
            return Ok(ControlFlow::Continue(()));
        }
        let output = root.join(path);
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            // An empty directory is how an archive shows a submodule, so
            // the compile must see every one.
            fs::create_dir_all(&output)
                .with_context(|| format!("failed to create '{}'", path.display()))
                .map_err(failed)?;
            return Ok(ControlFlow::Continue(()));
        }
        if !entry_type.is_file() {
            return Err(failed(anyhow!(
                "'{}' is a link or special file; only regular files are supported",
                path.display()
            )));
        }
        kept_bytes = kept_bytes.saturating_add(entry.size());
        if kept_bytes > MAX_KEPT_BYTES {
            return Err(SourceCompileError {
                code: SourceCompileErrorCode::BundleTooLarge,
                error: anyhow!(
                    "the course files expand beyond the {MAX_KEPT_BYTES} byte limit at '{}'",
                    path.display()
                ),
            });
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create '{}'", parent.display()))
                .map_err(failed)?;
        }
        fs::File::create(&output)
            .and_then(|mut file| io::copy(entry, &mut file))
            .with_context(|| format!("failed to unpack '{}'", path.display()))
            .map_err(failed)?;
        Ok(ControlFlow::Continue(()))
    })
}

/// Reads and checks `intar.yaml` before anything is unpacked, so the courses
/// root decides what the archive may write.
fn read_snapshot_manifest(snapshot: &Path) -> Result<IntarManifestV1, SourceCompileError> {
    let invalid = |error| SourceCompileError {
        code: SourceCompileErrorCode::ManifestInvalid,
        error,
    };
    let mut yaml = None;
    for_each_snapshot_entry(snapshot, |path, entry| {
        if path != Path::new(MANIFEST_PATH) {
            return Ok(ControlFlow::Continue(()));
        }
        if !entry.header().entry_type().is_file() {
            return Err(invalid(anyhow!("{MANIFEST_PATH} must be a regular file")));
        }
        let mut bytes = Vec::new();
        entry
            .take(MAX_KEPT_BYTES)
            .read_to_end(&mut bytes)
            .with_context(|| format!("failed to read {MANIFEST_PATH}"))
            .map_err(invalid)?;
        yaml = Some(bytes);
        Ok(ControlFlow::Break(()))
    })?;
    let yaml = yaml.ok_or_else(|| SourceCompileError {
        code: SourceCompileErrorCode::ManifestMissing,
        error: anyhow!("{MANIFEST_PATH} is missing from the repository root"),
    })?;
    let yaml = String::from_utf8(yaml)
        .map_err(|_| invalid(anyhow!("{MANIFEST_PATH} is not valid UTF-8")))?;
    parse_intar_manifest(&yaml)
}

type SnapshotEntry<'a> = tar::Entry<'a, GzDecoder<fs::File>>;

/// Visits each archive entry with its path below the top-level directory,
/// whatever that directory's name (`<owner>-<repo>-<sha>` on GitHub).
fn for_each_snapshot_entry(
    snapshot: &Path,
    mut visit: impl FnMut(&Path, &mut SnapshotEntry<'_>) -> Result<ControlFlow<()>, SourceCompileError>,
) -> Result<(), SourceCompileError> {
    let failed = |error| SourceCompileError {
        code: SourceCompileErrorCode::CompileFailed,
        error,
    };
    let file = fs::File::open(snapshot)
        .context("failed to open the repository snapshot")
        .map_err(failed)?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    for entry in archive
        .entries()
        .context("failed to read the repository snapshot")
        .map_err(failed)?
    {
        let mut entry = entry
            .context("failed to read the repository snapshot")
            .map_err(failed)?;
        let path = entry
            .path()
            .context("failed to read a repository snapshot path")
            .and_then(|path| repository_path(&path))
            .map_err(failed)?;
        // The top-level directory itself, and the `pax_global_header` that
        // GitHub's archives open with, have nothing below the top level.
        // Per-entry pax headers need no code: tar folds them into the entry.
        if path.as_os_str().is_empty() {
            continue;
        }
        if visit(&path, &mut entry)?.is_break() {
            break;
        }
    }
    Ok(())
}

fn repository_path(archive_path: &Path) -> Result<PathBuf> {
    let mut components = archive_path.components();
    if !matches!(components.next(), Some(Component::Normal(_))) {
        bail!(
            "archive entry '{}' is outside the repository directory",
            archive_path.display()
        );
    }
    let mut path = PathBuf::new();
    for component in components {
        match component {
            Component::Normal(part) => path.push(part),
            Component::CurDir => {}
            _ => bail!(
                "archive entry '{}' escapes the repository directory",
                archive_path.display()
            ),
        }
    }
    Ok(path)
}

/// Runs the desired compiles one at a time until the desired-state channel
/// closes. `program` is the builder binary; its `compile-source` subcommand
/// runs in `work_dir`, which holds nothing between compiles.
pub(crate) async fn run_supervisor(
    bridge: BridgeConfig,
    work_dir: PathBuf,
    program: PathBuf,
    mut desired: watch::Receiver<Vec<DesiredSourceCompileV1>>,
) {
    // Compiles that ended on this host; skipped while they stay desired.
    let mut finished: Vec<DesiredSourceCompileV1> = Vec::new();
    loop {
        let next = {
            let current = desired.borrow_and_update();
            finished.retain(|compile| current.contains(compile));
            current
                .iter()
                .find(|compile| !finished.contains(compile))
                .cloned()
        };
        let Some(compile) = next else {
            if desired.changed().await.is_err() {
                return;
            }
            continue;
        };
        let result = run_compile(&bridge, &work_dir, &program, &compile, &mut desired).await;
        if let Err(error) = tokio::fs::remove_dir_all(&work_dir).await
            && error.kind() != io::ErrorKind::NotFound
        {
            warn!(error = %error, "failed to remove the source compile directory");
        }
        match result {
            Ok(()) => finished.push(compile),
            Err(error) => {
                warn!(
                    compile_id = %compile.compile_id,
                    attempt = compile.attempt,
                    error = %format!("{error:#}"),
                    "source compile failed on this builder; retrying"
                );
                tokio::time::sleep(RETRY_DELAY).await;
            }
        }
    }
}

/// Fetches, compiles and reports one compile. It returns once the child has
/// exited, and early without a report when the compile leaves the desired
/// state.
async fn run_compile(
    bridge: &BridgeConfig,
    work_dir: &Path,
    program: &Path,
    compile: &DesiredSourceCompileV1,
    desired: &mut watch::Receiver<Vec<DesiredSourceCompileV1>>,
) -> Result<()> {
    if let Err(error) = tokio::fs::remove_dir_all(work_dir).await
        && error.kind() != io::ErrorKind::NotFound
    {
        return Err(error).context("failed to clear the source compile directory");
    }
    tokio::fs::create_dir_all(work_dir)
        .await
        .context("failed to create the source compile directory")?;
    let url = format!(
        "{}{AGENT_SOURCES_PATH}/{}",
        bridge.base_url.trim().trim_end_matches('/'),
        compile.compile_id
    );
    let snapshot_url = format!("{url}?attempt={}", compile.attempt);
    let result_url = format!("{url}/result?attempt={}", compile.attempt);
    let snapshot = work_dir.join(SNAPSHOT_FILE);
    tokio::select! {
        fetched = fetch_snapshot(bridge, &snapshot_url, &snapshot) => fetched?,
        () = left_desired_state(desired, compile) => return Ok(()),
    }

    let mut child = Command::new(program)
        .arg("compile-source")
        .arg("--snapshot")
        .arg(&snapshot)
        .arg("--out")
        .arg(work_dir)
        .arg(format!("--rev={}", compile.rev))
        .args(["--arch", builder_arch(&compile.arch)])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("failed to start '{}'", program.display()))?;
    let exit = tokio::select! {
        status = child.wait() => Some(status.context("failed to wait for the source compiler")?),
        () = tokio::time::sleep(COMPILE_TIMEOUT) => None,
        () = left_desired_state(desired, compile) => {
            child.kill().await.context("failed to kill the source compiler")?;
            info!(compile_id = %compile.compile_id, "killed a source compile that left the desired state");
            return Ok(());
        }
    };
    if exit.is_none() {
        child
            .kill()
            .await
            .context("failed to kill the source compiler")?;
    }
    let result = read_compile_result(work_dir, exit)?;
    tokio::select! {
        () = post_result(bridge, &result_url, compile, &result) => {}
        () = left_desired_state(desired, compile) => {}
    }
    Ok(())
}

/// Resolves once `compile` is no longer desired; never when the channel closes.
async fn left_desired_state(
    desired: &mut watch::Receiver<Vec<DesiredSourceCompileV1>>,
    compile: &DesiredSourceCompileV1,
) {
    while desired.borrow_and_update().contains(compile) {
        if desired.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

async fn fetch_snapshot(bridge: &BridgeConfig, url: &str, snapshot: &Path) -> Result<()> {
    let token = bootstrap_builder_access_token(bridge).await?;
    let response = agent_http_client()?
        .get(url)
        .bearer_auth(token.trim())
        .send()
        .await
        .context("failed to fetch the source snapshot")?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .context("failed to read the source snapshot")?;
    if !status.is_success() {
        bail!(
            "source snapshot fetch failed with status {status}: {}",
            String::from_utf8_lossy(&bytes)
        );
    }
    tokio::fs::write(snapshot, &bytes)
        .await
        .context("failed to write the source snapshot")
}

enum CompileResult {
    Compiled { meta: String, bundle: Vec<u8> },
    Failed(Vec<SourceCompileErrorV1>),
}

/// The child's result. A crash or the timeout is a compile failure, so the
/// Worker stops re-delivering the commit.
fn read_compile_result(work_dir: &Path, exit: Option<ExitStatus>) -> Result<CompileResult> {
    let failure = |message: String| {
        CompileResult::Failed(vec![SourceCompileErrorV1 {
            path: None,
            line: None,
            code: SourceCompileErrorCode::CompileFailed,
            message,
        }])
    };
    let Some(status) = exit else {
        return Ok(failure(format!(
            "the compile did not finish within {} seconds",
            COMPILE_TIMEOUT.as_secs()
        )));
    };
    if !status.success() {
        return Ok(failure(format!("the compiler stopped: {status}")));
    }
    match fs::read(work_dir.join(ERRORS_FILE)) {
        Ok(errors) => {
            return Ok(CompileResult::Failed(
                serde_json::from_slice(&errors).context("invalid compile errors")?,
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("failed to read the compile errors"),
    }
    Ok(CompileResult::Compiled {
        meta: fs::read_to_string(work_dir.join(META_FILE))
            .context("failed to read the bundle meta")?,
        bundle: fs::read(work_dir.join(BUNDLE_FILE)).context("failed to read the bundle")?,
    })
}

/// Posts until the Worker takes or refuses the result. A refusal, such as a
/// 409 `SourceRefusalV1` for a fenced attempt, is dropped.
async fn post_result(
    bridge: &BridgeConfig,
    url: &str,
    compile: &DesiredSourceCompileV1,
    result: &CompileResult,
) {
    loop {
        let delay = match send_result(bridge, url, compile, result).await {
            Ok(response) if response.status().is_success() => {
                info!(compile_id = %compile.compile_id, attempt = compile.attempt, "posted source compile result");
                return;
            }
            Ok(response) if response.status() == StatusCode::SERVICE_UNAVAILABLE => response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok()?.trim().parse().ok())
                .map_or(UNAVAILABLE_RETRY_DELAY, Duration::from_secs),
            Ok(response) if response.status().is_client_error() => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let refusal = serde_json::from_str::<SourceRefusalV1>(&body)
                    .map(|refusal| refusal.code)
                    .ok();
                warn!(
                    compile_id = %compile.compile_id,
                    attempt = compile.attempt,
                    %status,
                    ?refusal,
                    body = %body,
                    "the Worker refused the source compile result; dropping it"
                );
                return;
            }
            Ok(response) => {
                warn!(status = %response.status(), "source compile result post failed; retrying");
                RETRY_DELAY
            }
            Err(error) => {
                warn!(error = %format!("{error:#}"), "source compile result post failed; retrying");
                RETRY_DELAY
            }
        };
        tokio::time::sleep(delay).await;
    }
}

async fn send_result(
    bridge: &BridgeConfig,
    url: &str,
    compile: &DesiredSourceCompileV1,
    result: &CompileResult,
) -> Result<reqwest::Response> {
    let token = bootstrap_builder_access_token(bridge).await?;
    let request = agent_http_client()?.post(url).bearer_auth(token.trim());
    let request = match result {
        CompileResult::Compiled { meta, bundle } => {
            let mut form = Form::new().text(SOURCE_META_FIELD, meta.clone());
            if !compile.validate_only {
                // Known lengths, so the request carries a Content-Length.
                form = form.part(
                    SOURCE_BUNDLE_FIELD,
                    Part::bytes(bundle.clone())
                        .file_name(format!("{}.tar.gz", compile.rev))
                        .mime_str("application/gzip")?,
                );
            }
            request.multipart(form)
        }
        CompileResult::Failed(errors) => {
            request
                .header(CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(&SourceCompileFailureV1 {
                    compile_id: compile.compile_id.clone(),
                    attempt: compile.attempt,
                    errors: errors.clone(),
                })?)
        }
    };
    request
        .send()
        .await
        .context("failed to post the source compile result")
}

#[cfg(test)]
mod tests;
