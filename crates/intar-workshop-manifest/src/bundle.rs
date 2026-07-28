use crate::error::{Result, WorkshopManifestError};
use crate::model::{CompiledWorkshop, ValidatedWorkshop};
use crate::validate::{load_and_validate, read_bundle_source};
use flate2::{Compression, GzBuilder};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Cursor, Write};
use std::path::Path;
use tar::{Builder, EntryType, Header, HeaderMode};

pub const COMPILED_MANIFEST_PATH: &str = "workshop.compiled.json";

#[derive(Debug, Clone)]
pub struct WorkshopBundle {
    pub workshop: ValidatedWorkshop,
    pub bytes: Vec<u8>,
    pub sha256: String,
}

pub fn build_bundle(root: impl AsRef<Path>) -> Result<WorkshopBundle> {
    let root = root.as_ref();
    let workshop = load_and_validate(root)?;
    let mut entries = BTreeMap::new();
    let compiled = CompiledWorkshop {
        format_version: 1,
        scheduled_duration_minutes: workshop.scheduled_duration_minutes,
        manifest: &workshop.manifest,
    };
    let mut compiled_json = serde_json::to_vec_pretty(&compiled)
        .map_err(|error| WorkshopManifestError::Bundle(error.to_string()))?;
    compiled_json.push(b'\n');
    entries.insert(COMPILED_MANIFEST_PATH.to_string(), compiled_json);
    for source in &workshop.source_files {
        entries.insert(source.clone(), read_bundle_source(root, source)?);
    }

    let encoder = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::best());
    let mut archive = Builder::new(encoder);
    archive.mode(HeaderMode::Deterministic);
    for (path, bytes) in entries {
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Regular);
        header.set_size(
            u64::try_from(bytes.len())
                .map_err(|error| WorkshopManifestError::Bundle(error.to_string()))?,
        );
        header.set_mode(if path.ends_with(".sh") { 0o755 } else { 0o644 });
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_cksum();
        archive
            .append_data(&mut header, path, Cursor::new(bytes))
            .map_err(|error| WorkshopManifestError::Bundle(error.to_string()))?;
    }
    let encoder = archive
        .into_inner()
        .map_err(|error| WorkshopManifestError::Bundle(error.to_string()))?;
    let bytes = encoder
        .finish()
        .map_err(|error| WorkshopManifestError::Bundle(error.to_string()))?;
    let sha256 = sha256_hex(&bytes);
    Ok(WorkshopBundle {
        workshop,
        bytes,
        sha256,
    })
}

pub fn write_bundle(root: impl AsRef<Path>, output: impl AsRef<Path>) -> Result<WorkshopBundle> {
    let bundle = build_bundle(root)?;
    let output = output.as_ref();
    if let Some(parent) = output.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            WorkshopManifestError::Bundle(format!(
                "failed to create output directory '{}': {error}",
                parent.display()
            ))
        })?;
    }
    let mut file = std::fs::File::create(output).map_err(|error| {
        WorkshopManifestError::Bundle(format!(
            "failed to create bundle '{}': {error}",
            output.display()
        ))
    })?;
    file.write_all(&bundle.bytes).map_err(|error| {
        WorkshopManifestError::Bundle(format!(
            "failed to write bundle '{}': {error}",
            output.display()
        ))
    })?;
    file.sync_all().map_err(|error| {
        WorkshopManifestError::Bundle(format!(
            "failed to sync bundle '{}': {error}",
            output.display()
        ))
    })?;
    Ok(bundle)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}
