use super::*;

pub(super) async fn evict_cache_if_needed(
    cache: &ImageCacheConfig,
    db: &Db,
    cache_root: &Path,
) -> Result<()> {
    let Some(max_bytes) = cache.max_bytes else {
        return Ok(());
    };

    let access_rows = db.load_image_cache_access().await?;
    let mut entries = Vec::new();
    for row in &access_rows {
        let raw_path = cached_raw_image_path_for_key(cache_root, &row.image_key, &row.image_sha256);
        match tokio::fs::metadata(&raw_path).await {
            Ok(metadata) => entries.push(CacheEntry {
                sha: row.image_sha256.clone(),
                bytes: file_allocated_bytes(&metadata),
                last_accessed_at_ms: row.last_accessed_at_ms,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                db.delete_image_cache_access(row.image_sha256.clone())
                    .await?;
            }
            Err(error) => {
                warn!(path = %raw_path.display(), error = %error, "failed to stat raw cache entry during eviction");
            }
        }
    }

    let protected = protected_image_shas(db).await;
    let artifact_bytes = artifact_cache_bytes(cache_root).await?;
    let raw_budget = max_bytes.saturating_sub(artifact_bytes);
    let evictions = select_evictions(&entries, &protected, raw_budget);
    let evicted = evictions.iter().cloned().collect::<HashSet<_>>();

    for sha in &evictions {
        let Some(row) = access_rows.iter().find(|row| row.image_sha256 == *sha) else {
            continue;
        };
        let raw_path = cached_raw_image_path_for_key(cache_root, &row.image_key, sha);
        let marker_path = raw_cache_marker_path_for_key(cache_root, &row.image_key, sha);
        let bytes = tokio::fs::metadata(&raw_path)
            .await
            .map(|metadata| file_allocated_bytes(&metadata))
            .unwrap_or(0);
        remove_raw_cache_entry(&raw_path, &marker_path).await?;
        remove_launch_descriptor_if_matching(cache_root, &row.image_key, sha).await?;
        db.delete_image_cache_access(sha.clone()).await?;
        info!(
            image = %row.image_key,
            sha = %sha,
            bytes,
            reason = "lru_over_budget",
            "evicted raw image cache entry"
        );
    }

    let retained_artifacts = access_rows
        .iter()
        .filter(|row| !evicted.contains(&row.image_sha256))
        .flat_map(|row| [row.kernel_sha256.clone(), row.initrd_sha256.clone()])
        .collect::<HashSet<_>>();
    evict_unreferenced_artifacts(cache_root, &retained_artifacts).await?;

    let remaining_raw = entries
        .iter()
        .filter(|entry| !evicted.contains(&entry.sha))
        .fold(0_u64, |sum, entry| sum.saturating_add(entry.bytes));
    let remaining_artifacts = artifact_cache_bytes(cache_root).await?;
    let remaining = remaining_raw.saturating_add(remaining_artifacts);
    if remaining > max_bytes {
        warn!(
            cache_root = %cache_root.display(),
            max_bytes,
            remaining_bytes = remaining,
            protected_count = protected.len(),
            "image cache remains over budget because no more unprotected entries are evictable"
        );
    }

    Ok(())
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
        protected.insert(image.image_sha256);
    }
    for vm in desired.vms {
        if vm.desired_phase == intar_contracts::bridge::DesiredVmPhase::Running {
            protected.insert(vm.image_sha256);
        }
    }
    protected
}

pub(super) async fn artifact_cache_bytes(cache_root: &Path) -> Result<u64> {
    let artifact_dir = cache_root.join("artifacts");
    let mut total = 0_u64;
    let mut entries = match tokio::fs::read_dir(&artifact_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "failed to read artifact cache dir {}",
                    artifact_dir.display()
                )
            });
        }
    };

    while let Some(entry) = entries
        .next_entry()
        .await
        .context("failed to iterate artifact cache dir")?
    {
        let metadata = entry
            .metadata()
            .await
            .with_context(|| format!("failed to stat {}", entry.path().display()))?;
        if metadata.is_file() {
            total = total.saturating_add(file_allocated_bytes(&metadata));
        }
    }
    Ok(total)
}

pub(super) async fn evict_unreferenced_artifacts(
    cache_root: &Path,
    retained_artifacts: &HashSet<String>,
) -> Result<()> {
    let artifact_dir = cache_root.join("artifacts");
    let mut entries = match tokio::fs::read_dir(&artifact_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "failed to read artifact cache dir {}",
                    artifact_dir.display()
                )
            });
        }
    };

    while let Some(entry) = entries
        .next_entry()
        .await
        .context("failed to iterate artifact cache dir")?
    {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if retained_artifacts.contains(&file_name) {
            continue;
        }
        let path = entry.path();
        let metadata = entry
            .metadata()
            .await
            .with_context(|| format!("failed to stat {}", path.display()))?;
        if !metadata.is_file() {
            continue;
        }
        // A concurrent VM create downloads kernel/initrd before its access
        // row is written, so an artifact absent from the retained set may
        // simply be brand new. Only sweep artifacts old enough that any
        // in-flight create referencing them has long since recorded itself.
        if artifact_within_eviction_grace(&metadata) {
            continue;
        }
        tokio::fs::remove_file(&path)
            .await
            .with_context(|| format!("failed to remove artifact {}", path.display()))?;
        info!(
            sha = %file_name,
            bytes = metadata.len(),
            reason = "unreferenced_artifact",
            "evicted image cache artifact"
        );
    }

    Ok(())
}

pub(super) const ARTIFACT_EVICTION_GRACE: Duration = Duration::from_secs(15 * 60);

pub(super) fn artifact_within_eviction_grace(metadata: &std::fs::Metadata) -> bool {
    let Ok(modified) = metadata.modified() else {
        // Without a modification time we cannot prove the artifact is old;
        // keep it rather than risk deleting a freshly downloaded one.
        return true;
    };
    match SystemTime::now().duration_since(modified) {
        Ok(age) => age < ARTIFACT_EVICTION_GRACE,
        // Modified in the future (clock adjustment): treat as fresh.
        Err(_) => true,
    }
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

pub(super) async fn ensure_cached_raw_entry(
    image: &RegistryImageRecord,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<CachedRawImage> {
    // A foreground launch can overlap the background warmer, and sibling VMs
    // often share an image. Serialize the complete compressed + raw pipeline so
    // one task cannot unlink or replace a path another task just returned.
    let raw_lock = cache_entry_lock(
        cache_root,
        format!("raw:{}:{}", image.image_key, image.image_sha256),
    )
    .await;
    let _raw_guard = raw_lock.lock().await;

    let raw_path = cached_raw_image_path(cache_root, image);
    let marker_path = raw_cache_marker_path(cache_root, image);
    match tokio::fs::metadata(&raw_path).await {
        Ok(metadata) if metadata.len() == image.image_virtual_size_bytes => {
            match read_raw_cache_marker(&marker_path).await {
                Ok(marker) if raw_cache_marker_matches(&marker, image, metadata.len()) => {
                    info!(path = %raw_path.display(), "raw image cache hit");
                    return Ok(CachedRawImage {
                        path: raw_path,
                        sha256: marker.raw_sha256,
                    });
                }
                Ok(marker) => {
                    warn!(
                        path = %raw_path.display(),
                        marker_image_sha256 = %marker.image_sha256,
                        marker_bytes = marker.image_virtual_size_bytes,
                        "cached raw image marker mismatch; refreshing"
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    warn!(
                        path = %raw_path.display(),
                        "cached raw image missing verification marker; refreshing"
                    );
                }
                Err(error) => {
                    warn!(
                        path = %raw_path.display(),
                        "failed to read cached raw image marker: {error}; refreshing"
                    );
                }
            }
            remove_raw_cache_entry(&raw_path, &marker_path).await?;
        }
        Ok(metadata) => {
            warn!(
                path = %raw_path.display(),
                expected_bytes = image.image_virtual_size_bytes,
                actual_bytes = metadata.len(),
                "cached raw image size mismatch; refreshing"
            );
            remove_raw_cache_entry(&raw_path, &marker_path).await?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            warn!(path = %raw_path.display(), "failed to stat cached raw image: {error}");
        }
    }

    debug!(
        image = %image.image_key,
        kernel_sha256 = %image.boot.kernel_sha256,
        initrd_sha256 = %image.boot.initrd_sha256,
        cmdline = %image.boot.cmdline,
        "preparing direct-boot raw image cache entry"
    );

    let compressed_path = ensure_cached_entry(image, registry, bridge, cache_root, client).await?;
    let image_dir = cache_root.join(&image.image_key);
    let (tmp_path, tmp_file) =
        create_tmp_file(&image_dir, &format!("{}.raw", image.image_sha256)).await?;
    drop(tmp_file);

    let compressed_path_for_task = compressed_path.clone();
    let tmp_path_for_task = tmp_path.clone();
    let virtual_size_bytes = image.image_virtual_size_bytes;
    let decompress_result = tokio::task::spawn_blocking(move || {
        decompress_raw_zstd_sparse(
            &compressed_path_for_task,
            &tmp_path_for_task,
            virtual_size_bytes,
        )
    })
    .await
    .context("raw zstd decompression task panicked")?;
    let raw_sha256 = match decompress_result {
        Ok(raw_sha256) => raw_sha256,
        Err(error) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(error)
                .with_context(|| format!("failed to decompress cached image {}", image.image_key));
        }
    };

    if tokio::fs::metadata(&raw_path).await.is_ok() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        if verified_cached_raw_image_metadata(cache_root, &image.image_key, &image.image_sha256)
            .is_some()
        {
            let marker = read_raw_cache_marker(&marker_path)
                .await
                .context("read concurrently published raw cache marker")?;
            return Ok(CachedRawImage {
                path: raw_path,
                sha256: marker.raw_sha256,
            });
        }
        remove_raw_cache_entry(&raw_path, &marker_path).await?;
    }
    tokio::fs::rename(&tmp_path, &raw_path)
        .await
        .with_context(|| {
            format!(
                "failed to move raw image into place at {}",
                raw_path.display()
            )
        })?;
    write_raw_cache_marker(cache_root, image, &raw_sha256)
        .await
        .with_context(|| format!("failed to write raw cache marker for {}", image.image_key))?;
    info!(path = %raw_path.display(), "raw image cache ready");
    Ok(CachedRawImage {
        path: raw_path,
        sha256: raw_sha256,
    })
}

pub(super) async fn ensure_cached_entry(
    image: &RegistryImageRecord,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    if !is_safe_component(&image.image_key) {
        anyhow::bail!("invalid image key {:?}", image.image_key);
    }

    debug!(
        cache_root = %cache_root.display(),
        image = image.image_key,
        "ensuring image is cached"
    );

    let image_dir = cache_root.join(&image.image_key);
    tokio::fs::create_dir_all(&image_dir)
        .await
        .with_context(|| {
            format!(
                "failed to create image cache dir at {}",
                image_dir.display()
            )
        })?;

    let image_path = cached_image_path(cache_root, image);
    let expected_sha256 = image.image_sha256.clone();
    cache_sha_sidecar(
        &format!("{expected_sha256}  {}\n", image.image_filename),
        &image_dir,
        &sha_filename(image),
    )
    .await
    .with_context(|| format!("failed to cache sha256 for image {}", image.image_key))?;
    let had_existing = tokio::fs::metadata(&image_path).await.is_ok();
    let mut existing_failed_sha_check = false;

    if had_existing {
        match sha256_file(&image_path).await {
            Ok(have) if have == expected_sha256 => {
                info!(path = %image_path.display(), "cache hit");
                return Ok(image_path);
            }
            Ok(have) => {
                existing_failed_sha_check = true;
                warn!(
                    path = %image_path.display(),
                    expected_sha256 = %expected_sha256,
                    actual_sha256 = %have,
                    "cached image sha256 mismatch; refreshing"
                );
            }
            Err(e) => {
                existing_failed_sha_check = true;
                warn!(path = %image_path.display(), "failed to hash cached image: {e}");
            }
        }
    }

    let image_url = build_registry_url(registry, &image.download_url)?;
    let (tmp_path, mut tmp_file) = create_tmp_file(&image_dir, &image.image_filename).await?;
    info!(tmp_path = %tmp_path.display(), url = %redact_url_userinfo(image_url.as_str()), "download start");

    let download_start = std::time::Instant::now();
    let download_result =
        download_to_file(client, registry, bridge, &image.download_url, &mut tmp_file).await;
    drop(tmp_file);

    let download = match download_result {
        Ok(download) => download,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            if had_existing && !existing_failed_sha_check {
                warn!(
                    path = %image_path.display(),
                    "failed to refresh image; using existing cached copy: {e}"
                );
                return Ok(image_path);
            }
            return Err(anyhow::anyhow!(
                "failed to download image {}: {e}",
                image.image_key
            ));
        }
    };

    if download.sha256 != expected_sha256 {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        anyhow::bail!(
            "downloaded image {} sha256 mismatch: expected {}, got {}",
            image.image_key,
            expected_sha256,
            download.sha256
        );
    }

    info!(
        bytes = download.bytes,
        url = %redact_url_userinfo(&download.source_url),
        elapsed_ms = download_start.elapsed().as_millis(),
        "download complete"
    );

    if tokio::fs::metadata(&image_path).await.is_ok() {
        if let Ok(existing_sha256) = sha256_file(&image_path).await
            && existing_sha256 == download.sha256
        {
            info!(
                path = %image_path.display(),
                "cache already populated; discarding download"
            );
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Ok(image_path);
        }
        let _ = tokio::fs::remove_file(&image_path).await;
    }

    tokio::fs::rename(&tmp_path, &image_path)
        .await
        .with_context(|| {
            format!(
                "failed to move cached image into place at {}",
                image_path.display()
            )
        })?;

    info!(path = %image_path.display(), "cached image");

    Ok(image_path)
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
