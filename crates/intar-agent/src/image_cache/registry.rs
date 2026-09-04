use super::*;

pub(super) async fn list_registry_images(
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    client: &reqwest::Client,
) -> Result<Vec<RegistryImageRecord>> {
    let index_url = registry_base_url(registry)?;
    let display_url = redact_url_userinfo(index_url.as_str());
    let index = tokio::time::timeout(REGISTRY_INDEX_TIMEOUT, async {
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
        response
            .json::<RegistryIndex>()
            .await
            .with_context(|| format!("reading registry JSON index from {display_url}"))
    })
    .await
    .with_context(|| format!("registry index exceeded its deadline at {display_url}"))??;
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
                image_key: image.image_key,
                image_id,
                image_virtual_size_bytes: image.image_virtual_size_bytes,
                chunk_manifest_sha256,
                guest_bootstrap_abi: 1,
                boot: RegistryImageBoot {
                    kernel_sha256,
                    initrd_sha256,
                    cmdline: image.boot.cmdline,
                },
                manifest_download_url,
                chunk_download_base_url,
            })
        })
        .collect()
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
