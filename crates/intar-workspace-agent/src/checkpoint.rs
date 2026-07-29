use crate::model::{CheckpointCompression, CheckpointDescriptor};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use futures_util::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PROBE_VERIFIER_ROOT: &str = "/var/lib/intar-workspace-agent/probes";
const RECONSTRUCTION_SHELL: &str = "/bin/bash";

pub struct StagedCheckpoint {
    _temporary: TempDir,
    checkpoint_id: String,
    root: PathBuf,
}

impl StagedCheckpoint {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn checkpoint_id(&self) -> &str {
        &self.checkpoint_id
    }
}

pub trait CheckpointApplier: Send + Sync {
    fn apply<'a>(
        &'a self,
        checkpoint: &'a StagedCheckpoint,
    ) -> Pin<Box<dyn Future<Output = Result<(), CheckpointError>> + Send + 'a>>;
}

#[derive(Clone, Debug)]
pub struct CommandCheckpointApplier {
    program: PathBuf,
}

#[derive(Clone, Debug, Default)]
pub struct BuiltinCheckpointApplier;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconstructionManifest {
    schema_version: u8,
    workshop_slug: String,
    checkpoint_id: String,
    install_root: PathBuf,
    bootstrap_script: PathBuf,
    runtime_files: Vec<ReconstructionFile>,
    apply_steps: Vec<ReconstructionStep>,
    probe_verifiers: Vec<ReconstructionProbeVerifier>,
    external_images: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconstructionFile {
    archive_path: PathBuf,
    install_path: PathBuf,
    sha256: String,
    mode: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconstructionStep {
    module_id: String,
    catch_up_script: PathBuf,
    verify_script: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconstructionProbeVerifier {
    module_id: String,
    verifier_script: PathBuf,
    probe_ids: Vec<String>,
}

impl CommandCheckpointApplier {
    pub fn new(program: PathBuf) -> Self {
        Self { program }
    }
}

impl CheckpointApplier for CommandCheckpointApplier {
    fn apply<'a>(
        &'a self,
        checkpoint: &'a StagedCheckpoint,
    ) -> Pin<Box<dyn Future<Output = Result<(), CheckpointError>> + Send + 'a>> {
        Box::pin(async move {
            let status = tokio::process::Command::new(&self.program)
                .arg("--checkpoint-id")
                .arg(checkpoint.checkpoint_id())
                .arg("--staged-root")
                .arg(checkpoint.root())
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .kill_on_drop(true)
                .status()
                .await
                .map_err(|source| CheckpointError::ApplyStart {
                    program: self.program.clone(),
                    source,
                })?;
            if !status.success() {
                return Err(CheckpointError::ApplyFailed {
                    program: self.program.clone(),
                    status: status.to_string(),
                });
            }
            Ok(())
        })
    }
}

impl CheckpointApplier for BuiltinCheckpointApplier {
    fn apply<'a>(
        &'a self,
        checkpoint: &'a StagedCheckpoint,
    ) -> Pin<Box<dyn Future<Output = Result<(), CheckpointError>> + Send + 'a>> {
        Box::pin(async move { apply_reconstruction_bundle(checkpoint).await })
    }
}

pub async fn download_and_stage(
    client: &reqwest::Client,
    descriptor: &CheckpointDescriptor,
    tmpfs_root: &Path,
    max_checkpoint_bytes: u64,
    trusted_signing_keys: &BTreeMap<String, String>,
) -> Result<StagedCheckpoint, CheckpointError> {
    fs::create_dir_all(tmpfs_root).map_err(|source| CheckpointError::CreateTmpfsRoot {
        path: tmpfs_root.to_path_buf(),
        source,
    })?;

    let temporary = tempfile::Builder::new()
        .prefix("checkpoint-")
        .tempdir_in(tmpfs_root)
        .map_err(|source| CheckpointError::CreateTmpfsRoot {
            path: tmpfs_root.to_path_buf(),
            source,
        })?;
    let archive_path = temporary.path().join("bundle.tar");

    let response = client
        .get(descriptor.signed_url.expose())
        .send()
        .await
        .map_err(|source| CheckpointError::Download { source })?
        .error_for_status()
        .map_err(|source| CheckpointError::Download { source })?;

    if let Some(length) = response.content_length()
        && (length != descriptor.size_bytes || length > max_checkpoint_bytes)
    {
        return Err(CheckpointError::UnexpectedDownloadSize {
            expected: descriptor.size_bytes,
            actual: length,
        });
    }

    let mut output = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&archive_path)
        .await
        .map_err(|source| CheckpointError::WriteArchive {
            path: archive_path.clone(),
            source,
        })?;
    let mut hasher = Sha256::new();
    let mut bytes_written = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|source| CheckpointError::Download { source })?;
        bytes_written = bytes_written
            .checked_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
            .ok_or(CheckpointError::DownloadTooLarge {
                limit: max_checkpoint_bytes,
            })?;
        if bytes_written > max_checkpoint_bytes || bytes_written > descriptor.size_bytes {
            return Err(CheckpointError::DownloadTooLarge {
                limit: max_checkpoint_bytes.min(descriptor.size_bytes),
            });
        }
        hasher.update(&chunk);
        output
            .write_all(&chunk)
            .await
            .map_err(|source| CheckpointError::WriteArchive {
                path: archive_path.clone(),
                source,
            })?;
    }
    output
        .sync_all()
        .await
        .map_err(|source| CheckpointError::WriteArchive {
            path: archive_path.clone(),
            source,
        })?;
    drop(output);

    if bytes_written != descriptor.size_bytes {
        return Err(CheckpointError::UnexpectedDownloadSize {
            expected: descriptor.size_bytes,
            actual: bytes_written,
        });
    }
    verify_digest(&descriptor.sha256, &hasher.finalize())?;
    verify_signature(descriptor, &archive_path, trusted_signing_keys)?;

    extract_staged_archive(temporary, archive_path, descriptor, max_checkpoint_bytes).await
}

/// Offline publication proof for the exact bytes supplied by the trusted
/// builder. The same signature, extraction, manifest, and built-in apply path
/// used by a real learner generation is retained; only HTTP download is
/// replaced by a bounded copy from the builder-uploaded guest file.
pub async fn stage_local_checkpoint(
    source_path: &Path,
    descriptor: &CheckpointDescriptor,
    tmpfs_root: &Path,
    max_checkpoint_bytes: u64,
    trusted_signing_keys: &BTreeMap<String, String>,
) -> Result<StagedCheckpoint, CheckpointError> {
    let now = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX);
    descriptor
        .validate(now, max_checkpoint_bytes)
        .map_err(CheckpointError::InvalidDescriptor)?;
    fs::create_dir_all(tmpfs_root).map_err(|source| CheckpointError::CreateTmpfsRoot {
        path: tmpfs_root.to_path_buf(),
        source,
    })?;
    verify_tmpfs(tmpfs_root)?;
    let metadata =
        fs::symlink_metadata(source_path).map_err(|source| CheckpointError::ReadLocalArchive {
            path: source_path.to_path_buf(),
            source,
        })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CheckpointError::UnsafeLocalArchive {
            path: source_path.to_path_buf(),
        });
    }
    if metadata.len() != descriptor.size_bytes || metadata.len() > max_checkpoint_bytes {
        return Err(CheckpointError::UnexpectedDownloadSize {
            expected: descriptor.size_bytes,
            actual: metadata.len(),
        });
    }

    let temporary = tempfile::Builder::new()
        .prefix("checkpoint-proof-")
        .tempdir_in(tmpfs_root)
        .map_err(|source| CheckpointError::CreateTmpfsRoot {
            path: tmpfs_root.to_path_buf(),
            source,
        })?;
    let archive_path = temporary.path().join("bundle.tar");
    let mut source = tokio::fs::File::open(source_path).await.map_err(|source| {
        CheckpointError::ReadLocalArchive {
            path: source_path.to_path_buf(),
            source,
        }
    })?;
    let mut output = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&archive_path)
        .await
        .map_err(|source| CheckpointError::WriteArchive {
            path: archive_path.clone(),
            source,
        })?;
    let mut hasher = Sha256::new();
    let mut bytes_written = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read =
            source
                .read(&mut buffer)
                .await
                .map_err(|source| CheckpointError::ReadLocalArchive {
                    path: source_path.to_path_buf(),
                    source,
                })?;
        if read == 0 {
            break;
        }
        bytes_written = bytes_written
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or(CheckpointError::DownloadTooLarge {
                limit: max_checkpoint_bytes,
            })?;
        if bytes_written > descriptor.size_bytes || bytes_written > max_checkpoint_bytes {
            return Err(CheckpointError::DownloadTooLarge {
                limit: descriptor.size_bytes.min(max_checkpoint_bytes),
            });
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read]).await.map_err(|source| {
            CheckpointError::WriteArchive {
                path: archive_path.clone(),
                source,
            }
        })?;
    }
    output
        .sync_all()
        .await
        .map_err(|source| CheckpointError::WriteArchive {
            path: archive_path.clone(),
            source,
        })?;
    drop(output);
    if bytes_written != descriptor.size_bytes {
        return Err(CheckpointError::UnexpectedDownloadSize {
            expected: descriptor.size_bytes,
            actual: bytes_written,
        });
    }
    verify_digest(&descriptor.sha256, &hasher.finalize())?;
    verify_signature(descriptor, &archive_path, trusted_signing_keys)?;
    extract_staged_archive(temporary, archive_path, descriptor, max_checkpoint_bytes).await
}

async fn extract_staged_archive(
    temporary: TempDir,
    archive_path: PathBuf,
    descriptor: &CheckpointDescriptor,
    max_checkpoint_bytes: u64,
) -> Result<StagedCheckpoint, CheckpointError> {
    let extraction_root = temporary.path().join("root");
    let archive_for_task = archive_path.clone();
    let root_for_task = extraction_root.clone();
    let compression = descriptor.compression.clone();
    let expanded_limit = max_checkpoint_bytes.saturating_mul(8);
    tokio::task::spawn_blocking(move || {
        extract_archive(
            &archive_for_task,
            &root_for_task,
            compression,
            expanded_limit,
        )
    })
    .await
    .map_err(|source| CheckpointError::ExtractionTask { source })??;

    fs::remove_file(&archive_path).map_err(|source| CheckpointError::WriteArchive {
        path: archive_path,
        source,
    })?;

    Ok(StagedCheckpoint {
        _temporary: temporary,
        checkpoint_id: descriptor.checkpoint_id.clone(),
        root: extraction_root,
    })
}

fn verify_signature(
    descriptor: &CheckpointDescriptor,
    archive_path: &Path,
    trusted_signing_keys: &BTreeMap<String, String>,
) -> Result<(), CheckpointError> {
    let encoded_key = trusted_signing_keys
        .get(&descriptor.signing_key_id)
        .ok_or_else(|| CheckpointError::UntrustedSigner {
            key_id: descriptor.signing_key_id.clone(),
        })?;
    let key_bytes =
        BASE64_STANDARD
            .decode(encoded_key)
            .map_err(|_| CheckpointError::InvalidSigningKey {
                key_id: descriptor.signing_key_id.clone(),
            })?;
    let key = VerifyingKey::from_bytes(&key_bytes.try_into().map_err(|_| {
        CheckpointError::InvalidSigningKey {
            key_id: descriptor.signing_key_id.clone(),
        }
    })?)
    .map_err(|_| CheckpointError::InvalidSigningKey {
        key_id: descriptor.signing_key_id.clone(),
    })?;
    let signature_bytes = BASE64_STANDARD
        .decode(&descriptor.signature_b64)
        .map_err(|_| CheckpointError::InvalidSignatureEncoding)?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| CheckpointError::InvalidSignatureEncoding)?;
    let bytes = fs::read(archive_path).map_err(|source| CheckpointError::WriteArchive {
        path: archive_path.to_path_buf(),
        source,
    })?;
    key.verify(&bytes, &signature)
        .map_err(|_| CheckpointError::SignatureMismatch {
            key_id: descriptor.signing_key_id.clone(),
        })
}

async fn apply_reconstruction_bundle(checkpoint: &StagedCheckpoint) -> Result<(), CheckpointError> {
    let manifest_path = checkpoint.root().join("checkpoint.json");
    let manifest_bytes = fs::read(&manifest_path).map_err(|source| CheckpointError::ApplyIo {
        operation: "read reconstruction manifest",
        path: manifest_path.clone(),
        source,
    })?;
    if manifest_bytes.len() > 2 * 1024 * 1024 {
        return Err(CheckpointError::InvalidManifest(
            "checkpoint.json exceeds 2 MiB".to_owned(),
        ));
    }
    let manifest = serde_json::from_slice::<ReconstructionManifest>(&manifest_bytes)
        .map_err(|error| CheckpointError::InvalidManifest(error.to_string()))?;
    validate_reconstruction_manifest(checkpoint, &manifest)?;
    install_runtime_source(checkpoint, &manifest)?;
    install_probe_verifiers_at(checkpoint, &manifest, Path::new(PROBE_VERIFIER_ROOT))?;

    run_reconstruction_script(
        checkpoint.root().join(&manifest.bootstrap_script),
        &manifest,
        checkpoint,
        "bootstrap",
    )
    .await?;
    for step in &manifest.apply_steps {
        run_reconstruction_script(
            checkpoint.root().join(&step.catch_up_script),
            &manifest,
            checkpoint,
            &format!("module {} catch-up", step.module_id),
        )
        .await?;
        run_reconstruction_script(
            checkpoint.root().join(&step.verify_script),
            &manifest,
            checkpoint,
            &format!("module {} verifier", step.module_id),
        )
        .await?;
    }
    Ok(())
}

fn validate_reconstruction_manifest(
    checkpoint: &StagedCheckpoint,
    manifest: &ReconstructionManifest,
) -> Result<(), CheckpointError> {
    if manifest.schema_version != 3 {
        return Err(CheckpointError::InvalidManifest(
            "unsupported reconstruction manifest schema".to_owned(),
        ));
    }
    if manifest.checkpoint_id != checkpoint.checkpoint_id() {
        return Err(CheckpointError::InvalidManifest(
            "manifest checkpoint_id does not match the signed descriptor".to_owned(),
        ));
    }
    validate_identifier("workshop_slug", &manifest.workshop_slug)?;
    validate_install_root(&manifest.install_root)?;
    validate_relative_path(&manifest.bootstrap_script)?;
    if manifest.bootstrap_script != Path::new("runtime/bootstrap.sh") {
        return Err(CheckpointError::InvalidManifest(
            "bootstrap_script must be runtime/bootstrap.sh".to_owned(),
        ));
    }
    if manifest.runtime_files.is_empty()
        || manifest.apply_steps.is_empty()
        || manifest.probe_verifiers.is_empty()
    {
        return Err(CheckpointError::InvalidManifest(
            "runtime_files, apply_steps, and probe_verifiers must be non-empty".to_owned(),
        ));
    }

    let mut declared = BTreeSet::from([
        PathBuf::from("checkpoint.json"),
        PathBuf::from("runtime/bootstrap.sh"),
        PathBuf::from("runtime/images.lock"),
    ]);
    let mut destinations = BTreeSet::new();
    for file in &manifest.runtime_files {
        validate_relative_path(&file.archive_path)?;
        validate_relative_path(&file.install_path)?;
        if !file.archive_path.starts_with("runtime/root")
            || file.archive_path == Path::new("runtime/root")
        {
            return Err(CheckpointError::InvalidManifest(
                "runtime file archive paths must be below runtime/root".to_owned(),
            ));
        }
        if !declared.insert(file.archive_path.clone())
            || !destinations.insert(file.install_path.clone())
        {
            return Err(CheckpointError::InvalidManifest(
                "runtime file paths must be unique".to_owned(),
            ));
        }
        if file.mode != 0o644 && file.mode != 0o755 {
            return Err(CheckpointError::InvalidManifest(
                "runtime file mode must be 0644 or 0755".to_owned(),
            ));
        }
        validate_sha256(&file.sha256)?;
        let path = checkpoint.root().join(&file.archive_path);
        let bytes = read_staged_regular(&path)?;
        verify_digest(&file.sha256, &Sha256::digest(&bytes))?;
    }
    let mut modules = BTreeSet::new();
    let mut probe_ids = BTreeSet::new();
    let mut verifier_paths = BTreeMap::new();
    for verifier in &manifest.probe_verifiers {
        validate_identifier("probe module_id", &verifier.module_id)?;
        if verifier.probe_ids.is_empty() || !modules.insert(&verifier.module_id) {
            return Err(CheckpointError::InvalidManifest(
                "probe verifier modules must be unique and have at least one probe".to_owned(),
            ));
        }
        let expected_path = PathBuf::from(format!("probes/{}/verify.sh", verifier.module_id));
        if verifier.verifier_script != expected_path
            || !declared.insert(verifier.verifier_script.clone())
        {
            return Err(CheckpointError::InvalidManifest(
                "probe verifier paths must be unique canonical module paths".to_owned(),
            ));
        }
        for probe_id in &verifier.probe_ids {
            validate_identifier("probe_id", probe_id)?;
            if !probe_ids.insert(probe_id.as_str()) {
                return Err(CheckpointError::InvalidManifest(
                    "probe IDs must be globally unique".to_owned(),
                ));
            }
        }
        let _ = read_staged_regular(&checkpoint.root().join(&verifier.verifier_script))?;
        verifier_paths.insert(
            verifier.module_id.as_str(),
            verifier.verifier_script.as_path(),
        );
    }

    let mut step_modules = BTreeSet::new();
    for step in &manifest.apply_steps {
        validate_identifier("module_id", &step.module_id)?;
        if !step_modules.insert(&step.module_id) {
            return Err(CheckpointError::InvalidManifest(
                "module IDs must be unique".to_owned(),
            ));
        }
        validate_relative_path(&step.catch_up_script)?;
        if !step.catch_up_script.starts_with("scripts")
            || !declared.insert(step.catch_up_script.clone())
        {
            return Err(CheckpointError::InvalidManifest(
                "catch-up paths must be unique and below scripts".to_owned(),
            ));
        }
        validate_relative_path(&step.verify_script)?;
        if verifier_paths.get(step.module_id.as_str()).copied()
            != Some(step.verify_script.as_path())
        {
            return Err(CheckpointError::InvalidManifest(
                "apply verifier must reference its module probe verifier".to_owned(),
            ));
        }
        let _ = read_staged_regular(&checkpoint.root().join(&step.catch_up_script))?;
    }
    if manifest.external_images.is_empty() {
        return Err(CheckpointError::InvalidManifest(
            "external_images must be non-empty".to_owned(),
        ));
    }
    let mut images = BTreeSet::new();
    for image in &manifest.external_images {
        validate_digest_pinned_image(image)?;
        if !images.insert(image.as_str()) {
            return Err(CheckpointError::InvalidManifest(
                "external_images contains a duplicate".to_owned(),
            ));
        }
    }
    let image_lock =
        fs::read_to_string(checkpoint.root().join("runtime/images.lock")).map_err(|source| {
            CheckpointError::ApplyIo {
                operation: "read image lock",
                path: checkpoint.root().join("runtime/images.lock"),
                source,
            }
        })?;
    let locked = image_lock
        .lines()
        .map(|line| line.split('#').next().unwrap_or_default().trim())
        .filter(|line| !line.is_empty())
        .collect::<BTreeSet<_>>();
    if locked != images {
        return Err(CheckpointError::InvalidManifest(
            "runtime/images.lock does not match external_images".to_owned(),
        ));
    }
    let actual = collect_staged_files(checkpoint.root())?;
    if actual != declared {
        return Err(CheckpointError::InvalidManifest(
            "archive contains undeclared files".to_owned(),
        ));
    }
    Ok(())
}

fn install_probe_verifiers_at(
    checkpoint: &StagedCheckpoint,
    manifest: &ReconstructionManifest,
    destination: &Path,
) -> Result<(), CheckpointError> {
    let parent = destination.parent().ok_or_else(|| {
        CheckpointError::InvalidManifest("probe verifier root has no parent".to_owned())
    })?;
    reject_symlink_components(parent)?;
    fs::create_dir_all(parent).map_err(|source| CheckpointError::ApplyIo {
        operation: "create probe verifier parent",
        path: parent.to_path_buf(),
        source,
    })?;
    reject_symlink_components(parent)?;

    if destination.exists() {
        let marker = destination.join(".intar-probe-owner");
        let owner = fs::read_to_string(&marker).map_err(|source| CheckpointError::ApplyIo {
            operation: "read probe verifier owner marker",
            path: marker,
            source,
        })?;
        if owner.trim() != manifest.workshop_slug {
            return Err(CheckpointError::InvalidManifest(
                "refusing to replace probe verifiers not owned by this workshop".to_owned(),
            ));
        }
        fs::remove_dir_all(destination).map_err(|source| CheckpointError::ApplyIo {
            operation: "replace prior probe verifiers",
            path: destination.to_path_buf(),
            source,
        })?;
    }

    let staging = tempfile::Builder::new()
        .prefix(".intar-workshop-probes-")
        .tempdir_in(parent)
        .map_err(|source| CheckpointError::ApplyIo {
            operation: "create probe verifier staging directory",
            path: parent.to_path_buf(),
            source,
        })?;
    for verifier in &manifest.probe_verifiers {
        let bytes = read_staged_regular(&checkpoint.root().join(&verifier.verifier_script))?;
        let path = staging.path().join(format!("{}.sh", verifier.module_id));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o500);
        }
        let mut output = options
            .open(&path)
            .map_err(|source| CheckpointError::ApplyIo {
                operation: "create probe verifier",
                path: path.clone(),
                source,
            })?;
        output
            .write_all(&bytes)
            .and_then(|()| output.sync_all())
            .map_err(|source| CheckpointError::ApplyIo {
                operation: "write probe verifier",
                path,
                source,
            })?;
    }
    fs::write(
        staging.path().join(".intar-probe-owner"),
        format!("{}\n", manifest.workshop_slug),
    )
    .map_err(|source| CheckpointError::ApplyIo {
        operation: "write probe verifier owner marker",
        path: staging.path().join(".intar-probe-owner"),
        source,
    })?;
    let staging_path = staging.keep();
    fs::rename(&staging_path, destination).map_err(|source| CheckpointError::ApplyIo {
        operation: "activate probe verifiers",
        path: destination.to_path_buf(),
        source,
    })
}

fn install_runtime_source(
    checkpoint: &StagedCheckpoint,
    manifest: &ReconstructionManifest,
) -> Result<(), CheckpointError> {
    let parent = manifest
        .install_root
        .parent()
        .ok_or_else(|| CheckpointError::InvalidManifest("install_root has no parent".to_owned()))?;
    reject_symlink_components(parent)?;
    fs::create_dir_all(parent).map_err(|source| CheckpointError::ApplyIo {
        operation: "create install parent",
        path: parent.to_path_buf(),
        source,
    })?;
    reject_symlink_components(parent)?;

    if manifest.install_root.exists() {
        let marker = manifest.install_root.join(".intar-runtime-owner");
        let owner = fs::read_to_string(&marker).map_err(|source| CheckpointError::ApplyIo {
            operation: "read existing runtime owner marker",
            path: marker,
            source,
        })?;
        if owner.trim() != manifest.workshop_slug {
            return Err(CheckpointError::InvalidManifest(
                "refusing to replace an install root not owned by this workshop".to_owned(),
            ));
        }
        fs::remove_dir_all(&manifest.install_root).map_err(|source| CheckpointError::ApplyIo {
            operation: "replace prior incomplete workshop runtime",
            path: manifest.install_root.clone(),
            source,
        })?;
    }

    let staging = tempfile::Builder::new()
        .prefix(".intar-workshop-runtime-")
        .tempdir_in(parent)
        .map_err(|source| CheckpointError::ApplyIo {
            operation: "create runtime staging directory",
            path: parent.to_path_buf(),
            source,
        })?;
    for file in &manifest.runtime_files {
        let destination = staging.path().join(&file.install_path);
        if let Some(directory) = destination.parent() {
            fs::create_dir_all(directory).map_err(|source| CheckpointError::ApplyIo {
                operation: "create runtime source directory",
                path: directory.to_path_buf(),
                source,
            })?;
        }
        let bytes = read_staged_regular(&checkpoint.root().join(&file.archive_path))?;
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(file.mode);
        }
        let mut output = options
            .open(&destination)
            .map_err(|source| CheckpointError::ApplyIo {
                operation: "create runtime source file",
                path: destination.clone(),
                source,
            })?;
        output
            .write_all(&bytes)
            .map_err(|source| CheckpointError::ApplyIo {
                operation: "write runtime source file",
                path: destination.clone(),
                source,
            })?;
        output
            .sync_all()
            .map_err(|source| CheckpointError::ApplyIo {
                operation: "sync runtime source file",
                path: destination,
                source,
            })?;
    }
    fs::write(
        staging.path().join(".intar-runtime-owner"),
        format!("{}\n", manifest.workshop_slug),
    )
    .map_err(|source| CheckpointError::ApplyIo {
        operation: "write runtime owner marker",
        path: staging.path().join(".intar-runtime-owner"),
        source,
    })?;
    let staging_path = staging.keep();
    fs::rename(&staging_path, &manifest.install_root).map_err(|source| CheckpointError::ApplyIo {
        operation: "activate runtime source",
        path: manifest.install_root.clone(),
        source,
    })
}

async fn run_reconstruction_script(
    program: PathBuf,
    manifest: &ReconstructionManifest,
    checkpoint: &StagedCheckpoint,
    label: &str,
) -> Result<(), CheckpointError> {
    // Checkpoint bytes stay on the required noexec tmpfs. The scripts are
    // signed workshop inputs, so pass their paths to the fixed guest shell
    // instead of asking the kernel to execute them from that mount.
    let status = tokio::process::Command::new(RECONSTRUCTION_SHELL)
        .arg("--")
        .arg(&program)
        // Reconstruction scripts are workshop-authored. Keep the workspace
        // agent's report/bootstrap credentials and process configuration out
        // of their environment, and expose only the deterministic execution
        // contract required by the signed bundle.
        .env_clear()
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        )
        .env("HOME", "/root")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("INTAR_WORKSHOP_INSTALL_ROOT", &manifest.install_root)
        .env(
            "INTAR_WORKSHOP_IMAGE_LOCK",
            checkpoint.root().join("runtime/images.lock"),
        )
        .env("INTAR_WORKSHOP_CHECKPOINT_ID", checkpoint.checkpoint_id())
        .current_dir(&manifest.install_root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|source| CheckpointError::ApplyStart {
            program: program.clone(),
            source,
        })?;
    if !status.success() {
        return Err(CheckpointError::ApplyFailed {
            program: PathBuf::from(label),
            status: status.to_string(),
        });
    }
    Ok(())
}

fn validate_identifier(name: &str, value: &str) -> Result<(), CheckpointError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(CheckpointError::InvalidManifest(format!(
            "{name} is invalid"
        )));
    }
    Ok(())
}

fn validate_install_root(path: &Path) -> Result<(), CheckpointError> {
    if !path.is_absolute()
        || !path.starts_with("/opt")
        || path == Path::new("/opt")
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(CheckpointError::InvalidManifest(
            "install_root must be a normalized path below /opt".to_owned(),
        ));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), CheckpointError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(CheckpointError::InvalidManifest(
            "SHA-256 values must be lowercase hexadecimal".to_owned(),
        ));
    }
    Ok(())
}

fn validate_digest_pinned_image(value: &str) -> Result<(), CheckpointError> {
    let Some((name, digest)) = value.split_once("@sha256:") else {
        return Err(CheckpointError::InvalidManifest(format!(
            "tag-only external image '{value}' is forbidden"
        )));
    };
    if name.is_empty()
        || !name.contains('/')
        || name.contains(char::is_whitespace)
        || name.starts_with(['.', '-', '/', ':'])
    {
        return Err(CheckpointError::InvalidManifest(format!(
            "external image '{value}' has an invalid repository"
        )));
    }
    validate_sha256(digest)
}

fn read_staged_regular(path: &Path) -> Result<Vec<u8>, CheckpointError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| CheckpointError::ApplyIo {
        operation: "inspect staged file",
        path: path.to_path_buf(),
        source,
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(CheckpointError::InvalidManifest(format!(
            "staged path '{}' is not a regular file",
            path.display()
        )));
    }
    fs::read(path).map_err(|source| CheckpointError::ApplyIo {
        operation: "read staged file",
        path: path.to_path_buf(),
        source,
    })
}

fn collect_staged_files(root: &Path) -> Result<BTreeSet<PathBuf>, CheckpointError> {
    fn visit(
        root: &Path,
        relative: &Path,
        output: &mut BTreeSet<PathBuf>,
    ) -> Result<(), CheckpointError> {
        let directory = root.join(relative);
        let entries = fs::read_dir(&directory).map_err(|source| CheckpointError::ApplyIo {
            operation: "read staged directory",
            path: directory,
            source,
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| CheckpointError::ApplyIo {
                operation: "read staged directory entry",
                path: root.join(relative),
                source,
            })?;
            let path = relative.join(entry.file_name());
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|source| CheckpointError::ApplyIo {
                    operation: "inspect staged path",
                    path: entry.path(),
                    source,
                })?;
            if metadata.is_dir() {
                visit(root, &path, output)?;
            } else if metadata.is_file() && !metadata.file_type().is_symlink() {
                output.insert(path);
            } else {
                return Err(CheckpointError::InvalidManifest(
                    "staged archive contains a non-regular path".to_owned(),
                ));
            }
        }
        Ok(())
    }
    let mut output = BTreeSet::new();
    visit(root, Path::new(""), &mut output)?;
    Ok(output)
}

fn reject_symlink_components(path: &Path) -> Result<(), CheckpointError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CheckpointError::InvalidManifest(format!(
                    "install path component '{}' is a symlink",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(source) => {
                return Err(CheckpointError::ApplyIo {
                    operation: "inspect install path",
                    path: current,
                    source,
                });
            }
        }
    }
    Ok(())
}

pub fn verify_tmpfs(path: &Path) -> Result<(), CheckpointError> {
    #[cfg(target_os = "linux")]
    {
        let canonical = path
            .canonicalize()
            .map_err(|source| CheckpointError::InspectTmpfs {
                path: path.to_path_buf(),
                source,
            })?;
        let mountinfo = fs::read_to_string("/proc/self/mountinfo").map_err(|source| {
            CheckpointError::InspectTmpfs {
                path: path.to_path_buf(),
                source,
            }
        })?;
        if deepest_mount_filesystem(&mountinfo, &canonical).as_deref() != Some("tmpfs") {
            return Err(CheckpointError::NotTmpfs { path: canonical });
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(CheckpointError::NotTmpfs {
            path: path.to_path_buf(),
        })
    }
}

#[cfg(target_os = "linux")]
fn deepest_mount_filesystem(mountinfo: &str, path: &Path) -> Option<String> {
    mountinfo
        .lines()
        .filter_map(|line| {
            let (left, right) = line.split_once(" - ")?;
            let mount_point = left.split_whitespace().nth(4)?;
            let fs_type = right.split_whitespace().next()?;
            let decoded = decode_mount_path(mount_point);
            let mount_path = PathBuf::from(decoded);
            path.starts_with(&mount_path)
                .then_some((mount_path.components().count(), fs_type.to_owned()))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, fs_type)| fs_type)
}

#[cfg(target_os = "linux")]
fn decode_mount_path(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

fn verify_digest(expected: &str, actual: &[u8]) -> Result<(), CheckpointError> {
    let actual = base16ct::lower::encode_string(actual);
    if actual != expected {
        return Err(CheckpointError::DigestMismatch {
            expected: expected.to_owned(),
            actual,
        });
    }
    Ok(())
}

fn extract_archive(
    archive_path: &Path,
    destination: &Path,
    compression: CheckpointCompression,
    max_expanded_bytes: u64,
) -> Result<(), CheckpointError> {
    fs::create_dir(destination).map_err(|source| CheckpointError::Extract {
        path: destination.to_path_buf(),
        source,
    })?;
    let archive = fs::File::open(archive_path).map_err(|source| CheckpointError::Extract {
        path: archive_path.to_path_buf(),
        source,
    })?;

    match compression {
        CheckpointCompression::None => extract_tar(archive, destination, max_expanded_bytes),
        CheckpointCompression::Gzip => extract_tar(
            flate2::read::GzDecoder::new(archive),
            destination,
            max_expanded_bytes,
        ),
        CheckpointCompression::Zstd => {
            let decoder = zstd::stream::read::Decoder::new(archive).map_err(|source| {
                CheckpointError::Extract {
                    path: archive_path.to_path_buf(),
                    source,
                }
            })?;
            extract_tar(decoder, destination, max_expanded_bytes)
        }
    }
}

fn extract_tar<R: Read>(
    reader: R,
    destination: &Path,
    max_expanded_bytes: u64,
) -> Result<(), CheckpointError> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|source| CheckpointError::Extract {
            path: destination.to_path_buf(),
            source,
        })?;
    let mut expanded = 0_u64;

    for entry in entries {
        let mut entry = entry.map_err(|source| CheckpointError::Extract {
            path: destination.to_path_buf(),
            source,
        })?;
        let relative = entry
            .path()
            .map_err(|source| CheckpointError::Extract {
                path: destination.to_path_buf(),
                source,
            })?
            .into_owned();
        validate_relative_path(&relative)?;

        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(CheckpointError::UnsafeEntry {
                path: relative,
                reason: "only regular files and directories are allowed".to_owned(),
            });
        }

        let target = destination.join(&relative);
        if kind.is_dir() {
            fs::create_dir_all(&target).map_err(|source| CheckpointError::Extract {
                path: target.clone(),
                source,
            })?;
            set_safe_permissions(&target, true, 0)?;
            continue;
        }

        let size = entry
            .header()
            .size()
            .map_err(|source| CheckpointError::Extract {
                path: relative.clone(),
                source,
            })?;
        expanded = expanded
            .checked_add(size)
            .ok_or(CheckpointError::ExpandedTooLarge {
                limit: max_expanded_bytes,
            })?;
        if expanded > max_expanded_bytes {
            return Err(CheckpointError::ExpandedTooLarge {
                limit: max_expanded_bytes,
            });
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|source| CheckpointError::Extract {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(&target)
            .map_err(|source| CheckpointError::Extract {
                path: target.clone(),
                source,
            })?;
        io::copy(&mut entry, &mut output).map_err(|source| CheckpointError::Extract {
            path: target.clone(),
            source,
        })?;
        output.flush().map_err(|source| CheckpointError::Extract {
            path: target.clone(),
            source,
        })?;
        let source_mode = entry.header().mode().unwrap_or(0o600);
        set_safe_permissions(&target, false, source_mode)?;
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), CheckpointError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CheckpointError::UnsafeEntry {
            path: path.to_path_buf(),
            reason: "path must contain only normal relative components".to_owned(),
        });
    }
    Ok(())
}

fn set_safe_permissions(
    path: &Path,
    directory: bool,
    source_mode: u32,
) -> Result<(), CheckpointError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if directory || source_mode & 0o111 != 0 {
            0o755
        } else {
            0o644
        };
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|source| {
            CheckpointError::Extract {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum CheckpointError {
    #[error("invalid checkpoint descriptor: {0}")]
    InvalidDescriptor(String),
    #[error("failed to create checkpoint tmpfs root {path}: {source}")]
    CreateTmpfsRoot {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("checkpoint download failed: {source}")]
    Download {
        #[source]
        source: reqwest::Error,
    },
    #[error("checkpoint download size is {actual} bytes; expected {expected}")]
    UnexpectedDownloadSize { expected: u64, actual: u64 },
    #[error("checkpoint download exceeded {limit} bytes")]
    DownloadTooLarge { limit: u64 },
    #[error("failed to write checkpoint archive {path}: {source}")]
    WriteArchive {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to read local checkpoint archive {path}: {source}")]
    ReadLocalArchive {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("local checkpoint archive is not a regular non-symlink file: {path}")]
    UnsafeLocalArchive { path: PathBuf },
    #[error("checkpoint digest mismatch: expected {expected}, received {actual}")]
    DigestMismatch { expected: String, actual: String },
    #[error("checkpoint was signed by untrusted key '{key_id}'")]
    UntrustedSigner { key_id: String },
    #[error("trusted checkpoint signing key '{key_id}' is invalid")]
    InvalidSigningKey { key_id: String },
    #[error("checkpoint signature is not valid standard-base64 Ed25519 data")]
    InvalidSignatureEncoding,
    #[error("checkpoint Ed25519 signature from '{key_id}' did not verify")]
    SignatureMismatch { key_id: String },
    #[error("checkpoint extraction task failed: {source}")]
    ExtractionTask {
        #[source]
        source: tokio::task::JoinError,
    },
    #[error("failed to extract checkpoint entry {path}: {source}")]
    Extract {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("unsafe checkpoint entry {path}: {reason}")]
    UnsafeEntry { path: PathBuf, reason: String },
    #[error("expanded checkpoint exceeded {limit} bytes")]
    ExpandedTooLarge { limit: u64 },
    #[error("failed to inspect checkpoint tmpfs {path}: {source}")]
    InspectTmpfs {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("checkpoint staging path is not backed by tmpfs: {path}")]
    NotTmpfs { path: PathBuf },
    #[error("failed to start checkpoint apply program {program}: {source}")]
    ApplyStart {
        program: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("checkpoint apply program {program} exited with {status}")]
    ApplyFailed { program: PathBuf, status: String },
    #[error("invalid checkpoint reconstruction manifest: {0}")]
    InvalidManifest(String),
    #[error("failed to {operation} at {path}: {source}")]
    ApplyIo {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::ReconstructionManifest;
    use super::StagedCheckpoint;
    use super::run_reconstruction_script;
    use super::stage_local_checkpoint;
    use super::{extract_archive, verify_digest, verify_signature};
    use crate::model::{CheckpointCompression, CheckpointDescriptor};
    use crate::secrets::SecretString;
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[cfg(unix)]
    #[tokio::test]
    async fn reconstruction_shell_runs_a_readable_non_executable_script() {
        use std::os::unix::fs::PermissionsExt as _;

        let temporary = TempDir::new().expect("temp dir");
        let root = temporary.path().join("root");
        let install_root = temporary.path().join("install");
        fs::create_dir_all(root.join("runtime")).expect("runtime directory");
        fs::create_dir(&install_root).expect("install root");
        let script = root.join("runtime/bootstrap.sh");
        fs::write(
            &script,
            b"#!/usr/bin/env bash\nset -euo pipefail\nprintf applied > invocation.ok\n",
        )
        .expect("script");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o644))
            .expect("non-executable script mode");

        let checkpoint = StagedCheckpoint {
            _temporary: temporary,
            checkpoint_id: "checkpoint-00".to_owned(),
            root,
        };
        let manifest = ReconstructionManifest {
            schema_version: 3,
            workshop_slug: "test-workshop".to_owned(),
            checkpoint_id: checkpoint.checkpoint_id().to_owned(),
            install_root: install_root.clone(),
            bootstrap_script: PathBuf::from("runtime/bootstrap.sh"),
            runtime_files: Vec::new(),
            apply_steps: Vec::new(),
            probe_verifiers: Vec::new(),
            external_images: Vec::new(),
        };

        run_reconstruction_script(script, &manifest, &checkpoint, "bootstrap")
            .await
            .expect("fixed shell must run a signed script from a noexec-compatible path");
        assert_eq!(
            fs::read(install_root.join("invocation.ok")).expect("execution marker"),
            b"applied"
        );
    }

    #[test]
    fn digest_mismatch_is_rejected() {
        let actual = Sha256::digest(b"checkpoint");
        let error = verify_digest(&"0".repeat(64), &actual).expect_err("digest must differ");
        assert!(error.to_string().contains("digest mismatch"));
    }

    #[test]
    fn ed25519_signature_and_signer_id_are_enforced() {
        let temp = TempDir::new().expect("temp dir");
        let archive = temp.path().join("bundle.tar");
        let bytes = b"signed reconstruction bundle";
        fs::write(&archive, bytes).expect("bundle");
        let signing = SigningKey::from_bytes(&[9_u8; 32]);
        let descriptor = CheckpointDescriptor {
            checkpoint_id: "checkpoint-00".to_owned(),
            signed_url: SecretString::new("https://intar.test/checkpoint"),
            sha256: base16ct::lower::encode_string(&Sha256::digest(bytes)),
            size_bytes: bytes.len() as u64,
            compression: CheckpointCompression::None,
            signature_b64: BASE64_STANDARD.encode(signing.sign(bytes).to_bytes()),
            signing_key_id: "runtime-v1".to_owned(),
            expires_at_unix_ms: i64::MAX,
        };
        let mut trusted = BTreeMap::from([(
            "runtime-v1".to_owned(),
            BASE64_STANDARD.encode(signing.verifying_key().to_bytes()),
        )]);
        verify_signature(&descriptor, &archive, &trusted).expect("signature verifies");

        trusted.clear();
        assert!(verify_signature(&descriptor, &archive, &trusted).is_err());
        trusted.insert(
            "runtime-v1".to_owned(),
            BASE64_STANDARD.encode(
                SigningKey::from_bytes(&[8_u8; 32])
                    .verifying_key()
                    .to_bytes(),
            ),
        );
        assert!(verify_signature(&descriptor, &archive, &trusted).is_err());
        fs::write(&archive, b"tampered").expect("tamper bundle");
        assert!(verify_signature(&descriptor, &archive, &trusted).is_err());
    }

    #[cfg_attr(not(target_os = "linux"), ignore = "requires a Linux tmpfs mount")]
    #[tokio::test]
    async fn offline_proof_stages_the_exact_signed_bytes_in_tmpfs() {
        let source = TempDir::new().expect("source temp");
        let archive = source.path().join("bundle.tar");
        let file = fs::File::create(&archive).expect("archive");
        let mut tar = tar::Builder::new(file);
        let payload = b"proof";
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "checkpoint.json", payload.as_slice())
            .expect("append");
        tar.finish().expect("finish");
        drop(tar);
        let bytes = fs::read(&archive).expect("read archive");
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let descriptor = CheckpointDescriptor {
            checkpoint_id: "checkpoint-00".to_owned(),
            signed_url: SecretString::new("https://offline-proof.invalid/checkpoint"),
            sha256: base16ct::lower::encode_string(&Sha256::digest(&bytes)),
            size_bytes: bytes.len() as u64,
            compression: CheckpointCompression::None,
            signature_b64: BASE64_STANDARD.encode(signing.sign(&bytes).to_bytes()),
            signing_key_id: "runtime-proof-v1".to_owned(),
            expires_at_unix_ms: i64::MAX,
        };
        let trusted = BTreeMap::from([(
            descriptor.signing_key_id.clone(),
            BASE64_STANDARD.encode(signing.verifying_key().to_bytes()),
        )]);
        let tmpfs = tempfile::Builder::new()
            .prefix("intar-agent-proof-test-")
            .tempdir_in("/dev/shm")
            .expect("tmpfs test root");
        let staged =
            stage_local_checkpoint(&archive, &descriptor, tmpfs.path(), 1024 * 1024, &trusted)
                .await
                .expect("stage exact local bundle");
        assert_eq!(
            fs::read(staged.root().join("checkpoint.json")).expect("payload"),
            payload
        );

        let mut tampered = bytes;
        tampered[0] ^= 1;
        fs::write(&archive, tampered).expect("tamper");
        let error = match stage_local_checkpoint(
            &archive,
            &descriptor,
            tmpfs.path(),
            1024 * 1024,
            &trusted,
        )
        .await
        {
            Ok(_) => panic!("tampered bytes must fail"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("digest mismatch"));
    }

    #[test]
    fn path_traversal_entry_is_rejected() {
        let temp = TempDir::new().expect("temp dir");
        let archive_path = temp.path().join("bundle.tar");
        let file = fs::File::create(&archive_path).expect("archive");
        let mut builder = tar::Builder::new(file);
        let payload = b"owned";
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        // tar::Builder rejects traversal itself, so write the raw header name.
        header.as_mut_bytes()[0..13].copy_from_slice(b"../escape.txt");
        header.set_cksum();
        builder
            .append(&header, payload.as_slice())
            .expect("write malicious entry");
        builder.finish().expect("finish tar");

        let destination = temp.path().join("extract");
        let error = extract_archive(
            &archive_path,
            &destination,
            CheckpointCompression::None,
            1024,
        )
        .expect_err("traversal must fail");
        assert!(error.to_string().contains("unsafe checkpoint entry"));
        assert!(!temp.path().join("escape.txt").exists());
    }

    #[test]
    fn symlinks_are_rejected() {
        let temp = TempDir::new().expect("temp dir");
        let archive_path = temp.path().join("bundle.tar");
        let file = fs::File::create(&archive_path).expect("archive");
        let mut builder = tar::Builder::new(file);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_link_name("/etc/passwd").expect("link name");
        header.set_cksum();
        builder
            .append_data(&mut header, "link", std::io::empty())
            .expect("write symlink");
        builder.finish().expect("finish tar");

        let error = extract_archive(
            &archive_path,
            &temp.path().join("extract"),
            CheckpointCompression::None,
            1024,
        )
        .expect_err("symlink must fail");
        assert!(error.to_string().contains("only regular files"));
    }
}
