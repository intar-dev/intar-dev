use serde::Serialize;

/// The normalized, version-one workshop authoring manifest.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<WorkspaceProvider>,
    pub applications: Vec<WorkspaceApplication>,
}

/// Provider-specific authoring input. Absence means the existing `agent_kvm`
/// runtime. Provider resolution happens at publication time so a source bundle
/// remains deterministic and never needs organization cloud credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceProvider {
    HetznerCloud {
        vm_id: String,
        server_type: String,
        system_image: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceVm {
    pub id: String,
    pub image: String,
    pub vcpu_millis: u32,
    pub memory_mib: u32,
    pub disk_gib: u32,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderArchitecture {
    X86,
    Arm,
}

/// Normalized hardware returned by the Hetzner catalog resolver. API-specific
/// units must be converted before constructing this value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HetznerServerTypeObservation {
    pub name: String,
    pub architecture: ProviderArchitecture,
    pub cores: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
    pub deprecated: bool,
}

/// Immutable provider metadata written into the published/hydrated manifest.
/// The explicit `compatible` proof can only be produced by the resolver path;
/// unverified authoring input never has this representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum ResolvedWorkspaceProvider {
    #[serde(rename = "agent_kvm")]
    AgentKvm,
    #[serde(rename = "hetzner_cloud")]
    HetznerCloud {
        #[serde(rename = "vmId")]
        vm_id: String,
        #[serde(rename = "serverType")]
        server_type: String,
        #[serde(rename = "systemImage")]
        system_image: String,
        hardware: ResolvedProviderHardware,
        compatible: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProviderHardware {
    pub architecture: ProviderArchitecture,
    pub cores: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
}
