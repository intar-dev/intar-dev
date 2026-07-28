use crate::model::{HealthStatus, ProbeObservation, ProbeStatus};
use crate::secrets::SanitizedError;
use intar_kino_proto::kino_v1;
use prost::Message;
use std::time::Duration;
use url::Url;

const MAX_KINO_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SSH_HOST_KEYS: usize = 16;

#[derive(Clone, Debug)]
pub struct KinoSnapshot {
    pub health: HealthStatus,
    pub probes: Vec<ProbeObservation>,
    pub ssh_host_keys_openssh: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct KinoClient {
    client: reqwest::Client,
    url: Url,
}

impl KinoClient {
    pub fn new(url: Url) -> Result<Self, KinoError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(KinoError::Build)?;
        Ok(Self { client, url })
    }

    pub async fn poll(&self, secrets: &[&str]) -> Result<KinoSnapshot, KinoError> {
        let response = self
            .client
            .get(self.url.clone())
            .send()
            .await
            .map_err(KinoError::Request)?
            .error_for_status()
            .map_err(KinoError::Request)?;
        if response.content_length().is_some_and(|length| {
            length > u64::try_from(MAX_KINO_RESPONSE_BYTES).unwrap_or(u64::MAX)
        }) {
            return Err(KinoError::ResponseTooLarge);
        }
        let bytes = response.bytes().await.map_err(KinoError::Request)?;
        if bytes.len() > MAX_KINO_RESPONSE_BYTES {
            return Err(KinoError::ResponseTooLarge);
        }
        decode_snapshot(&bytes, secrets)
    }
}

fn decode_snapshot(bytes: &[u8], secrets: &[&str]) -> Result<KinoSnapshot, KinoError> {
    let snapshot = kino_v1::ProbesSnapshotV1::decode(bytes).map_err(KinoError::Decode)?;
    let observed_at = snapshot.generated_at_unix_ms;
    let mut probes = Vec::with_capacity(snapshot.probes.len());
    for probe in snapshot.probes {
        if probe.id.is_empty() || probe.id.len() > 128 || probe.id.contains(['\n', '\r', '\0']) {
            return Err(KinoError::InvalidProbeId);
        }
        let status = match probe.status {
            1 => ProbeStatus::Pass,
            2 => ProbeStatus::Fail,
            _ => ProbeStatus::Unknown,
        };
        probes.push(ProbeObservation {
            id: probe.id,
            status,
            observed_at_unix_ms: observed_at,
            error: (!probe.error.is_empty()).then(|| SanitizedError::new(&probe.error, secrets)),
        });
    }
    probes.sort_by(|left, right| left.id.cmp(&right.id));

    // A valid response proves the guest-side observer is healthy. Individual
    // module probes intentionally remain independent: future or regressed
    // modules may fail without making the learner's SSH workspace unavailable.
    let health = HealthStatus::Healthy;

    if snapshot.ssh_host_keys_openssh.len() > MAX_SSH_HOST_KEYS {
        return Err(KinoError::TooManyHostKeys);
    }
    let mut host_keys = snapshot.ssh_host_keys_openssh;
    for key in &host_keys {
        if key.len() > 4096
            || key.contains(['\n', '\r', '\0'])
            || !(key.starts_with("ssh-") || key.starts_with("ecdsa-"))
        {
            return Err(KinoError::InvalidHostKey);
        }
    }
    host_keys.sort();
    host_keys.dedup();

    Ok(KinoSnapshot {
        health,
        probes,
        ssh_host_keys_openssh: host_keys,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum KinoError {
    #[error("failed to build Kino HTTP client: {0}")]
    Build(reqwest::Error),
    #[error("Kino request failed: {0}")]
    Request(reqwest::Error),
    #[error("Kino response exceeded the size limit")]
    ResponseTooLarge,
    #[error("failed to decode Kino response: {0}")]
    Decode(prost::DecodeError),
    #[error("Kino returned an invalid probe ID")]
    InvalidProbeId,
    #[error("Kino returned too many SSH host keys")]
    TooManyHostKeys,
    #[error("Kino returned an invalid SSH host key")]
    InvalidHostKey,
}

#[cfg(test)]
mod tests {
    use super::decode_snapshot;
    use intar_kino_proto::kino_v1;
    use prost::Message;

    #[test]
    fn kino_mapping_excludes_raw_probe_values_and_sanitizes_errors() {
        let secret = "report-secret";
        let snapshot = kino_v1::ProbesSnapshotV1 {
            generated_at_unix_ms: 123,
            probes: vec![kino_v1::ProbeSnapshot {
                id: "cluster-ready".to_owned(),
                status: 2,
                error: format!("request token={secret} failed"),
                ..Default::default()
            }],
            ssh_host_keys_openssh: vec!["ssh-ed25519 AAAATEST host".to_owned()],
        };
        let mapped = decode_snapshot(&snapshot.encode_to_vec(), &[secret]).expect("decode");
        assert_eq!(mapped.probes.len(), 1);
        assert_eq!(mapped.health, crate::model::HealthStatus::Healthy);
        let serialized = serde_json::to_string(&mapped.probes).expect("serialize");
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("stdout"));
    }
}
