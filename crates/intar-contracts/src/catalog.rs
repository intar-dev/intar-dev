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
pub struct ScenarioManifestV1 {
    pub schema_version: u16,
    pub scenario_id: String,
    pub name: String,
    pub description: String,
    pub vms: Vec<ScenarioVmManifestV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioVmManifestV1 {
    pub name: String,
    pub image_key: ImageKey,
    pub image_sha256: String,
    pub cpu_count: u16,
    pub memory_mib: Mib,
    pub disk_mib: Mib,
    pub probes: Vec<ScenarioProbeManifestV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioProbeManifestV1 {
    pub id: String,
    pub phase: ProbePhase,
    pub kind: String,
    pub display_name: String,
}
