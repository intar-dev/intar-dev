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

/// Builder proof for one checkpoint. A checkpoint is publishable only when
/// both booleans are true for every VM image in the record.
#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointBuildResult {
    pub checkpoint_id: String,
    pub vm_images: Vec<BuiltVmImage>,
    pub sanitized: bool,
    pub cold_boot_verified: bool,
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
