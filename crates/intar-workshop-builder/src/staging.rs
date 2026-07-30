use std::fs;
use std::fs::OpenOptions;
use std::path::Path;

use anyhow::{Context as _, Result, bail, ensure};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;

const STAGING_MARKER: &str = ".intar-workshop-staging-v1";
const STAGING_MARKER_CONTENT: &str = "intar-workshop-builder-staging-v1\n";

/// Validate the domain-neutral publication staging root without consulting
/// any local VM or authored-image dependency.
pub fn preflight_staging_root(path: &Path, prepare: bool) -> Result<()> {
    ensure!(path.is_absolute(), "staging work root must be absolute");
    ensure!(path != Path::new("/"), "staging work root must not be '/'");
    if prepare {
        fs::create_dir_all(path)
            .with_context(|| format!("failed to create staging work root '{}'", path.display()))?;
    }
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect staging work root '{}'", path.display()))?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "staging work root '{}' must be a real directory",
        path.display()
    );
    #[cfg(unix)]
    ensure!(
        metadata.permissions().mode() & 0o022 == 0,
        "staging work root '{}' is group/world writable",
        path.display()
    );
    let probe = path.join(format!(".preflight-{}", std::process::id()));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .with_context(|| format!("staging work root '{}' is not writable", path.display()))?;
    fs::remove_file(&probe).context("failed to remove workshop staging preflight file")?;
    Ok(())
}

pub(crate) fn mark_staging_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect staging directory '{}'", path.display()))?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "staging path '{}' is not a real directory",
        path.display()
    );
    fs::write(path.join(STAGING_MARKER), STAGING_MARKER_CONTENT)
        .with_context(|| format!("failed to mark staging directory '{}'", path.display()))
}

pub(crate) fn unmark_staging_directory(path: &Path) -> Result<()> {
    fs::remove_file(path.join(STAGING_MARKER))
        .with_context(|| format!("failed to remove staging marker from '{}'", path.display()))
}

/// Remove direct-child staging directories left by a previous builder process.
/// A candidate must have both a tempfile-style publication name and the exact
/// marker written by this binary. Symlinks, nested paths, and unmarked content
/// are never removed.
pub fn cleanup_stale_staging_directories(root: &Path) -> Result<usize> {
    ensure!(root.is_absolute(), "staging cleanup root must be absolute");
    ensure!(
        root != Path::new("/"),
        "staging cleanup root must not be '/'"
    );
    let root_metadata = fs::symlink_metadata(root)
        .with_context(|| format!("failed to inspect staging root '{}'", root.display()))?;
    ensure!(
        root_metadata.is_dir() && !root_metadata.file_type().is_symlink(),
        "staging cleanup root '{}' must be a real directory",
        root.display()
    );
    let root = root
        .canonicalize()
        .with_context(|| format!("failed to canonicalize staging root '{}'", root.display()))?;
    let mut removed = 0_usize;
    for entry in fs::read_dir(&root)
        .with_context(|| format!("failed to read staging root '{}'", root.display()))?
    {
        let entry = entry.context("failed to read staging directory entry")?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("staging root contains a non-UTF-8 entry"))?;
        if !is_staging_name(&name) {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("failed to inspect staging candidate '{}'", path.display()))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let canonical = path.canonicalize().with_context(|| {
            format!(
                "failed to canonicalize staging candidate '{}'",
                path.display()
            )
        })?;
        if canonical.parent() != Some(root.as_path()) {
            bail!(
                "staging candidate '{}' does not resolve directly beneath '{}'",
                path.display(),
                root.display()
            );
        }
        let marker = canonical.join(STAGING_MARKER);
        let marker_metadata = match fs::symlink_metadata(&marker) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to inspect staging marker '{}'", marker.display())
                });
            }
        };
        if !marker_metadata.is_file() || marker_metadata.file_type().is_symlink() {
            continue;
        }
        if fs::read_to_string(&marker)
            .with_context(|| format!("failed to read staging marker '{}'", marker.display()))?
            != STAGING_MARKER_CONTENT
        {
            continue;
        }
        fs::remove_dir_all(&canonical).with_context(|| {
            format!(
                "failed to remove stale staging directory '{}'",
                canonical.display()
            )
        })?;
        removed = removed
            .checked_add(1)
            .context("stale staging cleanup count overflow")?;
    }
    Ok(removed)
}

fn is_staging_name(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("publication-") else {
        return false;
    };
    suffix.len() >= 6
        && suffix.len() <= 256
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::{cleanup_stale_staging_directories, mark_staging_directory};

    #[test]
    fn cleanup_removes_only_direct_marked_publication_directories() {
        let root = tempfile::tempdir().unwrap();
        let stale = root.path().join("publication-job-123456");
        let unmarked = root.path().join("publication-keep-123456");
        let unrelated = root.path().join("operator-data-123456");
        std::fs::create_dir(&stale).unwrap();
        std::fs::create_dir(&unmarked).unwrap();
        std::fs::create_dir(&unrelated).unwrap();
        std::fs::write(stale.join("payload"), b"partial").unwrap();
        mark_staging_directory(&stale).unwrap();

        assert_eq!(cleanup_stale_staging_directories(root.path()).unwrap(), 1);
        assert!(!stale.exists());
        assert!(unmarked.exists());
        assert!(unrelated.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_never_follows_a_marked_name_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(
            outside.path().join(".intar-workshop-staging-v1"),
            "intar-workshop-builder-staging-v1\n",
        )
        .unwrap();
        let link = root.path().join("publication-link-123456");
        symlink(outside.path(), &link).unwrap();

        assert_eq!(cleanup_stale_staging_directories(root.path()).unwrap(), 0);
        assert!(outside.path().exists());
        assert!(link.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_rejects_a_symlinked_root() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let actual = tempfile::tempdir().unwrap();
        let root = parent.path().join("work-root");
        symlink(actual.path(), &root).unwrap();

        let error = cleanup_stale_staging_directories(&root).unwrap_err();

        assert!(error.to_string().contains("must be a real directory"));
        assert!(actual.path().exists());
    }
}
