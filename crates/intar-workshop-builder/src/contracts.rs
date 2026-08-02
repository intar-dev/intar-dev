use intar_contracts::catalog::{ImageFormat, ImageKey};
use intar_workshop_manifest::RuntimeProfileObservation;
use schemars::JsonSchema;
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
    /// Trusted control-plane catalog observations for every direct-cloud
    /// profile in the claimed source bundle. The builder independently binds
    /// these to source profile IDs and revalidates them before producing any
    /// publication artifact.
    pub runtime_profile_observations: Vec<ClaimedRuntimeProfileObservation>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ClaimedRuntimeProfileObservation {
    pub profile_id: String,
    pub observation: RuntimeProfileObservation,
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
    pub format: RuntimeBundleFormat,
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

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeBundleFormat {
    DirectCloudLinuxX86_64V1,
}

/// The only terminal payloads accepted by the workshop publication endpoint.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorkshopPublicationResult {
    Succeeded {
        manifest: Box<HydratedWorkshopManifestV2>,
        checkpoints: Vec<CheckpointBuildResult>,
    },
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HydratedWorkshopManifestV2 {
    #[schemars(range(min = 2, max = 2))]
    pub schema_version: u8,
    pub workshop: HydratedWorkshop,
    pub workspace: HydratedWorkspace,
    pub modules: Vec<HydratedModule>,
    pub agenda: Vec<HydratedAgendaItem>,
    pub presentation: HydratedPresentation,
    pub duration_minutes: u32,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HydratedWorkshop {
    pub slug: String,
    pub title: String,
    pub summary: String,
    pub prerequisites: Vec<String>,
    pub attribution: HydratedAttribution,
    pub default_lobby_minutes: u32,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HydratedAttribution {
    pub title: String,
    pub url: String,
    pub license: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HydratedWorkspace {
    pub lease_grace_minutes: u32,
    pub vms: Vec<HydratedWorkspaceVm>,
    pub runtime_profiles: Vec<HydratedRuntimeProfile>,
    pub checkpoints: Vec<HydratedCheckpoint>,
    pub initial_checkpoint_id: String,
    pub applications: Vec<HydratedWorkspaceApplication>,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HydratedRuntimeProviderKind {
    AgentKvm,
    HetznerCloud,
    GcpCompute,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HydratedRuntimeArchitecture {
    X86_64,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HydratedRuntimeHardware {
    pub architecture: HydratedRuntimeArchitecture,
    pub cpu_millis: u32,
    pub provider_cpu_count: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HydratedGcpRootDiskType {
    PdBalanced,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(
    deny_unknown_fields,
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "provider"
)]
pub enum HydratedRuntimeProfile {
    AgentKvm {
        id: String,
        vm_id: String,
        requested_system_image: String,
        immutable_system_image: String,
        locations: Vec<String>,
        hardware: HydratedRuntimeHardware,
    },
    HetznerCloud {
        id: String,
        vm_id: String,
        machine_type: String,
        requested_system_image: String,
        immutable_system_image: String,
        locations: Vec<String>,
        hardware: HydratedRuntimeHardware,
    },
    GcpCompute {
        id: String,
        vm_id: String,
        machine_type: String,
        requested_system_image: String,
        immutable_system_image: String,
        root_disk_type: HydratedGcpRootDiskType,
        locations: Vec<String>,
        hardware: HydratedRuntimeHardware,
    },
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HydratedWorkspaceVm {
    pub id: String,
    pub name: String,
    pub cpu_millis: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HydratedCheckpoint {
    pub id: String,
    pub label: String,
    pub vm_images: Vec<HydratedVmImage>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
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

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
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

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
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

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HydratedHint {
    pub id: String,
    pub title: String,
    pub body_markdown: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
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

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HydratedPresentation {
    pub slides: Vec<HydratedSlide>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
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

#[cfg(test)]
mod tests {
    use super::HydratedWorkshopManifestV2;

    #[test]
    fn hydrated_v2_serialization_matches_the_tracked_contract_fixture() -> anyhow::Result<()> {
        let source = include_str!("../fixtures/hydrated-workshop-manifest-v2.json");
        let expected: serde_json::Value = serde_json::from_str(source)?;
        let manifest: HydratedWorkshopManifestV2 = serde_json::from_str(source)?;

        assert_eq!(serde_json::to_value(&manifest)?, expected);
        assert_eq!(manifest.schema_version, 2);
        Ok(())
    }

    #[test]
    fn hydrated_v2_rejects_missing_required_contract_fields() -> anyhow::Result<()> {
        let mut value: serde_json::Value = serde_json::from_str(include_str!(
            "../fixtures/hydrated-workshop-manifest-v2.json"
        ))?;
        value["workshop"]
            .as_object_mut()
            .expect("fixture workshop is an object")
            .remove("attribution");

        assert!(serde_json::from_value::<HydratedWorkshopManifestV2>(value).is_err());
        Ok(())
    }

    #[test]
    fn hydrated_v2_enforces_x86_and_provider_specific_profile_shapes() -> anyhow::Result<()> {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../fixtures/hydrated-workshop-manifest-v2.json"
        ))?;
        for mutation in [
            ("hardware architecture", "arm64"),
            ("GCP root disk", "pd-ssd"),
            ("agent discriminator", "agent_kvm"),
        ] {
            let mut value = fixture.clone();
            let profile = &mut value["workspace"]["runtimeProfiles"][0];
            match mutation.0 {
                "hardware architecture" => profile["hardware"]["architecture"] = mutation.1.into(),
                "GCP root disk" => profile["rootDiskType"] = mutation.1.into(),
                "agent discriminator" => profile["provider"] = mutation.1.into(),
                _ => unreachable!(),
            }
            assert!(
                serde_json::from_value::<HydratedWorkshopManifestV2>(value).is_err(),
                "accepted invalid {}",
                mutation.0
            );
        }
        Ok(())
    }

    #[test]
    fn hydrated_v2_accepts_agent_profile_without_cloud_metadata() -> anyhow::Result<()> {
        let mut value: serde_json::Value = serde_json::from_str(include_str!(
            "../fixtures/hydrated-workshop-manifest-v2.json"
        ))?;
        let profile = value["workspace"]["runtimeProfiles"][0]
            .as_object_mut()
            .expect("fixture runtime profile is an object");
        profile.insert("provider".to_owned(), "agent_kvm".into());
        profile.remove("machineType");
        profile.remove("rootDiskType");
        profile.insert("locations".to_owned(), serde_json::json!([]));
        let requested = profile["requestedSystemImage"].clone();
        profile.insert("immutableSystemImage".to_owned(), requested);

        let manifest = serde_json::from_value::<HydratedWorkshopManifestV2>(value)?;
        assert!(matches!(
            &manifest.workspace.runtime_profiles[0],
            super::HydratedRuntimeProfile::AgentKvm { .. }
        ));
        Ok(())
    }
}
