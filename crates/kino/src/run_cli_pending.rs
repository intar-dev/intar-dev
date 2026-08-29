//! Crash-safe retry state for one learner hint reveal.
//!
//! The file contains only a public hint alias, ordinal, and opaque request ID.
//! It never stores broker credentials, hint text, or solution content.

use intar_contracts::run_cli::{RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliRequestV1};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use thiserror::Error;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;

pub(crate) const PENDING_HINT_REVEAL_FILENAME: &str = "pending-hint-reveal-v1.json";
const MAX_PENDING_HINT_BYTES: u64 = 1024;
static NEXT_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PendingHintReveal {
    pub(crate) retry_scope: String,
    pub(crate) alias: String,
    pub(crate) expected_ordinal: u16,
    pub(crate) request_id: String,
}

impl PendingHintReveal {
    pub(crate) fn validate(&self) -> Result<(), PendingHintError> {
        if !valid_retry_scope(&self.retry_scope) {
            return Err(PendingHintError::Invalid);
        }
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: self.request_id.clone(),
            action: RunCliActionV1::HintReveal {
                alias: self.alias.clone(),
                expected_ordinal: self.expected_ordinal,
            },
        };
        request.validate().map_err(|_| PendingHintError::Invalid)
    }
}

fn valid_retry_scope(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Debug, Error)]
pub(crate) enum PendingHintError {
    #[error("learner home is unavailable")]
    HomeUnavailable,
    #[error("learner home path is invalid")]
    InvalidHome,
    #[error("pending hint action path is invalid")]
    InvalidPath,
    #[error("pending hint action is invalid")]
    Invalid,
    #[error("pending hint action path is unsafe")]
    UnsafePath,
    #[error("pending hint action could not be read")]
    Read(#[source] std::io::Error),
    #[error("pending hint action could not be written")]
    Write(#[source] std::io::Error),
    #[error("pending hint action could not be encoded")]
    Encode(#[source] serde_json::Error),
    #[error("pending hint action could not be decoded")]
    Decode(#[source] serde_json::Error),
}

pub(crate) fn configured_path() -> Result<PathBuf, PendingHintError> {
    let home = env::var_os("HOME").ok_or(PendingHintError::HomeUnavailable)?;
    if home.is_empty() {
        return Err(PendingHintError::HomeUnavailable);
    }
    let home = PathBuf::from(home);
    if !home.is_absolute() {
        return Err(PendingHintError::InvalidHome);
    }
    Ok(home
        .join(".cache")
        .join("intar")
        .join(PENDING_HINT_REVEAL_FILENAME))
}

pub(crate) fn load_at(path: &Path) -> Result<Option<PendingHintReveal>, PendingHintError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(PendingHintError::Read(error)),
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_PENDING_HINT_BYTES {
        return Err(PendingHintError::UnsafePath);
    }
    let raw = fs::read(path).map_err(PendingHintError::Read)?;
    let pending =
        serde_json::from_slice::<PendingHintReveal>(&raw).map_err(PendingHintError::Decode)?;
    pending.validate()?;
    Ok(Some(pending))
}

pub(crate) fn persist_at(path: &Path, pending: &PendingHintReveal) -> Result<(), PendingHintError> {
    pending.validate()?;
    let parent = path.parent().ok_or(PendingHintError::InvalidPath)?;
    if parent.as_os_str().is_empty() {
        return Err(PendingHintError::InvalidPath);
    }
    fs::create_dir_all(parent).map_err(PendingHintError::Write)?;
    let payload = serde_json::to_vec(pending).map_err(PendingHintError::Encode)?;
    let temporary = pending_temp_path(parent, path)?;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary).map_err(PendingHintError::Write)?;
    if let Err(error) = file.write_all(&payload).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(PendingHintError::Write(error));
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(PendingHintError::Write(error));
    }
    Ok(())
}

pub(crate) fn clear_if_matches_at(
    path: &Path,
    expected: &PendingHintReveal,
) -> Result<(), PendingHintError> {
    match load_at(path)? {
        Some(current) if current == *expected => {
            fs::remove_file(path).map_err(PendingHintError::Write)
        }
        Some(_) | None => Ok(()),
    }
}

fn pending_temp_path(parent: &Path, path: &Path) -> Result<PathBuf, PendingHintError> {
    let file_name = path.file_name().ok_or(PendingHintError::InvalidPath)?;
    let sequence = NEXT_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        ".{}.{}.{}.tmp",
        file_name.to_string_lossy(),
        std::process::id(),
        sequence
    )))
}

#[cfg(test)]
mod tests {
    use super::{PendingHintReveal, clear_if_matches_at, load_at, persist_at};
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;

    fn pending() -> PendingHintReveal {
        PendingHintReveal {
            retry_scope: "scope_test".to_owned(),
            alias: "general".to_owned(),
            expected_ordinal: 2,
            request_id: "kino-123-4".to_owned(),
        }
    }

    #[test]
    fn writes_and_loads_one_atomic_safe_pending_action() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("state").join("pending.json");
        let expected = pending();
        persist_at(&path, &expected).expect("persist");
        assert_eq!(load_at(&path).expect("load"), Some(expected));
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let entries = std::fs::read_dir(path.parent().expect("parent"))
            .expect("entries")
            .count();
        assert_eq!(entries, 1);
    }

    #[test]
    fn clears_only_the_action_that_completed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("pending.json");
        let first = pending();
        persist_at(&path, &first).expect("persist first");
        let different = PendingHintReveal {
            expected_ordinal: 3,
            ..first.clone()
        };
        clear_if_matches_at(&path, &different).expect("leave a newer action alone");
        assert_eq!(load_at(&path).expect("load first"), Some(first.clone()));
        clear_if_matches_at(&path, &first).expect("clear matching action");
        assert_eq!(load_at(&path).expect("load cleared"), None);
    }
}
