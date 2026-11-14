use super::*;

use std::collections::HashSet;
use std::os::unix::fs::MetadataExt as _;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StoreGcReport {
    pub templates_removed: usize,
    pub chunks_removed: usize,
    pub ram_files_removed: usize,
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
    let (mut templates, stale) = load_templates(&templates_root)?;
    templates.sort_by_key(|entry| entry.last_used);
    let mut remove = HashSet::new();
    let current_store_bytes = estimated_store_bytes(&templates, &remove, &config.jail_root)?;
    let current_free_bytes = fs2::available_space(&config.jail_root)
        .with_context(|| format!("read free space for {}", config.jail_root.display()))?;

    loop {
        let retained_store_bytes = estimated_store_bytes(&templates, &remove, &config.jail_root)?;
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
    // A template of another schema is never launched again; only a live VM
    // still booted from it keeps it.
    for (image_id, path) in stale {
        if protected_image_ids.contains(&image_id) {
            continue;
        }
        std::fs::remove_dir_all(&path)
            .with_context(|| format!("remove a template of another schema {}", path.display()))?;
        report.templates_removed += 1;
    }

    let retained = templates
        .iter()
        .filter(|entry| !remove.contains(&entry.image_id))
        .collect::<Vec<_>>();
    report.chunks_removed = prune_unreferenced(
        &chunks_root,
        ".raw",
        &referenced_chunks(&retained),
        now,
        grace,
    )?;
    // A RAM store file stays while any template was made from it.
    report.ram_files_removed = prune_unreferenced(
        &config.jail_root.join("ram"),
        ".ram",
        &referenced_ram(&retained),
        now,
        grace,
    )?;
    report.estimated_bytes_after = estimated_store_bytes(&templates, &remove, &config.jail_root)?;
    report.filesystem_free_bytes_after = fs2::available_space(&config.jail_root)?;
    Ok(report)
}

fn referenced_chunks(retained: &[&TemplateGcEntry]) -> HashSet<String> {
    retained
        .iter()
        .flat_map(|entry| entry.metadata.chunk_raw_sha256s.iter())
        .map(|sha| sha.as_str().to_owned())
        .collect()
}

fn referenced_ram(retained: &[&TemplateGcEntry]) -> HashSet<String> {
    retained
        .iter()
        .filter_map(|entry| entry.metadata.wake.as_ref())
        .map(|wake| wake.ram_store_sha256.as_str().to_owned())
        .collect()
}

/// Remove `<sha256><suffix>` files of `root` that no retained template
/// references: root-owned, singly linked, and untouched for `grace`.
fn prune_unreferenced(
    root: &Path,
    suffix: &str,
    referenced: &HashSet<String>,
    now: SystemTime,
    grace: Duration,
) -> Result<usize> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(sha256) = name.strip_suffix(suffix) else {
            continue;
        };
        if Sha256Digest::parse(sha256.to_owned()).is_err() || referenced.contains(sha256) {
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

/// The current-schema templates, and the image directories of any other
/// schema (or with unreadable metadata) by image ID and path.
type StaleTemplates = Vec<(String, PathBuf)>;

fn load_templates(root: &Path) -> Result<(Vec<TemplateGcEntry>, StaleTemplates)> {
    let mut result = Vec::new();
    let mut stale = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((result, stale)),
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
                Ok(metadata) if metadata.schema_version == IMAGE_TEMPLATE_METADATA_V3 => metadata,
                _ => {
                    stale.push((image_id, entry.path()));
                    continue;
                }
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
    Ok((result, stale))
}

fn estimated_store_bytes(
    templates: &[TemplateGcEntry],
    removed: &HashSet<String>,
    jail_root: &Path,
) -> Result<u64> {
    let retained = templates
        .iter()
        .filter(|entry| !removed.contains(&entry.image_id))
        .collect::<Vec<_>>();
    let store_files = referenced_chunks(&retained)
        .into_iter()
        .map(|sha| jail_root.join("chunks").join(format!("{sha}.raw")))
        .chain(
            referenced_ram(&retained)
                .into_iter()
                .map(|sha| jail_root.join("ram").join(format!("{sha}.ram"))),
        );
    let template_files = retained.iter().flat_map(|entry| {
        // A base's `ram` shares its store file's extents; a pack's is its own.
        let own_ram = entry
            .metadata
            .wake
            .as_ref()
            .is_some_and(|wake| wake.ram.sha256 != wake.ram_store_sha256);
        [
            "kernel",
            "initrd",
            "metadata-v2.json",
            "last-used",
            "stub",
            "cpu-profile.json",
        ]
        .into_iter()
        .chain(own_ram.then_some("ram"))
        .map(|name| entry.path.join(name))
    });
    let mut bytes = 0_u64;
    for path in store_files.chain(template_files) {
        if let Ok(metadata) = std::fs::metadata(path) {
            bytes = bytes.saturating_add(allocated_bytes(&metadata));
        }
    }
    Ok(bytes)
}

fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_of_another_schema_go_unless_a_live_vm_holds_them() -> Result<()> {
        let root = tempfile::tempdir()?;
        let config = JailerdConfig {
            jail_root: root.path().to_owned(),
            ..JailerdConfig::default()
        };
        let templates = root.path().join("templates");
        let (old, held, unreadable) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        for id in [&old, &held, &unreadable] {
            std::fs::create_dir_all(templates.join(id))?;
        }
        for id in [&old, &held] {
            std::fs::write(
                templates.join(id).join("metadata-v2.json"),
                r#"{"schema_version":2}"#,
            )?;
        }
        // Not an image directory: left alone.
        std::fs::create_dir_all(templates.join(".staging"))?;

        let report = gc_root_stores(&config, &HashSet::from([held.clone()]))?;

        assert_eq!(report.templates_removed, 2);
        assert!(!templates.join(&old).exists() && !templates.join(&unreadable).exists());
        assert!(templates.join(&held).exists(), "a live VM's template stays");
        assert!(templates.join(".staging").exists());
        Ok(())
    }

    #[test]
    fn a_ram_store_file_stays_while_a_template_was_made_from_it() -> Result<()> {
        let root = tempfile::tempdir()?;
        let config = JailerdConfig {
            jail_root: root.path().to_owned(),
            store_gc_grace_seconds: 60,
            ..JailerdConfig::default()
        };
        let digest = |digit: &str| Sha256Digest::parse(digit.repeat(64));
        let artifact = ImageTemplateArtifactV2 {
            sha256: digest("a")?,
            bytes: 1,
            device: 1,
            inode: 1,
        };
        let metadata = ImageTemplateMetadataV2 {
            schema_version: IMAGE_TEMPLATE_METADATA_V3,
            image_sha256: digest("d")?,
            chunk_manifest_sha256: Some(digest("d")?),
            chunk_raw_sha256s: Vec::new(),
            virtual_size_bytes: 1,
            root_disk: artifact.clone(),
            kernel: artifact.clone(),
            initrd: None,
            wake: Some(ImageTemplateWakeV1 {
                ram_store_sha256: digest("a")?,
                ram: artifact.clone(),
                stub: artifact.clone(),
                cpu_profile: artifact,
            }),
        };
        let template = root.path().join("templates").join("d".repeat(64));
        std::fs::create_dir_all(&template)?;
        std::fs::write(
            template.join("metadata-v2.json"),
            serde_json::to_vec(&metadata)?,
        )?;
        let ram = root.path().join("ram");
        std::fs::create_dir_all(&ram)?;
        let (used, unused) = (
            ram.join(format!("{}.ram", "a".repeat(64))),
            ram.join(format!("{}.ram", "b".repeat(64))),
        );
        for path in [&used, &unused] {
            File::create(path)?.set_modified(UNIX_EPOCH + Duration::from_secs(1_000))?;
        }

        let report = gc_root_stores(&config, &HashSet::new())?;

        assert!(used.exists(), "a referenced RAM store file stays");
        // Only root-owned files go, so only a root test run sees one go.
        let as_root = rustix::process::geteuid().is_root();
        assert_eq!(report.ram_files_removed, usize::from(as_root));
        assert_eq!(unused.exists(), !as_root);
        Ok(())
    }

    #[test]
    fn gc_stops_after_projected_reclamation_meets_both_limits() {
        assert!(retention_pressure_satisfied(96, 128, 96, 128));
        assert!(!retention_pressure_satisfied(97, 256, 96, 128));
        assert!(!retention_pressure_satisfied(1, 127, 96, 128));
    }
}
