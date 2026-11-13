//! The bundle upload: a `multipart/form-data` POST of the `meta` and
//! `bundle` fields with a bearer token, as `scenario-publish.yml` drives it.

use anyhow::{Context, Result, anyhow, bail};
use intar_contracts::source::{
    SOURCE_BUNDLE_FIELD, SOURCE_META_FIELD, SourceBundleMetaV2, SourceRefusalCode, SourceRefusalV1,
};
use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::time::Duration;

const DEFAULT_BUNDLE_OUTPUT_ROOT: &str = "dist/bundles";
/// The whole bundle request, the body upload included.
const BUNDLE_UPLOAD_TIMEOUT: Duration = Duration::from_secs(if cfg!(test) { 5 } else { 120 });
/// Exit codes of a failed upload that the scenario-publish workflow acts on.
/// Every other failure exits 1.
const EXIT_SUPERSEDED: u8 = 3;
const EXIT_COMPILER_OUTDATED: u8 = 4;
/// `EX_TEMPFAIL`: a transport error, a client timeout, a 429 or a 5xx.
const EXIT_TRANSIENT: u8 = 75;

/// Where an upload goes and the token it carries.
#[derive(Debug)]
pub(super) struct BundleUploadTarget {
    pub(super) url: String,
    token: String,
}

impl BundleUploadTarget {
    pub(super) fn new(url: &str, token: Option<&str>) -> Result<Self> {
        let url = url.trim();
        if url.is_empty() {
            bail!("bundle upload URL is empty");
        }
        let token = token.map(str::trim).unwrap_or_default();
        if token.is_empty() {
            bail!("a bundle upload needs --token");
        }
        Ok(Self {
            url: url.to_owned(),
            token: token.to_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct BundleUploadReceipt {
    pub(super) queued: u64,
    pub(super) assigned: usize,
}

/// A failed bundle upload and the exit code it ends the process with.
#[derive(Debug)]
struct UploadFailed {
    exit_code: u8,
    message: String,
}

impl fmt::Display for UploadFailed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

/// The process exit code for a failed command.
pub(super) fn exit_code(error: &anyhow::Error) -> u8 {
    error
        .downcast_ref::<UploadFailed>()
        .map_or(1, |failed| failed.exit_code)
}

fn transient(message: String) -> UploadFailed {
    UploadFailed {
        exit_code: EXIT_TRANSIENT,
        message,
    }
}

pub(super) fn default_bundle_rev() -> Result<String> {
    if let Ok(github_sha) = env::var("GITHUB_SHA") {
        let trimmed = github_sha.trim();
        if trimmed.len() >= 12 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(trimmed[..12].to_owned());
        }
    }

    let output = ProcessCommand::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .context("failed to execute `git rev-parse --short=12 HEAD`")?;
    if output.status.success() {
        let stdout = String::from_utf8(output.stdout).context("git emitted invalid UTF-8")?;
        let rev = stdout.trim();
        if !rev.is_empty() {
            return Ok(rev.to_owned());
        }
    }

    bail!("failed to determine bundle revision; pass --rev explicitly");
}

/// 1 to 128 of `[A-Za-z0-9._-]`, and not `.` or `..`: the rev names a file.
pub(super) fn validate_bundle_rev(rev: &str) -> Result<()> {
    let safe = (1..=128).contains(&rev.len())
        && rev != "."
        && rev != ".."
        && rev
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if !safe {
        bail!("invalid bundle rev '{rev}' (expected 1-128 safe slug characters)");
    }
    Ok(())
}

pub(super) fn default_bundle_output_path(rev: &str) -> PathBuf {
    Path::new(DEFAULT_BUNDLE_OUTPUT_ROOT).join(format!("{rev}.json.gz"))
}

pub(super) fn upload_bundle(
    target: &BundleUploadTarget,
    bundle_path: &Path,
    rev: &str,
) -> Result<BundleUploadReceipt> {
    // reqwest rejects a non-HTTP scheme only while it streams the body, where
    // it can surface as a transport error, so a bad target fails here with 1.
    let url = reqwest::Url::parse(&target.url)
        .with_context(|| format!("invalid bundle upload URL {}", target.url))?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("bundle upload URL {} must use http or https", target.url);
    }
    let meta = SourceBundleMetaV2 {
        rev: rev.to_owned(),
    };
    let part = reqwest::blocking::multipart::Part::file(bundle_path)
        .with_context(|| format!("failed to read bundle {}", bundle_path.display()))?
        .file_name(format!("{rev}.json.gz"))
        .mime_str("application/gzip")?;
    // Part::file has a known length, so reqwest sends a Content-Length.
    let form = reqwest::blocking::multipart::Form::new()
        .text(SOURCE_META_FIELD, serde_json::to_string(&meta)?)
        .part(SOURCE_BUNDLE_FIELD, part);

    let response = reqwest::blocking::Client::builder()
        .timeout(BUNDLE_UPLOAD_TIMEOUT)
        .build()?
        .post(url)
        .bearer_auth(&target.token)
        .multipart(form)
        .send()
        .map_err(|error| {
            let message = format!("failed to upload bundle to {}", target.url);
            // A builder error, such as a bad token header, fails the same on a retry.
            if error.is_builder() {
                anyhow::Error::new(error).context(message)
            } else {
                anyhow::Error::new(error).context(transient(message))
            }
        })?;
    let status = response.status();
    let body = response
        .text()
        .with_context(|| transient("failed to read bundle response".to_owned()))?;
    parse_bundle_upload_response(status, &body, rev)
}

pub(super) fn parse_bundle_upload_response(
    status: reqwest::StatusCode,
    body: &str,
    requested_rev: &str,
) -> Result<BundleUploadReceipt> {
    if status != reqwest::StatusCode::ACCEPTED {
        let exit_code =
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                EXIT_TRANSIENT
            } else if status == reqwest::StatusCode::CONFLICT {
                match serde_json::from_str::<SourceRefusalV1>(body).map(|refusal| refusal.code) {
                    Ok(SourceRefusalCode::Superseded) => EXIT_SUPERSEDED,
                    Ok(SourceRefusalCode::CompilerOutdated) => EXIT_COMPILER_OUTDATED,
                    _ => 1,
                }
            } else {
                1
            };
        return Err(anyhow!(UploadFailed {
            exit_code,
            message: format!("bundle upload failed with status {status}: {body}"),
        }));
    }

    let value: serde_json::Value =
        serde_json::from_str(body).context("bundle upload response is not valid JSON")?;
    let object = value
        .as_object()
        .context("bundle upload response must be a JSON object")?;
    if object.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        bail!("bundle upload response field 'ok' must be true");
    }
    let response_rev = object
        .get("rev")
        .and_then(serde_json::Value::as_str)
        .context("bundle upload response field 'rev' must be a string")?;
    if response_rev != requested_rev {
        bail!(
            "bundle upload response rev '{}' does not match requested rev '{}'",
            response_rev,
            requested_rev
        );
    }
    let queued = object
        .get("queued")
        .and_then(serde_json::Value::as_u64)
        .context("bundle upload response field 'queued' must be a nonnegative integer")?;
    let assigned = object
        .get("assigned")
        .and_then(serde_json::Value::as_array)
        .context("bundle upload response field 'assigned' must be an array")?;

    Ok(BundleUploadReceipt {
        queued,
        assigned: assigned.len(),
    })
}
