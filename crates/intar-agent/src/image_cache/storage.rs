use super::*;

pub(super) async fn evict_cache_if_needed(
    cache: &ImageCacheConfig,
    db: &Db,
    cache_root: &Path,
) -> Result<()> {
    let Some(max_bytes) = cache.max_bytes else {
        return Ok(());
    };
    let protected = protected_image_shas(db).await;
    let eviction_root = cache_root.to_path_buf();
    let protected_for_eviction = protected.clone();
    let remaining = tokio::task::spawn_blocking(move || {
        evict_chunk_cache_files(&eviction_root, &protected_for_eviction, max_bytes)
    })
    .await
    .context("chunk cache eviction worker panicked")??;
    if remaining > max_bytes {
        warn!(
            cache_root = %cache_root.display(),
            max_bytes,
            remaining_bytes = remaining,
            protected_count = protected.len(),
            "chunk cache remains over budget because live or recent files are protected"
        );
    }
    Ok(())
}

const CHUNK_CACHE_EVICTION_GRACE: Duration = Duration::from_secs(60 * 60);

fn evict_chunk_cache_files(
    cache_root: &Path,
    protected_image_ids: &HashSet<String>,
    max_bytes: u64,
) -> Result<u64> {
    let mut protected_paths = HashSet::new();
    let mut descriptors = Vec::new();
    collect_cache_files(&cache_root.join("launch-v3"), &mut descriptors)?;
    for (descriptor_path, _) in descriptors {
        if descriptor_path.extension().and_then(|value| value.to_str()) == Some("json") {
            let Ok(bytes) = std::fs::read(&descriptor_path) else {
                continue;
            };
            let Ok(descriptor) = serde_json::from_slice::<ChunkedLaunchDescriptorV1>(&bytes) else {
                continue;
            };
            if !protected_image_ids.contains(&descriptor.image_id) {
                continue;
            }
            protected_paths.insert(descriptor_path);
            protected_paths.insert(descriptor.chunk_manifest_path.clone());
            protected_paths.insert(descriptor.kernel_path.clone());
            protected_paths.insert(descriptor.initrd_path.clone());
            if let Ok(manifest) = serde_json::from_slice::<ImageChunkManifestV1>(
                &std::fs::read(&descriptor.chunk_manifest_path).unwrap_or_default(),
            ) {
                for chunk in manifest.chunks {
                    protected_paths.insert(
                        descriptor
                            .chunk_cache_root
                            .join(format!("{}.raw.zst", chunk.raw_sha256)),
                    );
                }
            }
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
        if protected_paths.contains(&path)
            || file_within_grace(&metadata, CHUNK_CACHE_EVICTION_GRACE)
        {
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

pub(super) async fn protected_image_shas(db: &Db) -> HashSet<String> {
    let mut protected = HashSet::new();
    match db.load_local_vm_image_shas().await {
        Ok(shas) => {
            protected.extend(shas);
        }
        Err(error) => {
            warn!(error = %error, "failed to load local vm image refs for cache protection");
        }
    }

    let desired_row = match db.load_desired_state().await {
        Ok(Some(row)) => row,
        Ok(None) => return protected,
        Err(error) => {
            warn!(error = %error, "failed to load desired state for cache protection");
            return protected;
        }
    };
    let desired = match serde_json::from_str::<intar_contracts::bridge::HostDesiredStateV2>(
        &desired_row.doc_json,
    ) {
        Ok(desired) => desired,
        Err(error) => {
            warn!(error = %error, "failed to parse desired state for cache protection");
            return protected;
        }
    };

    for image in desired.cached_images {
        protected.insert(image.image_id);
    }
    for vm in desired.vms {
        if vm.desired_phase == intar_contracts::bridge::DesiredVmPhase::Running {
            protected.insert(vm.image_id);
        }
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

pub(super) async fn ensure_cached_artifact(
    sha256: &str,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    let expected_sha256 = normalize_sha256(sha256)
        .ok_or_else(|| anyhow::anyhow!("invalid artifact sha256 {sha256:?}"))?;
    let artifact_dir = cache_root.join("artifacts");
    tokio::fs::create_dir_all(&artifact_dir)
        .await
        .with_context(|| {
            format!(
                "failed to create artifact cache dir {}",
                artifact_dir.display()
            )
        })?;
    let artifact_path = artifact_dir.join(&expected_sha256);
    let artifact_lock = cache_entry_lock(cache_root, format!("artifact:{expected_sha256}")).await;
    let _artifact_guard = artifact_lock.lock().await;

    if tokio::fs::metadata(&artifact_path).await.is_ok() {
        match sha256_file(&artifact_path).await {
            Ok(have) if have == expected_sha256 => {
                info!(path = %artifact_path.display(), "artifact cache hit");
                return Ok(artifact_path);
            }
            Ok(have) => {
                warn!(
                    path = %artifact_path.display(),
                    expected_sha256 = %expected_sha256,
                    actual_sha256 = %have,
                    "cached artifact sha256 mismatch; refreshing"
                );
            }
            Err(error) => {
                warn!(path = %artifact_path.display(), "failed to hash cached artifact: {error}");
            }
        }
    }

    let (tmp_path, mut tmp_file) = create_tmp_file(&artifact_dir, &expected_sha256).await?;
    let artifact_url = format!("/agent/registry/artifacts/{expected_sha256}");
    let download = download_to_file(client, registry, bridge, &artifact_url, &mut tmp_file).await;
    drop(tmp_file);

    let download = match download {
        Ok(download) => download,
        Err(error) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(error).with_context(|| format!("failed to download artifact {sha256}"));
        }
    };

    if download.sha256 != expected_sha256 {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        anyhow::bail!(
            "downloaded artifact sha256 mismatch: expected {}, got {}",
            expected_sha256,
            download.sha256
        );
    }

    if tokio::fs::metadata(&artifact_path).await.is_ok() {
        let _ = tokio::fs::remove_file(&artifact_path).await;
    }
    tokio::fs::rename(&tmp_path, &artifact_path)
        .await
        .with_context(|| {
            format!(
                "failed to move cached artifact into place at {}",
                artifact_path.display()
            )
        })?;
    Ok(artifact_path)
}
