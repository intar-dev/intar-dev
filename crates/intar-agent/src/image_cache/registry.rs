use super::*;

pub(super) async fn list_registry_images(
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    client: &reqwest::Client,
) -> Result<Vec<RegistryImageRecord>> {
    let index_url = registry_base_url(registry)?;
    let display_url = redact_url_userinfo(index_url.as_str());
    let response = apply_registry_auth(
        client.get(index_url.clone()),
        &index_url,
        registry,
        bridge,
        client,
    )
    .await?
    .send()
    .await
    .with_context(|| format!("GET {display_url}"))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("registry listing failed with HTTP {status}");
    }

    let index = response
        .json::<RegistryIndex>()
        .await
        .with_context(|| format!("reading registry JSON index from {display_url}"))?;
    Ok(registry_images_from_index(index))
}

pub(super) fn registry_images_from_index(index: RegistryIndex) -> Vec<RegistryImageRecord> {
    index
        .images
        .into_iter()
        .filter_map(|image| {
            if !is_safe_component(&image.image_key) {
                return None;
            }
            let image_id = normalize_sha256(image.image_id.as_deref()?)?;
            let chunk_manifest_sha256 = normalize_sha256(image.chunk_manifest_sha256.as_deref()?)?;
            if image.image_format != "raw_chunks_v1"
                || image.image_virtual_size_bytes == 0
                || image.guest_bootstrap_abi != Some(1)
            {
                return None;
            }
            let kernel_sha256 = normalize_sha256(&image.boot.kernel_sha256)?;
            let initrd_sha256 = normalize_sha256(&image.boot.initrd_sha256)?;
            if image.boot.cmdline.trim().is_empty() {
                return None;
            }
            let manifest_download_url = image.manifest_download_url?;
            let chunk_download_base_url = image.chunk_download_base_url?;
            if manifest_download_url.trim().is_empty() || chunk_download_base_url.trim().is_empty()
            {
                return None;
            }
            Some(RegistryImageRecord {
                #[cfg(test)]
                image_filename: format!("{}.chunks.json", image.image_key),
                image_key: image.image_key,
                #[cfg(test)]
                image_sha256: image_id.clone(),
                image_id,
                image_virtual_size_bytes: image.image_virtual_size_bytes,
                chunk_manifest_sha256,
                guest_bootstrap_abi: 1,
                boot: RegistryImageBoot {
                    kernel_sha256,
                    initrd_sha256,
                    cmdline: image.boot.cmdline,
                },
                #[cfg(test)]
                download_url: manifest_download_url.clone(),
                manifest_download_url,
                chunk_download_base_url,
            })
        })
        .collect()
}

#[cfg(test)]
pub(super) async fn resolve_registry_image(
    image_key: &str,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    client: &reqwest::Client,
) -> Result<RegistryImageRecord> {
    if !is_safe_component(image_key) {
        anyhow::bail!("invalid image key {image_key:?}");
    }

    list_registry_images(registry, bridge, client)
        .await?
        .into_iter()
        .find(|image| image.image_key == image_key)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "image key {image_key:?} is not advertised by registry {}",
                redact_url_userinfo(&registry.url)
            )
        })
}

#[cfg(test)]
pub(super) async fn cache_sha_sidecar(body: &str, dir: &Path, filename: &str) -> Result<()> {
    let (tmp_path, mut tmp_file) = create_tmp_file(dir, filename).await?;
    tmp_file
        .write_all(body.as_bytes())
        .await
        .context("writing sha256 sidecar to temp file")?;
    tmp_file
        .flush()
        .await
        .context("flushing sha256 temp file")?;
    drop(tmp_file);

    let final_path = dir.join(filename);
    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .with_context(|| {
            format!(
                "failed to move cached sha256 sidecar into place at {}",
                final_path.display()
            )
        })?;
    Ok(())
}

#[cfg(test)]
pub(super) fn cached_image_path(cache_root: &Path, image: &RegistryImageRecord) -> PathBuf {
    cache_root
        .join(&image.image_key)
        .join(&image.image_filename)
}

#[cfg(test)]
pub(super) fn cached_raw_image_path(cache_root: &Path, image: &RegistryImageRecord) -> PathBuf {
    cached_raw_image_path_for_key(cache_root, &image.image_key, &image.image_sha256)
}

#[cfg(test)]
pub(super) fn cached_raw_image_path_for_key(
    cache_root: &Path,
    image_key: &str,
    image_sha256: &str,
) -> PathBuf {
    cache_root
        .join(image_key)
        .join(format!("{image_sha256}.raw"))
}

#[cfg(test)]
pub(super) fn raw_cache_marker_path(cache_root: &Path, image: &RegistryImageRecord) -> PathBuf {
    raw_cache_marker_path_for_key(cache_root, &image.image_key, &image.image_sha256)
}

#[cfg(test)]
pub(super) fn raw_cache_marker_path_for_key(
    cache_root: &Path,
    image_key: &str,
    image_sha256: &str,
) -> PathBuf {
    cache_root
        .join(image_key)
        .join(format!("{image_sha256}.raw.verified.json"))
}

#[cfg(test)]
pub(super) fn launch_descriptor_path_for_key(cache_root: &Path, image_key: &str) -> PathBuf {
    cache_root.join(image_key).join(LAUNCH_DESCRIPTOR_FILENAME)
}

#[cfg(test)]
pub(super) fn launch_descriptor_path_for_raw(raw_path: &Path) -> Result<PathBuf> {
    let parent = raw_path.parent().context("cached raw image parent")?;
    Ok(parent.join(LAUNCH_DESCRIPTOR_FILENAME))
}

#[cfg(test)]
pub(super) fn raw_cache_marker_matches(
    marker: &RawCacheMarker,
    image: &RegistryImageRecord,
    actual_size_bytes: u64,
) -> bool {
    marker.schema_version == RAW_CACHE_MARKER_VERSION
        && marker.image_key == image.image_key
        && marker.image_sha256 == image.image_sha256
        && marker.image_virtual_size_bytes == image.image_virtual_size_bytes
        && marker.image_virtual_size_bytes == actual_size_bytes
        && normalize_sha256(&marker.raw_sha256).as_deref() == Some(marker.raw_sha256.as_str())
        && marker.kernel_sha256 == image.boot.kernel_sha256
        && marker.initrd_sha256 == image.boot.initrd_sha256
        && marker.cmdline == image.boot.cmdline
}

#[cfg(test)]
pub(super) async fn read_raw_cache_marker(path: &Path) -> std::io::Result<RawCacheMarker> {
    let bytes = tokio::fs::read(path).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
pub(super) fn read_raw_cache_marker_sync(path: &Path) -> std::io::Result<RawCacheMarker> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
pub(super) async fn write_raw_cache_marker(
    cache_root: &Path,
    image: &RegistryImageRecord,
    raw_sha256: &str,
) -> Result<()> {
    let image_dir = cache_root.join(&image.image_key);
    let marker_path = raw_cache_marker_path(cache_root, image);
    let marker = RawCacheMarker {
        schema_version: RAW_CACHE_MARKER_VERSION,
        image_key: image.image_key.clone(),
        image_sha256: image.image_sha256.clone(),
        image_virtual_size_bytes: image.image_virtual_size_bytes,
        raw_sha256: raw_sha256.to_owned(),
        kernel_sha256: image.boot.kernel_sha256.clone(),
        initrd_sha256: image.boot.initrd_sha256.clone(),
        cmdline: image.boot.cmdline.clone(),
    };
    let body = serde_json::to_vec(&marker).context("serializing raw cache marker")?;
    let (tmp_path, mut tmp_file) = create_tmp_file(
        &image_dir,
        &format!("{}.raw.verified.json", image.image_sha256),
    )
    .await?;
    tmp_file
        .write_all(&body)
        .await
        .context("writing raw cache marker temp file")?;
    tmp_file
        .flush()
        .await
        .context("flushing raw cache marker temp file")?;
    drop(tmp_file);
    tokio::fs::rename(&tmp_path, &marker_path)
        .await
        .with_context(|| {
            format!(
                "failed to move raw cache marker into place at {}",
                marker_path.display()
            )
        })?;
    Ok(())
}

#[cfg(test)]
pub(super) async fn remove_raw_cache_entry(raw_path: &Path, marker_path: &Path) -> Result<()> {
    match tokio::fs::remove_file(raw_path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("failed to remove {}", raw_path.display()));
        }
    }
    match tokio::fs::remove_file(marker_path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to remove {}", marker_path.display()));
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) async fn remove_launch_descriptor_if_matching(
    cache_root: &Path,
    image_key: &str,
    image_sha256: &str,
) -> Result<()> {
    let path = launch_descriptor_path_for_key(cache_root, image_key);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read launch descriptor {}", path.display()));
        }
    };
    let remove = serde_json::from_slice::<LaunchDescriptorV1>(&bytes)
        .map(|descriptor| descriptor.image_sha256 == image_sha256)
        // A malformed descriptor cannot make any image Ready and is safe to
        // discard while the background cache worker already owns this key.
        .unwrap_or(true);
    if remove {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to remove launch descriptor {}", path.display())
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn sha_filename(image: &RegistryImageRecord) -> String {
    format!("{}.sha256", image.image_filename)
}

pub(super) fn decompress_raw_zstd_sparse(
    compressed_path: &Path,
    raw_path: &Path,
    virtual_size_bytes: u64,
) -> Result<String> {
    let input = std::fs::File::open(compressed_path)
        .with_context(|| format!("failed to open {}", compressed_path.display()))?;
    let mut decoder = zstd::stream::read::Decoder::new(input)
        .with_context(|| format!("failed to open zstd stream {}", compressed_path.display()))?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(raw_path)
        .with_context(|| format!("failed to open {}", raw_path.display()))?;

    let mut written = 0u64;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = decoder
            .read(&mut buffer)
            .with_context(|| format!("failed to decompress {}", compressed_path.display()))?;
        if read == 0 {
            break;
        }
        written = written
            .checked_add(read as u64)
            .ok_or_else(|| anyhow::anyhow!("decompressed image size overflow"))?;
        if written > virtual_size_bytes {
            anyhow::bail!(
                "decompressed image {} exceeds advertised virtual size: {} > {}",
                compressed_path.display(),
                written,
                virtual_size_bytes
            );
        }
        hasher.update(&buffer[..read]);
        if buffer[..read].iter().all(|byte| *byte == 0) {
            output
                .seek(SeekFrom::Current(read as i64))
                .with_context(|| format!("failed to seek {}", raw_path.display()))?;
        } else {
            output
                .write_all(&buffer[..read])
                .with_context(|| format!("failed to write {}", raw_path.display()))?;
        }
    }

    if written != virtual_size_bytes {
        anyhow::bail!(
            "decompressed image {} size does not match advertised virtual size: {} != {}",
            compressed_path.display(),
            written,
            virtual_size_bytes
        );
    }
    output
        .set_len(virtual_size_bytes)
        .with_context(|| format!("failed to set length for {}", raw_path.display()))?;
    output
        .sync_all()
        .with_context(|| format!("failed to sync {}", raw_path.display()))?;
    Ok(to_hex_lower(&hasher.finalize()))
}

pub(super) fn registry_base_url(registry: &ImageRegistryConfig) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(registry.url.trim())
        .with_context(|| "image registry URL is invalid")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        anyhow::bail!("image registry URL must be an absolute HTTP(S) URL");
    }
    Ok(url)
}

pub(super) fn same_origin(left: &reqwest::Url, right: &reqwest::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

pub(super) fn ensure_registry_origin(
    registry: &ImageRegistryConfig,
    candidate: &reqwest::Url,
) -> Result<()> {
    let base = registry_base_url(registry)?;
    if !same_origin(&base, candidate) {
        anyhow::bail!(
            "registry resource URL origin {} does not match configured registry origin {}",
            candidate.origin().ascii_serialization(),
            base.origin().ascii_serialization()
        );
    }
    Ok(())
}

pub(super) fn build_registry_url(
    registry: &ImageRegistryConfig,
    path_or_url: &str,
) -> Result<reqwest::Url> {
    let base = registry_base_url(registry)?;
    let mut join_base = base.clone();
    join_base.set_query(None);
    join_base.set_fragment(None);
    if !path_or_url.starts_with('/') && !join_base.path().ends_with('/') {
        let path = format!("{}/", join_base.path());
        join_base.set_path(&path);
    }
    let candidate = join_base
        .join(path_or_url)
        .with_context(|| "registry resource URL is invalid")?;
    ensure_registry_origin(registry, &candidate)?;
    Ok(candidate)
}

pub(super) async fn apply_registry_auth(
    builder: reqwest::RequestBuilder,
    request_url: &reqwest::Url,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    client: &reqwest::Client,
) -> Result<reqwest::RequestBuilder> {
    ensure_registry_origin(registry, request_url)?;

    if let Some(username) = registry.username.as_deref() {
        return Ok(builder.basic_auth(username, registry.password.clone()));
    }

    let Some(bridge) = bridge.filter(|bridge| bridge.enabled) else {
        return Ok(builder);
    };

    let token = registry_access_token(bridge, client).await?;
    Ok(builder.bearer_auth(token))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentBootstrapRequest<'a> {
    host_id: &'a str,
    bootstrap_token: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentBootstrapResponse {
    access_token: String,
}

pub(super) async fn bootstrap_agent_access(
    bridge: &BridgeConfig,
    client: &reqwest::Client,
) -> Result<String> {
    if bridge.base_url.trim().is_empty()
        || bridge.host_id.trim().is_empty()
        || bridge.bootstrap_token.trim().is_empty()
    {
        anyhow::bail!("bridge bootstrap config is required for registry bearer auth");
    }

    let url = format!(
        "{}/api/agent/bootstrap",
        bridge.base_url.trim_end_matches('/')
    );
    let display_url = redact_url_userinfo(&url);
    let response = client
        .post(&url)
        .json(&AgentBootstrapRequest {
            host_id: &bridge.host_id,
            bootstrap_token: &bridge.bootstrap_token,
        })
        .send()
        .await
        .with_context(|| format!("POST {display_url}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("agent bootstrap failed with HTTP {status}: {body}");
    }

    let body = response
        .json::<AgentBootstrapResponse>()
        .await
        .context("failed to parse agent bootstrap response")?;
    Ok(body.access_token)
}

pub(super) fn is_safe_component(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
}

pub(super) async fn create_tmp_file(
    dir: &Path,
    filename: &str,
) -> Result<(PathBuf, tokio::fs::File)> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();

    let mut attempts = 0u8;
    loop {
        attempts = attempts.saturating_add(1);
        let candidate = dir.join(format!(".{filename}.part.{pid}.{nanos}.{attempts}"));
        let open_result = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await;
        match open_result {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if attempts < 8 && e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(anyhow::anyhow!(
                    "failed to create temp file in {}: {e}",
                    dir.display()
                ));
            }
        }
    }
}

pub(super) struct DownloadResult {
    pub(super) bytes: u64,
    pub(super) sha256: String,
    #[cfg(test)]
    pub(super) source_url: String,
}

pub(super) async fn download_to_file(
    client: &reqwest::Client,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    image_url_or_path: &str,
    file: &mut tokio::fs::File,
) -> Result<DownloadResult> {
    let _download_permit = cache_downloads()
        .acquire()
        .await
        .context("image cache download semaphore closed")?;
    let url = build_registry_url(registry, image_url_or_path)?;
    let display_url = redact_url_userinfo(url.as_str());
    let response = apply_registry_auth(client.get(url.clone()), &url, registry, bridge, client)
        .await?
        .send()
        .await
        .with_context(|| format!("GET {display_url}"))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("download failed from {display_url} with HTTP {status}");
    }

    let mut bytes: u64 = 0;
    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("reading response body from {display_url}"))?;
        bytes = bytes.saturating_add(chunk.len() as u64);
        file.write_all(&chunk)
            .await
            .with_context(|| "writing image to temp file")?;
        hasher.update(&chunk);
    }
    file.flush().await.context("flushing temp file")?;

    Ok(DownloadResult {
        bytes,
        sha256: to_hex_lower(&hasher.finalize()),
        #[cfg(test)]
        source_url: url.to_string(),
    })
}

pub(super) async fn sha256_file(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("failed to open file for hashing at {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .await
            .with_context(|| format!("failed reading file for hashing at {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(to_hex_lower(&hasher.finalize()))
}

pub(super) fn to_hex_lower(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0f));
    }
    out
}

pub(super) fn nibble_to_hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => '0',
    }
}
