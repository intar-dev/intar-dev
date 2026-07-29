use crate::model::{BootstrapResponse, CheckpointDescriptor, ExecutionIdentity};
use crate::secrets::SecretString;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const STATE_VERSION: u16 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedState {
    state_version: u16,
    identity: ExecutionIdentity,
    report_credential: SecretString,
    checkpoint: CheckpointDescriptor,
    checkpoint_applied: bool,
    last_reserved_report_sequence: u64,
}

#[derive(Clone, Debug)]
pub struct GenerationState {
    inner: PersistedState,
}

impl GenerationState {
    pub fn identity(&self) -> &ExecutionIdentity {
        &self.inner.identity
    }

    pub fn report_credential(&self) -> &SecretString {
        &self.inner.report_credential
    }

    pub fn checkpoint(&self) -> &CheckpointDescriptor {
        &self.inner.checkpoint
    }

    pub fn checkpoint_applied(&self) -> bool {
        self.inner.checkpoint_applied
    }

    pub fn last_reserved_report_sequence(&self) -> u64 {
        self.inner.last_reserved_report_sequence
    }
}

#[derive(Clone, Debug)]
pub struct StateStore {
    path: PathBuf,
    identity: ExecutionIdentity,
}

impl StateStore {
    pub fn new(path: PathBuf, identity: ExecutionIdentity) -> Self {
        Self { path, identity }
    }

    pub fn load(&self) -> Result<Option<GenerationState>, StateError> {
        let raw = match fs::read(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(StateError::Read {
                    path: self.path.clone(),
                    source,
                });
            }
        };
        let state =
            serde_json::from_slice::<PersistedState>(&raw).map_err(|source| StateError::Parse {
                path: self.path.clone(),
                source,
            })?;
        self.validate_state(&state)?;
        Ok(Some(GenerationState { inner: state }))
    }

    pub fn install_bootstrap(
        &self,
        response: BootstrapResponse,
    ) -> Result<GenerationState, StateError> {
        if self.path.exists() {
            return Err(StateError::BootstrapAlreadyConsumed);
        }
        let state = PersistedState {
            state_version: STATE_VERSION,
            identity: response.identity,
            report_credential: response.report_credential,
            checkpoint: response.checkpoint,
            checkpoint_applied: false,
            last_reserved_report_sequence: 0,
        };
        self.validate_state(&state)?;
        self.write(&state)?;
        Ok(GenerationState { inner: state })
    }

    pub fn mark_checkpoint_applied(&self, state: &mut GenerationState) -> Result<(), StateError> {
        self.validate_state(&state.inner)?;
        state.inner.checkpoint_applied = true;
        // The signed download capability is no longer useful after successful
        // apply. Keep the content address for audit/recovery, but do not retain
        // the expired URL on the guest disk.
        state.inner.checkpoint.signed_url = SecretString::new("[consumed]");
        self.write(&state.inner)
    }

    /// Reserves and persists a sequence before it is transmitted. A crash may
    /// therefore leave a harmless gap, but can never replay an accepted value.
    pub fn reserve_report_sequence(&self, state: &mut GenerationState) -> Result<u64, StateError> {
        self.validate_state(&state.inner)?;
        let next = state
            .inner
            .last_reserved_report_sequence
            .checked_add(1)
            .ok_or(StateError::SequenceExhausted)?;
        state.inner.last_reserved_report_sequence = next;
        self.write(&state.inner)?;
        Ok(next)
    }

    fn validate_state(&self, state: &PersistedState) -> Result<(), StateError> {
        if state.state_version != STATE_VERSION {
            return Err(StateError::UnsupportedVersion(state.state_version));
        }
        if state.identity != self.identity {
            return Err(StateError::StaleGeneration {
                expected: self.identity.clone(),
                actual: state.identity.clone(),
            });
        }
        Ok(())
    }

    fn write(&self, state: &PersistedState) -> Result<(), StateError> {
        let parent = self.path.parent().ok_or_else(|| StateError::InvalidPath {
            path: self.path.clone(),
        })?;
        fs::create_dir_all(parent).map_err(|source| StateError::Write {
            path: self.path.clone(),
            source,
        })?;

        let file_name = self
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| StateError::InvalidPath {
                path: self.path.clone(),
            })?;
        let temporary = parent.join(format!(".{file_name}.new"));
        let bytes = serde_json::to_vec(state).map_err(StateError::Serialize)?;

        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|source| StateError::Write {
                path: temporary.clone(),
                source,
            })?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| StateError::Write {
                path: temporary.clone(),
                source,
            })?;
        fs::rename(&temporary, &self.path).map_err(|source| StateError::Write {
            path: self.path.clone(),
            source,
        })?;
        Ok(())
    }
}

pub fn read_bootstrap_capability(path: &Path) -> Result<SecretString, StateError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| StateError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    if !metadata.file_type().is_file() {
        return Err(StateError::InsecureBootstrapFile {
            path: path.to_path_buf(),
            reason: "must be a regular file".to_owned(),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(StateError::InsecureBootstrapFile {
                path: path.to_path_buf(),
                reason: "must not be readable or writable by group or other users".to_owned(),
            });
        }
    }

    let mut file = fs::File::open(path).map_err(|source| StateError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    let mut limited = (&mut file).take(4097);
    let mut value = String::new();
    limited
        .read_to_string(&mut value)
        .map_err(|source| StateError::Read {
            path: path.to_path_buf(),
            source,
        })?;
    let value = value.trim().to_owned();
    if value.is_empty() || value.len() > 4096 {
        return Err(StateError::InvalidBootstrapCapability);
    }
    Ok(SecretString::new(value))
}

pub fn remove_bootstrap_capability(path: &Path) -> Result<(), StateError> {
    fs::remove_file(path).map_err(|source| StateError::Write {
        path: path.to_path_buf(),
        source,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("failed to read agent state {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse agent state {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("failed to serialize agent state: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to write agent state {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("agent state path is invalid: {path}")]
    InvalidPath { path: PathBuf },
    #[error("unsupported agent state version {0}")]
    UnsupportedVersion(u16),
    #[error("state belongs to stale generation {actual:?}; expected {expected:?}")]
    StaleGeneration {
        expected: ExecutionIdentity,
        actual: ExecutionIdentity,
    },
    #[error("bootstrap capability has already been consumed for this generation")]
    BootstrapAlreadyConsumed,
    #[error("bootstrap capability file {path} is insecure: {reason}")]
    InsecureBootstrapFile { path: PathBuf, reason: String },
    #[error("bootstrap capability has an invalid length")]
    InvalidBootstrapCapability,
    #[error("report sequence space is exhausted")]
    SequenceExhausted,
}

#[cfg(test)]
mod tests {
    use super::StateStore;
    use crate::model::{
        BootstrapResponse, CONTRACT_VERSION, CheckpointCompression, CheckpointDescriptor,
        ExecutionIdentity,
    };
    use crate::secrets::SecretString;
    use tempfile::TempDir;

    fn identity(generation: u32) -> ExecutionIdentity {
        ExecutionIdentity {
            execution_id: "exec-1".to_owned(),
            workspace_id: "workspace-1".to_owned(),
            generation,
        }
    }

    fn response() -> BootstrapResponse {
        BootstrapResponse {
            contract_version: CONTRACT_VERSION,
            identity: identity(1),
            report_credential: SecretString::new("report-secret"),
            checkpoint: CheckpointDescriptor {
                checkpoint_id: "00".to_owned(),
                signed_url: SecretString::new("https://assets.intar.dev/checkpoint?signed=yes"),
                sha256: "a".repeat(64),
                size_bytes: 12,
                compression: CheckpointCompression::None,
                signature_b64: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    [0_u8; 64],
                ),
                signing_key_id: "runtime-v1".to_owned(),
                expires_at_unix_ms: i64::MAX,
            },
        }
    }

    #[test]
    fn bootstrap_response_can_be_installed_only_once() {
        let temp = TempDir::new().expect("temp dir");
        let store = StateStore::new(temp.path().join("state.json"), identity(1));
        store
            .install_bootstrap(response())
            .expect("first bootstrap should persist");
        let error = store
            .install_bootstrap(response())
            .expect_err("replayed bootstrap must fail");
        assert!(error.to_string().contains("already been consumed"));
    }

    #[test]
    fn reservations_are_persisted_before_reports() {
        let temp = TempDir::new().expect("temp dir");
        let store = StateStore::new(temp.path().join("state.json"), identity(1));
        let mut state = store.install_bootstrap(response()).expect("bootstrap");
        assert_eq!(store.reserve_report_sequence(&mut state).expect("seq"), 1);
        assert_eq!(store.reserve_report_sequence(&mut state).expect("seq"), 2);
        let loaded = store.load().expect("load").expect("state");
        assert_eq!(loaded.last_reserved_report_sequence(), 2);
    }

    #[test]
    fn state_from_old_generation_is_rejected() {
        let temp = TempDir::new().expect("temp dir");
        let old = StateStore::new(temp.path().join("state.json"), identity(1));
        old.install_bootstrap(response()).expect("bootstrap");
        let current = StateStore::new(temp.path().join("state.json"), identity(2));
        assert!(current.load().is_err());
    }
}
