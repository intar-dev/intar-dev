#![allow(clippy::missing_errors_doc)]

use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

pub const BUILD_FORMAT_VERSION: &str = "intar-image-build-v1";

#[derive(Debug, Clone)]
pub struct ScenarioContentHashInput<'a> {
    pub scenario_id: &'a str,
    pub scenario_dir: &'a Path,
    pub base_definition: &'a str,
    pub kino_version: &'a str,
    pub target_arch: &'a str,
}

pub fn scenario_content_hash(input: &ScenarioContentHashInput<'_>) -> Result<String> {
    if input.scenario_id.trim().is_empty() {
        bail!("scenario_id is required");
    }
    if !input.scenario_dir.is_dir() {
        bail!(
            "scenario_dir '{}' is not a directory",
            input.scenario_dir.display()
        );
    }

    let mut hasher = Sha256::new();
    hash_field(&mut hasher, "format", BUILD_FORMAT_VERSION.as_bytes());
    hash_field(&mut hasher, "scenario_id", input.scenario_id.as_bytes());
    hash_field(
        &mut hasher,
        "base_definition",
        input.base_definition.as_bytes(),
    );
    hash_field(&mut hasher, "kino_version", input.kino_version.as_bytes());
    hash_field(&mut hasher, "target_arch", input.target_arch.as_bytes());

    for path in sorted_files(input.scenario_dir)? {
        let relative = path
            .strip_prefix(input.scenario_dir)
            .context("scenario file escaped scenario directory")?;
        let normalized_path = format!(
            "scenarios/{}/{}",
            input.scenario_id.trim(),
            normalize_relative_path(relative)?
        );
        let bytes = fs::read(&path)
            .with_context(|| format!("failed to read scenario file '{}'", path.display()))?;
        hash_field(&mut hasher, "file_path", normalized_path.as_bytes());
        hash_field(&mut hasher, "file_bytes", &bytes);
    }

    Ok(hex_digest(hasher.finalize()))
}

#[must_use]
pub fn sha256_bytes_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_digest(hasher.finalize())
}

fn sorted_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_files(root, &mut files)?;
    files.sort_by(|left, right| {
        normalize_relative_path(left.strip_prefix(root).unwrap_or(left))
            .unwrap_or_else(|_| left.display().to_string())
            .cmp(
                &normalize_relative_path(right.strip_prefix(root).unwrap_or(right))
                    .unwrap_or_else(|_| right.display().to_string()),
            )
    });
    Ok(files)
}

fn collect_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(path)
        .with_context(|| format!("failed to read directory '{}'", path.display()))?
    {
        let entry = entry.with_context(|| format!("failed to read '{}'", path.display()))?;
        let file_type = entry
            .file_type()
            .with_context(|| format!("failed to stat '{}'", entry.path().display()))?;
        if file_type.is_dir() {
            collect_files(&entry.path(), files)?;
        } else if file_type.is_file() {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn normalize_relative_path(path: &Path) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(
                value
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("scenario path is not valid UTF-8"))?
                    .to_string(),
            ),
            Component::CurDir => {}
            _ => bail!("scenario path contains unsupported component"),
        }
    }
    if parts.is_empty() {
        bail!("scenario file path is empty");
    }
    Ok(parts.join("/"))
}

fn hash_field(hasher: &mut Sha256, key: &str, value: &[u8]) {
    hasher.update(key.as_bytes());
    hasher.update([0]);
    hasher.update(value.len().to_le_bytes());
    hasher.update(value);
    hasher.update([0xff]);
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::fs;

    use super::{ScenarioContentHashInput, scenario_content_hash};

    #[test]
    fn hash_is_stable_for_same_content() {
        let left = tempfile::tempdir().unwrap();
        fs::create_dir(left.path().join("sub")).unwrap();
        fs::write(left.path().join("scenario.hcl"), "scenario").unwrap();
        fs::write(left.path().join("sub/provision.sh"), "apt update").unwrap();

        let right = tempfile::tempdir().unwrap();
        fs::create_dir(right.path().join("sub")).unwrap();
        fs::write(right.path().join("sub/provision.sh"), "apt update").unwrap();
        fs::write(right.path().join("scenario.hcl"), "scenario").unwrap();

        assert_eq!(hash_for(left.path()), hash_for(right.path()));
    }

    #[test]
    fn hash_changes_when_inputs_change() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("scenario.hcl"), "scenario").unwrap();
        let original = hash_for(dir.path());

        fs::write(dir.path().join("scenario.hcl"), "scenario changed").unwrap();
        assert_ne!(original, hash_for(dir.path()));

        let kino_changed = scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: "broken-nginx",
            scenario_dir: dir.path(),
            base_definition: "trixie=suite=trixie\narch=amd64",
            kino_version: "0.1.25",
            target_arch: "x86_64",
        })
        .unwrap();
        assert_ne!(hash_for(dir.path()), kino_changed);
    }

    #[test]
    fn hash_changes_when_path_changes() {
        let left = tempfile::tempdir().unwrap();
        fs::write(left.path().join("a.txt"), "same").unwrap();
        let right = tempfile::tempdir().unwrap();
        fs::write(right.path().join("b.txt"), "same").unwrap();

        assert_ne!(hash_for(left.path()), hash_for(right.path()));
    }

    fn hash_for(path: &std::path::Path) -> String {
        scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: "broken-nginx",
            scenario_dir: path,
            base_definition: "trixie=suite=trixie\narch=amd64",
            kino_version: "0.1.24",
            target_arch: "x86_64",
        })
        .unwrap()
    }
}
