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

/// Loaded signer for one builder process. The secret key is intentionally not
/// `Debug`, serialized, cloned, or placed in a publication report.
pub(crate) struct RuntimeBundleSigner {
    key_id: String,
    key: SigningKey,
}

pub(crate) struct ProducedRuntimeBundle {
    pub bytes: Vec<u8>,
    pub artifact: RuntimeBundleArtifact,
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

    pub(crate) fn verifying_key_b64(&self) -> String {
        BASE64_STANDARD.encode(self.key.verifying_key().to_bytes())
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
    let included = dependency_closure(ordered_modules, target)?;
    let mut entries = BTreeMap::new();
    let mut steps = Vec::with_capacity(included.len());
    let mut probe_verifiers = Vec::with_capacity(ordered_modules.len());
    let runtime = collect_runtime_source(root, &mut entries)?;
    let external_images = runtime
        .external_images
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();

    for module in ordered_modules {
        let verifier_archive_path = format!("probes/{}/verify.sh", module.id);
        let verify = read_runtime_script(root, &module.verify_script)?;
        collect_digest_pinned_images(&verify, &mut BTreeSet::new())
            .with_context(|| format!("invalid image reference in '{}'", module.verify_script))?;
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
        collect_digest_pinned_images(&catch_up, &mut BTreeSet::new())
            .with_context(|| format!("invalid image reference in '{}'", module.catch_up_script))?;
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
    })
}

struct CollectedRuntimeSource {
    install_root: String,
    files: Vec<ReconstructionFile>,
    external_images: Vec<String>,
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
    std::str::from_utf8(&bootstrap).context("runtime/bootstrap.sh must contain valid UTF-8")?;
    entries.insert(RUNTIME_BOOTSTRAP_PATH.to_owned(), bootstrap);

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

    Ok(CollectedRuntimeSource {
        install_root: config.install_root,
        files,
        external_images,
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
        if !REGISTRIES
            .iter()
            .any(|registry| token.starts_with(registry))
        {
            continue;
        }
        let has_tag = token
            .rsplit('/')
            .next()
            .is_some_and(|tail| tail.contains(':'));
        if !has_tag && !token.contains("@sha256:") {
            continue;
        }
        if !token.contains("@sha256:") {
            bail!("tag-only OCI reference '{token}' is forbidden");
        }
        validate_digest_pinned_image(token)?;
        if !inventory.contains(token) {
            bail!("OCI reference '{token}' is absent from runtime/images.lock");
        }
    }
    Ok(())
}

fn dependency_closure<'a>(
    ordered_modules: &'a [&'a Module],
    target: &Module,
) -> Result<Vec<&'a Module>> {
    let by_id = ordered_modules
        .iter()
        .map(|module| (module.id.as_str(), *module))
        .collect::<BTreeMap<_, _>>();
    let mut required = BTreeSet::new();
    let mut pending = vec![target.id.as_str()];
    while let Some(module_id) = pending.pop() {
        if !required.insert(module_id) {
            continue;
        }
        let module = by_id
            .get(module_id)
            .with_context(|| format!("runtime bundle references unknown module '{module_id}'"))?;
        pending.extend(module.depends_on.iter().map(String::as_str));
    }
    Ok(ordered_modules
        .iter()
        .copied()
        .filter(|module| required.contains(module.id.as_str()))
        .collect())
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

fn collect_digest_pinned_images(bytes: &[u8], output: &mut BTreeSet<String>) -> Result<()> {
    let source = std::str::from_utf8(bytes).context("runtime script is not UTF-8")?;
    for token in source.split(|character: char| !is_oci_token_character(character)) {
        if !token.contains("@sha256:") {
            continue;
        }
        validate_digest_pinned_image(token)?;
        output.insert(token.to_owned());
    }
    Ok(())
}

fn is_oci_token_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '/' | ':' | '@')
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
    fn platform_reference_bundle_is_reconstructible_and_inventory_closed() {
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workshops/platform-engineering");
        let workshop = intar_workshop_manifest::load_and_validate(&root).unwrap();
        let modules = workshop.manifest.modules.iter().collect::<Vec<_>>();
        let produced = produce_runtime_bundle(
            &root,
            &workshop,
            &modules,
            modules.len() - 1,
            RuntimeBundleCompression::None,
            &signer(),
        )
        .unwrap();

        assert!(produced.bytes.len() > 1_000_000);
        assert_eq!(produced.artifact.sha256.len(), 64);
        assert_eq!(produced.artifact.signing_key_id, "runtime-test-v1");
        let entries = unpack(&produced.bytes, RuntimeBundleCompression::None);
        assert_eq!(
            entries.get("runtime/root/LICENSE").unwrap(),
            &fs::read(root.join("LICENSE")).unwrap()
        );
    }

    #[test]
    fn extracts_only_valid_digest_pinned_external_images() {
        let digest = "a".repeat(64);
        let mut images = BTreeSet::new();
        collect_digest_pinned_images(
            format!("pull registry.example:5000/team/app@sha256:{digest}\n").as_bytes(),
            &mut images,
        )
        .unwrap();
        assert_eq!(
            images.into_iter().collect::<Vec<_>>(),
            vec![format!("registry.example:5000/team/app@sha256:{digest}")]
        );
        assert!(
            collect_digest_pinned_images(
                b"pull example/app@sha256:not-a-digest",
                &mut BTreeSet::new()
            )
            .is_err()
        );
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
        let inventory = BTreeSet::new();
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
