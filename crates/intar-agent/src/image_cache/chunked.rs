use super::*;

pub(super) async fn ensure_cached_chunked_image_entry(
    image: &RegistryImageRecord,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<CachedChunkedImage> {
    let lock = cache_entry_lock(cache_root, format!("chunks:{}", image.image_id)).await;
    let _guard = lock.lock().await;
    let manifests = cache_root.join("manifests");
    let chunks = cache_root.join("chunks");
    tokio::fs::create_dir_all(&manifests).await?;
    tokio::fs::create_dir_all(&chunks).await?;
    let manifest_path = manifests.join(format!("{}.json", image.chunk_manifest_sha256));
    ensure_downloaded_file(
        &manifest_path,
        &image.manifest_download_url,
        &image.chunk_manifest_sha256,
        None,
        registry,
        bridge,
        client,
    )
    .await?;
    let manifest: ImageChunkManifestV1 =
        serde_json::from_slice(&tokio::fs::read(&manifest_path).await?)
            .context("decode cached image chunk manifest")?;
    manifest
        .validate()
        .context("validate cached image chunk manifest")?;
    anyhow::ensure!(
        manifest.image_id == image.image_id
            && manifest.virtual_size_bytes == image.image_virtual_size_bytes,
        "cached chunk manifest identity does not match registry index"
    );

    let downloads = futures_util::stream::iter(manifest.chunks.iter().cloned().map(|chunk| {
        let chunks = chunks.clone();
        async move {
            let path = chunks.join(format!("{}.raw.zst", chunk.raw_sha256));
            let url = format!(
                "{}/{}",
                image.chunk_download_base_url.trim_end_matches('/'),
                chunk.raw_sha256
            );
            let lock = cache_entry_lock(cache_root, format!("chunk:{}", chunk.raw_sha256)).await;
            let _guard = lock.lock().await;
            ensure_downloaded_file(
                &path,
                &url,
                &chunk.encoded_sha256,
                Some(chunk.encoded_size_bytes),
                registry,
                bridge,
                client,
            )
            .await
        }
    }))
    .buffer_unordered(16)
    .collect::<Vec<_>>()
    .await;
    for result in downloads {
        result?;
    }

    let (kernel_path, initrd_path) = tokio::try_join!(
        ensure_cached_artifact(
            &image.boot.kernel_sha256,
            registry,
            bridge,
            cache_root,
            client,
        ),
        ensure_cached_artifact(
            &image.boot.initrd_sha256,
            registry,
            bridge,
            cache_root,
            client,
        ),
    )?;

    Ok(CachedChunkedImage {
        image_key: image.image_key.clone(),
        image_id: image.image_id.clone(),
        chunk_manifest_path: manifest_path,
        chunk_manifest_sha256: image.chunk_manifest_sha256.clone(),
        chunk_cache_root: chunks,
        kernel_path,
        initrd_path,
        kernel_sha256: image.boot.kernel_sha256.clone(),
        initrd_sha256: image.boot.initrd_sha256.clone(),
        cmdline: image.boot.cmdline.clone(),
        virtual_size_bytes: image.image_virtual_size_bytes,
        guest_bootstrap_abi: image.guest_bootstrap_abi,
    })
}

async fn ensure_downloaded_file(
    path: &Path,
    url: &str,
    expected_sha256: &str,
    expected_bytes: Option<u64>,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    client: &reqwest::Client,
) -> Result<()> {
    if let Ok(metadata) = tokio::fs::metadata(path).await
        && metadata.is_file()
        && expected_bytes.is_none_or(|bytes| metadata.len() == bytes)
        && matches!(sha256_file(path).await, Ok(actual) if actual == expected_sha256)
    {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let parent = path.parent().context("cached object has no parent")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .context("cached object filename is not UTF-8")?;
    let (temporary, mut output) = create_tmp_file(parent, name).await?;
    let download = download_to_file(client, registry, bridge, url, &mut output).await?;
    output.sync_all().await?;
    drop(output);
    let result = (|| -> Result<()> {
        anyhow::ensure!(
            download.sha256 == expected_sha256,
            "downloaded SHA-256 mismatch"
        );
        if let Some(expected) = expected_bytes {
            anyhow::ensure!(download.bytes == expected, "downloaded size mismatch");
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    tokio::fs::rename(&temporary, path).await?;
    Ok(())
}

pub(crate) async fn mark_template_ready(
    image: &CachedChunkedImage,
    prepared: &PreparedImageV3Result,
) -> Result<()> {
    let cache_root = cache_root_from_chunked_image(image)?;
    let descriptor_path =
        chunked_launch_descriptor_path(cache_root, &image.image_key, &image.image_id);
    let directory = descriptor_path
        .parent()
        .context("launch descriptor parent")?;
    tokio::fs::create_dir_all(directory).await?;
    let descriptor = ChunkedLaunchDescriptorV1 {
        schema_version: 1,
        image_key: image.image_key.clone(),
        image_id: image.image_id.clone(),
        chunk_manifest_path: image.chunk_manifest_path.clone(),
        chunk_manifest_sha256: image.chunk_manifest_sha256.clone(),
        chunk_cache_root: image.chunk_cache_root.clone(),
        image_virtual_size_bytes: image.virtual_size_bytes,
        guest_bootstrap_abi: image.guest_bootstrap_abi,
        kernel_path: image.kernel_path.clone(),
        kernel_sha256: image.kernel_sha256.clone(),
        initrd_path: image.initrd_path.clone(),
        initrd_sha256: image.initrd_sha256.clone(),
        cmdline: image.cmdline.clone(),
        prepared_image: prepared.clone(),
    };
    validate_chunked_launch_descriptor(
        cache_root,
        &image.image_key,
        Some(&image.image_id),
        descriptor.clone(),
    )?;
    let (temporary, mut output) =
        create_tmp_file(directory, &format!("{}.ready.json", image.image_id)).await?;
    output.write_all(&serde_json::to_vec(&descriptor)?).await?;
    output.sync_all().await?;
    drop(output);
    tokio::fs::rename(temporary, descriptor_path).await?;
    Ok(())
}

pub(crate) async fn require_ready_image_launch(
    cache_root: &Path,
    image_key: &str,
    expected_image_id: Option<&str>,
) -> Result<ReadyImageLaunch> {
    anyhow::ensure!(is_safe_component(image_key), "invalid image key");
    let expected = expected_image_id
        .map(|value| normalize_sha256(value).context("invalid expected image id"))
        .transpose()?
        .context("expected image id is required for a chunked launch")?;
    let path = chunked_launch_descriptor_path(cache_root, image_key, &expected);
    let descriptor: ChunkedLaunchDescriptorV1 = serde_json::from_slice(
        &tokio::fs::read(&path)
            .await
            .context("prewarmed chunked launch descriptor is unavailable")?,
    )?;
    validate_chunked_launch_descriptor(cache_root, image_key, Some(&expected), descriptor)
}

pub(crate) fn verified_cached_image_metadata(
    cache_root: &Path,
    image_key: &str,
    image_id: &str,
    require_template: bool,
) -> Option<std::fs::Metadata> {
    let path = chunked_launch_descriptor_path(cache_root, image_key, image_id);
    let descriptor: ChunkedLaunchDescriptorV1 =
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let ready =
        validate_chunked_launch_descriptor(cache_root, image_key, Some(image_id), descriptor)
            .ok()?;
    if require_template && !ready.prepared_image.fast_template_store {
        return None;
    }
    std::fs::metadata(ready.image.chunk_manifest_path).ok()
}

fn validate_chunked_launch_descriptor(
    cache_root: &Path,
    image_key: &str,
    expected_image_id: Option<&str>,
    descriptor: ChunkedLaunchDescriptorV1,
) -> Result<ReadyImageLaunch> {
    anyhow::ensure!(
        descriptor.schema_version == 1,
        "unsupported chunked launch descriptor"
    );
    anyhow::ensure!(
        descriptor.image_key == image_key,
        "chunked launch image key mismatch"
    );
    anyhow::ensure!(
        normalize_sha256(&descriptor.image_id).as_deref() == Some(descriptor.image_id.as_str())
            && normalize_sha256(&descriptor.chunk_manifest_sha256).as_deref()
                == Some(descriptor.chunk_manifest_sha256.as_str())
            && descriptor.guest_bootstrap_abi == 1,
        "chunked launch identity is invalid"
    );
    if let Some(expected) = expected_image_id {
        anyhow::ensure!(
            descriptor.image_id == expected,
            "stale chunked launch descriptor"
        );
    }
    anyhow::ensure!(
        descriptor.chunk_manifest_path
            == cache_root
                .join("manifests")
                .join(format!("{}.json", descriptor.chunk_manifest_sha256))
            && descriptor.chunk_cache_root == cache_root.join("chunks")
            && descriptor.kernel_path
                == cache_root.join("artifacts").join(&descriptor.kernel_sha256)
            && descriptor.initrd_path
                == cache_root.join("artifacts").join(&descriptor.initrd_sha256),
        "chunked launch descriptor contains an unexpected cache path"
    );
    let manifest_bytes = std::fs::read(&descriptor.chunk_manifest_path)?;
    anyhow::ensure!(
        sha256_bytes(&manifest_bytes) == descriptor.chunk_manifest_sha256,
        "cached chunk manifest digest mismatch"
    );
    let manifest: ImageChunkManifestV1 = serde_json::from_slice(&manifest_bytes)?;
    manifest.validate()?;
    anyhow::ensure!(
        manifest.image_id == descriptor.image_id
            && manifest.virtual_size_bytes == descriptor.image_virtual_size_bytes,
        "cached chunk manifest identity mismatch"
    );
    for chunk in &manifest.chunks {
        let path = descriptor
            .chunk_cache_root
            .join(format!("{}.raw.zst", chunk.raw_sha256));
        let metadata = regular_cached_file(&path, "encoded image chunk")?;
        anyhow::ensure!(
            metadata.len() == chunk.encoded_size_bytes,
            "cached chunk size mismatch"
        );
    }
    regular_cached_file(&descriptor.kernel_path, "kernel")?;
    regular_cached_file(&descriptor.initrd_path, "initrd")?;
    validate_prepared_v3_descriptor(&descriptor)?;
    Ok(ReadyImageLaunch {
        image: CachedChunkedImage {
            image_key: descriptor.image_key,
            image_id: descriptor.image_id,
            chunk_manifest_path: descriptor.chunk_manifest_path,
            chunk_manifest_sha256: descriptor.chunk_manifest_sha256,
            chunk_cache_root: descriptor.chunk_cache_root,
            kernel_path: descriptor.kernel_path,
            initrd_path: descriptor.initrd_path,
            kernel_sha256: descriptor.kernel_sha256,
            initrd_sha256: descriptor.initrd_sha256,
            cmdline: descriptor.cmdline,
            virtual_size_bytes: descriptor.image_virtual_size_bytes,
            guest_bootstrap_abi: descriptor.guest_bootstrap_abi,
        },
        prepared_image: descriptor.prepared_image,
    })
}

fn validate_prepared_v3_descriptor(descriptor: &ChunkedLaunchDescriptorV1) -> Result<()> {
    let prepared = &descriptor.prepared_image;
    anyhow::ensure!(
        prepared.image_id.as_str() == descriptor.image_id
            && prepared.chunk_manifest_sha256.as_str() == descriptor.chunk_manifest_sha256
            && prepared.virtual_size_bytes == descriptor.image_virtual_size_bytes
            && prepared.fast_template_store,
        "prepared v3 image identity mismatch"
    );
    validate_prepared_source(
        &prepared.root_disk,
        &descriptor.image_id,
        "root.raw",
        &descriptor.image_id,
        ArtifactAccess::ReadWrite,
    )?;
    validate_prepared_source(
        &prepared.kernel,
        &descriptor.image_id,
        "kernel",
        &descriptor.kernel_sha256,
        ArtifactAccess::ReadOnly,
    )?;
    if let Some(initrd) = &prepared.initrd {
        validate_prepared_source(
            initrd,
            &descriptor.image_id,
            "initrd",
            &descriptor.initrd_sha256,
            ArtifactAccess::ReadOnly,
        )?;
    }
    Ok(())
}

fn chunked_launch_descriptor_path(cache_root: &Path, image_key: &str, image_id: &str) -> PathBuf {
    cache_root
        .join("launch-v3")
        .join(image_key)
        .join(format!("{image_id}.ready.json"))
}

fn cache_root_from_chunked_image(image: &CachedChunkedImage) -> Result<&Path> {
    image
        .chunk_manifest_path
        .parent()
        .and_then(Path::parent)
        .context("cached chunk manifest is not below the cache root")
}

fn sha256_bytes(bytes: &[u8]) -> String {
    to_hex_lower(&Sha256::digest(bytes))
}

pub(crate) async fn touch_cached_image(db: &Db, image: &CachedChunkedImage) -> Result<()> {
    db.touch_image_cache_entry(ImageCacheAccessRow {
        image_key: image.image_key.clone(),
        image_sha256: image.image_id.clone(),
        kernel_sha256: image.kernel_sha256.clone(),
        initrd_sha256: image.initrd_sha256.clone(),
        raw_bytes: 0,
        last_accessed_at_ms: now_unix_ms(),
    })
    .await
}

pub(crate) async fn ensure_cached_tools_disk(
    tools_disk_sha256: &str,
    tools_disk_size_bytes: u64,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    let sha256 = normalize_sha256(tools_disk_sha256).context("invalid tools disk SHA-256")?;
    anyhow::ensure!(
        tools_disk_size_bytes == 64 * 1024 * 1024,
        "tools disk must be exactly 64 MiB"
    );
    let lock = cache_entry_lock(cache_root, format!("tools:{sha256}")).await;
    let _guard = lock.lock().await;
    let directory = cache_root.join("tools");
    tokio::fs::create_dir_all(&directory).await?;
    let raw_path = directory.join(format!("{sha256}.ext4"));
    if let Ok(metadata) = tokio::fs::metadata(&raw_path).await
        && metadata.len() == tools_disk_size_bytes
        && matches!(sha256_file(&raw_path).await, Ok(actual) if actual == sha256)
    {
        return Ok(raw_path);
    }
    let _ = tokio::fs::remove_file(&raw_path).await;
    let compressed_path = directory.join(format!(".{sha256}.ext4.zst"));
    let (temporary, mut output) = create_tmp_file(&directory, "tools.ext4.zst").await?;
    let url = format!("/agent/registry/guest-tools/disks/{sha256}");
    download_to_file(client, registry, bridge, &url, &mut output).await?;
    output.sync_all().await?;
    drop(output);
    tokio::fs::rename(&temporary, &compressed_path).await?;
    let compressed_for_decode = compressed_path.clone();
    let raw_for_decode = raw_path.clone();
    let raw_sha256 = tokio::task::spawn_blocking(move || {
        decompress_raw_zstd_sparse(
            &compressed_for_decode,
            &raw_for_decode,
            tools_disk_size_bytes,
        )
    })
    .await
    .context("tools disk decoder panicked")??;
    let _ = tokio::fs::remove_file(&compressed_path).await;
    if raw_sha256 != sha256 {
        let _ = tokio::fs::remove_file(&raw_path).await;
        anyhow::bail!("tools disk SHA-256 mismatch");
    }
    Ok(raw_path)
}
