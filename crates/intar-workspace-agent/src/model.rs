use crate::secrets::{SanitizedError, SecretString};
use serde::{Deserialize, Serialize};
use url::Url;

pub const CONTRACT_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionIdentity {
    pub execution_id: String,
    pub workspace_id: String,
    pub generation: u32,
}

impl ExecutionIdentity {
    pub fn validate(&self) -> Result<(), String> {
        validate_id("execution_id", &self.execution_id)?;
        validate_id("workspace_id", &self.workspace_id)?;
        if self.generation == 0 {
            return Err("generation must be greater than zero".to_owned());
        }
        Ok(())
    }
}

fn validate_id(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{name} must contain between 1 and 128 bytes"));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!(
            "{name} may contain only ASCII letters, digits, '-' and '_'"
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
pub struct BootstrapRequest {
    pub contract_version: u16,
    pub identity: ExecutionIdentity,
    pub agent_version: String,
}

impl BootstrapRequest {
    pub fn new(identity: ExecutionIdentity) -> Self {
        Self {
            contract_version: CONTRACT_VERSION,
            identity,
            agent_version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointCompression {
    None,
    Gzip,
    Zstd,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CheckpointDescriptor {
    pub checkpoint_id: String,
    /// Time-limited, provider-generated URL. The URL itself is a secret and is
    /// never included in Debug output or reports.
    pub signed_url: SecretString,
    pub sha256: String,
    pub size_bytes: u64,
    pub compression: CheckpointCompression,
    /// Ed25519 signature over the exact compressed bytes downloaded from
    /// `signed_url`. The signer ID selects a public key pinned in cloud-init.
    pub signature_b64: String,
    pub signing_key_id: String,
    pub expires_at_unix_ms: i64,
}

impl CheckpointDescriptor {
    pub fn validate(&self, now_unix_ms: i64, max_bytes: u64) -> Result<(), String> {
        if self.checkpoint_id.is_empty() || self.checkpoint_id.len() > 128 {
            return Err("checkpoint_id must contain between 1 and 128 bytes".to_owned());
        }
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("checkpoint sha256 must be 64 lowercase hexadecimal characters".to_owned());
        }
        if self.size_bytes == 0 || self.size_bytes > max_bytes {
            return Err(format!(
                "checkpoint size must be between 1 and {max_bytes} bytes"
            ));
        }
        if self.signing_key_id.is_empty()
            || self.signing_key_id.len() > 128
            || !self
                .signing_key_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err("checkpoint signing_key_id is invalid".to_owned());
        }
        let signature = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            self.signature_b64.as_bytes(),
        )
        .map_err(|_| "checkpoint signature_b64 is invalid".to_owned())?;
        if signature.len() != 64 {
            return Err("checkpoint signature must decode to 64 bytes".to_owned());
        }
        if self.expires_at_unix_ms <= now_unix_ms {
            return Err("checkpoint signed URL is expired".to_owned());
        }
        validate_signed_url(self.signed_url.expose())
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct BootstrapResponse {
    pub contract_version: u16,
    pub identity: ExecutionIdentity,
    pub report_credential: SecretString,
    pub checkpoint: CheckpointDescriptor,
}

impl BootstrapResponse {
    pub fn validate_for(
        &self,
        identity: &ExecutionIdentity,
        now_unix_ms: i64,
        max_checkpoint_bytes: u64,
    ) -> Result<(), String> {
        if self.contract_version != CONTRACT_VERSION {
            return Err(format!(
                "unsupported bootstrap contract version {}",
                self.contract_version
            ));
        }
        if &self.identity != identity {
            return Err("bootstrap response identity does not match this generation".to_owned());
        }
        if self.report_credential.expose().is_empty()
            || self.report_credential.expose().len() > 4096
        {
            return Err("report credential has an invalid length".to_owned());
        }
        self.checkpoint.validate(now_unix_ms, max_checkpoint_bytes)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPhase {
    Bootstrapping,
    ApplyingCheckpoint,
    StartingServices,
    Ready,
    Degraded,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Unknown,
    Healthy,
    Degraded,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeStatus {
    Unknown,
    Pass,
    Fail,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProbeObservation {
    pub id: String,
    pub status: ProbeStatus,
    pub observed_at_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SanitizedError>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AgentReport {
    pub contract_version: u16,
    pub identity: ExecutionIdentity,
    pub sequence: u64,
    pub checkpoint_id: String,
    pub boot_id: String,
    pub phase: AgentPhase,
    pub health: HealthStatus,
    pub terminal_ready: bool,
    pub recording_drain_completed: bool,
    /// Ordered module steps whose signed catch-up and verifier scripts
    /// completed successfully during this checkpoint reconstruction.
    pub completed_module_ids: Vec<String>,
    pub ssh_host_keys_openssh: Vec<String>,
    pub probes: Vec<ProbeObservation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SanitizedError>,
    pub reported_at_unix_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ReportResponse {
    pub accepted_sequence: u64,
    #[serde(default)]
    pub drain_recordings: bool,
    #[serde(default)]
    pub next_checkpoint: Option<CheckpointDescriptor>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ArtifactGrantRequest {
    pub contract_version: u16,
    pub identity: ExecutionIdentity,
    pub kind: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ArtifactUploadGrant {
    pub identity: ExecutionIdentity,
    pub artifact_id: String,
    pub signed_upload_url: SecretString,
    pub expires_at_unix_ms: i64,
}

impl ArtifactUploadGrant {
    pub fn validate_for(
        &self,
        identity: &ExecutionIdentity,
        now_unix_ms: i64,
    ) -> Result<(), String> {
        if &self.identity != identity {
            return Err("artifact grant identity does not match this generation".to_owned());
        }
        if self.artifact_id.is_empty() || self.artifact_id.len() > 128 {
            return Err("artifact_id has an invalid length".to_owned());
        }
        if self.expires_at_unix_ms <= now_unix_ms {
            return Err("artifact upload grant is expired".to_owned());
        }
        validate_signed_url(self.signed_upload_url.expose())
    }
}

pub fn validate_signed_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "signed URL is invalid".to_owned())?;
    if url.scheme() != "https" {
        return Err("signed URL must use HTTPS".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("signed URL must not contain credentials or a fragment".to_owned());
    }
    if url.host_str().is_none() {
        return Err("signed URL must include a hostname".to_owned());
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReportSequenceGuard {
    identity: ExecutionIdentity,
    last_accepted: u64,
}

impl ReportSequenceGuard {
    pub fn new(identity: ExecutionIdentity, last_accepted: u64) -> Self {
        Self {
            identity,
            last_accepted,
        }
    }

    pub fn accept(&mut self, identity: &ExecutionIdentity, sequence: u64) -> Result<(), String> {
        if identity != &self.identity {
            return Err("report belongs to a stale execution generation".to_owned());
        }
        if sequence <= self.last_accepted {
            return Err(format!(
                "report sequence {sequence} is stale; last accepted is {}",
                self.last_accepted
            ));
        }
        self.last_accepted = sequence;
        Ok(())
    }

    pub fn last_accepted(&self) -> u64 {
        self.last_accepted
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AgentPhase, AgentReport, CONTRACT_VERSION, ExecutionIdentity, HealthStatus,
        ReportSequenceGuard,
    };

    fn identity(generation: u32) -> ExecutionIdentity {
        ExecutionIdentity {
            execution_id: "exec_1".to_owned(),
            workspace_id: "workspace_1".to_owned(),
            generation,
        }
    }

    #[test]
    fn sequence_guard_rejects_stale_and_other_generation_reports() {
        let mut guard = ReportSequenceGuard::new(identity(2), 7);
        assert!(guard.accept(&identity(2), 8).is_ok());
        assert!(guard.accept(&identity(2), 8).is_err());
        assert!(guard.accept(&identity(2), 6).is_err());
        assert!(guard.accept(&identity(1), 9).is_err());
        assert_eq!(guard.last_accepted(), 8);
    }

    #[test]
    fn report_serializes_completed_module_attestation_in_signed_order() {
        let report = AgentReport {
            contract_version: CONTRACT_VERSION,
            identity: identity(2),
            sequence: 8,
            checkpoint_id: "checkpoint-02".to_owned(),
            boot_id: "00000000-0000-4000-8000-000000000002".to_owned(),
            phase: AgentPhase::StartingServices,
            health: HealthStatus::Unknown,
            terminal_ready: false,
            recording_drain_completed: false,
            completed_module_ids: vec!["00".to_owned(), "01".to_owned(), "02".to_owned()],
            ssh_host_keys_openssh: Vec::new(),
            probes: Vec::new(),
            error: None,
            reported_at_unix_ms: 42,
        };

        let serialized = serde_json::to_value(report).expect("agent report JSON");
        assert_eq!(
            serialized["completed_module_ids"],
            serde_json::json!(["00", "01", "02"])
        );
        assert_eq!(
            serialized["boot_id"],
            "00000000-0000-4000-8000-000000000002"
        );
    }
}
