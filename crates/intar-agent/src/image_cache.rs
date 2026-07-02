#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use futures_util::StreamExt as _;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Semaphore;
use tracing::{debug, error, info, warn};

use crate::config::{BridgeConfig, ImageRegistryConfig, normalize_sha256, redact_url_userinfo};
use crate::vm::qemu_img;

const MAX_CONCURRENT_DOWNLOADS: usize = 2;
#[derive(Debug, Clone)]
struct RegistryImageRecord {
    image_key: String,
    image_filename: String,
    image_sha256: String,
    download_url: String,
}

#[derive(Debug, Deserialize)]
struct RegistryIndex {
    images: Vec<RegistryIndexImage>,
}

#[derive(Debug, Deserialize)]
struct RegistryIndexImage {
    image_key: String,
    image_sha256: String,
    download_url: String,
}

pub fn spawn_warm_cache_with_bridge(
    registry: ImageRegistryConfig,
    bridge: BridgeConfig,
    qemu_img: String,
) {
    tokio::spawn(async move {
        let cache_root = match default_cache_root() {
            Ok(path) => path,
            Err(e) => {
                error!("failed to determine image cache dir: {e}");
                return;
            }
        };

        let client = reqwest::Client::new();
        info!(
            cache_root = %cache_root.display(),
            poll_interval_minutes = registry.refresh_interval_minutes,
            registry = %redact_url_userinfo(&registry.url),
            "starting image registry cache worker"
        );

        run_cache_refresh_cycle(&registry, Some(&bridge), &cache_root, &client, &qemu_img).await;

        let mut interval = tokio::time::interval(Duration::from_secs(
            registry.refresh_interval_minutes.saturating_mul(60),
        ));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            interval.tick().await;
            run_cache_refresh_cycle(&registry, Some(&bridge), &cache_root, &client, &qemu_img)
                .await;
        }
    });
}

pub fn spawn_log_cache_state_with_bridge(registry: ImageRegistryConfig, bridge: BridgeConfig) {
    tokio::spawn(async move {
        let cache_root = match default_cache_root() {
            Ok(path) => path,
            Err(e) => {
                error!("failed to determine image cache dir: {e}");
                return;
            }
        };

        let client = reqwest::Client::new();
        let images = match list_registry_images(&registry, Some(&bridge), &client).await {
            Ok(images) => images,
            Err(e) => {
                error!(
                    registry = %redact_url_userinfo(&registry.url),
                    "failed to list image registry for cache state: {e}"
                );
                return;
            }
        };

        let mut present: usize = 0;
        let mut missing: usize = 0;
        let mut unknown: usize = 0;

        for image in images {
            let path = cached_raw_image_path(&cache_root, &image);
            match tokio::fs::metadata(&path).await {
                Ok(meta) => {
                    present = present.saturating_add(1);
                    info!(
                        image = %image.image_key,
                        path = %path.display(),
                        bytes = meta.len(),
                        "cache present"
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    missing = missing.saturating_add(1);
                    info!(image = %image.image_key, path = %path.display(), "cache missing");
                }
                Err(e) => {
                    unknown = unknown.saturating_add(1);
                    warn!(
                        image = %image.image_key,
                        path = %path.display(),
                        "failed to stat cache file: {e}"
                    );
                }
            }
        }

        info!(
            cache_root = %cache_root.display(),
            present,
            missing,
            unknown,
            registry = %redact_url_userinfo(&registry.url),
            "image cache state"
        );
    });
}

pub fn default_cache_root() -> Result<PathBuf> {
    let base = dirs::cache_dir().ok_or_else(|| anyhow::anyhow!("cache dir unavailable"))?;
    Ok(base.join("intar-agent").join("images"))
}

async fn run_cache_refresh_cycle(
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
    qemu_img: &str,
) {
    let images = match list_registry_images(registry, bridge, client).await {
        Ok(images) => images,
        Err(e) => {
            error!(
                registry = %redact_url_userinfo(&registry.url),
                "failed to list image registry: {e}"
            );
            return;
        }
    };

    if images.is_empty() {
        warn!(
            registry = %redact_url_userinfo(&registry.url),
            "image registry did not advertise any qcow2 images"
        );
        return;
    }

    info!(
        cache_root = %cache_root.display(),
        image_count = images.len(),
        registry = %redact_url_userinfo(&registry.url),
        "refreshing image cache from registry"
    );

    let sem = Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS));
    let mut handles = Vec::with_capacity(images.len());
    for image in images {
        let client = client.clone();
        let cache_root = cache_root.to_path_buf();
        let registry = registry.clone();
        let bridge = bridge.cloned();
        let qemu_img = qemu_img.to_string();
        let sem = Arc::clone(&sem);
        handles.push(tokio::spawn(async move {
            let span = tracing::info_span!(
                "image_cache",
                image = %image.image_key,
                registry = %redact_url_userinfo(&registry.url),
            );
            let _guard = span.enter();

            let _permit = match sem.acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => return,
            };

            match ensure_cached_raw_entry(
                &image,
                &registry,
                bridge.as_ref(),
                &cache_root,
                &client,
                &qemu_img,
            )
            .await
            {
                Ok(path) => info!(path = %path.display(), "cache ready"),
                Err(e) => error!("failed to cache image: {e}"),
            }
        }));
    }

    for handle in handles {
        let _ = handle.await;
    }

    info!("image cache refresh finished");
}

#[cfg(test)]
pub async fn ensure_cached(
    image_key: &str,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    let image = resolve_registry_image(image_key, registry, bridge, client).await?;
    ensure_cached_entry(&image, registry, bridge, cache_root, client).await
}

pub async fn ensure_cached_raw(
    image_key: &str,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
    qemu_img: &str,
) -> Result<PathBuf> {
    let image = resolve_registry_image(image_key, registry, bridge, client).await?;
    ensure_cached_raw_entry(&image, registry, bridge, cache_root, client, qemu_img).await
}

async fn ensure_cached_raw_entry(
    image: &RegistryImageRecord,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
    qemu_img: &str,
) -> Result<PathBuf> {
    let qcow2_path = ensure_cached_entry(image, registry, bridge, cache_root, client).await?;
    let raw_path = cached_raw_image_path(cache_root, image);
    if tokio::fs::metadata(&raw_path).await.is_ok() {
        info!(path = %raw_path.display(), "raw image cache hit");
        return Ok(raw_path);
    }

    let image_dir = cache_root.join(&image.image_key);
    let (tmp_path, tmp_file) =
        create_tmp_file(&image_dir, &format!("{}.raw", image.image_sha256)).await?;
    drop(tmp_file);

    let base_format = qemu_img::detect_format(qemu_img, &qcow2_path)
        .await
        .with_context(|| {
            format!(
                "failed to detect cached image format at {}",
                qcow2_path.display()
            )
        })?;
    qemu_img::convert_to_raw(qemu_img, &qcow2_path, &base_format, &tmp_path)
        .await
        .with_context(|| format!("failed to convert cached image {} to raw", image.image_key))?;

    if tokio::fs::metadata(&raw_path).await.is_ok() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Ok(raw_path);
    }
    tokio::fs::rename(&tmp_path, &raw_path)
        .await
        .with_context(|| {
            format!(
                "failed to move raw image into place at {}",
                raw_path.display()
            )
        })?;
    info!(path = %raw_path.display(), "raw image cache ready");
    Ok(raw_path)
}

async fn ensure_cached_entry(
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
        &format!("{expected_sha256}  {}.qcow2\n", image.image_key),
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

    let image_url = build_registry_url(registry, &image.download_url);
    let (tmp_path, mut tmp_file) = create_tmp_file(&image_dir, &image.image_filename).await?;
    info!(tmp_path = %tmp_path.display(), url = %redact_url_userinfo(&image_url), "download start");

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

async fn list_registry_images(
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    client: &reqwest::Client,
) -> Result<Vec<RegistryImageRecord>> {
    let index_url = registry.url.clone();
    let display_url = redact_url_userinfo(&index_url);
    let response = apply_registry_auth(client.get(&index_url), registry, bridge, client)
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

fn registry_images_from_index(index: RegistryIndex) -> Vec<RegistryImageRecord> {
    index
        .images
        .into_iter()
        .filter_map(|image| {
            if !is_safe_component(&image.image_key) {
                return None;
            }
            let image_sha256 = normalize_sha256(&image.image_sha256)?;
            if image.download_url.trim().is_empty() {
                return None;
            }
            Some(RegistryImageRecord {
                image_filename: format!("{}.qcow2", image.image_key),
                image_key: image.image_key,
                image_sha256,
                download_url: image.download_url,
            })
        })
        .collect()
}

async fn resolve_registry_image(
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

async fn cache_sha_sidecar(body: &str, dir: &Path, filename: &str) -> Result<()> {
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

fn cached_image_path(cache_root: &Path, image: &RegistryImageRecord) -> PathBuf {
    cache_root
        .join(&image.image_key)
        .join(&image.image_filename)
}

fn cached_raw_image_path(cache_root: &Path, image: &RegistryImageRecord) -> PathBuf {
    cache_root
        .join(&image.image_key)
        .join(format!("{}.raw", image.image_sha256))
}

fn sha_filename(image: &RegistryImageRecord) -> String {
    format!("{}.sha256", image.image_filename)
}

fn build_registry_url(registry: &ImageRegistryConfig, path_or_url: &str) -> String {
    if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
        return path_or_url.to_owned();
    }

    if path_or_url.starts_with('/')
        && let Ok(base) = reqwest::Url::parse(&registry.url)
    {
        let origin = base.origin().ascii_serialization();
        return format!("{}{}", origin.trim_end_matches('/'), path_or_url);
    }

    format!(
        "{}/{}",
        registry.url.trim_end_matches('/'),
        path_or_url.trim_start_matches('/')
    )
}

async fn apply_registry_auth(
    builder: reqwest::RequestBuilder,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    client: &reqwest::Client,
) -> Result<reqwest::RequestBuilder> {
    if let Some(username) = registry.username.as_deref() {
        return Ok(builder.basic_auth(username, registry.password.clone()));
    }

    let Some(bridge) = bridge.filter(|bridge| bridge.enabled) else {
        return Ok(builder);
    };

    let token = bootstrap_agent_access(bridge, client).await?;
    Ok(builder.bearer_auth(token))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentBootstrapRequest<'a> {
    host_id: &'a str,
    bootstrap_token: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentBootstrapResponse {
    access_token: String,
}

async fn bootstrap_agent_access(bridge: &BridgeConfig, client: &reqwest::Client) -> Result<String> {
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

fn is_safe_component(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
}

async fn create_tmp_file(dir: &Path, filename: &str) -> Result<(PathBuf, tokio::fs::File)> {
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

struct DownloadResult {
    bytes: u64,
    sha256: String,
    source_url: String,
}

async fn download_to_file(
    client: &reqwest::Client,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    image_url_or_path: &str,
    file: &mut tokio::fs::File,
) -> Result<DownloadResult> {
    let url = build_registry_url(registry, image_url_or_path);
    let display_url = redact_url_userinfo(&url);
    let response = apply_registry_auth(client.get(&url), registry, bridge, client)
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
        source_url: url,
    })
}

async fn sha256_file(path: &Path) -> Result<String> {
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

fn to_hex_lower(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0f));
    }
    out
}

fn nibble_to_hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => '0',
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::tls_provider::ensure_ring_provider;

    use super::*;

    fn sha256_bytes(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        to_hex_lower(&hasher.finalize())
    }

    fn registry_config(addr: std::net::SocketAddr) -> ImageRegistryConfig {
        ImageRegistryConfig {
            url: format!("http://{addr}/images"),
            username: None,
            password: None,
            refresh_interval_minutes: 15,
        }
    }

    fn registry_index(entries: &[(&str, &str, &str)]) -> Vec<u8> {
        let images = entries
            .iter()
            .map(|(image_key, image_sha256, download_url)| {
                format!(
                    r#"{{"image_key":"{image_key}","image_sha256":"{image_sha256}","download_url":"{download_url}"}}"#
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(r#"{{"images":[{images}]}}"#).into_bytes()
    }

    #[tokio::test]
    async fn ensure_cached_downloads_and_reuses_cache() -> Result<()> {
        let body = b"hello-image";
        let expected = sha256_bytes(body);

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let list_requests = Arc::new(AtomicUsize::new(0));
        let image_requests = Arc::new(AtomicUsize::new(0));
        let list_requests_bg = Arc::clone(&list_requests);
        let image_requests_bg = Arc::clone(&image_requests);
        let body_vec = body.to_vec();
        let index = registry_index(&[("ubuntu", &expected, "/agent/registry/images/ubuntu/sha")]);

        std::thread::spawn(move || {
            for stream in listener.incoming().take(8) {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let mut buf = [0u8; 4096];
                let read = match stream.read(&mut buf) {
                    Ok(read) => read,
                    Err(_) => continue,
                };
                let request = String::from_utf8_lossy(&buf[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");

                let (status, response_body) = match path {
                    "/images" => {
                        list_requests_bg.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", index.clone())
                    }
                    "/agent/registry/images/ubuntu/sha" => {
                        image_requests_bg.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", body_vec.clone())
                    }
                    _ => ("404 Not Found", Vec::new()),
                };

                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&response_body);
            }
        });

        let cache_root = tempfile::tempdir()?;
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        let path_1 = ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await?;
        let path_2 = ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await?;

        assert_eq!(path_1, path_2);
        assert!(path_1.is_file());
        assert_eq!(list_requests.load(Ordering::SeqCst), 2);
        assert_eq!(image_requests.load(Ordering::SeqCst), 1);
        assert!(
            cache_root
                .path()
                .join("ubuntu")
                .join("ubuntu.qcow2.sha256")
                .is_file()
        );

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_raw_reuses_preconverted_raw_without_qemu() -> Result<()> {
        let body = b"hello-image";
        let expected = sha256_bytes(body);

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let body_vec = body.to_vec();
        let index = registry_index(&[("ubuntu", &expected, "/agent/registry/images/ubuntu/sha")]);

        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let mut buf = [0u8; 4096];
                let read = match stream.read(&mut buf) {
                    Ok(read) => read,
                    Err(_) => continue,
                };
                let request = String::from_utf8_lossy(&buf[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");

                let (status, response_body) = match path {
                    "/images" => ("200 OK", index.clone()),
                    "/agent/registry/images/ubuntu/sha" => ("200 OK", body_vec.clone()),
                    _ => ("404 Not Found", Vec::new()),
                };

                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&response_body);
            }
        });

        let cache_root = tempfile::tempdir()?;
        let raw_dir = cache_root.path().join("ubuntu");
        tokio::fs::create_dir_all(&raw_dir).await?;
        let raw_path = raw_dir.join(format!("{expected}.raw"));
        tokio::fs::write(&raw_path, b"preconverted raw").await?;
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        let path = ensure_cached_raw(
            "ubuntu",
            &registry,
            None,
            cache_root.path(),
            &client,
            "/definitely/missing/qemu-img",
        )
        .await?;

        assert_eq!(path, raw_path);
        assert_eq!(tokio::fs::read(&path).await?, b"preconverted raw");
        assert!(
            cache_root
                .path()
                .join("ubuntu")
                .join("ubuntu.qcow2")
                .is_file()
        );

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_rejects_sha_mismatch() -> Result<()> {
        let body = b"hello-image";
        let wrong = sha256_bytes(b"wrong");

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let body_vec = body.to_vec();
        let index = registry_index(&[("ubuntu", &wrong, "/agent/registry/images/ubuntu/wrong")]);

        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let mut buf = [0u8; 4096];
                let read = match stream.read(&mut buf) {
                    Ok(read) => read,
                    Err(_) => continue,
                };
                let request = String::from_utf8_lossy(&buf[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");

                let (status, response_body) = match path {
                    "/images" => ("200 OK", index.clone()),
                    "/agent/registry/images/ubuntu/wrong" => ("200 OK", body_vec.clone()),
                    _ => ("404 Not Found", Vec::new()),
                };

                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&response_body);
            }
        });

        let cache_root = tempfile::tempdir()?;
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        match ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await {
            Ok(path) => anyhow::bail!("expected sha mismatch to fail, cached {}", path.display()),
            Err(error) => {
                let msg = error.to_string();
                assert!(msg.contains("sha256 mismatch"), "unexpected error: {msg}");
            }
        }
        assert!(
            !cache_root
                .path()
                .join("ubuntu")
                .join("ubuntu.qcow2")
                .exists(),
            "mismatched image must not be installed in cache"
        );

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_rejects_missing_registry_sha256() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let index =
            br#"{"images":[{"image_key":"ubuntu","image_sha256":"","download_url":"/image"}]}"#
                .to_vec();

        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let mut buf = [0u8; 4096];
                let read = match stream.read(&mut buf) {
                    Ok(read) => read,
                    Err(_) => continue,
                };
                let request = String::from_utf8_lossy(&buf[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");

                let (status, response_body) = match path {
                    "/images" => ("200 OK", index.clone()),
                    _ => ("404 Not Found", Vec::new()),
                };

                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&response_body);
            }
        });

        let cache_root = tempfile::tempdir()?;
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        match ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await {
            Ok(path) => anyhow::bail!(
                "expected missing registry sha256 to fail, cached {}",
                path.display()
            ),
            Err(error) => {
                let msg = error.to_string();
                assert!(
                    msg.contains("is not advertised by registry"),
                    "unexpected error: {msg}"
                );
            }
        }
        assert!(
            !cache_root
                .path()
                .join("ubuntu")
                .join("ubuntu.qcow2")
                .exists(),
            "unverified image must not be installed in cache"
        );

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_uses_basic_auth_when_configured() -> Result<()> {
        let body = b"hello-image";
        let expected = sha256_bytes(body);
        let authorization = "Basic ZGVtbzpzZWNyZXQ=".to_string();

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let body_vec = body.to_vec();
        let index = registry_index(&[("ubuntu", &expected, "/agent/registry/images/ubuntu/sha")]);

        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let mut buf = [0u8; 4096];
                let read = match stream.read(&mut buf) {
                    Ok(read) => read,
                    Err(_) => continue,
                };
                let request = String::from_utf8_lossy(&buf[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let has_auth = request.lines().any(|line| {
                    line.eq_ignore_ascii_case(&format!("authorization: {authorization}"))
                });

                let (status, response_body) = if !has_auth {
                    ("401 Unauthorized", Vec::new())
                } else {
                    match path {
                        "/images" => ("200 OK", index.clone()),
                        "/agent/registry/images/ubuntu/sha" => ("200 OK", body_vec.clone()),
                        _ => ("404 Not Found", Vec::new()),
                    }
                };

                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&response_body);
            }
        });

        let cache_root = tempfile::tempdir()?;
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = ImageRegistryConfig {
            url: format!("http://{addr}/images"),
            username: Some("demo".to_string()),
            password: Some("secret".to_string()),
            refresh_interval_minutes: 15,
        };

        let path = ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await?;
        assert!(path.is_file());

        Ok(())
    }

    #[test]
    fn registry_images_from_index_discards_invalid_records() {
        let sha = "a".repeat(64);
        let images = registry_images_from_index(RegistryIndex {
            images: vec![
                RegistryIndexImage {
                    image_key: "ubuntu".to_string(),
                    image_sha256: sha.clone(),
                    download_url: "/agent/registry/images/ubuntu/sha".to_string(),
                },
                RegistryIndexImage {
                    image_key: "../bad".to_string(),
                    image_sha256: sha.clone(),
                    download_url: "/bad".to_string(),
                },
                RegistryIndexImage {
                    image_key: "missing-sha".to_string(),
                    image_sha256: String::new(),
                    download_url: "/missing".to_string(),
                },
            ],
        });

        assert_eq!(
            images
                .into_iter()
                .map(|image| {
                    (
                        image.image_key,
                        image.image_filename,
                        image.image_sha256,
                        image.download_url,
                    )
                })
                .collect::<Vec<_>>(),
            vec![(
                "ubuntu".to_string(),
                "ubuntu.qcow2".to_string(),
                sha,
                "/agent/registry/images/ubuntu/sha".to_string(),
            )]
        );
    }

    #[tokio::test]
    async fn ensure_cached_rejects_unlisted_image_key() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let sha = "a".repeat(64);
        let index = registry_index(&[(
            "broken-nginx-webserver-amd64",
            &sha,
            "/agent/registry/images/broken-nginx-webserver-amd64/sha",
        )]);

        std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let mut buf = [0u8; 4096];
                let read = match stream.read(&mut buf) {
                    Ok(read) => read,
                    Err(_) => continue,
                };
                let request = String::from_utf8_lossy(&buf[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");

                let (status, response_body) = match path {
                    "/images" => ("200 OK", index.clone()),
                    _ => ("404 Not Found", Vec::new()),
                };

                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&response_body);
            }
        });

        let cache_root = tempfile::tempdir()?;
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        match ensure_cached(
            "broken_nginx_webserver_amd64",
            &registry,
            None,
            cache_root.path(),
            &client,
        )
        .await
        {
            Ok(_) => anyhow::bail!("expected unlisted image key to fail"),
            Err(error) => {
                let msg = error.to_string();
                assert!(
                    msg.contains("is not advertised by registry"),
                    "unexpected error: {msg}"
                );
            }
        }

        Ok(())
    }
}
