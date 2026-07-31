use crate::model::{CheckpointCompression, CheckpointDescriptor};
use crate::secrets::SanitizedError;
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
use std::process::{ExitStatus, Stdio};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PROBE_VERIFIER_ROOT: &str = "/var/lib/intar-workshop-probes";
const RECONSTRUCTION_SHELL: &str = "/bin/bash";
const LEARNER_RUNNER: &str = "/usr/sbin/runuser";
const COMMAND_DIAGNOSTIC_TAIL_BYTES: usize = 96;
const COMMAND_DIAGNOSTIC_MAX_BYTES: usize = 256;
const RECONSTRUCTION_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

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

#[derive(Clone, Debug)]
pub struct BuiltinCheckpointApplier {
    reconstruction_identity: ReconstructionIdentity,
}

#[derive(Clone, Debug)]
struct ReconstructionIdentity {
    user: String,
    home: PathBuf,
}

enum ScriptIdentity<'a> {
    Root {
        home: &'a Path,
        learner_user: &'a str,
    },
    Reconstruction(&'a ReconstructionIdentity),
}

struct CommandOutcome {
    status: ExitStatus,
    stdout_tail: Vec<u8>,
    stderr_tail: Vec<u8>,
}

struct ProcessGroupGuard {
    #[cfg(unix)]
    pid: Option<nix::unistd::Pid>,
}

impl ProcessGroupGuard {
    fn new(child: &tokio::process::Child) -> Self {
        #[cfg(unix)]
        {
            let pid = child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .map(nix::unistd::Pid::from_raw);
            Self { pid }
        }
        #[cfg(not(unix))]
        {
            let _ = child;
            Self {}
        }
    }

    fn terminate(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid.take() {
            let _ = nix::sys::signal::killpg(pid, nix::sys::signal::Signal::SIGKILL);
        }
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

struct LearnerExecutionMaterial {
    _temporary: TempDir,
    root: PathBuf,
    image_lock: PathBuf,
}

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

impl BuiltinCheckpointApplier {
    pub fn new(user: String, home: PathBuf) -> Self {
        Self {
            reconstruction_identity: ReconstructionIdentity { user, home },
        }
    }

    pub fn root() -> Self {
        Self::new("root".to_owned(), PathBuf::from("/root"))
    }
}

impl CheckpointApplier for CommandCheckpointApplier {
    fn apply<'a>(
        &'a self,
        checkpoint: &'a StagedCheckpoint,
    ) -> Pin<Box<dyn Future<Output = Result<(), CheckpointError>> + Send + 'a>> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&self.program);
            command
                .arg("--checkpoint-id")
                .arg(checkpoint.checkpoint_id())
                .arg("--staged-root")
                .arg(checkpoint.root())
                .stdin(Stdio::null())
                .kill_on_drop(true);
            let outcome = run_command_with_bounded_output(&mut command)
                .await
                .map_err(|source| CheckpointError::ApplyStart {
                    program: self.program.clone(),
                    source,
                })?;
            if !outcome.status.success() {
                return Err(CheckpointError::ApplyFailed {
                    program: self.program.clone(),
                    status: outcome.status.to_string(),
                    diagnostic: command_diagnostic(&outcome),
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
        Box::pin(async move {
            apply_reconstruction_bundle(checkpoint, &self.reconstruction_identity).await
        })
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

async fn apply_reconstruction_bundle(
    checkpoint: &StagedCheckpoint,
    reconstruction_identity: &ReconstructionIdentity,
) -> Result<(), CheckpointError> {
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

    let bootstrap_home = tempfile::Builder::new()
        .prefix("intar-root-reconstruction-")
        .tempdir()
        .map_err(|source| CheckpointError::ApplyIo {
            operation: "create private root reconstruction home",
            path: std::env::temp_dir(),
            source,
        })?;
    run_reconstruction_script(
        checkpoint.root().join(&manifest.bootstrap_script),
        &manifest,
        checkpoint.root().join("runtime/images.lock"),
        "bootstrap",
        ScriptIdentity::Root {
            home: bootstrap_home.path(),
            learner_user: &reconstruction_identity.user,
        },
    )
    .await?;

    if reconstruction_identity.user != "root" {
        handoff_tree(&manifest.install_root, reconstruction_identity)?;
        handoff_tree(Path::new(PROBE_VERIFIER_ROOT), reconstruction_identity)?;
        let execution = LearnerExecutionMaterial::new(checkpoint, reconstruction_identity)?;
        for step in &manifest.apply_steps {
            let catch_up = execution.stage_script(
                &checkpoint.root().join(&step.catch_up_script),
                &format!("catch-up-{}", step.module_id),
                reconstruction_identity,
            )?;
            run_reconstruction_script(
                catch_up,
                &manifest,
                execution.image_lock.clone(),
                &format!("module {} catch-up", step.module_id),
                ScriptIdentity::Reconstruction(reconstruction_identity),
            )
            .await?;
            let verifier = execution.stage_script(
                &checkpoint.root().join(&step.verify_script),
                &format!("verify-{}", step.module_id),
                reconstruction_identity,
            )?;
            run_reconstruction_script(
                verifier,
                &manifest,
                execution.image_lock.clone(),
                &format!("module {} verifier", step.module_id),
                ScriptIdentity::Reconstruction(reconstruction_identity),
            )
            .await?;
        }
        return Ok(());
    }

    for step in &manifest.apply_steps {
        run_reconstruction_script(
            checkpoint.root().join(&step.catch_up_script),
            &manifest,
            checkpoint.root().join("runtime/images.lock"),
            &format!("module {} catch-up", step.module_id),
            ScriptIdentity::Root {
                home: bootstrap_home.path(),
                learner_user: &reconstruction_identity.user,
            },
        )
        .await?;
        run_reconstruction_script(
            checkpoint.root().join(&step.verify_script),
            &manifest,
            checkpoint.root().join("runtime/images.lock"),
            &format!("module {} verifier", step.module_id),
            ScriptIdentity::Root {
                home: bootstrap_home.path(),
                learner_user: &reconstruction_identity.user,
            },
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
                path: destination.clone(),
                source,
            })?;
        #[cfg(unix)]
        fs::set_permissions(
            &destination,
            std::os::unix::fs::PermissionsExt::from_mode(file.mode),
        )
        .map_err(|source| CheckpointError::ApplyIo {
            operation: "set declared runtime source mode",
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
    #[cfg(unix)]
    set_directory_tree_mode(staging.path(), 0o755).map_err(|source| CheckpointError::ApplyIo {
        operation: "set runtime source directory modes",
        path: staging.path().to_path_buf(),
        source,
    })?;
    let staging_path = staging.keep();
    fs::rename(&staging_path, &manifest.install_root).map_err(|source| CheckpointError::ApplyIo {
        operation: "activate runtime source",
        path: manifest.install_root.clone(),
        source,
    })
}

#[cfg(unix)]
fn set_directory_tree_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runtime directory mode update refuses non-directories and symlinks",
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    for child in fs::read_dir(path)? {
        let child = child?.path();
        let metadata = fs::symlink_metadata(&child)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runtime directory mode update refuses symlinks",
            ));
        }
        if metadata.is_dir() {
            set_directory_tree_mode(&child, mode)?;
        }
    }
    Ok(())
}

impl LearnerExecutionMaterial {
    fn new(
        checkpoint: &StagedCheckpoint,
        identity: &ReconstructionIdentity,
    ) -> Result<Self, CheckpointError> {
        let temporary = tempfile::Builder::new()
            .prefix("intar-learner-reconstruction-")
            .tempdir()
            .map_err(|source| CheckpointError::ApplyIo {
                operation: "create private learner reconstruction directory",
                path: std::env::temp_dir(),
                source,
            })?;
        let root = temporary.path().to_path_buf();
        let image_lock = root.join("images.lock");
        write_private_execution_file(
            &image_lock,
            &read_staged_regular(&checkpoint.root().join("runtime/images.lock"))?,
            0o400,
        )?;
        handoff_tree(&root, identity)?;
        Ok(Self {
            _temporary: temporary,
            root,
            image_lock,
        })
    }

    fn stage_script(
        &self,
        source: &Path,
        label: &str,
        identity: &ReconstructionIdentity,
    ) -> Result<PathBuf, CheckpointError> {
        validate_identifier("execution script label", label)?;
        let destination = self.root.join(format!("{label}.sh"));
        write_private_execution_file(&destination, &read_staged_regular(source)?, 0o500)?;
        handoff_tree(&destination, identity)?;
        Ok(destination)
    }
}

fn write_private_execution_file(
    path: &Path,
    bytes: &[u8],
    mode: u32,
) -> Result<(), CheckpointError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(mode);
    }
    let mut output = options
        .open(path)
        .map_err(|source| CheckpointError::ApplyIo {
            operation: "create private reconstruction file",
            path: path.to_path_buf(),
            source,
        })?;
    output
        .write_all(bytes)
        .and_then(|()| output.sync_all())
        .map_err(|source| CheckpointError::ApplyIo {
            operation: "write private reconstruction file",
            path: path.to_path_buf(),
            source,
        })?;
    #[cfg(unix)]
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(mode)).map_err(
        |source| CheckpointError::ApplyIo {
            operation: "set private reconstruction file mode",
            path: path.to_path_buf(),
            source,
        },
    )?;
    Ok(())
}

#[cfg(unix)]
fn handoff_tree(path: &Path, identity: &ReconstructionIdentity) -> Result<(), CheckpointError> {
    use std::os::unix::fs::MetadataExt as _;

    let account = nix::unistd::User::from_name(&identity.user)
        .map_err(|_| {
            CheckpointError::InvalidExecutionIdentity(format!(
                "reconstruction user '{}' could not be resolved",
                identity.user
            ))
        })?
        .ok_or_else(|| {
            CheckpointError::InvalidExecutionIdentity(format!(
                "reconstruction user '{}' does not exist",
                identity.user
            ))
        })?;
    if account.uid.is_root() || account.gid.as_raw() == 0 {
        return Err(CheckpointError::InvalidExecutionIdentity(format!(
            "reconstruction user '{}' must have a non-root UID and primary GID",
            identity.user
        )));
    }
    if account.dir != identity.home {
        return Err(CheckpointError::InvalidExecutionIdentity(format!(
            "reconstruction user '{}' has home '{}', expected '{}'",
            identity.user,
            account.dir.display(),
            identity.home.display()
        )));
    }
    let home = fs::symlink_metadata(&identity.home).map_err(|source| CheckpointError::ApplyIo {
        operation: "inspect reconstruction home",
        path: identity.home.clone(),
        source,
    })?;
    if !home.is_dir()
        || home.file_type().is_symlink()
        || home.uid() != account.uid.as_raw()
        || home.gid() != account.gid.as_raw()
    {
        return Err(CheckpointError::InvalidExecutionIdentity(format!(
            "reconstruction home '{}' must be a real directory owned by '{}'",
            identity.home.display(),
            identity.user
        )));
    }
    chown_tree(path, account.uid.as_raw(), account.gid.as_raw()).map_err(|source| {
        CheckpointError::ApplyIo {
            operation: "hand reconstruction files to the learner",
            path: path.to_path_buf(),
            source,
        }
    })
}

#[cfg(unix)]
fn chown_tree(path: &Path, uid: u32, gid: u32) -> io::Result<()> {
    use std::os::unix::fs::chown;

    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "reconstruction ownership handoff refuses symlinks",
        ));
    }
    if metadata.is_dir() {
        for child in fs::read_dir(path)? {
            chown_tree(&child?.path(), uid, gid)?;
        }
    }
    chown(path, Some(uid), Some(gid))
}

#[cfg(not(unix))]
fn handoff_tree(path: &Path, _identity: &ReconstructionIdentity) -> Result<(), CheckpointError> {
    Err(CheckpointError::InvalidExecutionIdentity(format!(
        "reconstruction ownership handoff is unsupported for '{}'",
        path.display()
    )))
}

async fn run_reconstruction_script(
    program: PathBuf,
    manifest: &ReconstructionManifest,
    image_lock: PathBuf,
    label: &str,
    identity: ScriptIdentity<'_>,
) -> Result<(), CheckpointError> {
    // Checkpoint bytes stay on the required noexec tmpfs. The scripts are
    // signed workshop inputs, so pass their paths to the fixed guest shell
    // instead of asking the kernel to execute them from that mount.
    // Reconstruction scripts are workshop-authored. Keep the workspace
    // agent's report/bootstrap credentials and process configuration out of
    // their environment, and expose only the deterministic execution
    // contract required by the signed bundle. Bootstrap remains privileged;
    // every catch-up and verifier runs as the configured learner identity.
    let checkpoint_id = manifest.checkpoint_id.as_str();
    let install_root = manifest.install_root.to_string_lossy();
    let image_lock = image_lock.to_string_lossy();
    let shell_program = program.to_string_lossy();
    let mut command = match identity {
        ScriptIdentity::Root { home, learner_user } => {
            let mut command = tokio::process::Command::new(RECONSTRUCTION_SHELL);
            command
                .arg("--noprofile")
                .arg("--norc")
                .arg("-c")
                .arg("umask 0022; exec /bin/bash -- \"$1\"")
                .arg("intar-reconstruction")
                .arg(&program)
                .env_clear()
                .env("PATH", RECONSTRUCTION_PATH)
                .env("HOME", home)
                .env("USER", "root")
                .env("LOGNAME", "root")
                .env("SHELL", RECONSTRUCTION_SHELL)
                .env("LANG", "C.UTF-8")
                .env("LC_ALL", "C.UTF-8")
                .env("INTAR_WORKSHOP_INSTALL_ROOT", &manifest.install_root)
                .env("INTAR_WORKSHOP_IMAGE_LOCK", image_lock.as_ref())
                .env("INTAR_WORKSHOP_CHECKPOINT_ID", checkpoint_id)
                .env("INTAR_WORKSHOP_LEARNER_USER", learner_user);
            command
        }
        ScriptIdentity::Reconstruction(identity) => {
            let mut command = tokio::process::Command::new(LEARNER_RUNNER);
            command
                .arg("--user")
                .arg(&identity.user)
                .arg("--")
                .arg("/usr/bin/env")
                .arg("-i")
                .arg(format!("HOME={}", identity.home.display()))
                .arg(format!("USER={}", identity.user))
                .arg(format!("LOGNAME={}", identity.user))
                .arg(format!("SHELL={RECONSTRUCTION_SHELL}"))
                .arg(format!("PATH={RECONSTRUCTION_PATH}"))
                .arg("LANG=C.UTF-8")
                .arg("LC_ALL=C.UTF-8")
                .arg(format!("INTAR_WORKSHOP_INSTALL_ROOT={install_root}"))
                .arg(format!("INTAR_WORKSHOP_IMAGE_LOCK={image_lock}"))
                .arg(format!("INTAR_WORKSHOP_CHECKPOINT_ID={checkpoint_id}"))
                .arg(format!("INTAR_WORKSHOP_LEARNER_USER={}", identity.user))
                .arg(RECONSTRUCTION_SHELL)
                .arg("--noprofile")
                .arg("--norc")
                .arg("-c")
                .arg("umask 0022; exec /bin/bash -- \"$1\"")
                .arg("intar-reconstruction")
                .arg(shell_program.as_ref())
                .env_clear()
                .env("PATH", RECONSTRUCTION_PATH)
                .env("LANG", "C.UTF-8")
                .env("LC_ALL", "C.UTF-8");
            command
        }
    };
    command
        .current_dir(&manifest.install_root)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let outcome = run_command_with_bounded_output(&mut command)
        .await
        .map_err(|source| CheckpointError::ApplyStart {
            program: program.clone(),
            source,
        })?;
    if !outcome.status.success() {
        return Err(CheckpointError::ApplyFailed {
            program: PathBuf::from(label),
            status: outcome.status.to_string(),
            diagnostic: command_diagnostic(&outcome),
        });
    }
    Ok(())
}

async fn run_command_with_bounded_output(
    command: &mut tokio::process::Command,
) -> io::Result<CommandOutcome> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let mut process_group = ProcessGroupGuard::new(&child);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("checkpoint command stdout pipe was not created"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("checkpoint command stderr pipe was not created"))?;
    let wait = async {
        let result = child.wait().await;
        // A reconstruction script must leave durable services through the
        // service manager or container runtime, never as inherited children.
        // Reap any remaining descendants before waiting for pipe EOF.
        process_group.terminate();
        result
    };
    let (status, stdout_tail, stderr_tail) =
        tokio::try_join!(wait, read_bounded_tail(stdout), read_bounded_tail(stderr))?;
    Ok(CommandOutcome {
        status,
        stdout_tail,
        stderr_tail,
    })
}

async fn read_bounded_tail(mut stream: impl tokio::io::AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut tail = Vec::with_capacity(COMMAND_DIAGNOSTIC_TAIL_BYTES);
    let mut buffer = [0_u8; 8192];
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..read]);
        if tail.len() > COMMAND_DIAGNOSTIC_TAIL_BYTES {
            let excess = tail.len() - COMMAND_DIAGNOSTIC_TAIL_BYTES;
            tail.drain(..excess);
        }
    }
    Ok(tail)
}

fn command_diagnostic(outcome: &CommandOutcome) -> String {
    let mut raw = String::new();
    for (label, bytes) in [
        ("stderr", outcome.stderr_tail.as_slice()),
        ("stdout", outcome.stdout_tail.as_slice()),
    ] {
        let value = String::from_utf8_lossy(bytes)
            .chars()
            .map(|character| {
                if character.is_control() {
                    ' '
                } else {
                    character
                }
            })
            .collect::<String>();
        let value = value.trim();
        if !value.is_empty() {
            raw.push_str("; ");
            raw.push_str(label);
            raw.push_str(" tail: ");
            raw.push_str(value);
        }
    }
    let mut diagnostic = SanitizedError::new(raw, &[]).as_str().to_owned();
    if diagnostic.len() > COMMAND_DIAGNOSTIC_MAX_BYTES {
        diagnostic.truncate(floor_char_boundary(
            &diagnostic,
            COMMAND_DIAGNOSTIC_MAX_BYTES,
        ));
    }
    diagnostic
}

fn floor_char_boundary(value: &str, index: usize) -> usize {
    let mut boundary = index.min(value.len());
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    boundary
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
    #[error("checkpoint apply program {program} exited with {status}{diagnostic}")]
    ApplyFailed {
        program: PathBuf,
        status: String,
        diagnostic: String,
    },
    #[error("checkpoint download and apply exceeded {seconds} seconds")]
    ApplyTimedOut { seconds: u64 },
    #[error("invalid checkpoint reconstruction manifest: {0}")]
    InvalidManifest(String),
    #[error("invalid checkpoint reconstruction identity: {0}")]
    InvalidExecutionIdentity(String),
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
    use super::CommandOutcome;
    use super::ReconstructionManifest;
    use super::ScriptIdentity;
    use super::StagedCheckpoint;
    use super::command_diagnostic;
    #[cfg(target_os = "linux")]
    use super::run_command_with_bounded_output;
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
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt as _;
    use std::path::PathBuf;
    #[cfg(target_os = "linux")]
    use std::time::Duration;
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
        fs::write(root.join("runtime/images.lock"), b"image lock").expect("image lock");
        let script = root.join("runtime/bootstrap.sh");
        fs::write(
            &script,
            b"#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s' \"${INTAR_WORKSHOP_LEARNER_USER}\" > learner-user.ok\nprintf applied > invocation.ok\n",
        )
        .expect("script");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o644))
            .expect("non-executable script mode");

        let checkpoint = StagedCheckpoint {
            _temporary: temporary,
            checkpoint_id: "checkpoint-00".to_owned(),
            root,
        };
        let reconstruction_home = TempDir::new().expect("reconstruction home");
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

        run_reconstruction_script(
            script,
            &manifest,
            checkpoint.root().join("runtime/images.lock"),
            "bootstrap",
            ScriptIdentity::Root {
                home: reconstruction_home.path(),
                learner_user: "root",
            },
        )
        .await
        .expect("fixed shell must run a signed script from a noexec-compatible path");
        assert_eq!(
            fs::read(install_root.join("invocation.ok")).expect("execution marker"),
            b"applied"
        );
        assert_eq!(
            fs::read(install_root.join("learner-user.ok")).expect("learner-user marker"),
            b"root"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reconstruction_failure_drains_noisy_output_and_keeps_bounded_tails() {
        use std::os::unix::fs::PermissionsExt as _;

        let temporary = TempDir::new().expect("temp dir");
        let root = temporary.path().join("root");
        let install_root = temporary.path().join("install");
        fs::create_dir_all(root.join("runtime")).expect("runtime directory");
        fs::create_dir(&install_root).expect("install root");
        fs::write(root.join("runtime/images.lock"), b"image lock").expect("image lock");
        let script = root.join("runtime/bootstrap.sh");
        fs::write(
            &script,
            br#"#!/usr/bin/env bash
set -euo pipefail
for _ in $(seq 1 100000); do printf x; done
for _ in $(seq 1 1000); do printf y >&2; done
printf '\nINTAR_TALOS_FAILURE=nodes0,kubectl-connect,run2,oom0,restart0,wait-kubelet\n' >&2
exit 17
"#,
        )
        .expect("script");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o400))
            .expect("readable script mode");

        let checkpoint = StagedCheckpoint {
            _temporary: TempDir::new().expect("checkpoint owner"),
            checkpoint_id: "checkpoint-00".to_owned(),
            root: root.clone(),
        };
        let manifest = ReconstructionManifest {
            schema_version: 3,
            workshop_slug: "test-workshop".to_owned(),
            checkpoint_id: checkpoint.checkpoint_id().to_owned(),
            install_root,
            bootstrap_script: PathBuf::from("runtime/bootstrap.sh"),
            runtime_files: Vec::new(),
            apply_steps: Vec::new(),
            probe_verifiers: Vec::new(),
            external_images: Vec::new(),
        };

        let error = run_reconstruction_script(
            script,
            &manifest,
            root.join("runtime/images.lock"),
            "bootstrap",
            ScriptIdentity::Root {
                home: temporary.path(),
                learner_user: "root",
            },
        )
        .await
        .expect_err("script must fail");
        let message = error.to_string();
        assert!(message.contains(
            "INTAR_TALOS_FAILURE=nodes0,kubectl-connect,run2,oom0,restart0,wait-kubelet"
        ));
        assert!(message.contains("stdout tail:"));
        assert!(message.len() <= 500);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cancelling_a_checkpoint_command_kills_its_process_group() {
        let temporary = TempDir::new().expect("temp dir");
        let pid_file = temporary.path().join("descendant.pid");
        let pid_file_for_command = pid_file.clone();
        let task = tokio::spawn(async move {
            let mut command = tokio::process::Command::new("/bin/bash");
            command
                .arg("--noprofile")
                .arg("--norc")
                .arg("-c")
                .arg("sleep 300 & printf '%s' \"$!\" > \"$1\"; wait")
                .arg("intar-process-group-test")
                .arg(pid_file_for_command);
            run_command_with_bounded_output(&mut command).await
        });

        let raw_pid = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(value) = fs::read_to_string(&pid_file)
                    && !value.is_empty()
                {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("descendant PID must be written");
        let pid = nix::unistd::Pid::from_raw(
            raw_pid
                .parse::<i32>()
                .expect("descendant PID must be numeric"),
        );

        task.abort();
        let _ = task.await;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if nix::sys::signal::kill(pid, None)
                    .is_err_and(|error| error == nix::errno::Errno::ESRCH)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("process-group descendant must be killed on cancellation");
    }

    #[cfg(unix)]
    #[test]
    fn command_diagnostics_are_sanitized_and_utf8_safely_bounded() {
        let mut stdout_tail = "🙂".repeat(128).into_bytes();
        stdout_tail.extend_from_slice(b"\0\x1b[31m");
        let outcome = CommandOutcome {
            status: std::process::ExitStatus::from_raw(256),
            stdout_tail,
            stderr_tail: b"failed at https://store.example/bundle?token=super-secret\r\ncredential=also-secret"
                .to_vec(),
        };

        let diagnostic = command_diagnostic(&outcome);
        assert!(diagnostic.len() <= super::COMMAND_DIAGNOSTIC_MAX_BYTES);
        assert!(diagnostic.is_char_boundary(diagnostic.len()));
        assert!(!diagnostic.contains("super-secret"));
        assert!(!diagnostic.contains("also-secret"));
        assert!(!diagnostic.contains("?token="));
        assert!(!diagnostic.contains('\0'));
        assert!(!diagnostic.contains('\u{1b}'));
        assert!(!diagnostic.contains('\n'));
        assert!(diagnostic.contains("[REDACTED]"));
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
