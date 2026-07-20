use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::future::Future;
use std::io::Read as _;
use std::path::Path;

use anyhow::{Context as _, Result, anyhow, bail};
use intar_contracts::catalog::{ImageArchitecture, ImageFormat, ImageKey};
use intar_image_upload::{PublishArtifactFile, UploadImageBlob};
use intar_workshop_manifest::{Module, ValidatedWorkshop};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::backend::{
    BeginWorkshopBuild, CanonicalScript, CanonicalScriptKind, CheckpointImageTarget,
    SealCheckpoint, SealedVmArtifact, WorkshopExecutionBackend,
};
use crate::bundle::prepare_bundle;
use crate::client::{PublicationRegistry, WorkshopBlobPublisher};
use crate::config::WorkerConfig;
use crate::contracts::{
    BuiltVmImage, CheckpointBuildResult, WorkshopPublicationClaim, WorkshopPublicationResult,
};
use crate::hydrate::hydrate_workshop_manifest;

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum ProcessOutcome {
    Idle,
    Succeeded {
        publication_id: String,
    },
    Failed {
        publication_id: String,
        error: String,
    },
}

/// Claim and completely process at most one publication. Domain publication
/// remains atomic: uploaded content-addressed blobs are not visible as a
/// workshop revision until the single terminal success report is accepted.
pub async fn process_next<R, B>(
    registry: &R,
    backend: &mut B,
    worker: &WorkerConfig,
) -> Result<ProcessOutcome>
where
    R: PublicationRegistry + WorkshopBlobPublisher,
    B: WorkshopExecutionBackend,
{
    process_next_until_cancelled(registry, backend, worker, &CancellationToken::new()).await
}

/// Claim and process at most one publication, leaving an interrupted claim
/// resumable instead of reporting it as a terminal publication failure.
pub async fn process_next_until_cancelled<R, B>(
    registry: &R,
    backend: &mut B,
    worker: &WorkerConfig,
    cancellation: &CancellationToken,
) -> Result<ProcessOutcome>
where
    R: PublicationRegistry + WorkshopBlobPublisher,
    B: WorkshopExecutionBackend,
{
    let Some(claim) = cancellable(cancellation, registry.claim_next()).await? else {
        return Ok(ProcessOutcome::Idle);
    };
    let publication_id = claim.publication_id.clone();
    info!(publication_id, "claimed workshop publication");

    let build = build_publication(registry, backend, worker, &claim, cancellation).await;
    match build {
        Ok(success) => {
            cancellable(cancellation, registry.refresh_auth()).await?;
            cancellable(
                cancellation,
                registry.post_result(&publication_id, &success),
            )
            .await
            .context("failed to commit successful workshop publication")?;
            info!(publication_id, "workshop publication succeeded");
            Ok(ProcessOutcome::Succeeded { publication_id })
        }
        Err(error) => {
            backend.abort();
            if cancellation.is_cancelled() {
                return Err(error).context("workshop publication interrupted by shutdown");
            }
            let message = public_error(&error);
            warn!(publication_id, error = %error, "workshop publication failed");
            cancellable(cancellation, registry.refresh_auth())
                .await
                .with_context(|| {
                    format!(
                        "workshop publication failed ({message}); builder auth refresh for failure report also failed"
                    )
                })?;
            cancellable(
                cancellation,
                registry.post_result(
                    &publication_id,
                    &WorkshopPublicationResult::Failed {
                        error: message.clone(),
                    },
                ),
            )
            .await
            .with_context(|| {
                format!(
                    "workshop publication failed ({message}); terminal failure report also failed"
                )
            })?;
            Ok(ProcessOutcome::Failed {
                publication_id,
                error: message,
            })
        }
    }
}

async fn build_publication<R, B>(
    registry: &R,
    backend: &mut B,
    worker: &WorkerConfig,
    claim: &WorkshopPublicationClaim,
    cancellation: &CancellationToken,
) -> Result<WorkshopPublicationResult>
where
    R: PublicationRegistry + WorkshopBlobPublisher,
    B: WorkshopExecutionBackend,
{
    let bytes = cancellable(
        cancellation,
        registry.download_bundle(&claim.bundle_url, worker.max_compressed_bundle_bytes),
    )
    .await?;
    ensure_running(cancellation)?;
    let prepared = prepare_bundle(claim, &bytes, worker)?;
    ensure_running(cancellation)?;
    let modules = stable_topological_modules(&prepared.workshop)?;
    backend.begin(&BeginWorkshopBuild {
        publication_id: &claim.publication_id,
        bundle_root: &prepared.root,
        manifest: &prepared.workshop.manifest,
        architecture: worker.architecture.clone(),
    })?;
    ensure_running(cancellation)?;

    let mut checkpoints = Vec::with_capacity(modules.len());
    let mut uploaded_artifacts = BTreeSet::new();
    for (index, module) in modules.iter().enumerate() {
        ensure_running(cancellation)?;
        let catch_up_path = prepared.root.join(&module.catch_up_script);
        backend
            .run_canonical_script(&CanonicalScript {
                module_id: &module.id,
                kind: CanonicalScriptKind::CatchUp,
                source_path: &catch_up_path,
            })
            .with_context(|| format!("catch-up for module '{}' failed", module.id))?;
        ensure_running(cancellation)?;

        let verify_path = prepared.root.join(&module.verify_script);
        backend
            .run_canonical_script(&CanonicalScript {
                module_id: &module.id,
                kind: CanonicalScriptKind::Verify,
                source_path: &verify_path,
            })
            .with_context(|| format!("verification for module '{}' failed", module.id))?;
        ensure_running(cancellation)?;
        backend
            .sanitize_and_shutdown(&module.checkpoint)
            .with_context(|| format!("checkpoint '{}' sanitization failed", module.checkpoint))?;
        ensure_running(cancellation)?;

        let targets = checkpoint_targets(claim, &prepared.workshop, module, worker)?;
        let artifacts = backend
            .seal_checkpoint(&SealCheckpoint {
                checkpoint_id: &module.checkpoint,
                targets: &targets,
            })
            .with_context(|| format!("failed to seal checkpoint '{}'", module.checkpoint))?;
        ensure_running(cancellation)?;
        validate_sealed_artifacts(&prepared.workshop, &targets, &artifacts)?;
        backend
            .cold_boot_checkpoint(&module.checkpoint, &artifacts)
            .with_context(|| format!("failed to cold boot checkpoint '{}'", module.checkpoint))?;
        ensure_running(cancellation)?;
        backend
            .run_canonical_script(&CanonicalScript {
                module_id: &module.id,
                kind: CanonicalScriptKind::Verify,
                source_path: &verify_path,
            })
            .with_context(|| {
                format!(
                    "cold-boot verification for checkpoint '{}' failed",
                    module.checkpoint
                )
            })?;
        ensure_running(cancellation)?;
        backend
            .finish_cold_boot(&module.checkpoint)
            .with_context(|| {
                format!(
                    "failed to shut down cold-boot proof for checkpoint '{}'",
                    module.checkpoint
                )
            })?;
        ensure_running(cancellation)?;

        cancellable(cancellation, registry.refresh_auth())
            .await
            .with_context(|| {
                format!(
                    "failed to refresh builder auth before uploading checkpoint '{}'",
                    module.checkpoint
                )
            })?;
        let vm_images =
            hash_and_upload_artifacts(registry, &artifacts, &mut uploaded_artifacts, cancellation)?;
        checkpoints.push(CheckpointBuildResult {
            checkpoint_id: module.checkpoint.clone(),
            vm_images,
            sanitized: true,
            cold_boot_verified: true,
        });

        if index + 1 < modules.len() {
            backend
                .resume_from_checkpoint(&module.checkpoint, &artifacts)
                .with_context(|| {
                    format!(
                        "failed to resume mutable build from checkpoint '{}'",
                        module.checkpoint
                    )
                })?;
            ensure_running(cancellation)?;
        }
    }
    ensure_running(cancellation)?;
    backend.finish()?;
    ensure_running(cancellation)?;
    let manifest = hydrate_workshop_manifest(&prepared.root, &prepared.workshop, &checkpoints)?;
    Ok(WorkshopPublicationResult::Succeeded {
        manifest: Box::new(manifest),
        checkpoints,
    })
}

fn stable_topological_modules(source: &ValidatedWorkshop) -> Result<Vec<&Module>> {
    let mut completed = BTreeSet::new();
    let mut ordered = Vec::with_capacity(source.manifest.modules.len());
    while ordered.len() < source.manifest.modules.len() {
        let mut progressed = false;
        for module in &source.manifest.modules {
            if completed.contains(&module.id) {
                continue;
            }
            if module
                .depends_on
                .iter()
                .all(|dependency| completed.contains(dependency))
            {
                completed.insert(module.id.clone());
                ordered.push(module);
                progressed = true;
            }
        }
        if !progressed {
            bail!("validated workshop modules cannot be ordered by dependencies");
        }
    }
    Ok(ordered)
}

fn checkpoint_targets(
    claim: &WorkshopPublicationClaim,
    source: &ValidatedWorkshop,
    module: &Module,
    worker: &WorkerConfig,
) -> Result<Vec<CheckpointImageTarget>> {
    let scenario = format!("workshop-{}-{}", claim.publication_id, module.checkpoint);
    if !is_safe_registry_slug(&scenario) {
        bail!("derived checkpoint scenario ID '{scenario}' is invalid");
    }
    source
        .manifest
        .workspace
        .vms
        .iter()
        .map(|vm| {
            if !is_safe_registry_slug(&vm.id) {
                bail!("workspace VM ID '{}' is not registry-safe", vm.id);
            }
            Ok(CheckpointImageTarget {
                vm_id: vm.id.clone(),
                image_key: ImageKey {
                    scenario: scenario.clone(),
                    vm: vm.id.clone(),
                    arch: worker.architecture.clone(),
                },
            })
        })
        .collect()
}

fn validate_sealed_artifacts(
    source: &ValidatedWorkshop,
    targets: &[CheckpointImageTarget],
    artifacts: &[SealedVmArtifact],
) -> Result<()> {
    if artifacts.len() != targets.len() {
        bail!(
            "checkpoint sealed {} VM images but {} are required",
            artifacts.len(),
            targets.len()
        );
    }
    let targets_by_vm = targets
        .iter()
        .map(|target| (target.vm_id.as_str(), target))
        .collect::<BTreeMap<_, _>>();
    let source_by_vm = source
        .manifest
        .workspace
        .vms
        .iter()
        .map(|vm| (vm.id.as_str(), vm))
        .collect::<BTreeMap<_, _>>();
    let mut seen = BTreeSet::new();
    for artifact in artifacts {
        if !seen.insert(artifact.vm_id.as_str()) {
            bail!(
                "checkpoint contains duplicate VM image '{}'",
                artifact.vm_id
            );
        }
        let target = targets_by_vm
            .get(artifact.vm_id.as_str())
            .with_context(|| format!("checkpoint returned unknown VM '{}'", artifact.vm_id))?;
        if artifact.image_key != target.image_key {
            bail!(
                "checkpoint VM '{}' returned an unexpected image key",
                artifact.vm_id
            );
        }
        if artifact.image_format != ImageFormat::RawZstd {
            bail!("checkpoint VM '{}' must use raw_zstd", artifact.vm_id);
        }
        let source_vm = source_by_vm
            .get(artifact.vm_id.as_str())
            .context("validated workshop VM disappeared")?;
        let expected_size = u64::from(source_vm.disk_gib)
            .checked_mul(1_024 * 1_024 * 1_024)
            .context("workspace VM disk byte size overflow")?;
        if artifact.image_virtual_size_bytes != expected_size {
            bail!(
                "checkpoint VM '{}' virtual size {} does not match declared {}",
                artifact.vm_id,
                artifact.image_virtual_size_bytes,
                expected_size
            );
        }
        if artifact.boot_cmdline != intar_image_build::PUBLISHED_BOOT_CMDLINE {
            bail!(
                "checkpoint VM '{}' does not use the published Intar boot cmdline",
                artifact.vm_id
            );
        }
        for path in [
            &artifact.image_path,
            &artifact.kernel_path,
            &artifact.initrd_path,
        ] {
            require_regular_file(path)?;
        }
    }
    Ok(())
}

fn hash_and_upload_artifacts<R: WorkshopBlobPublisher>(
    registry: &R,
    artifacts: &[SealedVmArtifact],
    uploaded_artifacts: &mut BTreeSet<String>,
    cancellation: &CancellationToken,
) -> Result<Vec<BuiltVmImage>> {
    artifacts
        .iter()
        .map(|artifact| {
            ensure_running(cancellation)?;
            let image_sha256 = sha256_file_until_cancelled(&artifact.image_path, cancellation)?;
            let kernel_sha256 = sha256_file_until_cancelled(&artifact.kernel_path, cancellation)?;
            let initrd_sha256 = sha256_file_until_cancelled(&artifact.initrd_path, cancellation)?;
            ensure_running(cancellation)?;
            let flat_image_key = registry_image_key(&artifact.image_key);
            registry.upload_image(&UploadImageBlob {
                image_key: flat_image_key,
                scenario_id: artifact.image_key.scenario.clone(),
                vm_name: artifact.vm_id.clone(),
                sha256: image_sha256.clone(),
                source_path: artifact.image_path.clone(),
            })?;
            ensure_running(cancellation)?;
            for (sha256, path) in [
                (&kernel_sha256, &artifact.kernel_path),
                (&initrd_sha256, &artifact.initrd_path),
            ] {
                if uploaded_artifacts.insert(sha256.clone()) {
                    ensure_running(cancellation)?;
                    registry.upload_artifact(
                        &PublishArtifactFile::new(path, sha256).map_err(anyhow::Error::from)?,
                    )?;
                }
            }
            Ok(artifact.report(image_sha256, kernel_sha256, initrd_sha256))
        })
        .collect()
}

#[cfg(test)]
fn sha256_file(path: &Path) -> Result<String> {
    sha256_file_until_cancelled(path, &CancellationToken::new())
}

fn sha256_file_until_cancelled(path: &Path, cancellation: &CancellationToken) -> Result<String> {
    let mut file = File::open(path)
        .with_context(|| format!("failed to open sealed artifact '{}'", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        ensure_running(cancellation)?;
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("failed to hash sealed artifact '{}'", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        std::write!(&mut output, "{byte:02x}").map_err(|error| anyhow!(error))?;
    }
    Ok(output)
}

async fn cancellable<T>(
    cancellation: &CancellationToken,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => bail!("workshop build cancelled"),
        result = future => result,
    }
}

fn ensure_running(cancellation: &CancellationToken) -> Result<()> {
    if cancellation.is_cancelled() {
        bail!("workshop build cancelled");
    }
    Ok(())
}

fn require_regular_file(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect sealed artifact '{}'", path.display()))?;
    if !metadata.file_type().is_file() {
        bail!("sealed artifact '{}' is not a regular file", path.display());
    }
    Ok(())
}

fn registry_image_key(key: &ImageKey) -> String {
    format!(
        "{}-{}-{}",
        key.scenario,
        key.vm,
        architecture_name(&key.arch)
    )
}

const fn architecture_name(architecture: &ImageArchitecture) -> &'static str {
    match architecture {
        ImageArchitecture::X86_64 => "x86_64",
        ImageArchitecture::Aarch64 => "aarch64",
    }
}

fn is_safe_registry_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && !matches!(value, "." | "..")
}

fn public_error(error: &anyhow::Error) -> String {
    let message = format!("{error:#}");
    message.chars().take(4_096).collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Write;

    use super::{public_error, registry_image_key, sha256_file};
    use intar_contracts::catalog::{ImageArchitecture, ImageKey};

    #[test]
    fn hashes_files_and_flattens_image_keys_like_the_registry() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"hello").unwrap();
        assert_eq!(
            sha256_file(file.path()).unwrap(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(
            registry_image_key(&ImageKey {
                scenario: "workshop-pub-checkpoint-00".to_owned(),
                vm: "workspace".to_owned(),
                arch: ImageArchitecture::X86_64,
            }),
            "workshop-pub-checkpoint-00-workspace-x86_64"
        );
    }

    #[test]
    fn public_failures_are_bounded() {
        let error = anyhow::anyhow!("{}", "x".repeat(5_000));
        assert_eq!(public_error(&error).chars().count(), 4_096);
    }
}
