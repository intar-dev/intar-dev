#![allow(clippy::missing_errors_doc)]

//! Filesystem-facing wrapper around the pure content-hash core in
//! `intar-image-scenario`. Walks the scenario directory into in-memory
//! entries so filesystem and in-memory callers hash byte-identically.

use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use intar_image_scenario::{ScenarioContentHashParams, scenario_content_hash_from_entries};

pub use intar_image_scenario::{BUILD_FORMAT_VERSION, sha256_bytes_hex};

#[derive(Debug, Clone)]
pub struct ScenarioContentHashInput<'a> {
    pub scenario_id: &'a str,
    pub scenario_dir: &'a Path,
    pub base_definition: &'a str,
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

    let mut entries = Vec::new();
    for path in sorted_files(input.scenario_dir)? {
        let relative = path
            .strip_prefix(input.scenario_dir)
            .context("scenario file escaped scenario directory")?;
        if relative.file_name() == Some(std::ffi::OsStr::new("lecture.md")) {
            continue;
        }
        let bytes = fs::read(&path)
            .with_context(|| format!("failed to read scenario file '{}'", path.display()))?;
        entries.push((normalize_relative_path(relative)?, bytes));
    }

    scenario_content_hash_from_entries(
        &ScenarioContentHashParams {
            scenario_id: input.scenario_id,
            base_definition: input.base_definition,
            target_arch: input.target_arch,
        },
        &entries,
    )
    .map_err(|error| anyhow::anyhow!(error))
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::fs;

    use intar_image_scenario::{ScenarioContentHashParams, scenario_content_hash_from_entries};

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
    }

    #[test]
    fn hash_changes_when_path_changes() {
        let left = tempfile::tempdir().unwrap();
        fs::write(left.path().join("a.txt"), "same").unwrap();
        let right = tempfile::tempdir().unwrap();
        fs::write(right.path().join("b.txt"), "same").unwrap();

        assert_ne!(hash_for(left.path()), hash_for(right.path()));
    }

    #[test]
    fn fs_walk_matches_in_memory_entries() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("scenario.hcl"), "scenario body").unwrap();
        fs::write(dir.path().join("sub/provision.sh"), "apt update").unwrap();

        let from_fs = hash_for(dir.path());
        let from_entries = scenario_content_hash_from_entries(
            &ScenarioContentHashParams {
                scenario_id: "broken-nginx",
                base_definition: "trixie=suite=trixie\narch=amd64",
                target_arch: "x86_64",
            },
            &[
                // Deliberately unsorted; the core sorts.
                ("sub/provision.sh".to_string(), b"apt update".to_vec()),
                ("scenario.hcl".to_string(), b"scenario body".to_vec()),
            ],
        )
        .unwrap();

        assert_eq!(from_fs, from_entries);
    }

    #[test]
    fn ignores_lecture_markdown() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("scenario.hcl"), "scenario body").unwrap();
        let before = hash_for(dir.path());
        fs::write(dir.path().join("lecture.md"), "Theory changed.").unwrap();
        assert_eq!(before, hash_for(dir.path()));
    }

    fn hash_for(path: &std::path::Path) -> String {
        scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: "broken-nginx",
            scenario_dir: path,
            base_definition: "trixie=suite=trixie\narch=amd64",
            target_arch: "x86_64",
        })
        .unwrap()
    }
}
