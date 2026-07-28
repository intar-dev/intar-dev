use std::fs;
use std::path::{Path, PathBuf};

const RECORDING_PREFIX: &str = "ssh-session-";
const RECORDING_SUFFIX: &str = ".krec";

/// Moves one completed Kino recording from the learner-writable directory
/// into root-owned staging. The move closes the path-replacement race before
/// upload; partial recordings are deliberately invisible to this function.
pub(crate) fn stage_next_completed_recording(
    recording_dir: &Path,
    staging_dir: &Path,
    max_bytes: u64,
) -> Result<Option<PathBuf>, RecordingError> {
    ensure_real_directory(staging_dir, true)?;
    if let Some(path) = first_safe_staged_recording(staging_dir, max_bytes)? {
        return Ok(Some(path));
    }
    ensure_real_directory(recording_dir, false)?;

    let mut entries = fs::read_dir(recording_dir)
        .map_err(|source| RecordingError::ReadDirectory {
            path: recording_dir.to_path_buf(),
            source,
        })?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|source| RecordingError::ReadDirectory {
            path: recording_dir.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        if !valid_recording_name(&name) {
            continue;
        }
        let staged = staging_dir.join(&name);
        match fs::rename(entry.path(), &staged) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(RecordingError::Stage {
                    path: entry.path(),
                    source,
                });
            }
        }
        match validate_staged_file(&staged, max_bytes) {
            Ok(()) => return Ok(Some(staged)),
            Err(error) => {
                let _ = fs::remove_file(&staged);
                return Err(error);
            }
        }
    }
    Ok(None)
}

pub(crate) fn remove_uploaded_recording(path: &Path) -> Result<(), RecordingError> {
    fs::remove_file(path).map_err(|source| RecordingError::Remove {
        path: path.to_path_buf(),
        source,
    })
}

fn first_safe_staged_recording(
    staging_dir: &Path,
    max_bytes: u64,
) -> Result<Option<PathBuf>, RecordingError> {
    let mut entries = fs::read_dir(staging_dir)
        .map_err(|source| RecordingError::ReadDirectory {
            path: staging_dir.to_path_buf(),
            source,
        })?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|source| RecordingError::ReadDirectory {
            path: staging_dir.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        if !valid_recording_name(&name) {
            continue;
        }
        let path = entry.path();
        validate_staged_file(&path, max_bytes)?;
        return Ok(Some(path));
    }
    Ok(None)
}

fn ensure_real_directory(path: &Path, create: bool) -> Result<(), RecordingError> {
    if create {
        fs::create_dir_all(path).map_err(|source| RecordingError::CreateDirectory {
            path: path.to_path_buf(),
            source,
        })?;
    }
    let metadata = fs::symlink_metadata(path).map_err(|source| RecordingError::ReadDirectory {
        path: path.to_path_buf(),
        source,
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(RecordingError::UnsafeDirectory {
            path: path.to_path_buf(),
        });
    }
    #[cfg(unix)]
    if create {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| {
            RecordingError::CreateDirectory {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

fn validate_staged_file(path: &Path, max_bytes: u64) -> Result<(), RecordingError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| RecordingError::Inspect {
        path: path.to_path_buf(),
        source,
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(RecordingError::UnsafeFile {
            path: path.to_path_buf(),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.nlink() != 1 {
            return Err(RecordingError::UnsafeFile {
                path: path.to_path_buf(),
            });
        }
    }
    if metadata.len() == 0 || metadata.len() > max_bytes {
        return Err(RecordingError::Size {
            path: path.to_path_buf(),
            actual: metadata.len(),
            limit: max_bytes,
        });
    }
    Ok(())
}

fn valid_recording_name(value: &str) -> bool {
    let Some(middle) = value
        .strip_prefix(RECORDING_PREFIX)
        .and_then(|value| value.strip_suffix(RECORDING_SUFFIX))
    else {
        return false;
    };
    !middle.is_empty()
        && middle.len() <= 128
        && middle
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
        && middle.split('-').all(|part| !part.is_empty())
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum RecordingError {
    #[error("failed to create recording staging directory {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("recording directory is not a real directory: {path}")]
    UnsafeDirectory { path: PathBuf },
    #[error("failed to read recording directory {path}: {source}")]
    ReadDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to move completed recording {path} into protected staging: {source}")]
    Stage {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to inspect staged recording {path}: {source}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("staged recording is not a single-link regular file: {path}")]
    UnsafeFile { path: PathBuf },
    #[error("recording {path} is {actual} bytes; limit is {limit}")]
    Size {
        path: PathBuf,
        actual: u64,
        limit: u64,
    },
    #[error("failed to remove uploaded recording {path}: {source}")]
    Remove {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::stage_next_completed_recording;
    use std::fs;

    #[test]
    fn stages_only_final_single_link_recordings() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir: {error}"));
        let recordings = root.path().join("recordings");
        let staging = root.path().join("staging");
        fs::create_dir(&recordings).unwrap_or_else(|error| panic!("recordings: {error}"));
        fs::write(
            recordings.join("ssh-session-100-200.krec.partial"),
            b"partial",
        )
        .unwrap_or_else(|error| panic!("partial: {error}"));
        fs::write(recordings.join("ssh-session-100-201.krec"), b"complete")
            .unwrap_or_else(|error| panic!("complete: {error}"));

        let staged = stage_next_completed_recording(&recordings, &staging, 1024)
            .unwrap_or_else(|error| panic!("stage: {error}"))
            .unwrap_or_else(|| panic!("completed recording should stage"));
        assert_eq!(
            staged.file_name().and_then(|name| name.to_str()),
            Some("ssh-session-100-201.krec")
        );
        assert!(recordings.join("ssh-session-100-200.krec.partial").exists());
        assert!(!recordings.join("ssh-session-100-201.krec").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_hardlinked_recordings_after_atomic_stage() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir: {error}"));
        let recordings = root.path().join("recordings");
        let staging = root.path().join("staging");
        fs::create_dir(&recordings).unwrap_or_else(|error| panic!("recordings: {error}"));
        let source = root.path().join("source");
        fs::write(&source, b"sensitive").unwrap_or_else(|error| panic!("source: {error}"));
        fs::hard_link(&source, recordings.join("ssh-session-1-2.krec"))
            .unwrap_or_else(|error| panic!("hardlink: {error}"));

        assert!(stage_next_completed_recording(&recordings, &staging, 1024).is_err());
        assert!(!staging.join("ssh-session-1-2.krec").exists());
        assert_eq!(
            fs::read(&source).unwrap_or_else(|error| panic!("source read: {error}")),
            b"sensitive"
        );
    }
}
