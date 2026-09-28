use super::*;
use intar_image_build::source_bundle::validate_safe_cli_slug;
use intar_image_upload::{REGISTRY_SESSION_HEADER, RegistryUploadSession, UploadOutcome};

pub(super) fn load_build_config(path: Option<&Path>) -> Result<BuildConfig> {
    match path {
        Some(path) => BuildConfig::from_file(path)
            .with_context(|| format!("failed to load build config from {}", path.display())),
        None => Ok(BuildConfig::default()),
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

pub(super) fn validate_bundle_rev(rev: &str) -> Result<()> {
    validate_safe_cli_slug("bundle rev", rev)
}

pub(super) fn default_bundle_output_path(rev: &str) -> PathBuf {
    Path::new(DEFAULT_BUNDLE_OUTPUT_ROOT).join(format!("{rev}.tar.gz"))
}

pub(super) fn bundle_upload_target(
    config: Option<&RawUploadConfig>,
    url_override: Option<&str>,
    token_override: Option<&str>,
    no_upload: bool,
) -> Result<Option<BundleUploadTarget>> {
    if no_upload {
        return Ok(None);
    }

    let url = if let Some(url) = url_override {
        url.trim().to_owned()
    } else {
        let Some(config) = config else {
            return Ok(None);
        };
        if !config.enabled {
            return Ok(None);
        }
        bundle_url_from_publish_url(&config.url)
    };

    if url.is_empty() {
        bail!("bundle upload URL is empty");
    }

    let token = token_override
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            config
                .map(|config| config.token.trim())
                .filter(|token| !token.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| env::var(IMAGE_PUBLISH_TOKEN_ENV).unwrap_or_default());

    if token.trim().is_empty() {
        bail!("bundle upload requires upload.token, --token, or {IMAGE_PUBLISH_TOKEN_ENV}");
    }

    Ok(Some(BundleUploadTarget { url, token }))
}

pub(super) fn bundle_url_from_publish_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if let Some(base) = trimmed.strip_suffix("/registry/v1/publish") {
        format!("{base}/registry/v1/bundles")
    } else {
        trimmed.to_owned()
    }
}

pub(super) fn upload_bundle(
    uploader: Option<&ImageUploader>,
    target: &BundleUploadTarget,
    archive_path: &Path,
    rev: &str,
    meta: &serde_json::Value,
) -> Result<BundleUploadReceipt> {
    // The registry admits one writer per bundle upload, so the session opens
    // before the request and closes with its outcome. A target that is not the
    // registry bundles route has no admission to hold and uploads as before.
    let Some(uploader) = uploader else {
        return post_bundle(target, None, archive_path, rev, meta);
    };
    let session = uploader.start_session("image_bundle")?;
    let receipt = post_bundle(target, Some(&session), archive_path, rev, meta);
    let closed = session.complete(if receipt.is_ok() {
        UploadOutcome::Published
    } else {
        UploadOutcome::Abandoned
    });
    match (receipt, closed) {
        (Ok(receipt), Ok(())) => Ok(receipt),
        (Ok(_), Err(close)) => {
            Err(close).context("bundle uploaded but the registry upload session was not completed")
        }
        (Err(primary), _) => Err(primary),
    }
}

fn post_bundle(
    target: &BundleUploadTarget,
    session: Option<&RegistryUploadSession>,
    archive_path: &Path,
    rev: &str,
    meta: &serde_json::Value,
) -> Result<BundleUploadReceipt> {
    let part = reqwest::blocking::multipart::Part::file(archive_path)
        .with_context(|| format!("failed to read bundle {}", archive_path.display()))?
        .file_name(format!("{rev}.tar.gz"))
        .mime_str("application/gzip")?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("meta", serde_json::to_string(meta)?)
        .part("bundle", part);

    let mut request = reqwest::blocking::Client::new()
        .post(&target.url)
        .bearer_auth(target.token.trim());
    if let Some(session) = session {
        request = request.header(REGISTRY_SESSION_HEADER, session.id());
    }
    let response = request
        .multipart(form)
        .send()
        .with_context(|| format!("failed to upload bundle to {}", target.url))?;
    let status = response.status();
    let body = response.text().context("failed to read bundle response")?;
    parse_bundle_upload_response(status, &body, rev)
}

/// The admission client is built from the publish route, while the bundle POST
/// goes to the sibling bundles route: the reverse of the publish to bundles
/// derivation in this module. A target outside the registry has no admission to
/// hold.
pub(super) fn publish_url_from_bundle_url(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    trimmed
        .strip_suffix("/registry/v1/bundles")
        .map(|base| format!("{base}/registry/v1/publish"))
}

pub(super) fn parse_bundle_upload_response(
    status: reqwest::StatusCode,
    body: &str,
    requested_rev: &str,
) -> Result<BundleUploadReceipt> {
    if status != reqwest::StatusCode::ACCEPTED {
        bail!("bundle upload failed with status {status}: {body}");
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
