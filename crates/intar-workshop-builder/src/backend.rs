use std::path::{Path, PathBuf};

use anyhow::Result;
use intar_contracts::catalog::{ImageArchitecture, ImageFormat, ImageKey};
use intar_workshop_manifest::WorkshopManifest;

use crate::contracts::{BuiltVmImage, RuntimeBundleArtifact};

/// Purpose of a canonical source-bundle script. Implementations upload this
/// exact file into the isolated build guest and execute it there; callers
/// never provide an arbitrary command string.
#[derive(Debug, Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
pub enum CanonicalScriptKind {
    CatchUp,
    Verify,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CanonicalScript<'a> {
    pub module_id: &'a str,
    pub kind: CanonicalScriptKind,
    pub source_path: &'a Path,
}

#[derive(Debug, Clone)]
pub struct BeginWorkshopBuild<'a> {
    pub publication_id: &'a str,
    pub bundle_root: &'a Path,
    pub manifest: &'a WorkshopManifest,
    pub architecture: ImageArchitecture,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CheckpointImageTarget {
    pub vm_id: String,
    pub image_key: ImageKey,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SealCheckpoint<'a> {
    pub checkpoint_id: &'a str,
    pub targets: &'a [CheckpointImageTarget],
}

/// Exact direct-cloud reconstruction artifact that must be proven on a fresh
/// provider-equivalent base. The public key is derived from the same signer
/// that produced `artifact`; no private material crosses into the guest.
#[derive(Debug, Clone)]
pub struct RuntimeBundleColdBoot<'a> {
    pub checkpoint_id: &'a str,
    pub system_image: &'a str,
    pub bytes: &'a [u8],
    pub artifact: &'a RuntimeBundleArtifact,
    pub signing_public_key_b64: &'a str,
    pub max_checkpoint_bytes: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RuntimeBundleColdBootProof {
    pub workspace_agent_sha256: String,
}

/// Files and immutable boot metadata emitted by the trusted guest workflow.
/// The orchestrator hashes every file again before upload and validates that
/// the image identity is exactly the one it assigned.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SealedVmArtifact {
    pub vm_id: String,
    pub image_key: ImageKey,
    pub image_path: PathBuf,
    pub image_format: ImageFormat,
    pub image_virtual_size_bytes: u64,
    pub kernel_path: PathBuf,
    pub initrd_path: PathBuf,
    pub boot_cmdline: String,
}

impl SealedVmArtifact {
    pub fn report(
        &self,
        image_sha256: String,
        kernel_sha256: String,
        initrd_sha256: String,
    ) -> BuiltVmImage {
        BuiltVmImage {
            vm_id: self.vm_id.clone(),
            image_key: self.image_key.clone(),
            image_sha256,
            image_format: self.image_format.clone(),
            image_virtual_size_bytes: self.image_virtual_size_bytes,
            kernel_sha256,
            initrd_sha256,
            boot_cmdline: self.boot_cmdline.clone(),
        }
    }
}

/// Typed adapter for the existing direct-image/Kino guest workflow.
///
/// A production implementation is expected to use Intar's image cache,
/// direct-QEMU/Kino build SSH session, QMP shutdown handshake, raw-zstd
/// artifact writer, and a fresh runtime seed for cold-boot verification. The
/// interface intentionally has no `run(command)` escape hatch: only validated
/// bundle scripts and fixed lifecycle operations cross this boundary.
pub trait WorkshopExecutionBackend {
    fn begin(&mut self, request: &BeginWorkshopBuild<'_>) -> Result<()>;

    fn run_canonical_script(&mut self, script: &CanonicalScript<'_>) -> Result<()>;

    /// Remove machine identity, transient credentials, logs, caches, and
    /// build-only runtime state, then complete the acknowledged guest shutdown.
    fn sanitize_and_shutdown(&mut self, checkpoint_id: &str) -> Result<()>;

    /// Seal all VM disks using Intar's raw-zstd artifact path.
    fn seal_checkpoint(&mut self, request: &SealCheckpoint<'_>) -> Result<Vec<SealedVmArtifact>>;

    /// Boot the sealed checkpoint as a new guest generation with fresh
    /// credentials. This must never replace a running disk in place.
    fn cold_boot_checkpoint(
        &mut self,
        checkpoint_id: &str,
        artifacts: &[SealedVmArtifact],
    ) -> Result<()>;

    /// Shut down the cold-boot proof generation. When another checkpoint
    /// follows, the backend must leave the sealed state resumable.
    fn finish_cold_boot(&mut self, checkpoint_id: &str) -> Result<()>;

    /// Clone the configured clean direct-cloud base, boot it as a new guest,
    /// upload the exact signed bundle and configured workspace-agent binary,
    /// and require the agent's built-in apply + verifier path to succeed.
    /// Implementations must not reuse the sealed KVM checkpoint disk.
    fn cold_boot_runtime_bundle(
        &mut self,
        request: &RuntimeBundleColdBoot<'_>,
    ) -> Result<RuntimeBundleColdBootProof>;

    /// Start the next mutable build generation from the previous canonical
    /// checkpoint. This keeps checkpoint creation sequential and cumulative.
    fn resume_from_checkpoint(
        &mut self,
        checkpoint_id: &str,
        artifacts: &[SealedVmArtifact],
    ) -> Result<()>;

    fn finish(&mut self) -> Result<()>;

    /// Best-effort cleanup for every failure path after `begin` succeeds.
    fn abort(&mut self);
}
