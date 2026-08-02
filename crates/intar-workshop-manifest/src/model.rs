use serde::{Deserialize, Serialize};

/// The normalized, version-two workshop authoring manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkshopManifest {
    pub format_version: u8,
    pub workshop: Workshop,
    pub workspace: Workspace,
    pub modules: Vec<Module>,
    pub agenda: Vec<AgendaItem>,
    pub presentation: Presentation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Workshop {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub prerequisites: Vec<String>,
    pub attribution: String,
    pub default_lobby_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Workspace {
    pub lease_grace_minutes: u32,
    pub initial_checkpoint: String,
    pub vms: Vec<WorkspaceVm>,
    pub runtime_profiles: Vec<RuntimeProfile>,
    pub applications: Vec<WorkspaceApplication>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProviderKind {
    AgentKvm,
    HetznerCloud,
    GcpCompute,
}

impl RuntimeProviderKind {
    pub const fn is_direct_cloud(self) -> bool {
        matches!(self, Self::HetznerCloud | Self::GcpCompute)
    }
}

/// One explicitly named, immutable runtime choice offered by a Workshop
/// revision. Provider catalog resolution happens during publication; these are
/// the exact author inputs that a resolver must prove without substitution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeProfile {
    pub id: String,
    pub provider: RuntimeProviderKind,
    pub vm_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_type: Option<String>,
    pub system_image: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_disk_type: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceVm {
    pub id: String,
    pub cpu_millis: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceApplication {
    pub id: String,
    pub label: String,
    pub vm: String,
    pub port: u16,
    pub protocol: ApplicationProtocol,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_host: Option<String>,
    pub release_module: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationProtocol {
    Http,
    Ws,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Module {
    pub id: String,
    pub tier: ModuleTier,
    pub outcome: String,
    pub depends_on: Vec<String>,
    pub content: String,
    pub facilitator_notes: String,
    pub hints: Vec<String>,
    pub solution: String,
    pub explain_back: String,
    pub verify_script: String,
    pub catch_up_script: String,
    pub checkpoint: String,
    pub probes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleTier {
    Gate,
    Core,
    Stretch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgendaItem {
    pub id: String,
    pub kind: AgendaKind,
    pub duration_minutes: u32,
    pub scheduled: bool,
    pub module: Option<String>,
    pub slides: Vec<String>,
    pub release: ReleaseMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgendaKind {
    Briefing,
    Lab,
    Demo,
    Break,
    ExplainBack,
    Tinker,
    Retro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseMode {
    Facilitator,
    Automatic,
    Pool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Presentation {
    pub slides: Vec<PresentationSlide>,
    pub assets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PresentationSlide {
    pub id: String,
    pub content: String,
    pub presenter_notes: String,
    pub layout: SlideLayout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SlideLayout {
    Cover,
    Default,
    Section,
    Statement,
    Break,
    Closing,
}

/// A fully parsed and repository-validated workshop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedWorkshop {
    pub manifest: WorkshopManifest,
    pub scheduled_duration_minutes: u32,
    /// Sorted, safe paths included in the source bundle, including `workshop.hcl`.
    pub source_files: Vec<String>,
}

/// The canonical metadata added to every bundle as `workshop.compiled.json`.
#[derive(Debug, Serialize)]
pub struct CompiledWorkshop<'a> {
    pub format_version: u8,
    pub scheduled_duration_minutes: u32,
    pub manifest: &'a WorkshopManifest,
}

/// Architecture reported by a runtime provider while resolving immutable
/// publication metadata.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderArchitecture {
    X86_64,
    Arm64,
}

/// Provider-neutral catalog observation. API-specific units must be converted
/// before constructing this value. The resolver may turn an author-facing
/// image family into an exact immutable image identity, but may not substitute
/// another machine type or requested location.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProfileObservation {
    pub provider: RuntimeProviderKind,
    pub machine_type: String,
    pub resolved_system_image: String,
    pub system_image_is_immutable: bool,
    pub architecture: ProviderArchitecture,
    pub cores: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
    pub deprecated: bool,
    pub available_locations: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimeProfileResolutionRequest<'a> {
    pub profile: &'a RuntimeProfile,
    pub requirements: &'a WorkspaceVm,
}

/// Immutable provider metadata written into a Workshop revision after catalog
/// resolution. The explicit compatibility proof can only be produced by the
/// resolver path; unverified authoring input never has this representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRuntimeProfile {
    pub id: String,
    pub provider: RuntimeProviderKind,
    pub vm_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_type: Option<String>,
    /// Author-facing image selector from the immutable Workshop source.
    pub requested_system_image: String,
    /// Exact provider identity resolved at publication time. For agent KVM,
    /// checkpoint image digests are the immutable execution identity and this
    /// retains the exact authored base-image key.
    pub immutable_system_image: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_disk_type: Option<String>,
    pub locations: Vec<String>,
    pub hardware: ResolvedProviderHardware,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProviderHardware {
    pub architecture: ProviderArchitecture,
    pub cpu_millis: u32,
    pub provider_cpu_count: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
}
