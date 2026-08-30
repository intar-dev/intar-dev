use super::*;

use std::collections::HashSet;
use std::os::unix::fs::MetadataExt as _;

const LEGACY_RETENTION_MARKER: &str = ".image-v10-legacy-retention-start";

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StoreGcReport {
    pub templates_removed: usize,
    pub chunks_removed: usize,
    pub estimated_bytes_after: u64,
    pub filesystem_free_bytes_after: u64,
}

struct TemplateGcEntry {
    image_id: String,
    path: PathBuf,
    last_used: SystemTime,
    metadata: ImageTemplateMetadataV2,
}

pub fn gc_root_stores(
    config: &JailerdConfig,
    protected_image_ids: &HashSet<String>,
) -> Result<StoreGcReport> {
    let templates_root = config.jail_root.join("templates");
    let chunks_root = config.jail_root.join("chunks");
    let grace = Duration::from_secs(config.store_gc_grace_seconds);
    let now = SystemTime::now();
    ensure_legacy_template_retention_marker(config)?;
    let mut templates = load_templates(&templates_root, IMAGE_TEMPLATE_METADATA_V3)?;
    templates.sort_by_key(|entry| entry.last_used);
    let mut remove = HashSet::new();
    let current_store_bytes = estimated_store_bytes(&templates, &remove, &chunks_root)?;
    let current_free_bytes = fs2::available_space(&config.jail_root)
        .with_context(|| format!("read free space for {}", config.jail_root.display()))?;

    loop {
        let retained_store_bytes = estimated_store_bytes(&templates, &remove, &chunks_root)?;
        let projected_free_bytes = current_free_bytes
            .saturating_add(current_store_bytes.saturating_sub(retained_store_bytes));
        if retention_pressure_satisfied(
            retained_store_bytes,
            projected_free_bytes,
            config.template_budget_bytes,
            config.minimum_free_space_bytes,
        ) {
            break;
        }
        let Some(candidate) = templates.iter().find(|entry| {
            !remove.contains(&entry.image_id)
                && !protected_image_ids.contains(&entry.image_id)
                && now
                    .duration_since(entry.last_used)
                    .is_ok_and(|age| age >= grace)
        }) else {
            break;
        };
        remove.insert(candidate.image_id.clone());
    }

    let mut report = StoreGcReport::default();
    for entry in &templates {
        if remove.contains(&entry.image_id) {
            std::fs::remove_dir_all(&entry.path).with_context(|| {
                format!("remove unreferenced template {}", entry.path.display())
            })?;
            report.templates_removed += 1;
        }
    }
    report.templates_removed +=
        remove_expired_legacy_templates(config, &templates_root, protected_image_ids, now)?;

    let referenced_chunks = templates
        .iter()
        .filter(|entry| !remove.contains(&entry.image_id))
        .flat_map(|entry| {
            entry
                .metadata
                .chunk_raw_sha256s
                .iter()
                .map(|sha| sha.as_str().to_owned())
        })
        .collect::<HashSet<_>>();
    if let Ok(entries) = std::fs::read_dir(&chunks_root) {
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(raw_sha256) = name.strip_suffix(".raw") else {
                continue;
            };
            if Sha256Digest::parse(raw_sha256.to_owned()).is_err()
                || referenced_chunks.contains(raw_sha256)
            {
                continue;
            }
            let metadata = entry.metadata()?;
            if !metadata.is_file()
                || metadata.uid() != 0
                || metadata.gid() != 0
                || metadata.nlink() != 1
                || metadata
                    .modified()
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_none_or(|age| age < grace)
            {
                continue;
            }
            std::fs::remove_file(entry.path())?;
            report.chunks_removed += 1;
        }
    }
    report.estimated_bytes_after = estimated_store_bytes(&templates, &remove, &chunks_root)?;
    report.filesystem_free_bytes_after = fs2::available_space(&config.jail_root)?;
    Ok(report)
}

pub fn ensure_legacy_template_retention_marker(config: &JailerdConfig) -> Result<()> {
    std::fs::create_dir_all(&config.jail_root)?;
    let path = config.jail_root.join(LEGACY_RETENTION_MARKER);
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(&path)
    {
        Ok(mut file) => {
            writeln!(file, "{}", unix_time_millis()?)?;
            file.sync_all()?;
            rustix::fs::fchmod(&file, Mode::RUSR)?;
            rustix::fs::fchown(
                &file,
                Some(rustix::process::Uid::ROOT),
                Some(rustix::process::Gid::ROOT),
            )?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == 0
            && metadata.gid() == 0
            && metadata.mode() & 0o777 == 0o400,
        "legacy template retention marker is not root-owned and immutable"
    );
    Ok(())
}

fn remove_expired_legacy_templates(
    config: &JailerdConfig,
    templates_root: &Path,
    protected_image_ids: &HashSet<String>,
    now: SystemTime,
) -> Result<usize> {
    let marker = std::fs::metadata(config.jail_root.join(LEGACY_RETENTION_MARKER))?;
    let retention = Duration::from_secs(config.legacy_template_retention_seconds);
    if now
        .duration_since(marker.modified()?)
        .map_or(true, |age| age < retention)
    {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in load_templates(templates_root, IMAGE_TEMPLATE_METADATA_V2)? {
        if protected_image_ids.contains(&entry.image_id) {
            continue;
        }
        std::fs::remove_dir_all(&entry.path)
            .with_context(|| format!("remove retained legacy template {}", entry.path.display()))?;
        removed += 1;
    }
    Ok(removed)
}

fn retention_pressure_satisfied(
    retained_store_bytes: u64,
    projected_free_bytes: u64,
    template_budget_bytes: u64,
    minimum_free_space_bytes: u64,
) -> bool {
    retained_store_bytes <= template_budget_bytes
        && projected_free_bytes >= minimum_free_space_bytes
}

pub(super) fn touch_chunked_template(
    config: &JailerdConfig,
    image_id: &Sha256Digest,
) -> Result<()> {
    let path = config
        .jail_root
        .join("templates")
        .join(image_id.as_str())
        .join("last-used");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o400)
        .open(&path)?;
    writeln!(file, "{}", unix_time_millis()?)?;
    file.sync_all()?;
    rustix::fs::fchmod(&file, Mode::RUSR)?;
    rustix::fs::fchown(
        &file,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    Ok(())
}

fn load_templates(root: &Path, schema_version: u16) -> Result<Vec<TemplateGcEntry>> {
    let mut result = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let image_id = entry.file_name().to_string_lossy().to_string();
        if Sha256Digest::parse(image_id.clone()).is_err() || !entry.file_type()?.is_dir() {
            continue;
        }
        let metadata_path = entry.path().join("metadata-v2.json");
        let metadata: ImageTemplateMetadataV2 =
            match serde_json::from_slice::<ImageTemplateMetadataV2>(
                &std::fs::read(&metadata_path).unwrap_or_default(),
            ) {
                Ok(metadata) if metadata.schema_version == schema_version => metadata,
                _ => continue,
            };
        let last_used = std::fs::metadata(entry.path().join("last-used"))
            .and_then(|metadata| metadata.modified())
            .or_else(|_| std::fs::metadata(&metadata_path)?.modified())?;
        result.push(TemplateGcEntry {
            image_id,
            path: entry.path(),
            last_used,
            metadata,
        });
    }
    Ok(result)
}

fn estimated_store_bytes(
    templates: &[TemplateGcEntry],
    removed: &HashSet<String>,
    chunks_root: &Path,
) -> Result<u64> {
    let retained = templates
        .iter()
        .filter(|entry| !removed.contains(&entry.image_id))
        .collect::<Vec<_>>();
    let referenced_chunks = retained
        .iter()
        .flat_map(|entry| entry.metadata.chunk_raw_sha256s.iter())
        .map(|sha| sha.as_str())
        .collect::<HashSet<_>>();
    let mut bytes = 0_u64;
    for sha in referenced_chunks {
        if let Ok(metadata) = std::fs::metadata(chunks_root.join(format!("{sha}.raw"))) {
            bytes = bytes.saturating_add(allocated_bytes(&metadata));
        }
    }
    for entry in retained {
        for name in ["kernel", "initrd", "metadata-v2.json", "last-used"] {
            if let Ok(metadata) = std::fs::metadata(entry.path.join(name)) {
                bytes = bytes.saturating_add(allocated_bytes(&metadata));
            }
        }
    }
    Ok(bytes)
}

fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

#[cfg(test)]
mod tests {
    use super::retention_pressure_satisfied;

    #[test]
    fn gc_stops_after_projected_reclamation_meets_both_limits() {
        assert!(retention_pressure_satisfied(96, 128, 96, 128));
        assert!(!retention_pressure_satisfied(97, 256, 96, 128));
        assert!(!retention_pressure_satisfied(1, 127, 96, 128));
    }
}
