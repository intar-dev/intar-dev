use crate::model::ExecutionIdentity;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use url::Url;

pub const REPORT_INTERVAL_SECONDS: u64 = 10;
pub const DEFAULT_MAX_CHECKPOINT_BYTES: u64 = 512 * 1024 * 1024;
pub const DEFAULT_MAX_ARTIFACT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    pub identity: ExecutionIdentity,
    pub control_plane_endpoint: Url,
    pub bootstrap_capability_path: PathBuf,
    pub state_path: PathBuf,
    pub checkpoint_tmpfs_dir: PathBuf,
    /// Optional compatibility hook. Direct-cloud workshop guests use the
    /// built-in, manifest-validated applier when this is absent.
    #[serde(default)]
    pub checkpoint_apply_program: Option<PathBuf>,
    pub checkpoint_signing_keys: BTreeMap<String, String>,
    pub reconstruction_user: String,
    pub reconstruction_home: PathBuf,
    #[serde(default = "default_kino_url")]
    pub kino_url: Url,
    #[serde(default = "default_max_checkpoint_bytes")]
    pub max_checkpoint_bytes: u64,
    #[serde(default = "default_max_artifact_bytes")]
    pub max_artifact_bytes: u64,
    #[serde(default = "default_recording_dir")]
    pub recording_dir: PathBuf,
    #[serde(default = "default_recording_upload_staging_dir")]
    pub recording_upload_staging_dir: PathBuf,
    #[serde(default = "default_recording_drain_program")]
    pub recording_drain_program: PathBuf,
    #[serde(default = "default_true")]
    pub require_checkpoint_tmpfs: bool,
}

impl AgentConfig {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        let config = toml::from_str::<Self>(&raw).map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        self.identity.validate().map_err(ConfigError::Validation)?;

        if self.control_plane_endpoint.scheme() != "https"
            || self.control_plane_endpoint.host_str().is_none()
            || !self.control_plane_endpoint.username().is_empty()
            || self.control_plane_endpoint.password().is_some()
            || self.control_plane_endpoint.fragment().is_some()
            || self.control_plane_endpoint.query().is_some()
        {
            return Err(ConfigError::Validation(
                "control_plane_endpoint must be an HTTPS base URL without credentials, query, or fragment"
                    .to_owned(),
            ));
        }
        if !self.control_plane_endpoint.path().ends_with('/') {
            return Err(ConfigError::Validation(
                "control_plane_endpoint path must end with '/'".to_owned(),
            ));
        }
        if self.kino_url.scheme() != "http" || !is_loopback_host(&self.kino_url) {
            return Err(ConfigError::Validation(
                "kino_url must use HTTP and a loopback hostname".to_owned(),
            ));
        }
        if self.kino_url.query().is_some()
            || self.kino_url.fragment().is_some()
            || !self.kino_url.username().is_empty()
            || self.kino_url.password().is_some()
        {
            return Err(ConfigError::Validation(
                "kino_url must not contain credentials, query, or fragment".to_owned(),
            ));
        }

        for (name, path) in [
            ("bootstrap_capability_path", &self.bootstrap_capability_path),
            ("state_path", &self.state_path),
            ("checkpoint_tmpfs_dir", &self.checkpoint_tmpfs_dir),
            ("reconstruction_home", &self.reconstruction_home),
            ("recording_dir", &self.recording_dir),
            (
                "recording_upload_staging_dir",
                &self.recording_upload_staging_dir,
            ),
            ("recording_drain_program", &self.recording_drain_program),
        ] {
            if !path.is_absolute() {
                return Err(ConfigError::Validation(format!(
                    "{name} must be an absolute path"
                )));
            }
        }
        if let Some(path) = &self.checkpoint_apply_program
            && !path.is_absolute()
        {
            return Err(ConfigError::Validation(
                "checkpoint_apply_program must be an absolute path".to_owned(),
            ));
        }
        if !valid_user_name(&self.reconstruction_user) {
            return Err(ConfigError::Validation(
                "reconstruction_user must be a canonical local user name".to_owned(),
            ));
        }
        if self.reconstruction_user == "root" {
            return Err(ConfigError::Validation(
                "reconstruction_user must be an unprivileged learner identity".to_owned(),
            ));
        }
        let expected_home = PathBuf::from("/home").join(&self.reconstruction_user);
        if self.reconstruction_home != expected_home {
            return Err(ConfigError::Validation(format!(
                "reconstruction_home must be {} for reconstruction_user '{}'",
                expected_home.display(),
                self.reconstruction_user
            )));
        }
        if self.checkpoint_signing_keys.is_empty() || self.checkpoint_signing_keys.len() > 16 {
            return Err(ConfigError::Validation(
                "checkpoint_signing_keys must contain between 1 and 16 trusted keys".to_owned(),
            ));
        }
        for (key_id, encoded) in &self.checkpoint_signing_keys {
            if key_id.is_empty()
                || key_id.len() > 128
                || !key_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            {
                return Err(ConfigError::Validation(format!(
                    "checkpoint signing key ID '{key_id}' is invalid"
                )));
            }
            let decoded = BASE64_STANDARD.decode(encoded).map_err(|_| {
                ConfigError::Validation(format!(
                    "checkpoint signing key '{key_id}' is not standard base64"
                ))
            })?;
            if decoded.len() != 32 {
                return Err(ConfigError::Validation(format!(
                    "checkpoint signing key '{key_id}' must decode to 32 bytes"
                )));
            }
        }
        if self.max_checkpoint_bytes == 0 || self.max_artifact_bytes == 0 {
            return Err(ConfigError::Validation(
                "checkpoint and artifact size limits must be greater than zero".to_owned(),
            ));
        }
        if self.recording_dir == self.recording_upload_staging_dir
            || self
                .recording_upload_staging_dir
                .starts_with(&self.recording_dir)
        {
            return Err(ConfigError::Validation(
                "recording staging must be outside the learner-writable recording directory"
                    .to_owned(),
            ));
        }
        Ok(())
    }

    pub fn endpoint(&self, relative: &str) -> Result<Url, ConfigError> {
        self.control_plane_endpoint
            .join(relative)
            .map_err(|source| ConfigError::Endpoint { source })
    }
}

fn is_loopback_host(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn valid_user_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte == b'_')
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn default_kino_url() -> Url {
    Url::parse("http://127.0.0.1:18081/probes")
        .unwrap_or_else(|error| panic!("built-in Kino URL must parse: {error}"))
}

const fn default_max_checkpoint_bytes() -> u64 {
    DEFAULT_MAX_CHECKPOINT_BYTES
}

const fn default_max_artifact_bytes() -> u64 {
    DEFAULT_MAX_ARTIFACT_BYTES
}

const fn default_true() -> bool {
    true
}

fn default_recording_dir() -> PathBuf {
    PathBuf::from("/var/lib/kino-recordings")
}

fn default_recording_upload_staging_dir() -> PathBuf {
    PathBuf::from("/var/lib/intar-workspace-agent/recording-upload-staging")
}

fn default_recording_drain_program() -> PathBuf {
    PathBuf::from("/usr/libexec/intar-workspace-recording-drain")
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read agent config {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse agent config {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error("invalid agent configuration: {0}")]
    Validation(String),
    #[error("failed to construct control-plane endpoint: {source}")]
    Endpoint {
        #[source]
        source: url::ParseError,
    },
}

#[cfg(test)]
mod tests {
    use super::AgentConfig;

    #[test]
    fn rejects_non_https_control_plane_and_non_loopback_kino() {
        let parsed = toml::from_str::<AgentConfig>(
            r#"
                identity = { execution_id = "exec-1", workspace_id = "ws-1", generation = 1 }
                control_plane_endpoint = "http://intar.dev/api/workspace-agent/"
                bootstrap_capability_path = "/run/intar/bootstrap"
                state_path = "/var/lib/intar/state.json"
                checkpoint_tmpfs_dir = "/run/intar/checkpoints"
                checkpoint_signing_keys = { runtime_v1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
                reconstruction_user = "intar"
                reconstruction_home = "/home/intar"
                kino_url = "http://kino.example/probes"
            "#,
        )
        .expect("config TOML should deserialize");
        assert!(parsed.validate().is_err());
    }

    #[test]
    fn validates_the_configured_reconstruction_identity() {
        let valid = toml::from_str::<AgentConfig>(
            r#"
                identity = { execution_id = "exec-1", workspace_id = "ws-1", generation = 1 }
                control_plane_endpoint = "https://intar.dev/api/workspace-agent/"
                bootstrap_capability_path = "/run/intar/bootstrap"
                state_path = "/var/lib/intar/state.json"
                checkpoint_tmpfs_dir = "/run/intar/checkpoints"
                checkpoint_signing_keys = { runtime_v1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
                reconstruction_user = "intar"
                reconstruction_home = "/home/intar"
            "#,
        )
        .expect("config TOML should deserialize");
        valid.validate().expect("canonical learner identity");

        let invalid = AgentConfig {
            reconstruction_home: "/home/someone-else".into(),
            ..valid.clone()
        };
        assert!(invalid.validate().is_err());

        let root = AgentConfig {
            reconstruction_user: "root".to_owned(),
            reconstruction_home: "/root".into(),
            ..valid
        };
        assert!(root.validate().is_err());
    }

    #[test]
    fn reconstruction_identity_is_required() {
        let error = toml::from_str::<AgentConfig>(
            r#"
                identity = { execution_id = "exec-1", workspace_id = "ws-1", generation = 1 }
                control_plane_endpoint = "https://intar.dev/api/workspace-agent/"
                bootstrap_capability_path = "/run/intar/bootstrap"
                state_path = "/var/lib/intar/state.json"
                checkpoint_tmpfs_dir = "/run/intar/checkpoints"
                checkpoint_signing_keys = { runtime_v1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
            "#,
        )
        .expect_err("missing learner identity must fail closed");
        assert!(error.to_string().contains("reconstruction_user"));
    }
}
