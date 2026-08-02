use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Write as _};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use flate2::read::GzDecoder;
use intar_workshop_manifest::{COMPILED_MANIFEST_PATH, CompiledWorkshop, ValidatedWorkshop};

use crate::config::WorkerConfig;
use crate::contracts::WorkshopPublicationClaim;
use crate::staging::mark_staging_directory;

#[derive(Debug)]
pub struct PreparedWorkshopBundle {
    _temporary_root: tempfile::TempDir,
    pub root: PathBuf,
    pub workshop: ValidatedWorkshop,
}

pub(crate) fn prepare_local_bundle(
    path: &Path,
    expected_sha256: &str,
    worker: &WorkerConfig,
) -> Result<PreparedWorkshopBundle> {
    let compressed = fs::read(path)
        .with_context(|| format!("failed to read workshop bundle '{}'", path.display()))?;
    let compressed_len = u64::try_from(compressed.len()).context("bundle length overflow")?;
    if compressed_len == 0 || compressed_len > worker.max_compressed_bundle_bytes {
        bail!(
            "workshop bundle is empty or exceeds the {} byte compressed limit",
            worker.max_compressed_bundle_bytes
        );
    }
    let actual_hash = intar_image_build::sha256_bytes_hex(&compressed);
    if actual_hash != expected_sha256 {
        bail!(
            "workshop bundle hash mismatch: configured {}, local {}",
            expected_sha256,
            actual_hash
        );
    }

    fs::create_dir_all(&worker.work_root).with_context(|| {
        format!(
            "failed to create workshop builder work root '{}'",
            worker.work_root.display()
        )
    })?;
    let temporary_root = tempfile::Builder::new()
        .prefix("publication-authored-source-")
        .tempdir_in(&worker.work_root)
        .context("failed to create authored-image source work directory")?;
    mark_staging_directory(temporary_root.path())?;
    let root = temporary_root.path().join("source");
    fs::create_dir(&root).context("failed to create workshop source directory")?;
    extract_archive(&compressed, &root, worker)?;
    let workshop = intar_workshop_manifest::load_and_validate(&root)
        .context("local workshop bundle failed source validation")?;
    verify_compiled_manifest(&root, &workshop)?;

    Ok(PreparedWorkshopBundle {
        _temporary_root: temporary_root,
        root,
        workshop,
    })
}

pub fn prepare_bundle(
    claim: &WorkshopPublicationClaim,
    compressed: &[u8],
    worker: &WorkerConfig,
) -> Result<PreparedWorkshopBundle> {
    validate_claim(claim)?;
    let compressed_len = u64::try_from(compressed.len()).context("bundle length overflow")?;
    if compressed_len == 0 || compressed_len > worker.max_compressed_bundle_bytes {
        bail!(
            "workshop bundle is empty or exceeds the {} byte compressed limit",
            worker.max_compressed_bundle_bytes
        );
    }
    let actual_hash = intar_image_build::sha256_bytes_hex(compressed);
    if actual_hash != claim.content_hash {
        bail!(
            "workshop bundle hash mismatch: claim {}, downloaded {}",
            claim.content_hash,
            actual_hash
        );
    }

    fs::create_dir_all(&worker.work_root).with_context(|| {
        format!(
            "failed to create workshop builder work root '{}'",
            worker.work_root.display()
        )
    })?;
    let temporary_root = tempfile::Builder::new()
        .prefix("publication-")
        .tempdir_in(&worker.work_root)
        .context("failed to create workshop publication work directory")?;
    mark_staging_directory(temporary_root.path())?;
    let root = temporary_root.path().join("source");
    fs::create_dir(&root).context("failed to create workshop source directory")?;
    extract_archive(compressed, &root, worker)?;
    let workshop = intar_workshop_manifest::load_and_validate(&root)
        .context("downloaded workshop bundle failed source validation")?;
    verify_compiled_manifest(&root, &workshop)?;

    if workshop.manifest.workshop.id != claim.workshop_slug {
        bail!(
            "claimed workshop slug '{}' does not match source '{}'",
            claim.workshop_slug,
            workshop.manifest.workshop.id
        );
    }
    let source_checkpoints = workshop
        .manifest
        .modules
        .iter()
        .map(|module| module.checkpoint.clone())
        .collect::<BTreeSet<_>>();
    let claimed_checkpoints = claim
        .required_checkpoint_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if claim.required_checkpoint_ids.len() != claimed_checkpoints.len() {
        bail!("claim contains duplicate required checkpoint IDs");
    }
    if source_checkpoints != claimed_checkpoints {
        bail!(
            "claim checkpoint set does not match validated workshop source: expected {:?}, got {:?}",
            source_checkpoints,
            claimed_checkpoints
        );
    }

    Ok(PreparedWorkshopBundle {
        _temporary_root: temporary_root,
        root,
        workshop,
    })
}

fn verify_compiled_manifest(root: &Path, workshop: &ValidatedWorkshop) -> Result<()> {
    let path = root.join(COMPILED_MANIFEST_PATH);
    let source = fs::read(&path).with_context(|| {
        format!(
            "downloaded workshop bundle is missing '{}'",
            COMPILED_MANIFEST_PATH
        )
    })?;
    let actual: serde_json::Value =
        serde_json::from_slice(&source).context("workshop.compiled.json is not valid JSON")?;
    let expected = serde_json::to_value(CompiledWorkshop {
        format_version: 2,
        scheduled_duration_minutes: workshop.scheduled_duration_minutes,
        manifest: &workshop.manifest,
    })
    .context("failed to compile validated workshop manifest")?;
    if actual != expected {
        bail!("workshop.compiled.json does not match the validated HCL source");
    }
    Ok(())
}

fn extract_archive(compressed: &[u8], destination: &Path, worker: &WorkerConfig) -> Result<()> {
    let decoder = GzDecoder::new(Cursor::new(compressed));
    let mut archive = tar::Archive::new(decoder);
    let mut expanded_bytes = 0_u64;
    let mut entries_seen = 0_usize;
    let mut paths_seen = BTreeSet::new();

    for entry in archive
        .entries()
        .context("failed to read workshop tar archive")?
    {
        let mut entry = entry.context("failed to read workshop tar entry")?;
        entries_seen = entries_seen
            .checked_add(1)
            .context("workshop archive entry count overflow")?;
        if entries_seen > worker.max_bundle_entries {
            bail!(
                "workshop archive exceeds the {} entry limit",
                worker.max_bundle_entries
            );
        }
        let relative = safe_relative_path(entry.path()?.as_ref())?;
        if !paths_seen.insert(relative.clone()) {
            bail!(
                "workshop archive contains duplicate path '{}'",
                relative.display()
            );
        }
        let entry_type = entry.header().entry_type();
        let output = destination.join(&relative);
        if entry_type.is_dir() {
            fs::create_dir_all(&output)
                .with_context(|| format!("failed to create '{}'", output.display()))?;
            continue;
        }
        if !entry_type.is_file() {
            bail!(
                "workshop archive contains unsupported entry type at '{}'",
                relative.display()
            );
        }
        let size = entry
            .header()
            .size()
            .context("failed to read workshop tar entry size")?;
        expanded_bytes = expanded_bytes
            .checked_add(size)
            .context("workshop archive expanded size overflow")?;
        if expanded_bytes > worker.max_expanded_bundle_bytes {
            bail!(
                "workshop archive exceeds the {} byte expanded limit",
                worker.max_expanded_bundle_bytes
            );
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create '{}'", parent.display()))?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .with_context(|| format!("failed to create '{}'", output.display()))?;
        std::io::copy(&mut entry, &mut file)
            .with_context(|| format!("failed to extract '{}'", relative.display()))?;
        file.flush()
            .with_context(|| format!("failed to flush '{}'", output.display()))?;
        #[cfg(unix)]
        {
            // The deterministic bundle compiler emits only regular 0644 and
            // executable 0755 files. Preserve executable intent while
            // normalizing every other permission bit (including set-id).
            let archived_mode = entry
                .header()
                .mode()
                .context("failed to read workshop tar entry mode")?;
            let normalized_mode = if archived_mode & 0o111 == 0 {
                0o644
            } else {
                0o755
            };
            file.set_permissions(fs::Permissions::from_mode(normalized_mode))
                .with_context(|| {
                    format!(
                        "failed to set normalized permissions on '{}'",
                        output.display()
                    )
                })?;
        }
    }
    Ok(())
}

fn safe_relative_path(path: &Path) -> Result<PathBuf> {
    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => safe.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("workshop archive contains unsafe path '{}'", path.display())
            }
        }
    }
    if safe.as_os_str().is_empty() {
        bail!("workshop archive contains an empty path");
    }
    Ok(safe)
}

fn validate_claim(claim: &WorkshopPublicationClaim) -> Result<()> {
    for (label, value) in [
        ("publication_id", claim.publication_id.as_str()),
        ("workshop_slug", claim.workshop_slug.as_str()),
    ] {
        if !is_safe_id(value) {
            bail!("claim {label} is invalid");
        }
    }
    if claim.content_hash.len() != 64
        || !claim
            .content_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        bail!("claim content_hash must be a lowercase SHA-256 digest");
    }
    if claim.required_checkpoint_ids.is_empty() {
        bail!("claim must contain at least one required checkpoint ID");
    }
    for checkpoint in &claim.required_checkpoint_ids {
        if !is_safe_id(checkpoint) {
            bail!("claim contains invalid checkpoint ID '{checkpoint}'");
        }
    }
    if claim.bundle_url.trim().is_empty() {
        bail!("claim bundle_url is empty");
    }
    Ok(())
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && !matches!(value, "." | "..")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::Path;

    use flate2::{Compression, GzBuilder};
    use tar::{Builder, EntryType, Header};

    use super::{
        extract_archive, prepare_local_bundle, safe_relative_path, verify_compiled_manifest,
    };
    use crate::config::WorkerConfig;

    #[test]
    fn rejects_parent_paths() {
        assert!(safe_relative_path(Path::new("../escape")).is_err());
        assert!(safe_relative_path(Path::new("/absolute")).is_err());
    }

    #[test]
    fn rejects_non_regular_archive_entries() {
        let encoder = GzBuilder::new().write(Vec::new(), Compression::default());
        let mut archive = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_cksum();
        archive
            .append_data(&mut header, "link", std::io::empty())
            .unwrap();
        let bytes = archive.into_inner().unwrap().finish().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let worker = WorkerConfig {
            work_root: destination.path().to_path_buf(),
            ..WorkerConfig::default()
        };

        let error = extract_archive(&bytes, destination.path(), &worker).unwrap_err();
        assert!(error.to_string().contains("unsupported entry type"));
    }

    #[test]
    fn rejects_expanded_size_limit() {
        let encoder = GzBuilder::new().write(Vec::new(), Compression::default());
        let mut archive = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Regular);
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, "file", &b"data"[..])
            .unwrap();
        let bytes = archive.into_inner().unwrap().finish().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let worker = WorkerConfig {
            max_expanded_bundle_bytes: 3,
            ..WorkerConfig::default()
        };

        let error = extract_archive(&bytes, destination.path(), &worker).unwrap_err();
        assert!(error.to_string().contains("expanded limit"));
    }

    #[test]
    fn rejects_compiled_manifest_that_does_not_match_hcl() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../intar-workshop-manifest/tests/fixtures/platform-engineering-workshop");
        let bundle = intar_workshop_manifest::build_bundle(&fixture).unwrap();
        let destination = tempfile::tempdir().unwrap();
        extract_archive(&bundle.bytes, destination.path(), &WorkerConfig::default()).unwrap();
        let workshop = intar_workshop_manifest::load_and_validate(destination.path()).unwrap();
        std::fs::write(
            destination
                .path()
                .join(intar_workshop_manifest::COMPILED_MANIFEST_PATH),
            b"{}",
        )
        .unwrap();

        let error = verify_compiled_manifest(destination.path(), &workshop).unwrap_err();
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn local_bundle_requires_the_exact_configured_digest() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.work/workshops/platform-engineering");
        let bundle = intar_workshop_manifest::build_bundle(&fixture).unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("workshop.tar.gz");
        std::fs::write(&path, &bundle.bytes).unwrap();
        let worker = WorkerConfig {
            work_root: temporary.path().join("work"),
            ..WorkerConfig::default()
        };

        let prepared = prepare_local_bundle(&path, &bundle.sha256, &worker).unwrap();
        assert_eq!(
            prepared.workshop.manifest.workshop.id,
            bundle.workshop.manifest.workshop.id
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;

            let mode =
                std::fs::metadata(prepared.root.join("runtime/source/lab/00-setup/verify.sh"))
                    .unwrap()
                    .permissions()
                    .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        let error = prepare_local_bundle(&path, &"0".repeat(64), &worker).unwrap_err();
        assert!(error.to_string().contains("hash mismatch"));
    }
}
