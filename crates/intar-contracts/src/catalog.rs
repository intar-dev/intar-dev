use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageArchitecture {
    X86_64,
    Aarch64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ImageKey {
    pub scenario: String,
    pub vm: String,
    pub arch: ImageArchitecture,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Mib(pub u32);

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbePhase {
    Boot,
    Scenario,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioDifficulty {
    Easy,
    Medium,
    Hard,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioHintManifestV2 {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body_markdown: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioManifestV2 {
    pub schema_version: u16,
    pub scenario_id: String,
    pub name: String,
    pub title: String,
    pub category: String,
    pub description: String,
    pub difficulty: ScenarioDifficulty,
    pub estimated_minutes: u32,
    pub tags: Vec<String>,
    pub briefing_markdown: String,
    pub solution_markdown: String,
    pub hints: Vec<ScenarioHintManifestV2>,
    pub vms: Vec<ScenarioVmManifestV2>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioVmManifestV2 {
    pub name: String,
    pub image_key: ImageKey,
    pub image_sha256: String,
    pub image_format: ImageFormat,
    pub image_virtual_size_bytes: u64,
    pub boot: ScenarioVmBootManifestV2,
    pub cpu_count: u16,
    pub memory_mib: Mib,
    pub disk_mib: Mib,
    pub probes: Vec<ScenarioProbeManifestV2>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    RawZstd,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioVmBootManifestV2 {
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub cmdline: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioProbeManifestV2 {
    pub id: String,
    pub phase: ProbePhase,
    pub kind: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_markdown: Option<String>,
    pub hints: Vec<ScenarioHintManifestV2>,
}
