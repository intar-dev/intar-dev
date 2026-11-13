use super::*;

pub(super) async fn evict_cache_if_needed(
    cache: &ImageCacheConfig,
    db: &Db,
    cache_root: &Path,
) -> Result<()> {
    let max_bytes = cache.max_bytes;
    if max_bytes == 0 {
        return Ok(());
    }
    let protected = protected_digests(db).await;
    let eviction_root = cache_root.to_path_buf();
    let protected_count = protected.len();
    let remaining = tokio::task::spawn_blocking(move || {
        evict_cache_files(&eviction_root, &protected, max_bytes)
    })
    .await
    .context("cache eviction worker panicked")??;
    if remaining > max_bytes {
        warn!(
            cache_root = %cache_root.display(),
            max_bytes,
            remaining_bytes = remaining,
            protected_count,
            "image cache remains over budget because pinned, live, or recent files are protected"
        );
    }
    Ok(())
}

const CACHE_EVICTION_GRACE: Duration = Duration::from_secs(60 * 60);

/// Evict the oldest files until the cache fits. A protected manifest keeps
/// itself, its ready descriptor, and every blob it names.
fn evict_cache_files(
    cache_root: &Path,
    protected: &HashSet<OciDigest>,
    max_bytes: u64,
) -> Result<u64> {
    let store = BlobStore::new(cache_root);
    let mut protected_paths = HashSet::new();
    for manifest in protected {
        protected_paths.insert(store.path(manifest));
        protected_paths.insert(
            cache_root
                .join("launch")
                .join(format!("{}.ready.json", manifest.hex())),
        );
        for blob in ready::manifest_references(&store, manifest) {
            protected_paths.insert(store.path(&blob));
        }
    }

    let mut files = Vec::new();
    collect_cache_files(cache_root, &mut files)?;
    let mut total = files.iter().fold(0_u64, |sum, (_, metadata)| {
        sum.saturating_add(file_allocated_bytes(metadata))
    });
    files.sort_by_key(|(_, metadata)| metadata.modified().unwrap_or(UNIX_EPOCH));
    for (path, metadata) in files {
        if total <= max_bytes {
            break;
        }
        if protected_paths.contains(&path) || file_within_grace(&metadata, CACHE_EVICTION_GRACE) {
            continue;
        }
        let bytes = file_allocated_bytes(&metadata);
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(bytes);
        }
    }
    Ok(total)
}

fn collect_cache_files(
    directory: &Path,
    files: &mut Vec<(PathBuf, std::fs::Metadata)>,
) -> Result<()> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            collect_cache_files(&entry.path(), files)?;
        } else if metadata.is_file() {
            files.push((entry.path(), metadata));
        }
    }
    Ok(())
}

fn file_within_grace(metadata: &std::fs::Metadata, grace: Duration) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_none_or(|age| age < grace)
}

/// The pins of the cached desired state and every digest a persisted VM
/// boots from.
async fn protected_digests(db: &Db) -> HashSet<OciDigest> {
    let mut protected = HashSet::new();
    match db.load_local_vm_digests().await {
        Ok(digests) => protected.extend(
            digests
                .into_iter()
                .filter_map(|digest| OciDigest::try_from(digest).ok()),
        ),
        Err(error) => warn!(error = %error, "failed to load local VM digests for cache protection"),
    }
    match db.load_desired_state().await {
        Ok(Some(row)) => {
            match serde_json::from_str::<intar_contracts::bridge_v9::HostDesiredStateV3>(
                &row.doc_json,
            ) {
                Ok(desired) => {
                    let pins = RequiredPins::from_desired_state(&desired);
                    protected.extend(pins.images);
                    protected.extend(pins.kino);
                }
                Err(error) => {
                    warn!(error = %error, "failed to parse desired state for cache protection")
                }
            }
        }
        Ok(None) => {}
        Err(error) => warn!(error = %error, "failed to load desired state for cache protection"),
    }
    protected
}

pub(super) fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

/// Bytes a cache file actually occupies on disk. Raw images are written
/// sparsely, so their logical length vastly overstates disk usage; budgeting
/// on it would evict far below the operator's real `max_bytes`.
pub(super) fn file_allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.blocks().saturating_mul(512)
    }
    #[cfg(not(unix))]
    {
        metadata.len()
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{File, FileTimes};

    use super::super::pins::tests::digest;
    use super::*;

    fn write_old_file(path: &Path, bytes: &[u8]) -> Result<()> {
        std::fs::create_dir_all(path.parent().context("parent")?)?;
        std::fs::write(path, bytes)?;
        let old = SystemTime::now()
            .checked_sub(CACHE_EVICTION_GRACE + Duration::from_secs(1))
            .context("system clock supports an old fixture")?;
        File::open(path)?.set_times(FileTimes::new().set_modified(old))?;
        Ok(())
    }

    #[test]
    fn eviction_keeps_a_pinned_manifest_and_every_blob_it_names() -> Result<()> {
        let cache = tempfile::tempdir()?;
        let store = BlobStore::new(cache.path());
        let (pinned, config, layer, other) = (digest('1'), digest('2'), digest('3'), digest('4'));
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": intar_contracts::oci::OCI_MANIFEST_MEDIA_TYPE,
            "artifactType": intar_contracts::oci::MACHINE_ARTIFACT_TYPE,
            "config": {"mediaType": "c", "digest": config.as_str(), "size": 1},
            "layers": [{"mediaType": "l", "digest": layer.as_str(), "size": 1}],
        });
        write_old_file(&store.path(&pinned), &serde_json::to_vec(&manifest)?)?;
        for blob in [&config, &layer, &other] {
            write_old_file(&store.path(blob), &[0_u8; 4096])?;
        }
        let descriptor = cache
            .path()
            .join("launch")
            .join(format!("{}.ready.json", pinned.hex()));
        write_old_file(&descriptor, b"{}")?;

        let remaining = evict_cache_files(cache.path(), &HashSet::from([pinned.clone()]), 1)?;

        for kept in [
            store.path(&pinned),
            store.path(&config),
            store.path(&layer),
            descriptor,
        ] {
            assert!(kept.exists(), "{}", kept.display());
        }
        assert!(!store.path(&other).exists(), "an unpinned blob is evicted");
        assert!(remaining > 1);
        Ok(())
    }
}
