use super::*;

pub(super) fn load_build_config(path: Option<&Path>) -> Result<BuildConfig> {
    match path {
        Some(path) => BuildConfig::from_file(path)
            .with_context(|| format!("failed to load build config from {}", path.display())),
        None => Ok(BuildConfig::default()),
    }
}

pub(super) fn load_base_image_catalog(path: &Path) -> Result<BaseImageCatalog> {
    BaseImageCatalog::from_file(path)
        .with_context(|| format!("failed to load base image catalog from {}", path.display()))
}

pub(super) fn load_build_tools(path: &Path) -> Result<BuildTools> {
    BuildTools::from_file(path)
        .with_context(|| format!("failed to load build tools config from {}", path.display()))
}

pub(super) fn scenario_base_definition_identity(
    scenario: &Scenario,
    base_catalog: &BaseImageCatalog,
    target_arch: &str,
) -> Result<String> {
    let mut definitions = BTreeMap::new();
    for image in scenario.images.values() {
        let base_image = base_catalog
            .base_image_by_name(&image.base)
            .with_context(|| format!("base image '{}' not found in catalog", image.base))?;
        let definition = base_image
            .definition_for_arch(target_arch)
            .with_context(|| {
                format!(
                    "base image '{}' has no {target_arch} mmdebstrap definition",
                    image.base
                )
            })?;
        definitions.insert(image.base.clone(), definition.content_identity());
    }

    Ok(definitions
        .iter()
        .map(|(name, definition)| format!("{name}\n{definition}"))
        .collect::<Vec<_>>()
        .join("\n---\n"))
}

pub(super) fn contract_image_arch_slug(target_arch: &str) -> Result<&'static str> {
    match target_arch.trim() {
        "amd64" | "x86_64" => Ok("x86_64"),
        "arm64" | "aarch64" => Ok("aarch64"),
        other => bail!("unsupported target arch '{other}' for bundle metadata"),
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

pub(super) fn validate_scenario_arg(scenario: &str) -> Result<()> {
    validate_safe_cli_slug("scenario", scenario)
}

pub(super) fn validate_safe_cli_slug(label: &str, value: &str) -> Result<()> {
    if (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Ok(());
    }
    bail!("invalid {label} '{value}' (expected 1-128 safe slug characters)");
}

pub(super) fn default_bundle_output_path(rev: &str) -> PathBuf {
    Path::new(DEFAULT_BUNDLE_OUTPUT_ROOT).join(format!("{rev}.tar.gz"))
}

pub(super) fn collect_bundle_source_files(
    scenarios: &[PreparedBundleScenario],
    base_images_path: &Path,
    build_tools_path: &Path,
) -> Result<Vec<BundleSourceFile>> {
    if scenarios.is_empty() {
        bail!("bundle requires at least one scenario");
    }

    let mut files = Vec::new();
    add_bundle_file(base_images_path, BASE_IMAGES_PATH, &mut files)?;
    add_bundle_file(build_tools_path, BUILD_TOOLS_PATH, &mut files)?;

    for scenario in scenarios {
        collect_bundle_dir(
            &scenario.scenario_dir,
            &format!("scenarios/{}", scenario.scenario_id),
            &mut files,
        )?;
    }

    files.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    Ok(files)
}

pub(super) fn collect_bundle_dir(
    source_dir: &Path,
    archive_root: &str,
    files: &mut Vec<BundleSourceFile>,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source_dir)
        .with_context(|| format!("failed to stat '{}'", source_dir.display()))?;
    if metadata.file_type().is_symlink() {
        bail!(
            "symlink is not allowed in bundle sources: {}",
            source_dir.display()
        );
    }
    if !metadata.is_dir() {
        bail!(
            "bundle source directory '{}' does not exist",
            source_dir.display()
        );
    }

    for entry in fs::read_dir(source_dir)
        .with_context(|| format!("failed to read {}", source_dir.display()))?
    {
        let entry = entry.with_context(|| format!("failed to read {}", source_dir.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .with_context(|| format!("failed to stat '{}'", path.display()))?;
        if file_type.is_symlink() {
            bail!(
                "symlink is not allowed in bundle sources: {}",
                path.display()
            );
        } else if file_type.is_dir() {
            collect_bundle_dir(
                &path,
                &format!("{archive_root}/{}", archive_name(entry.file_name())?),
                files,
            )?;
        } else if file_type.is_file() {
            let archive_path = format!("{archive_root}/{}", archive_name(entry.file_name())?);
            add_bundle_file(&path, &archive_path, files)?;
        } else {
            bail!("bundle source '{}' is not a regular file", path.display());
        }
    }
    Ok(())
}

pub(super) fn add_bundle_file(
    source_path: &Path,
    archive_path: &str,
    files: &mut Vec<BundleSourceFile>,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source_path)
        .with_context(|| format!("failed to stat {}", source_path.display()))?;
    if metadata.file_type().is_symlink() {
        bail!(
            "symlink is not allowed in bundle sources: {}",
            source_path.display()
        );
    }
    if !metadata.is_file() {
        bail!(
            "bundle source file '{}' does not exist",
            source_path.display()
        );
    }
    validate_archive_path(archive_path)?;
    files.push(BundleSourceFile {
        source_path: source_path.to_path_buf(),
        archive_path: archive_path.to_owned(),
    });
    Ok(())
}

pub(super) fn archive_name(value: impl AsRef<OsStr>) -> Result<String> {
    let name = value
        .as_ref()
        .to_str()
        .ok_or_else(|| anyhow!("bundle archive path is not valid UTF-8"))?;
    validate_archive_component(name)?;
    Ok(name.to_owned())
}

pub(super) fn validate_archive_path(path: &str) -> Result<()> {
    let path = Path::new(path);
    if path.is_absolute() {
        bail!("bundle archive path must be relative");
    }
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                let name = name
                    .to_str()
                    .ok_or_else(|| anyhow!("bundle archive path is not valid UTF-8"))?;
                validate_archive_component(name)?;
            }
            _ => bail!("bundle archive path contains unsupported component"),
        }
    }
    Ok(())
}

pub(super) fn validate_archive_component(component: &str) -> Result<()> {
    if component.is_empty() || component == "." || component == ".." || component.contains('/') {
        bail!("invalid bundle archive path component '{component}'");
    }
    Ok(())
}

pub(super) fn write_bundle_archive(
    output_path: &Path,
    source_files: &[BundleSourceFile],
) -> Result<()> {
    if source_files.is_empty() {
        bail!("bundle archive requires at least one file");
    }
    let tar_bytes = bundle_tar_size_bytes(source_files)?;
    if tar_bytes > MAX_BUNDLE_TAR_BYTES {
        bail!(
            "bundle archive would expand to {tar_bytes} bytes, exceeding the {MAX_BUNDLE_TAR_BYTES} byte limit"
        );
    }
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let output = fs::File::create(output_path)
        .with_context(|| format!("failed to create {}", output_path.display()))?;
    let encoder = GzBuilder::new()
        .mtime(0)
        .write(output, Compression::default());
    let mut builder = tar::Builder::new(encoder);
    let mut sorted_files = source_files.to_vec();
    sorted_files.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));

    for source_file in sorted_files {
        let bytes = fs::read(&source_file.source_path)
            .with_context(|| format!("failed to read {}", source_file.source_path.display()))?;
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_cksum();
        builder
            .append_data(
                &mut header,
                Path::new(&source_file.archive_path),
                Cursor::new(bytes),
            )
            .with_context(|| {
                format!(
                    "failed to append {} to bundle archive",
                    source_file.archive_path
                )
            })?;
    }

    let encoder = builder
        .into_inner()
        .context("failed to finish tar bundle archive")?;
    encoder
        .finish()
        .context("failed to finish gzip bundle archive")?;
    Ok(())
}

pub(super) fn bundle_tar_size_bytes(source_files: &[BundleSourceFile]) -> Result<u64> {
    let mut total = TAR_BLOCK_SIZE * 2;
    for source_file in source_files {
        let size = fs::metadata(&source_file.source_path)
            .with_context(|| format!("failed to stat {}", source_file.source_path.display()))?
            .len();
        total = total
            .checked_add(TAR_BLOCK_SIZE)
            .and_then(|value| value.checked_add(padded_tar_entry_size(size)))
            .ok_or_else(|| anyhow!("bundle archive size overflow"))?;
    }
    Ok(total)
}

pub(super) fn padded_tar_entry_size(size: u64) -> u64 {
    size.div_ceil(TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
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
    target: &BundleUploadTarget,
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

    let response = reqwest::blocking::Client::new()
        .post(&target.url)
        .bearer_auth(target.token.trim())
        .multipart(form)
        .send()
        .with_context(|| format!("failed to upload bundle to {}", target.url))?;
    let status = response.status();
    let body = response.text().context("failed to read bundle response")?;
    parse_bundle_upload_response(status, &body, rev)
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
