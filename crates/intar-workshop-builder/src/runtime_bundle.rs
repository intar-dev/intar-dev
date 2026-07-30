use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Cursor, Read as _};
use std::path::Path;

use anyhow::{Context as _, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use ed25519_dalek::{Signer as _, SigningKey};
use intar_workshop_manifest::{Module, ValidatedWorkshop};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tar::{Builder, EntryType, Header, HeaderMode};

use crate::config::RuntimeBundleSigningConfig;
use crate::config::WorkerConfig;
use crate::contracts::{RuntimeBundleArtifact, RuntimeBundleCompression};

const RUNTIME_BUNDLE_SCHEMA_VERSION: u8 = 3;
const RUNTIME_SOURCE_SCHEMA_VERSION: u8 = 1;
const MAX_SIGNING_KEY_FILE_BYTES: u64 = 512;
const MAX_RUNTIME_SOURCE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RUNTIME_SOURCE_BYTES: u64 = 256 * 1024 * 1024;
const RUNTIME_CONFIG_PATH: &str = "runtime/runtime.json";
const RUNTIME_BOOTSTRAP_PATH: &str = "runtime/bootstrap.sh";
const RUNTIME_IMAGE_LOCK_PATH: &str = "runtime/images.lock";
const RUNTIME_SOURCE_PATH: &str = "runtime/source";
const WORKSHOP_LICENSE_PATH: &str = "LICENSE";
const SHELL_COMMAND_SEPARATOR: &str = "\0";

/// Loaded signer for one builder process. The secret key is intentionally not
/// `Debug`, serialized, cloned, or placed in a publication report.
pub(crate) struct RuntimeBundleSigner {
    key_id: String,
    key: SigningKey,
}

pub(crate) struct ProducedRuntimeBundle {
    pub bytes: Vec<u8>,
    pub artifact: RuntimeBundleArtifact,
    pub covered_module_ids: Vec<String>,
}

#[derive(Serialize)]
struct ReconstructionManifest<'a> {
    schema_version: u8,
    workshop_slug: &'a str,
    checkpoint_id: &'a str,
    install_root: String,
    bootstrap_script: String,
    runtime_files: Vec<ReconstructionFile>,
    apply_steps: Vec<ReconstructionStep<'a>>,
    probe_verifiers: Vec<ReconstructionProbeVerifier<'a>>,
    external_images: Vec<String>,
}

#[derive(Serialize)]
struct ReconstructionFile {
    archive_path: String,
    install_path: String,
    sha256: String,
    mode: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeSourceConfig {
    schema_version: u8,
    install_root: String,
}

#[derive(Serialize)]
struct ReconstructionStep<'a> {
    module_id: &'a str,
    catch_up_script: String,
    verify_script: String,
}

#[derive(Serialize)]
struct ReconstructionProbeVerifier<'a> {
    module_id: &'a str,
    verifier_script: String,
    probe_ids: &'a [String],
}

impl RuntimeBundleSigner {
    pub(crate) fn load(config: &RuntimeBundleSigningConfig) -> Result<Self> {
        let material = match (&config.private_key_file, &config.private_key_env) {
            (Some(path), None) => read_private_key_file(path)?,
            (None, Some(name)) => {
                let value = std::env::var(name).with_context(|| {
                    format!("runtime bundle signing environment variable '{name}' is not set")
                })?;
                decode_base64_seed(value.trim().as_bytes()).with_context(|| {
                    format!("runtime bundle signing environment variable '{name}' is invalid")
                })?
            }
            _ => bail!("runtime bundle signing config has an invalid private-key source"),
        };
        Ok(Self {
            key_id: config.key_id.clone(),
            key: SigningKey::from_bytes(&material),
        })
    }

    fn sign(&self, bytes: &[u8]) -> String {
        BASE64_STANDARD.encode(self.key.sign(bytes).to_bytes())
    }

    #[cfg(test)]
    fn verifying_key(&self) -> ed25519_dalek::VerifyingKey {
        self.key.verifying_key()
    }
}

/// Fail before registry authentication when an operator configured a signing
/// source that cannot be read or decoded. A missing optional config remains
/// valid for legacy `agent_kvm`-only builders and is rejected only if such a
/// builder claims a direct-cloud workshop.
pub fn preflight_runtime_bundle_signing(worker: &WorkerConfig) -> Result<()> {
    if let Some(config) = &worker.runtime_bundle_signing {
        let _ = RuntimeBundleSigner::load(config)?;
    }
    Ok(())
}

pub(crate) fn produce_runtime_bundle(
    root: &Path,
    workshop: &ValidatedWorkshop,
    ordered_modules: &[&Module],
    target_index: usize,
    compression: RuntimeBundleCompression,
    signer: &RuntimeBundleSigner,
) -> Result<ProducedRuntimeBundle> {
    let target = ordered_modules
        .get(target_index)
        .context("runtime bundle target module is outside the ordered module set")?;
    let included = &ordered_modules[..=target_index];
    let covered_module_ids = included.iter().map(|module| module.id.clone()).collect();
    let mut entries = BTreeMap::new();
    let mut steps = Vec::with_capacity(included.len());
    let mut probe_verifiers = Vec::with_capacity(ordered_modules.len());
    let runtime = collect_runtime_source(root, &mut entries)?;
    let external_images = runtime
        .external_images
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let image_inventory = external_images.iter().map(String::as_str).collect();

    for module in ordered_modules {
        let verifier_archive_path = format!("probes/{}/verify.sh", module.id);
        let verify = read_runtime_script(root, &module.verify_script)?;
        validate_executable_image_references(
            &module.verify_script,
            &verify,
            &image_inventory,
            &runtime.pinned_image_variables,
        )?;
        entries.insert(verifier_archive_path.clone(), verify);
        probe_verifiers.push(ReconstructionProbeVerifier {
            module_id: &module.id,
            verifier_script: verifier_archive_path,
            probe_ids: &module.probes,
        });
    }

    for module in included {
        let catch_up_archive_path = format!("scripts/{}/catch-up.sh", module.id);
        let verify_archive_path = format!("probes/{}/verify.sh", module.id);
        let catch_up = read_runtime_script(root, &module.catch_up_script)?;
        validate_executable_image_references(
            &module.catch_up_script,
            &catch_up,
            &image_inventory,
            &runtime.pinned_image_variables,
        )?;
        entries.insert(catch_up_archive_path.clone(), catch_up);
        steps.push(ReconstructionStep {
            module_id: &module.id,
            catch_up_script: catch_up_archive_path,
            verify_script: verify_archive_path,
        });
    }

    let manifest = ReconstructionManifest {
        schema_version: RUNTIME_BUNDLE_SCHEMA_VERSION,
        workshop_slug: &workshop.manifest.workshop.id,
        checkpoint_id: &target.checkpoint,
        install_root: runtime.install_root,
        bootstrap_script: RUNTIME_BOOTSTRAP_PATH.to_owned(),
        runtime_files: runtime.files,
        apply_steps: steps,
        probe_verifiers,
        external_images: external_images.into_iter().collect(),
    };
    let mut manifest_bytes =
        serde_json::to_vec_pretty(&manifest).context("failed to encode runtime bundle manifest")?;
    manifest_bytes.push(b'\n');
    entries.insert("checkpoint.json".to_owned(), manifest_bytes);

    // The allowlist above is the learner-data boundary. In particular, raw
    // source-bundle traversal must never be added here: facilitator notes,
    // solution Markdown, presentation notes, arbitrary secrets, and OCI layer
    // blobs are intentionally unreachable from this archive writer.
    let bytes = deterministic_archive(entries, compression)?;
    let sha256 = sha256_hex(&bytes);
    let signature_b64 = signer.sign(&bytes);
    Ok(ProducedRuntimeBundle {
        bytes,
        artifact: RuntimeBundleArtifact {
            sha256,
            compression,
            signature_b64,
            signing_key_id: signer.key_id.clone(),
            workspace_agent_sha256: None,
        },
        covered_module_ids,
    })
}

struct CollectedRuntimeSource {
    install_root: String,
    files: Vec<ReconstructionFile>,
    external_images: Vec<String>,
    pinned_image_variables: BTreeMap<String, String>,
}

fn collect_runtime_source(
    root: &Path,
    entries: &mut BTreeMap<String, Vec<u8>>,
) -> Result<CollectedRuntimeSource> {
    let config_bytes = read_regular_bounded(
        &root.join(RUNTIME_CONFIG_PATH),
        RUNTIME_CONFIG_PATH,
        64 * 1024,
    )?;
    let config = serde_json::from_slice::<RuntimeSourceConfig>(&config_bytes)
        .context("runtime/runtime.json is invalid")?;
    if config.schema_version != RUNTIME_SOURCE_SCHEMA_VERSION {
        bail!("runtime/runtime.json schema_version must be {RUNTIME_SOURCE_SCHEMA_VERSION}");
    }
    validate_install_root(&config.install_root)?;

    let bootstrap = read_regular_bounded(
        &root.join(RUNTIME_BOOTSTRAP_PATH),
        RUNTIME_BOOTSTRAP_PATH,
        1024 * 1024,
    )?;
    let bootstrap_text = std::str::from_utf8(&bootstrap)
        .context("runtime/bootstrap.sh must contain valid UTF-8")?
        .to_owned();

    let image_lock = read_regular_bounded(
        &root.join(RUNTIME_IMAGE_LOCK_PATH),
        RUNTIME_IMAGE_LOCK_PATH,
        1024 * 1024,
    )?;
    let external_images = parse_image_lock(&image_lock)?;
    entries.insert(RUNTIME_IMAGE_LOCK_PATH.to_owned(), image_lock);

    let source_root = root.join(RUNTIME_SOURCE_PATH);
    let metadata = fs::symlink_metadata(&source_root).with_context(|| {
        format!(
            "failed to inspect runtime source '{}'",
            source_root.display()
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("runtime/source must be a real directory");
    }
    let mut paths = Vec::new();
    collect_regular_paths(&source_root, Path::new(""), &mut paths)?;
    if paths.is_empty() {
        bail!("runtime/source must contain at least one learner-safe file");
    }

    if paths
        .iter()
        .any(|path| path == Path::new(WORKSHOP_LICENSE_PATH))
    {
        bail!("runtime/source must not duplicate the workshop root LICENSE");
    }
    let license = read_regular_bounded(
        &root.join(WORKSHOP_LICENSE_PATH),
        WORKSHOP_LICENSE_PATH,
        1024 * 1024,
    )?;
    let image_set = external_images
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut total = u64::try_from(license.len()).context("workshop LICENSE is too large")?;
    let mut files = Vec::with_capacity(paths.len() + 1);
    let mut text_sources = vec![(RUNTIME_BOOTSTRAP_PATH.to_owned(), bootstrap_text, true)];
    let license_archive_path = "runtime/root/LICENSE".to_owned();
    files.push(ReconstructionFile {
        archive_path: license_archive_path.clone(),
        install_path: WORKSHOP_LICENSE_PATH.to_owned(),
        sha256: sha256_hex(&license),
        mode: runtime_file_mode(&root.join(WORKSHOP_LICENSE_PATH))?,
    });
    entries.insert(license_archive_path, license);
    for relative in paths {
        validate_runtime_relative_path(&relative)?;
        let source = source_root.join(&relative);
        let relative_display = relative.to_string_lossy().replace('\\', "/");
        let bytes = read_regular_bounded(
            &source,
            &format!("{RUNTIME_SOURCE_PATH}/{relative_display}"),
            MAX_RUNTIME_SOURCE_FILE_BYTES,
        )?;
        total = total
            .checked_add(u64::try_from(bytes.len()).context("runtime source is too large")?)
            .context("runtime source size overflow")?;
        if total > MAX_RUNTIME_SOURCE_BYTES {
            bail!("runtime/source exceeds the {MAX_RUNTIME_SOURCE_BYTES} byte limit");
        }
        if let Ok(text) = std::str::from_utf8(&bytes) {
            validate_runtime_image_references(text, &image_set).with_context(|| {
                format!("runtime source '{relative_display}' has an unsafe image reference")
            })?;
            validate_split_image_blocks(
                &format!("runtime/source/{relative_display}"),
                text,
                &image_set,
                &BTreeMap::new(),
            )?;
            if is_dockerfile_path(&relative) {
                validate_dockerfile_image_references(text, &image_set).with_context(|| {
                    format!("runtime Dockerfile '{relative_display}' has an unsafe base image")
                })?;
            }
            let executable = relative
                .extension()
                .is_some_and(|extension| extension == "sh")
                || runtime_file_mode(&source)? == 0o755;
            text_sources.push((relative_display.clone(), text.to_owned(), executable));
        }
        let archive_path = format!("runtime/root/{relative_display}");
        let mode = runtime_file_mode(&source)?;
        files.push(ReconstructionFile {
            archive_path: archive_path.clone(),
            install_path: relative_display,
            sha256: sha256_hex(&bytes),
            mode,
        });
        entries.insert(archive_path, bytes);
    }
    validate_runtime_image_references(
        std::str::from_utf8(&bootstrap).context("runtime/bootstrap.sh must contain valid UTF-8")?,
        &image_set,
    )
    .context("runtime/bootstrap.sh has an unsafe image reference")?;
    entries.insert(RUNTIME_BOOTSTRAP_PATH.to_owned(), bootstrap);
    let pinned_image_variables = collect_literal_pinned_image_variables(&text_sources, &image_set)?;
    for (label, source, executable) in &text_sources {
        if *executable {
            validate_executable_image_references(
                label,
                source.as_bytes(),
                &image_set,
                &pinned_image_variables,
            )?;
        }
    }

    Ok(CollectedRuntimeSource {
        install_root: config.install_root,
        files,
        external_images,
        pinned_image_variables,
    })
}

fn read_regular_bounded(path: &Path, label: &str, limit: u64) -> Result<Vec<u8>> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("failed to inspect '{label}'"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("'{label}' must be a regular non-symlink file");
    }
    if metadata.len() > limit {
        bail!("'{label}' exceeds the {limit} byte limit");
    }
    fs::read(path).with_context(|| format!("failed to read '{label}'"))
}

fn collect_regular_paths(
    root: &Path,
    relative: &Path,
    output: &mut Vec<std::path::PathBuf>,
) -> Result<()> {
    let directory = root.join(relative);
    let mut children = fs::read_dir(&directory)
        .with_context(|| {
            format!(
                "failed to read runtime source directory '{}'",
                directory.display()
            )
        })?
        .collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(std::fs::DirEntry::file_name);
    for child in children {
        let child_relative = relative.join(child.file_name());
        let metadata = fs::symlink_metadata(child.path()).with_context(|| {
            format!(
                "failed to inspect runtime source '{}'",
                child.path().display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            bail!(
                "runtime source '{}' must not be a symlink",
                child_relative.display()
            );
        }
        if metadata.is_dir() {
            collect_regular_paths(root, &child_relative, output)?;
        } else if metadata.is_file() {
            output.push(child_relative);
        } else {
            bail!(
                "runtime source '{}' is not a regular file or directory",
                child_relative.display()
            );
        }
    }
    Ok(())
}

fn validate_install_root(value: &str) -> Result<()> {
    let path = Path::new(value);
    if !path.is_absolute()
        || !value.starts_with("/opt/")
        || value.len() > 200
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        bail!("runtime install_root must be a normalized absolute path below /opt");
    }
    Ok(())
}

fn validate_runtime_relative_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        bail!("runtime source path must be relative and non-empty");
    }
    let forbidden = [".git", "solutions", "facilitator", "slides"];
    for component in path.components() {
        let std::path::Component::Normal(value) = component else {
            bail!("runtime source path '{}' is not normalized", path.display());
        };
        let value = value.to_string_lossy();
        if forbidden.contains(&value.as_ref())
            || value.eq_ignore_ascii_case("solve.sh")
            || value.eq_ignore_ascii_case("id_rsa")
            || value.eq_ignore_ascii_case("id_ed25519")
        {
            bail!(
                "runtime source path '{}' crosses the learner-safe boundary",
                path.display()
            );
        }
    }
    Ok(())
}

fn runtime_file_mode(path: &Path) -> Result<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(path)?.permissions().mode();
        Ok(if mode & 0o111 != 0 { 0o755 } else { 0o644 })
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(0o644)
    }
}

fn parse_image_lock(bytes: &[u8]) -> Result<Vec<String>> {
    let source = std::str::from_utf8(bytes).context("runtime/images.lock must be UTF-8")?;
    let mut images = BTreeSet::new();
    for (index, raw) in source.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        if line.split_whitespace().count() != 1 {
            bail!(
                "runtime/images.lock line {} must contain exactly one image",
                index + 1
            );
        }
        validate_digest_pinned_image(line).with_context(|| {
            format!(
                "runtime/images.lock line {} is not digest pinned",
                index + 1
            )
        })?;
        if !images.insert(line.to_owned()) {
            bail!("runtime/images.lock contains duplicate image '{line}'");
        }
    }
    if images.is_empty() {
        bail!("runtime/images.lock must contain at least one digest-pinned image");
    }
    Ok(images.into_iter().collect())
}

fn validate_runtime_image_references(source: &str, inventory: &BTreeSet<&str>) -> Result<()> {
    const REGISTRIES: [&str; 8] = [
        "docker.io/",
        "ghcr.io/",
        "quay.io/",
        "registry.k8s.io/",
        "gcr.io/",
        "public.ecr.aws/",
        "xpkg.crossplane.io/",
        "docker.gitea.com/",
    ];
    for token in source.split(|character: char| !is_oci_token_character(character)) {
        let image_token = token.strip_prefix("docker://").unwrap_or(token);
        if image_token
            .split_once("@sha256:")
            .is_some_and(|(name, _)| !name.is_empty())
        {
            validate_digest_pinned_image(image_token)?;
            if !inventory_contains_image(inventory, image_token) {
                bail!("OCI reference '{image_token}' is absent from runtime/images.lock");
            }
            continue;
        }
        if !REGISTRIES
            .iter()
            .any(|registry| image_token.starts_with(registry))
        {
            continue;
        }
        let has_tag = image_token
            .rsplit('/')
            .next()
            .is_some_and(|tail| tail.contains(':'));
        if !has_tag && !image_token.contains("@sha256:") {
            continue;
        }
        if !image_token.contains("@sha256:") {
            bail!("tag-only OCI reference '{image_token}' is forbidden");
        }
        validate_digest_pinned_image(image_token)?;
        if !inventory_contains_image(inventory, image_token) {
            bail!("OCI reference '{image_token}' is absent from runtime/images.lock");
        }
    }
    for line in source.lines() {
        let line = strip_shell_comment(line).trim();
        if let Some(image) = yaml_image_scalar(line) {
            validate_consumed_image_reference(
                "runtime source image field",
                image,
                inventory,
                &BTreeMap::new(),
            )?;
        }
        for image in inline_yaml_image_scalars(line)
            .into_iter()
            .chain(json_image_scalars(line))
        {
            validate_consumed_image_reference(
                "runtime source inline image field",
                image,
                inventory,
                &BTreeMap::new(),
            )?;
        }
    }
    Ok(())
}

fn is_dockerfile_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name == "Dockerfile"
        || name.starts_with("Dockerfile.")
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("dockerfile"))
}

fn validate_dockerfile_image_references(source: &str, inventory: &BTreeSet<&str>) -> Result<()> {
    for line in source.lines() {
        let line = strip_shell_comment(line).trim();
        if let Some(image) = dockerfile_base_image(line) {
            validate_consumed_image_reference(
                "runtime source Dockerfile FROM",
                image,
                inventory,
                &BTreeMap::new(),
            )?;
        }
    }
    Ok(())
}

fn collect_literal_pinned_image_variables(
    sources: &[(String, String, bool)],
    inventory: &BTreeSet<&str>,
) -> Result<BTreeMap<String, String>> {
    let mut variables = BTreeMap::new();
    let mut assignments = BTreeMap::<String, BTreeSet<String>>::new();
    for (label, source, _) in sources {
        for line in source.lines() {
            let line = strip_shell_comment(line).trim();
            let line = line
                .strip_prefix("export ")
                .or_else(|| line.strip_prefix("readonly "))
                .or_else(|| line.strip_prefix("local "))
                .unwrap_or(line)
                .trim();
            let Some((name, raw_value)) = line.split_once('=') else {
                continue;
            };
            let name = name.trim();
            if !is_shell_identifier(name) {
                continue;
            }
            let value = unquote_static_value(raw_value.trim());
            assignments
                .entry(name.to_owned())
                .or_default()
                .insert(value.to_owned());
            if !value.contains("@sha256:") {
                continue;
            }
            if value.contains(['$', '`', '\\']) {
                bail!(
                    "{label} assigns a dynamically constructed OCI image to '{}'",
                    name
                );
            }
            validate_digest_pinned_image(value)?;
            if !inventory_contains_image(inventory, value) {
                bail!(
                    "{label} assigns OCI image '{value}' which is absent from runtime/images.lock"
                );
            }
            match variables.entry(name.to_owned()) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(value.to_owned());
                }
                std::collections::btree_map::Entry::Occupied(entry) if entry.get() == value => {}
                std::collections::btree_map::Entry::Occupied(entry) => {
                    bail!(
                        "OCI image variable '{}' has conflicting literal assignments '{}' and '{}'",
                        name,
                        entry.get(),
                        value
                    );
                }
            }
        }
    }
    for (name, pinned) in &variables {
        if assignments
            .get(name)
            .is_some_and(|values| values.iter().any(|value| value != pinned))
        {
            bail!(
                "OCI image variable '{name}' has another mutable, dynamic, or conflicting assignment"
            );
        }
    }
    Ok(variables)
}

fn validate_executable_image_references(
    label: &str,
    bytes: &[u8],
    inventory: &BTreeSet<&str>,
    variables: &BTreeMap<String, String>,
) -> Result<()> {
    let source = std::str::from_utf8(bytes)
        .with_context(|| format!("runtime executable '{label}' must contain valid UTF-8"))?;
    validate_runtime_image_references(source, inventory)
        .with_context(|| format!("runtime executable '{label}' has an unsafe image reference"))?;
    validate_split_image_blocks(label, source, inventory, variables)?;
    for command in logical_shell_commands(source) {
        let tokens = shell_tokens(&command)
            .with_context(|| format!("runtime executable '{label}' has ambiguous shell syntax"))?;
        validate_shell_image_consumers(label, &tokens, inventory, variables)?;
    }
    Ok(())
}

fn validate_split_image_blocks(
    label: &str,
    source: &str,
    inventory: &BTreeSet<&str>,
    variables: &BTreeMap<String, String>,
) -> Result<()> {
    let lines = source.lines().collect::<Vec<_>>();
    let mut index = 0;
    while index < lines.len() {
        let line = strip_shell_comment(lines[index]);
        if line.trim() != "image:" {
            index += 1;
            continue;
        }
        let parent_indent = line.len() - line.trim_start().len();
        let mut child_indent = None;
        let mut registry = None;
        let mut repository = None;
        let mut tag = None;
        let mut digest = None;
        index += 1;
        while index < lines.len() {
            let child = strip_shell_comment(lines[index]);
            let trimmed = child.trim();
            if trimmed.is_empty() {
                index += 1;
                continue;
            }
            let indent = child.len() - child.trim_start().len();
            if indent <= parent_indent {
                break;
            }
            let direct_indent = *child_indent.get_or_insert(indent);
            if indent == direct_indent
                && let Some((key, value)) = trimmed.split_once(':')
            {
                let value = unquote_static_value(value.trim());
                match key {
                    "registry" => registry = Some(value),
                    "repository" => repository = Some(value),
                    "tag" => tag = Some(value),
                    "digest" => digest = Some(value),
                    _ => {}
                }
            }
            index += 1;
        }
        if registry.is_none() && repository.is_none() && tag.is_none() && digest.is_none() {
            continue;
        }
        let registry = registry.with_context(|| {
            format!("runtime executable '{label}' has split image values without registry")
        })?;
        let repository = repository.with_context(|| {
            format!("runtime executable '{label}' has split image values without repository")
        })?;
        let digest = digest
            .filter(|digest| !digest.is_empty())
            .with_context(|| {
                format!("runtime executable '{label}' has split image values without digest")
            })?;
        let digest = digest.strip_prefix("sha256:").with_context(|| {
            format!("runtime executable '{label}' has a non-SHA-256 split image digest")
        })?;
        let tag = tag.filter(|tag| !tag.is_empty());
        let image = if let Some(tag) = tag {
            format!("{registry}/{repository}:{tag}@sha256:{digest}")
        } else {
            format!("{registry}/{repository}@sha256:{digest}")
        };
        validate_consumed_image_reference(label, &image, inventory, variables)?;
    }
    Ok(())
}

fn validate_shell_image_consumers(
    label: &str,
    tokens: &[String],
    inventory: &BTreeSet<&str>,
    variables: &BTreeMap<String, String>,
) -> Result<()> {
    validate_shell_image_consumers_inner(label, tokens, inventory, variables, false)
}

fn validate_shell_image_consumers_inner(
    label: &str,
    tokens: &[String],
    inventory: &BTreeSet<&str>,
    variables: &BTreeMap<String, String>,
    reject_bare_dynamic_command: bool,
) -> Result<()> {
    for segment in tokens.split(|token| token == SHELL_COMMAND_SEPARATOR) {
        validate_shell_image_segment(
            label,
            segment,
            inventory,
            variables,
            reject_bare_dynamic_command,
        )?;
    }
    Ok(())
}

fn validate_shell_image_segment(
    label: &str,
    tokens: &[String],
    inventory: &BTreeSet<&str>,
    variables: &BTreeMap<String, String>,
    reject_bare_dynamic_command: bool,
) -> Result<()> {
    validate_image_variable_mutations(label, tokens, variables)?;
    reject_indirect_image_execution(
        label,
        tokens,
        inventory,
        variables,
        reject_bare_dynamic_command,
    )?;
    let Some((index, tool)) = tokens
        .iter()
        .enumerate()
        .find_map(|(index, token)| image_tool_name(token).map(|tool| (index, tool)))
    else {
        return Ok(());
    };
    match tool {
        "docker" | "podman" | "nerdctl" => {
            let Some(mut subcommand) =
                image_tool_action_index(tokens, index + 1).with_context(|| {
                    format!("runtime executable '{label}' has ambiguous {tool} options")
                })?
            else {
                return Ok(());
            };
            if matches!(
                tokens.get(subcommand).map(String::as_str),
                Some("image" | "container")
            ) {
                let namespace = tokens[subcommand].as_str();
                subcommand = image_tool_action_index(tokens, subcommand + 1)
                    .with_context(|| {
                        format!(
                            "runtime executable '{label}' has ambiguous {tool} {namespace} options"
                        )
                    })?
                    .with_context(|| {
                        format!("runtime executable '{label}' has no {tool} {namespace} subcommand")
                    })?;
            }
            let action = tokens[subcommand].as_str();
            if matches!(action, "pull" | "run" | "create") {
                let image =
                    container_image_argument(&tokens[subcommand + 1..]).with_context(|| {
                        format!(
                            "runtime executable '{label}' has an ambiguous {tool} {action} image"
                        )
                    })?;
                validate_consumed_image_reference(label, image, inventory, variables)?;
            }
        }
        "ctr" => {
            let Some(namespace) =
                image_tool_action_index(tokens, index + 1).with_context(|| {
                    format!("runtime executable '{label}' has ambiguous ctr options")
                })?
            else {
                return Ok(());
            };
            let action = image_tool_action_index(tokens, namespace + 1).with_context(|| {
                format!("runtime executable '{label}' has ambiguous ctr images options")
            })?;
            if tokens.get(namespace).is_some_and(|value| value == "images")
                && action
                    .is_some_and(|action| tokens.get(action).is_some_and(|value| value == "pull"))
            {
                let action = action.context("ctr images pull action disappeared")?;
                let image = first_positional(&tokens[action + 1..], container_option_takes_value)
                    .with_context(|| {
                    format!("runtime executable '{label}' has an ambiguous ctr images pull")
                })?;
                validate_consumed_image_reference(label, image, inventory, variables)?;
            }
        }
        "crictl" | "oras" => {
            let action = image_tool_action_index(tokens, index + 1).with_context(|| {
                format!("runtime executable '{label}' has ambiguous {tool} options")
            })?;
            if action.is_some_and(|action| tokens.get(action).is_some_and(|value| value == "pull"))
            {
                let action = action.context("image pull action disappeared")?;
                let image = first_positional(&tokens[action + 1..], container_option_takes_value)
                    .with_context(|| {
                    format!("runtime executable '{label}' has an ambiguous {tool} pull")
                })?;
                validate_consumed_image_reference(label, image, inventory, variables)?;
            }
        }
        "crane" => {
            let action = image_tool_action_index(tokens, index + 1).with_context(|| {
                format!("runtime executable '{label}' has ambiguous crane options")
            })?;
            if matches!(
                action.and_then(|action| tokens.get(action).map(String::as_str)),
                Some("pull" | "export" | "copy")
            ) {
                let action = action.context("crane image action disappeared")?;
                let image = first_positional(&tokens[action + 1..], container_option_takes_value)
                    .with_context(|| {
                    format!("runtime executable '{label}' has an ambiguous {tool} source image")
                })?;
                validate_consumed_image_reference(label, image, inventory, variables)?;
            }
        }
        "skopeo" => {
            let action = image_tool_action_index(tokens, index + 1).with_context(|| {
                format!("runtime executable '{label}' has ambiguous skopeo options")
            })?;
            if action.is_some_and(|action| tokens.get(action).is_some_and(|value| value == "copy"))
            {
                let action = action.context("skopeo copy action disappeared")?;
                let image = first_positional(&tokens[action + 1..], container_option_takes_value)
                    .with_context(|| {
                    format!("runtime executable '{label}' has an ambiguous skopeo source image")
                })?;
                validate_consumed_image_reference(label, image, inventory, variables)?;
            }
        }
        "helm" => {
            if tokens[index + 1..].iter().any(|token| {
                let token = token.to_ascii_lowercase();
                token.contains("image.repository")
                    || token.contains("image.registry")
                    || token.contains("image.tag")
                    || token.contains("image.digest")
            }) {
                bail!(
                    "runtime executable '{label}' mutates Helm image fields on the command line; use validated split image values"
                );
            }
            for (value_index, token) in tokens[index + 1..].iter().enumerate() {
                let value = token.strip_prefix("--values=").or_else(|| {
                    matches!(token.as_str(), "-f" | "--values")
                        .then(|| tokens.get(index + 2 + value_index).map(String::as_str))
                        .flatten()
                });
                if value.is_some_and(|path| {
                    path != "-"
                        && path != "/dev/stdin"
                        && (path.contains(['$', '`'])
                            || path.contains("..")
                            || path.starts_with('/')
                            || path.contains("://"))
                }) {
                    bail!(
                        "runtime executable '{label}' uses a Helm values source outside the signed runtime bundle"
                    );
                }
            }
        }
        "kubectl" => {
            validate_image_flags(label, &tokens[index + 1..], inventory, variables)?;
            validate_kubectl_image_mutations(label, &tokens[index + 1..], inventory, variables)?;
        }
        "talosctl" => {
            validate_image_flags(label, &tokens[index + 1..], inventory, variables)?;
        }
        _ => {}
    }
    Ok(())
}

fn validate_kubectl_image_mutations(
    label: &str,
    tokens: &[String],
    inventory: &BTreeSet<&str>,
    variables: &BTreeMap<String, String>,
) -> Result<()> {
    for index in 0..tokens.len() {
        if tokens.get(index).is_some_and(|token| token == "set")
            && tokens.get(index + 1).is_some_and(|token| token == "image")
        {
            let mut found = false;
            for assignment in &tokens[index + 2..] {
                if assignment.starts_with('-') {
                    continue;
                }
                let Some((container, image)) = assignment.split_once('=') else {
                    continue;
                };
                if container.is_empty() || image.is_empty() {
                    bail!("runtime executable '{label}' has malformed kubectl set image");
                }
                validate_consumed_image_reference(label, image, inventory, variables)?;
                found = true;
            }
            if !found {
                bail!("runtime executable '{label}' has ambiguous kubectl set image");
            }
        }
        if tokens.get(index).is_some_and(|token| token == "patch") {
            let patch_tokens = &tokens[index + 1..];
            for (patch_index, token) in patch_tokens.iter().enumerate() {
                let patch_file = token.strip_prefix("--patch-file=").or_else(|| {
                    (token == "--patch-file")
                        .then(|| patch_tokens.get(patch_index + 1).map(String::as_str))
                        .flatten()
                });
                if patch_file.is_some_and(|path| path != "/dev/stdin") {
                    bail!(
                        "runtime executable '{label}' uses an external kubectl patch file whose image boundary cannot be proven"
                    );
                }
            }
            if patch_tokens
                .iter()
                .any(|token| token.to_ascii_lowercase().contains("image"))
            {
                bail!(
                    "runtime executable '{label}' mutates an image through kubectl patch; use a validated manifest"
                );
            }
        }
    }
    Ok(())
}

fn validate_image_variable_mutations(
    label: &str,
    tokens: &[String],
    variables: &BTreeMap<String, String>,
) -> Result<()> {
    for token in tokens {
        if let Some((name, value)) = token.split_once('=') {
            let name = name.strip_suffix('+').unwrap_or(name);
            if image_tool_name(value).is_some() {
                bail!(
                    "runtime executable '{label}' aliases image tool '{value}' through variable '{name}'"
                );
            }
            if variables.get(name).is_some_and(|pinned| pinned != value) {
                bail!("runtime executable '{label}' mutates pinned OCI image variable '{name}'");
            }
        }
    }
    for (index, token) in tokens.iter().enumerate() {
        match token.as_str() {
            "read" | "unset" => {
                if tokens[index + 1..]
                    .iter()
                    .any(|name| variables.contains_key(name.trim_start_matches('-')))
                {
                    bail!("runtime executable '{label}' mutates a pinned OCI image variable");
                }
            }
            "for" | "select"
                if tokens
                    .get(index + 1)
                    .is_some_and(|name| variables.contains_key(name)) =>
            {
                bail!("runtime executable '{label}' iterates over a pinned OCI image variable");
            }
            "readarray" | "mapfile" | "getopts"
                if tokens[index + 1..]
                    .iter()
                    .any(|name| variables.contains_key(name.trim_start_matches('-'))) =>
            {
                bail!("runtime executable '{label}' mutates a pinned OCI image variable");
            }
            "printf"
                if tokens.get(index + 1).is_some_and(|token| token == "-v")
                    && tokens
                        .get(index + 2)
                        .is_some_and(|name| variables.contains_key(name)) =>
            {
                bail!("runtime executable '{label}' mutates a pinned OCI image variable");
            }
            _ => {}
        }
    }
    Ok(())
}

fn reject_indirect_image_execution(
    label: &str,
    tokens: &[String],
    inventory: &BTreeSet<&str>,
    variables: &BTreeMap<String, String>,
    reject_bare_dynamic_command: bool,
) -> Result<()> {
    for (index, token) in tokens.iter().enumerate() {
        let command = token.rsplit('/').next().unwrap_or(token);
        if command == "eval" {
            bail!("runtime executable '{label}' uses eval, so image execution cannot be proven");
        }
        if matches!(command, "sh" | "bash" | "dash" | "zsh") {
            let Some(command_index) = tokens[index + 1..]
                .iter()
                .position(|value| {
                    value
                        .strip_prefix('-')
                        .is_some_and(|flags| !flags.starts_with('-') && flags.contains('c'))
                })
                .map(|relative| index + 1 + relative + 1)
            else {
                continue;
            };
            let nested = tokens
                .get(command_index)
                .context("shell -c is missing its command string")?;
            if exact_shell_variable(nested).is_some()
                || nested.trim_start().starts_with("$(")
                || nested.contains('`')
            {
                bail!("runtime executable '{label}' dynamically constructs a {command} -c command");
            }
            for nested_command in logical_shell_commands(nested) {
                let nested_tokens = shell_tokens(&nested_command).with_context(|| {
                    format!("runtime executable '{label}' has ambiguous nested shell syntax")
                })?;
                validate_shell_image_consumers_inner(
                    label,
                    &nested_tokens,
                    inventory,
                    variables,
                    true,
                )?;
            }
        }
    }
    if reject_bare_dynamic_command
        && tokens
            .first()
            .is_some_and(|command| command.starts_with('$') || command.starts_with('`'))
    {
        bail!(
            "runtime executable '{label}' dynamically selects command '{}'",
            tokens[0]
        );
    }
    if tokens.windows(2).any(|pair| {
        (pair[0].starts_with('$') || pair[0].starts_with('`'))
            && matches!(
                pair[1].as_str(),
                "pull" | "run" | "create" | "copy" | "export"
            )
    }) {
        bail!("runtime executable '{label}' dynamically selects an image tool");
    }
    if let Some((_, pair)) = tokens.windows(2).enumerate().find(|(index, pair)| {
        (*index == 0
            || tokens
                .get(index.saturating_sub(1))
                .is_some_and(|wrapper| matches!(wrapper.as_str(), "env" | "command" | "exec")))
            && (pair[0].starts_with('$') || pair[0].starts_with('`'))
            && pair[1]
                .strip_prefix('-')
                .is_some_and(|flags| !flags.starts_with('-') && flags.contains('c'))
    }) {
        bail!(
            "runtime executable '{label}' dynamically selects a shell near '{}' '{}'",
            pair[0],
            pair[1]
        );
    }
    Ok(())
}

fn image_tool_name(token: &str) -> Option<&str> {
    let tool = token.rsplit('/').next().unwrap_or(token);
    matches!(
        tool,
        "docker"
            | "podman"
            | "nerdctl"
            | "ctr"
            | "crictl"
            | "oras"
            | "crane"
            | "skopeo"
            | "helm"
            | "kubectl"
            | "talosctl"
    )
    .then_some(tool)
}

fn validate_image_flags(
    label: &str,
    tokens: &[String],
    inventory: &BTreeSet<&str>,
    variables: &BTreeMap<String, String>,
) -> Result<()> {
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if let Some(image) = token.strip_prefix("--image=") {
            validate_consumed_image_reference(label, image, inventory, variables)?;
        } else if token == "--image" {
            let image = tokens
                .get(index + 1)
                .context("image flag is missing its value")?;
            validate_consumed_image_reference(label, image, inventory, variables)?;
            index += 1;
        }
        index += 1;
    }
    Ok(())
}

fn container_image_argument(tokens: &[String]) -> Result<&str> {
    first_positional(tokens, container_option_takes_value)
}

fn image_tool_action_index(tokens: &[String], start: usize) -> Result<Option<usize>> {
    let index = first_positional_index(&tokens[start..], container_option_takes_value)?
        .map(|index| start + index);
    if index.is_some_and(|index| tokens[index].contains(['$', '`'])) {
        bail!("image command dynamically selects its action");
    }
    Ok(index)
}

fn first_positional(tokens: &[String], option_takes_value: fn(&str) -> bool) -> Result<&str> {
    let index = first_positional_index(tokens, option_takes_value)?
        .context("image command has no positional image argument")?;
    Ok(tokens[index].as_str())
}

fn first_positional_index(
    tokens: &[String],
    option_takes_value: fn(&str) -> bool,
) -> Result<Option<usize>> {
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if token == "--" {
            return Ok(tokens.get(index + 1).map(|_| index + 1));
        }
        if token.starts_with('-') {
            if !token.contains('=') && option_takes_value(token) {
                if tokens.get(index + 1).is_none() {
                    bail!("image command option '{token}' is missing its value");
                }
                index += 2;
            } else if token.contains('=') || container_option_is_boolean(token) {
                index += 1;
            } else {
                bail!("image command uses unsupported option '{token}'");
            }
            continue;
        }
        return Ok(Some(index));
    }
    Ok(None)
}

fn container_option_takes_value(value: &str) -> bool {
    matches!(
        value,
        "--add-host"
            | "--annotation"
            | "--authfile"
            | "--blkio-weight"
            | "--cap-add"
            | "--cap-drop"
            | "--cgroup-parent"
            | "--cidfile"
            | "--config"
            | "--connection"
            | "--context"
            | "--cpu-period"
            | "--cpu-quota"
            | "--cpus"
            | "--cpuset-cpus"
            | "--device"
            | "--dns"
            | "--entrypoint"
            | "--env"
            | "--env-file"
            | "--gpus"
            | "--host"
            | "--hosts-dir"
            | "--identity"
            | "--jobs"
            | "--label"
            | "--log-level"
            | "--memory"
            | "--mount"
            | "--name"
            | "--network"
            | "--namespace"
            | "--platform"
            | "--publish"
            | "--pull"
            | "--restart"
            | "--runtime"
            | "--security-opt"
            | "--snapshotter"
            | "--src-creds"
            | "--storage-driver"
            | "--tlscacert"
            | "--tlscert"
            | "--tlskey"
            | "--url"
            | "--user"
            | "--volume"
            | "--workdir"
            | "-H"
            | "-e"
            | "-h"
            | "-l"
            | "-m"
            | "-p"
            | "-u"
            | "-v"
            | "-w"
    )
}

fn container_option_is_boolean(value: &str) -> bool {
    matches!(
        value,
        "--all"
            | "--all-tags"
            | "--debug"
            | "--detach"
            | "--disable-content-trust"
            | "--experimental"
            | "--insecure"
            | "--insecure-registry"
            | "--interactive"
            | "--plain-http"
            | "--preserve-digests"
            | "--privileged"
            | "--quiet"
            | "--read-only"
            | "--recursive"
            | "--rm"
            | "--tls"
            | "--tlsverify"
            | "--tty"
            | "-D"
            | "-a"
            | "-d"
            | "-i"
            | "-q"
            | "-t"
    )
}

fn validate_consumed_image_reference(
    label: &str,
    raw: &str,
    inventory: &BTreeSet<&str>,
    variables: &BTreeMap<String, String>,
) -> Result<()> {
    let raw = raw.trim();
    let resolved = if let Some(variable) = exact_shell_variable(raw) {
        variables.get(variable).with_context(|| {
            format!("runtime executable '{label}' uses dynamic OCI image reference '{raw}'")
        })?
    } else {
        if raw.contains(['$', '`']) {
            bail!("runtime executable '{label}' dynamically constructs OCI image '{raw}'");
        }
        raw.strip_prefix("docker://").unwrap_or(raw)
    };
    if is_internal_image_reference(resolved) {
        return Ok(());
    }
    validate_digest_pinned_image(resolved).with_context(|| {
        format!("runtime executable '{label}' uses mutable OCI image '{resolved}'")
    })?;
    if !inventory_contains_image(inventory, resolved) {
        bail!(
            "runtime executable '{label}' uses OCI image '{resolved}' which is absent from runtime/images.lock"
        );
    }
    Ok(())
}

fn exact_shell_variable(value: &str) -> Option<&str> {
    if let Some(name) = value
        .strip_prefix("${")
        .and_then(|rest| rest.strip_suffix('}'))
    {
        return is_shell_identifier(name).then_some(name);
    }
    let name = value.strip_prefix('$')?;
    is_shell_identifier(name).then_some(name)
}

fn is_shell_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn is_internal_image_reference(value: &str) -> bool {
    let registry = value.split('/').next().unwrap_or_default();
    registry == "localhost"
        || registry.starts_with("localhost:")
        || registry == "127.0.0.1"
        || registry.starts_with("127.0.0.1:")
        || registry == "[::1]"
        || registry.starts_with("[::1]:")
        || registry
            .split(':')
            .next()
            .is_some_and(|host| host.ends_with(".svc") || host.ends_with(".svc.cluster.local"))
}

fn yaml_image_scalar(line: &str) -> Option<&str> {
    let line = line.strip_prefix("- ").unwrap_or(line).trim_start();
    let value = line
        .strip_prefix("image:")
        .or_else(|| line.strip_prefix("'image':"))
        .or_else(|| line.strip_prefix("\"image\":"))?
        .trim();
    if value.is_empty() {
        return None;
    }
    Some(unquote_static_value(value))
}

fn inline_yaml_image_scalars(line: &str) -> Vec<&str> {
    let mut images = Vec::new();
    for key in ["image:", "'image':", "\"image\":"] {
        for (offset, _) in line.match_indices(key) {
            let prefix = &line[..offset];
            if !prefix
                .trim_end()
                .chars()
                .last()
                .is_some_and(|character| matches!(character, '{' | '[' | ','))
            {
                continue;
            }
            let value = line[offset + key.len()..].trim_start();
            if let Some(value) = flow_scalar(value) {
                images.push(value);
            }
        }
    }
    images
}

fn json_image_scalars(line: &str) -> Vec<&str> {
    let mut images = Vec::new();
    let mut remaining = line;
    while let Some(offset) = remaining.find("\"image\"") {
        remaining = &remaining[offset + "\"image\"".len()..];
        let Some(value) = remaining.trim_start().strip_prefix(':') else {
            continue;
        };
        let value = value.trim_start();
        let Some(value) = value.strip_prefix('"') else {
            continue;
        };
        let Some(end) = value.find('"') else {
            continue;
        };
        images.push(&value[..end]);
        remaining = &value[end + 1..];
    }
    images
}

fn flow_scalar(value: &str) -> Option<&str> {
    if let Some(value) = value.strip_prefix('"') {
        return value.find('"').map(|end| &value[..end]);
    }
    if let Some(value) = value.strip_prefix('\'') {
        return value.find('\'').map(|end| &value[..end]);
    }
    let end = value
        .find(|character: char| matches!(character, ',' | '}' | ']') || character.is_whitespace())
        .unwrap_or(value.len());
    (end > 0).then_some(&value[..end])
}

fn dockerfile_base_image(line: &str) -> Option<&str> {
    let mut words = line.split_ascii_whitespace();
    if !words.next()?.eq_ignore_ascii_case("from") {
        return None;
    }
    let mut image = words.next()?;
    if image.starts_with("--platform=") {
        image = words.next()?;
    }
    (image != "scratch").then_some(image)
}

fn unquote_static_value(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn logical_shell_commands(source: &str) -> Vec<String> {
    let mut commands = Vec::new();
    let mut current = String::new();
    for raw in source.lines() {
        let line = raw.trim_end();
        let continued = line.ends_with('\\');
        current.push_str(line.strip_suffix('\\').unwrap_or(line));
        if continued || shell_tokens(&current).is_err() {
            current.push(' ');
            continue;
        }
        commands.push(std::mem::take(&mut current));
    }
    if !current.is_empty() {
        commands.push(current);
    }
    commands
}

fn shell_tokens(source: &str) -> Result<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in source.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        match quote {
            Some('\'') => {
                if character == '\'' {
                    quote = None;
                } else {
                    current.push(character);
                }
            }
            Some('"') => match character {
                '"' => quote = None,
                '\\' => escaped = true,
                _ => current.push(character),
            },
            Some(_) => unreachable!(),
            None => match character {
                '\'' | '"' => quote = Some(character),
                '\\' => escaped = true,
                '#' if current.is_empty() => break,
                ';' | '|' | '&' | '(' | ')' => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                    if tokens
                        .last()
                        .is_none_or(|token| token != SHELL_COMMAND_SEPARATOR)
                    {
                        tokens.push(SHELL_COMMAND_SEPARATOR.to_owned());
                    }
                }
                value if value.is_whitespace() => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                _ => current.push(character),
            },
        }
    }
    if escaped || quote.is_some() {
        bail!("unterminated quote or escape");
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Ok(tokens)
}

fn strip_shell_comment(line: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    let mut at_word_start = true;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
            at_word_start = false;
            continue;
        }
        match quote {
            Some('\'') => {
                if character == '\'' {
                    quote = None;
                }
            }
            Some('"') => match character {
                '"' => quote = None,
                '\\' => escaped = true,
                _ => {}
            },
            Some(_) => unreachable!(),
            None => match character {
                '\'' | '"' => {
                    quote = Some(character);
                    at_word_start = false;
                }
                '\\' => {
                    escaped = true;
                    at_word_start = false;
                }
                '#' if at_word_start => return &line[..index],
                value => at_word_start = value.is_whitespace(),
            },
        }
    }
    line
}

fn read_runtime_script(root: &Path, relative: &str) -> Result<Vec<u8>> {
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("failed to inspect runtime script '{}'", path.display()))?;
    if !metadata.file_type().is_file() {
        bail!("runtime script '{}' is not a regular file", path.display());
    }
    let bytes = fs::read(&path)
        .with_context(|| format!("failed to read runtime script '{}'", path.display()))?;
    std::str::from_utf8(&bytes)
        .with_context(|| format!("runtime script '{relative}' must contain valid UTF-8"))?;
    Ok(bytes)
}

fn is_oci_token_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '/' | ':' | '@')
}

fn inventory_contains_image(inventory: &BTreeSet<&str>, value: &str) -> bool {
    let Ok(expected) = canonical_digest_identity(value) else {
        return false;
    };
    inventory.iter().any(|candidate| {
        canonical_digest_identity(candidate).is_ok_and(|candidate| candidate == expected)
    })
}

fn canonical_digest_identity(value: &str) -> Result<(String, &str)> {
    validate_digest_pinned_image(value)?;
    let (name, digest) = value
        .split_once("@sha256:")
        .context("validated OCI image is missing its digest")?;
    let repository = if let Some((prefix, tail)) = name.rsplit_once('/') {
        let tail = tail
            .split_once(':')
            .map_or(tail, |(repository, _)| repository);
        format!("{prefix}/{tail}")
    } else {
        name.split_once(':')
            .map_or_else(|| name.to_owned(), |(repository, _)| repository.to_owned())
    };
    let canonical = if let Some((registry, rest)) = repository.split_once('/') {
        if registry.contains('.') || registry.contains(':') || registry == "localhost" {
            let registry = if registry == "index.docker.io" {
                "docker.io"
            } else {
                registry
            };
            if registry == "docker.io" && !rest.contains('/') {
                format!("{registry}/library/{rest}")
            } else {
                format!("{registry}/{rest}")
            }
        } else {
            format!("docker.io/{repository}")
        }
    } else {
        format!("docker.io/library/{repository}")
    };
    Ok((canonical, digest))
}

fn validate_digest_pinned_image(value: &str) -> Result<()> {
    let Some((name, digest)) = value.split_once("@sha256:") else {
        bail!("external image '{value}' is not pinned by SHA-256");
    };
    if name.is_empty()
        || name.len() > 255
        || name.starts_with(['.', '-', '/', ':'])
        || name.ends_with(['.', '-', '/', ':'])
        || name.contains("//")
        || !name.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-' | b'/' | b':')
        })
    {
        bail!("external image '{value}' has an invalid OCI repository name");
    }
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        bail!("external image '{value}' has an invalid SHA-256 digest");
    }
    Ok(())
}

fn deterministic_archive(
    entries: BTreeMap<String, Vec<u8>>,
    compression: RuntimeBundleCompression,
) -> Result<Vec<u8>> {
    match compression {
        RuntimeBundleCompression::None => write_tar(Vec::new(), entries),
        RuntimeBundleCompression::Gzip => {
            let encoder = flate2::GzBuilder::new()
                .mtime(0)
                .write(Vec::new(), flate2::Compression::best());
            let encoder = write_tar(encoder, entries)?;
            encoder
                .finish()
                .context("failed to finish runtime gzip bundle")
        }
        RuntimeBundleCompression::Zstd => {
            let encoder = zstd::stream::write::Encoder::new(Vec::new(), 19)
                .context("failed to create runtime zstd encoder")?;
            let encoder = write_tar(encoder, entries)?;
            encoder
                .finish()
                .context("failed to finish runtime zstd bundle")
        }
    }
}

fn write_tar<W: std::io::Write>(writer: W, entries: BTreeMap<String, Vec<u8>>) -> Result<W> {
    let mut archive = Builder::new(writer);
    archive.mode(HeaderMode::Deterministic);
    for (path, bytes) in entries {
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Regular);
        header.set_size(u64::try_from(bytes.len()).context("runtime bundle entry is too large")?);
        header.set_mode(if path.ends_with(".sh") { 0o700 } else { 0o600 });
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_cksum();
        archive
            .append_data(&mut header, path, Cursor::new(bytes))
            .context("failed to append runtime bundle entry")?;
    }
    archive
        .into_inner()
        .context("failed to finish runtime tar bundle")
}

fn read_private_key_file(path: &Path) -> Result<[u8; 32]> {
    let path_metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect runtime signing key '{}'", path.display()))?;
    if !path_metadata.file_type().is_file() {
        bail!(
            "runtime signing key '{}' is not a regular file",
            path.display()
        );
    }
    let mut file = fs::File::open(path)
        .with_context(|| format!("failed to open runtime signing key '{}'", path.display()))?;
    let metadata = file.metadata().with_context(|| {
        format!(
            "failed to inspect open runtime signing key '{}'",
            path.display()
        )
    })?;
    if metadata.len() == 0 || metadata.len() > MAX_SIGNING_KEY_FILE_BYTES {
        bail!(
            "runtime signing key '{}' has an invalid size",
            path.display()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        if path_metadata.dev() != metadata.dev() || path_metadata.ino() != metadata.ino() {
            bail!(
                "runtime signing key '{}' changed while it was being opened",
                path.display()
            );
        }
        let caller_uid = rustix::process::getuid().as_raw();
        let caller_gid = rustix::process::getgid().as_raw();
        #[cfg(target_os = "linux")]
        let has_access_acl = {
            use xattr::FileExt as _;

            file.get_xattr("system.posix_acl_access")
                .with_context(|| {
                    format!(
                        "failed to inspect runtime signing key ACLs '{}'",
                        path.display()
                    )
                })?
                .is_some()
        };
        #[cfg(not(target_os = "linux"))]
        let has_access_acl = false;
        if !private_key_permissions_are_safe(
            metadata.permissions().mode(),
            metadata.uid(),
            metadata.gid(),
            metadata.nlink(),
            caller_uid,
            caller_gid,
            has_access_acl,
        ) {
            bail!(
                "runtime signing key '{}' must have one link and no access ACL, and be caller-owned mode 0600 or root-owned mode 0640 for the caller's non-root primary group",
                path.display()
            );
        }
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
    file.read_to_end(&mut bytes)
        .with_context(|| format!("failed to read runtime signing key '{}'", path.display()))?;
    if bytes.len() == 32 {
        return bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("runtime signing key has an invalid length"));
    }
    decode_base64_seed(trim_ascii(&bytes))
        .with_context(|| format!("runtime signing key '{}' is invalid", path.display()))
}

#[cfg(unix)]
fn private_key_permissions_are_safe(
    mode: u32,
    owner_uid: u32,
    owner_gid: u32,
    link_count: u64,
    caller_uid: u32,
    caller_gid: u32,
    has_access_acl: bool,
) -> bool {
    if link_count != 1 || has_access_acl {
        return false;
    }
    let permissions = mode & 0o777;
    (owner_uid == caller_uid && permissions == 0o600)
        || (owner_uid == 0 && caller_gid != 0 && owner_gid == caller_gid && permissions == 0o640)
}

fn decode_base64_seed(encoded: &[u8]) -> Result<[u8; 32]> {
    let decoded = BASE64_STANDARD
        .decode(encoded)
        .context("private key must be a standard-base64 Ed25519 seed")?;
    decoded
        .try_into()
        .map_err(|_| anyhow::anyhow!("private key must decode to exactly 32 bytes"))
}

fn trim_ascii(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(u8::is_ascii_whitespace) {
        value = &value[1..];
    }
    while value.last().is_some_and(u8::is_ascii_whitespace) {
        value = &value[..value.len() - 1];
    }
    value
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Read;
    use std::path::PathBuf;

    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
    use ed25519_dalek::{Signature, Verifier as _};

    use super::*;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../intar-workshop-manifest/tests/fixtures/platform-engineering-workshop")
    }

    fn signer() -> RuntimeBundleSigner {
        RuntimeBundleSigner {
            key_id: "runtime-test-v1".to_owned(),
            key: SigningKey::from_bytes(&[7; 32]),
        }
    }

    fn unpack(bytes: &[u8], compression: RuntimeBundleCompression) -> BTreeMap<String, Vec<u8>> {
        let reader: Box<dyn Read> = match compression {
            RuntimeBundleCompression::None => Box::new(Cursor::new(bytes)),
            RuntimeBundleCompression::Gzip => {
                Box::new(flate2::read::GzDecoder::new(Cursor::new(bytes)))
            }
            RuntimeBundleCompression::Zstd => {
                Box::new(zstd::stream::read::Decoder::new(Cursor::new(bytes)).unwrap())
            }
        };
        let mut archive = tar::Archive::new(reader);
        archive
            .entries()
            .unwrap()
            .map(|entry| {
                let mut entry = entry.unwrap();
                let path = entry.path().unwrap().to_string_lossy().into_owned();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                (path, bytes)
            })
            .collect()
    }

    #[test]
    fn bundle_is_deterministic_signed_and_learner_safe() {
        let root = fixture();
        let workshop = intar_workshop_manifest::load_and_validate(&root).unwrap();
        let modules = workshop.manifest.modules.iter().collect::<Vec<_>>();
        let signer = signer();
        let first = produce_runtime_bundle(
            &root,
            &workshop,
            &modules,
            1,
            RuntimeBundleCompression::Zstd,
            &signer,
        )
        .unwrap();
        let second = produce_runtime_bundle(
            &root,
            &workshop,
            &modules,
            1,
            RuntimeBundleCompression::Zstd,
            &signer,
        )
        .unwrap();
        assert_eq!(first.bytes, second.bytes);
        assert_eq!(first.artifact, second.artifact);

        let signature = BASE64_STANDARD
            .decode(&first.artifact.signature_b64)
            .unwrap();
        signer
            .verifying_key()
            .verify(&first.bytes, &Signature::from_slice(&signature).unwrap())
            .unwrap();

        let entries = unpack(&first.bytes, RuntimeBundleCompression::Zstd);
        let mut expected_entries = vec!["checkpoint.json".to_owned()];
        expected_entries.extend(
            modules
                .iter()
                .map(|module| format!("probes/{}/verify.sh", module.id)),
        );
        expected_entries.extend([
            "runtime/bootstrap.sh".to_owned(),
            "runtime/images.lock".to_owned(),
            "runtime/root/LICENSE".to_owned(),
            "runtime/root/fixture.txt".to_owned(),
            "runtime/root/scripts/images.lock".to_owned(),
            "scripts/00/catch-up.sh".to_owned(),
            "scripts/01/catch-up.sh".to_owned(),
        ]);
        assert_eq!(
            entries.keys().cloned().collect::<Vec<_>>(),
            expected_entries
        );
        let all = entries.values().flatten().copied().collect::<Vec<_>>();
        let all = String::from_utf8(all).unwrap();
        assert!(!all.contains("facilitator/module-"));
        assert!(!all.contains("Canonical solution"));
        assert!(!all.contains("PRIVATE KEY"));
        assert!(!entries.keys().any(|path| {
            path.contains("solution")
                || path.contains("facilitator")
                || path.contains("layer")
                || path.ends_with(".tar")
        }));
        let manifest: serde_json::Value =
            serde_json::from_slice(entries.get("checkpoint.json").unwrap()).unwrap();
        assert_eq!(manifest["schema_version"], 3);
        assert_eq!(
            manifest["install_root"],
            "/opt/intar-workshops/platform-engineering-workshop"
        );
        assert_eq!(manifest["runtime_files"][0]["install_path"], "LICENSE");
        assert_eq!(manifest["runtime_files"][1]["install_path"], "fixture.txt");
        assert_eq!(
            entries.get("runtime/root/LICENSE").unwrap(),
            &fs::read(root.join("LICENSE")).unwrap()
        );
        assert_eq!(
            manifest["probe_verifiers"].as_array().unwrap().len(),
            modules.len()
        );
        assert_eq!(manifest["probe_verifiers"][0]["module_id"], "00");
        assert_eq!(
            manifest["apply_steps"][0]["verify_script"],
            "probes/00/verify.sh"
        );
        assert_eq!(
            manifest["external_images"][0],
            format!(
                "registry.example.invalid/intar/fixture@sha256:{}",
                "a".repeat(64)
            )
        );
    }

    #[test]
    fn platform_reference_bundles_reconstruct_ordered_checkpoint_prefixes() {
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workshops/platform-engineering");
        let workshop = intar_workshop_manifest::load_and_validate(&root).unwrap();
        let modules = workshop.manifest.modules.iter().collect::<Vec<_>>();
        let checkpoint_09_index = modules
            .iter()
            .position(|module| module.checkpoint == "checkpoint-09")
            .unwrap();
        let checkpoint_09 = produce_runtime_bundle(
            &root,
            &workshop,
            &modules,
            checkpoint_09_index,
            RuntimeBundleCompression::None,
            &signer(),
        )
        .unwrap();
        assert_eq!(
            checkpoint_09.covered_module_ids,
            ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]
        );
        let checkpoint_09_entries = unpack(&checkpoint_09.bytes, RuntimeBundleCompression::None);
        let checkpoint_09_manifest: serde_json::Value =
            serde_json::from_slice(checkpoint_09_entries.get("checkpoint.json").unwrap()).unwrap();
        let checkpoint_09_steps = checkpoint_09_manifest["apply_steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| step["module_id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            checkpoint_09_steps,
            ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]
        );
        assert!(checkpoint_09_entries.contains_key("scripts/07/catch-up.sh"));

        let checkpoint_10 = produce_runtime_bundle(
            &root,
            &workshop,
            &modules,
            modules.len() - 1,
            RuntimeBundleCompression::None,
            &signer(),
        )
        .unwrap();
        assert_eq!(
            checkpoint_10.covered_module_ids,
            [
                "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"
            ]
        );

        assert!(checkpoint_10.bytes.len() > 1_000_000);
        assert_eq!(checkpoint_10.artifact.sha256.len(), 64);
        assert_eq!(checkpoint_10.artifact.signing_key_id, "runtime-test-v1");
        let entries = unpack(&checkpoint_10.bytes, RuntimeBundleCompression::None);
        assert_eq!(
            entries.get("runtime/root/LICENSE").unwrap(),
            &fs::read(root.join("LICENSE")).unwrap()
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(entries.get("checkpoint.json").unwrap()).unwrap();
        let checkpoint_10_steps = manifest["apply_steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| step["module_id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            checkpoint_10_steps,
            [
                "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"
            ]
        );
        for module_id in ["03", "04", "05", "06", "07", "08", "09"] {
            assert!(entries.contains_key(&format!("scripts/{module_id}/catch-up.sh")));
        }
    }

    #[test]
    fn executable_images_must_be_exactly_digest_locked() {
        let locked = format!("registry.example:5000/team/app@sha256:{}", "a".repeat(64));
        let images = BTreeSet::from([locked.as_str()]);
        validate_executable_image_references(
            "test.sh",
            format!("docker pull {locked}\n").as_bytes(),
            &images,
            &BTreeMap::new(),
        )
        .unwrap();
        validate_executable_image_references(
            "test.sh",
            format!("skopeo copy docker://{locked} docker://localhost:30500/team/app:v1\n")
                .as_bytes(),
            &images,
            &BTreeMap::new(),
        )
        .unwrap();
        validate_executable_image_references(
            "test.sh",
            format!("docker --config /tmp/intar-docker image pull {locked}\n").as_bytes(),
            &images,
            &BTreeMap::new(),
        )
        .unwrap();

        for source in [
            "docker pull alpine\n",
            "docker pull alpine:latest\n",
            "docker --config /tmp/intar-docker pull alpine:latest\n",
            "docker pull registry.example:5000/team/app:latest\n",
            "docker pull \"$IMAGE\"\n",
            "ACTION=pull; docker \"$ACTION\" alpine:latest\n",
            "DOCKER=docker; \"$DOCKER\" pull alpine:latest\n",
            "\"$DOCKER\" pull alpine:latest\n",
            "env \"$DOCKER\" pull alpine:latest\n",
            "eval 'docker pull alpine:latest'\n",
            "bash -c 'docker pull alpine:latest'\n",
            "bash -lc 'docker pull alpine:latest'\n",
            "bash -c 'true; $CMD'\n",
            "CMD='docker pull alpine:latest'; bash -c \"$CMD\"\n",
            "SHELL=bash; \"$SHELL\" -c 'docker pull alpine:latest'\n",
            "docker run --gpus registry.example:5000/team/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa alpine:latest\n",
            "docker --unknown-option value pull registry.example:5000/team/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
            "docker pull registry.example:5000/team/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa && docker pull alpine:latest\n",
            "kubectl run demo --image=registry.other.invalid/team/app:latest\n",
            "kubectl set image deployment/demo app=alpine:latest\n",
            "kubectl patch deployment/demo -p '{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"image\":\"alpine:latest\"}]}}}}'\n",
            "kubectl patch deployment/demo --patch-file patch.json\n",
            "helm upgrade demo ./chart --set image.tag=latest\n",
            "crane copy --insecure registry.other.invalid/team/app:latest localhost:30500/team/app:v1\n",
            "skopeo copy docker://registry.other.invalid/team/app:latest docker://localhost:30500/team/app:v1\n",
        ] {
            assert!(
                validate_executable_image_references(
                    "test.sh",
                    source.as_bytes(),
                    &images,
                    &BTreeMap::new(),
                )
                .is_err(),
                "unsafe pull was accepted: {source}"
            );
        }

        let other = format!("registry.other.invalid/team/app@sha256:{}", "b".repeat(64));
        assert!(
            validate_executable_image_references(
                "test.sh",
                format!("crane pull {other} image.tar\n").as_bytes(),
                &images,
                &BTreeMap::new(),
            )
            .is_err()
        );
    }

    #[test]
    fn executable_image_variables_must_resolve_to_one_locked_literal() {
        let locked = format!(
            "registry.example.invalid/team/talos@sha256:{}",
            "c".repeat(64)
        );
        let images = BTreeSet::from([locked.as_str()]);
        let sources = vec![(
            "versions.env".to_owned(),
            format!("TALOS_IMAGE=\"{locked}\"\n"),
            false,
        )];
        let variables = collect_literal_pinned_image_variables(&sources, &images).unwrap();
        validate_executable_image_references(
            "create.sh",
            b"talosctl cluster create docker --image \"${TALOS_IMAGE}\"\n",
            &images,
            &variables,
        )
        .unwrap();

        for source in [
            "talosctl cluster create docker --image \"${REGISTRY}/${IMAGE}:latest\"\n",
            "docker pull \"${IMAGE:-alpine:latest}\"\n",
            "kubectl run demo --image \"$(resolve-image)\"\n",
            "TALOS_IMAGE=alpine:latest; docker pull \"$TALOS_IMAGE\"\n",
            "for TALOS_IMAGE in alpine:latest; do docker pull \"$TALOS_IMAGE\"; done\n",
            "mapfile -t TALOS_IMAGE < images.txt; docker pull \"$TALOS_IMAGE\"\n",
        ] {
            assert!(
                validate_executable_image_references(
                    "create.sh",
                    source.as_bytes(),
                    &images,
                    &variables,
                )
                .is_err(),
                "dynamic image was accepted: {source}"
            );
        }
        let conflicting_sources = vec![
            sources[0].clone(),
            (
                "override.sh".to_owned(),
                "TALOS_IMAGE=alpine:latest\n".to_owned(),
                true,
            ),
        ];
        assert!(collect_literal_pinned_image_variables(&conflicting_sources, &images).is_err());
    }

    #[test]
    fn image_lock_fails_closed_on_tags_and_duplicate_entries() {
        assert!(parse_image_lock(b"docker.io/library/busybox:1.37.0\n").is_err());
        let reference = format!("docker.io/library/busybox@sha256:{}", "a".repeat(64));
        assert!(parse_image_lock(format!("{reference}\n{reference}\n").as_bytes()).is_err());
    }

    #[test]
    fn learner_source_rejects_solution_paths_symlinks_and_unlocked_images() {
        assert!(validate_runtime_relative_path(Path::new("solutions/module-01.sh")).is_err());
        assert!(validate_runtime_relative_path(Path::new("lab/01/solve.sh")).is_err());
        let canonical = format!("docker.io/library/nats@sha256:{}", "b".repeat(64));
        let inventory = BTreeSet::from([canonical.as_str()]);
        assert!(
            validate_runtime_image_references(
                "image: docker.io/library/busybox:1.37.0",
                &inventory
            )
            .is_err()
        );
        assert!(
            validate_runtime_image_references(
                &format!("image: docker.io/library/busybox@sha256:{}", "a".repeat(64)),
                &inventory
            )
            .is_err()
        );
        assert!(
            validate_runtime_image_references(
                "image: registry.example.invalid/team/app:latest",
                &inventory
            )
            .is_err()
        );
        assert!(validate_runtime_image_references("image: alpine:latest", &inventory).is_err());
        assert!(
            validate_runtime_image_references(
                "containers: [{name: app, image: alpine:latest}]",
                &inventory
            )
            .is_err()
        );
        assert!(
            validate_runtime_image_references(
                "{\"containers\":[{\"image\":\"alpine:latest\"}]}",
                &inventory
            )
            .is_err()
        );
        assert!(
            validate_runtime_image_references(
                "containers: [{'image': 'alpine:latest'}]",
                &inventory
            )
            .is_err()
        );
        assert!(
            validate_runtime_image_references(
                "containers: [{\"image\": alpine:latest}]",
                &inventory
            )
            .is_err()
        );
        assert!(validate_runtime_image_references("'image': alpine:latest", &inventory).is_err());
        assert!(validate_runtime_image_references("\"image\": alpine:latest", &inventory).is_err());
        assert!(
            validate_runtime_image_references("image: localhost:30500/learner-app:v1", &inventory)
                .is_ok()
        );
        validate_runtime_image_references(
            &format!("image: nats:2.12.12@sha256:{}", "b".repeat(64)),
            &inventory,
        )
        .unwrap();
        validate_runtime_image_references(
            &format!("image: docker.io/nats@sha256:{}", "b".repeat(64)),
            &inventory,
        )
        .unwrap();
        validate_split_image_blocks(
            "values.sh",
            &format!(
                "image:\n  registry: docker.io\n  repository: library/nats\n  tag: \"\"\n  digest: sha256:{}\n",
                "b".repeat(64)
            ),
            &inventory,
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(
            validate_split_image_blocks(
                "values.sh",
                &format!(
                    "image:\n  registry: docker.io\n  repository: library/nats\n  tag: latest\n  digest: sha256:{}\n",
                    "c".repeat(64)
                ),
                &inventory,
                &BTreeMap::new(),
            )
            .is_err()
        );
        assert!(validate_dockerfile_image_references("FROM alpine:latest\n", &inventory).is_err());
        validate_dockerfile_image_references(
            "FROM zot.zot.svc.cluster.local:5000/library/learner:v1\n",
            &inventory,
        )
        .unwrap();
        assert!(!is_internal_image_reference(
            "registry.svc.example.com/team/app:latest"
        ));
    }

    #[test]
    fn reads_raw_or_base64_private_seed_from_locked_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("signing-key");
        fs::write(&path, BASE64_STANDARD.encode([9; 32])).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(read_private_key_file(&path).unwrap(), [9; 32]);
        fs::write(&path, [8; 32]).unwrap();
        assert_eq!(read_private_key_file(&path).unwrap(), [8; 32]);
    }

    #[cfg(unix)]
    #[test]
    fn accepts_only_owner_or_root_group_read_signing_key_modes() {
        assert!(private_key_permissions_are_safe(
            0o600, 1_000, 1_000, 1, 1_000, 1_000, false
        ));
        assert!(private_key_permissions_are_safe(
            0o640, 0, 1_000, 1, 1_000, 1_000, false
        ));

        assert!(!private_key_permissions_are_safe(
            0o640, 0, 2_000, 1, 1_000, 1_000, false
        ));
        assert!(!private_key_permissions_are_safe(
            0o640, 0, 0, 1, 0, 0, false
        ));
        assert!(!private_key_permissions_are_safe(
            0o640, 1_000, 1_000, 1, 1_000, 1_000, false
        ));
        assert!(!private_key_permissions_are_safe(
            0o660, 0, 1_000, 1, 1_000, 1_000, false
        ));
        assert!(!private_key_permissions_are_safe(
            0o604, 1_000, 1_000, 1, 1_000, 1_000, false
        ));
        assert!(!private_key_permissions_are_safe(
            0o600, 1_000, 1_000, 2, 1_000, 1_000, false
        ));
        assert!(!private_key_permissions_are_safe(
            0o600, 1_000, 1_000, 1, 1_000, 1_000, true
        ));
    }

    #[test]
    fn serializes_the_registry_runtime_bundle_report_contract() {
        let report = RuntimeBundleArtifact {
            sha256: "a".repeat(64),
            compression: RuntimeBundleCompression::Gzip,
            signature_b64: BASE64_STANDARD.encode([3_u8; 64]),
            signing_key_id: "workshop-runtime-v2".to_owned(),
            workspace_agent_sha256: Some("b".repeat(64)),
        };
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            serde_json::json!({
                "sha256": "a".repeat(64),
                "compression": "gzip",
                "signature_b64": BASE64_STANDARD.encode([3_u8; 64]),
                "signing_key_id": "workshop-runtime-v2",
                "workspace_agent_sha256": "b".repeat(64),
            })
        );
    }
}
