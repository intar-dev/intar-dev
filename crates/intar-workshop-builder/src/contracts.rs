use intar_contracts::catalog::{ImageFormat, ImageKey};
use serde::{Deserialize, Serialize};

/// One atomic workshop publication assigned to a trusted builder host.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkshopPublicationClaim {
    pub publication_id: String,
    pub workshop_slug: String,
    pub content_hash: String,
    pub required_checkpoint_ids: Vec<String>,
    pub bundle_url: String,
}

/// A sealed VM image produced for a canonical checkpoint.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BuiltVmImage {
    pub vm_id: String,
    pub image_key: ImageKey,
    pub image_sha256: String,
    pub image_format: ImageFormat,
    pub image_virtual_size_bytes: u64,
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub boot_cmdline: String,
}

/// Builder result for one checkpoint. Agent-KVM results carry sealed images
/// and completed local proof. Direct-provider results instead carry a signed
/// reconstruction bundle and an explicit provider-verification handoff.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointBuildResult {
    pub checkpoint_id: String,
    /// Exact ordered module prefix reconstructed by this checkpoint. The
    /// registry compares this with the source manifest before publishing.
    pub covered_module_ids: Vec<String>,
    pub vm_images: Vec<BuiltVmImage>,
    pub sanitized: bool,
    pub cold_boot_verified: bool,
    /// Separate proof that the exact signed reconstruction bundle was applied
    /// successfully by the direct-cloud guest agent on a fresh, pinned Debian
    /// base. This is deliberately not inferred from `cold_boot_verified`,
    /// which describes the sealed agent-KVM disk path.
    pub runtime_bundle_cold_boot_verified: bool,
    /// The direct provider must independently reconstruct and verify this
    /// signed bundle before the checkpoint becomes usable. Builder reports
    /// serialize this marker only for that pending provider-only handoff.
    #[serde(default, skip_serializing_if = "is_false")]
    pub provider_verification_pending: bool,
    /// Learner-safe reconstruction material for direct cloud workspaces. KVM
    /// publications omit it and continue using sealed VM images.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_bundle: Option<RuntimeBundleArtifact>,
}

const fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeBundleCompression {
    None,
    Gzip,
    #[default]
    Zstd,
}

/// Content-addressed artifact proof consumed by the Workshop registry. The
/// signature covers the exact uploaded (and therefore compressed) bytes.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeBundleArtifact {
    pub sha256: String,
    pub compression: RuntimeBundleCompression,
    pub signature_b64: String,
    pub signing_key_id: String,
    /// SHA-256 of the exact workspace-agent binary that verified and applied
    /// this bundle. Builder-side pending reports omit it; the independent
    /// provider verifier records it after reconstructing a clean guest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_agent_sha256: Option<String>,
}

/// The only terminal payloads accepted by the workshop publication endpoint.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorkshopPublicationResult {
    Succeeded {
        manifest: Box<HydratedWorkshopManifestV1>,
        checkpoints: Vec<CheckpointBuildResult>,
    },
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedWorkshopManifestV1 {
    pub schema_version: u8,
    pub workshop: HydratedWorkshop,
    pub workspace: HydratedWorkspace,
    pub modules: Vec<HydratedModule>,
    pub agenda: Vec<HydratedAgendaItem>,
    pub presentation: HydratedPresentation,
    pub duration_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedWorkshop {
    pub slug: String,
    pub title: String,
    pub summary: String,
    pub prerequisites: Vec<String>,
    pub attribution: HydratedAttribution,
    pub default_lobby_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedAttribution {
    pub title: String,
    pub url: String,
    pub license: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedWorkspace {
    pub lease_grace_minutes: u32,
    pub vms: Vec<HydratedWorkspaceVm>,
    pub checkpoints: Vec<HydratedCheckpoint>,
    pub initial_checkpoint_id: String,
    pub applications: Vec<HydratedWorkspaceApplication>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedWorkspaceVm {
    pub id: String,
    pub name: String,
    pub cpu_millis: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedCheckpoint {
    pub id: String,
    pub label: String,
    pub vm_images: Vec<HydratedVmImage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedVmImage {
    pub vm_id: String,
    pub image_key: ImageKey,
    pub image_sha256: String,
}

impl From<&BuiltVmImage> for HydratedVmImage {
    fn from(value: &BuiltVmImage) -> Self {
        Self {
            vm_id: value.vm_id.clone(),
            image_key: value.image_key.clone(),
            image_sha256: value.image_sha256.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedWorkspaceApplication {
    pub id: String,
    pub label: String,
    pub vm_id: String,
    pub port: u16,
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_host: Option<String>,
    pub release_module_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedModule {
    pub id: String,
    pub title: String,
    pub tier: String,
    pub outcome: String,
    pub depends_on: Vec<String>,
    pub participant_markdown: String,
    pub facilitator_notes_markdown: String,
    pub hints: Vec<HydratedHint>,
    pub solution_markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explain_back_prompt: Option<String>,
    pub probe_ids: Vec<String>,
    pub catch_up_checkpoint_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedHint {
    pub id: String,
    pub title: String,
    pub body_markdown: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedAgendaItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub duration_minutes: u32,
    pub scheduled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_id: Option<String>,
    pub slide_ids: Vec<String>,
    pub release: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedPresentation {
    pub slides: Vec<HydratedSlide>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedSlide {
    pub id: String,
    pub layout: String,
    pub title: String,
    pub body_markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes_markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_id: Option<String>,
}
