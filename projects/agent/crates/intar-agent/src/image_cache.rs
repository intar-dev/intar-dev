#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use futures_util::StreamExt as _;
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Semaphore;
use tracing::{debug, error, info, warn};

use crate::config::{ImageRegistryConfig, normalize_sha256, redact_url_userinfo};

const MAX_CONCURRENT_DOWNLOADS: usize = 2;
const IMAGE_SUFFIX: &str = ".qcow2";
const SHA256_SUFFIX: &str = ".qcow2.sha256";

#[derive(Debug, Clone)]
struct RegistryImageRecord {
    image_key: String,
    image_filename: String,
    sha256_filename: Option<String>,
}

pub fn spawn_warm_cache(registry: ImageRegistryConfig) {
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

        run_cache_refresh_cycle(&registry, &cache_root, &client).await;

        let mut interval = tokio::time::interval(Duration::from_secs(
            registry.refresh_interval_minutes.saturating_mul(60),
        ));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            interval.tick().await;
            run_cache_refresh_cycle(&registry, &cache_root, &client).await;
        }
    });
}

pub fn spawn_log_cache_state(registry: ImageRegistryConfig) {
    tokio::spawn(async move {
        let cache_root = match default_cache_root() {
            Ok(path) => path,
            Err(e) => {
                error!("failed to determine image cache dir: {e}");
                return;
            }
        };

        let client = reqwest::Client::new();
        let images = match list_registry_images(&registry, &client).await {
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
            let path = cached_image_path(&cache_root, &image);
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
    cache_root: &Path,
    client: &reqwest::Client,
) {
    let images = match list_registry_images(registry, client).await {
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

            match ensure_cached_entry(&image, &registry, &cache_root, &client).await {
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

pub async fn ensure_cached(
    image_key: &str,
    registry: &ImageRegistryConfig,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    let image = resolve_registry_image(image_key, registry, client).await?;
    ensure_cached_entry(&image, registry, cache_root, client).await
}

async fn ensure_cached_entry(
    image: &RegistryImageRecord,
    registry: &ImageRegistryConfig,
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
    let sha_path = cached_sha_path(cache_root, image);
    let expected_sha256 =
        resolve_expected_sha256(image, registry, &sha_path, &image_dir, client).await;
    let had_existing = tokio::fs::metadata(&image_path).await.is_ok();

    if had_existing {
        match expected_sha256.as_deref() {
            Some(expected) => match sha256_file(&image_path).await {
                Ok(have) if have == expected => {
                    info!(path = %image_path.display(), "cache hit");
                    return Ok(image_path);
                }
                Ok(have) => {
                    warn!(
                        path = %image_path.display(),
                        expected_sha256 = expected,
                        actual_sha256 = %have,
                        "cached image sha256 mismatch; refreshing"
                    );
                }
                Err(e) => {
                    warn!(path = %image_path.display(), "failed to hash cached image: {e}");
                }
            },
            None => {
                info!(
                    path = %image_path.display(),
                    "cache hit without sha256 verification"
                );
                return Ok(image_path);
            }
        }
    }

    let image_url = build_registry_url(registry, &image.image_filename);
    let (tmp_path, mut tmp_file) = create_tmp_file(&image_dir, &image.image_filename).await?;
    info!(tmp_path = %tmp_path.display(), url = %redact_url_userinfo(&image_url), "download start");

    let download_start = std::time::Instant::now();
    let download_result =
        download_to_file(client, registry, &image.image_filename, &mut tmp_file).await;
    drop(tmp_file);

    let download = match download_result {
        Ok(download) => download,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            if had_existing {
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

    if let Some(expected) = expected_sha256.as_deref()
        && download.sha256 != expected
    {
        warn!(
            image = image.image_key,
            expected_sha256 = expected,
            actual_sha256 = %download.sha256,
            "downloaded image sha256 mismatch"
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
    client: &reqwest::Client,
) -> Result<Vec<RegistryImageRecord>> {
    let index_url = format!("{}/", registry.url);
    let display_url = redact_url_userinfo(&index_url);
    let response = apply_basic_auth(client.get(&index_url), registry)
        .send()
        .await
        .with_context(|| format!("GET {display_url}"))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("registry listing failed with HTTP {status}");
    }

    let body = response
        .text()
        .await
        .with_context(|| format!("reading registry listing body from {display_url}"))?;
    Ok(extract_registry_images(&body))
}

fn extract_registry_images(body: &str) -> Vec<RegistryImageRecord> {
    let mut images = BTreeMap::<String, RegistryImageRecord>::new();
    for token in body.split(|ch: char| {
        ch.is_whitespace()
            || matches!(
                ch,
                '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ','
            )
    }) {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let token = token
            .strip_prefix("href=")
            .or_else(|| token.strip_prefix("src="))
            .unwrap_or(token);
        let token = token.split(['?', '#']).next().unwrap_or(token);
        let token = token.rsplit('/').next().unwrap_or(token);
        if let Some(key) = token.strip_suffix(SHA256_SUFFIX) {
            if is_safe_component(key) {
                let entry = images
                    .entry(key.to_string())
                    .or_insert_with(|| RegistryImageRecord {
                        image_key: key.to_string(),
                        image_filename: format!("{key}{IMAGE_SUFFIX}"),
                        sha256_filename: None,
                    });
                entry.sha256_filename = Some(token.to_string());
            }
            continue;
        }
        let Some(key) = token.strip_suffix(IMAGE_SUFFIX) else {
            continue;
        };
        if !is_safe_component(key) {
            continue;
        }
        let entry = images
            .entry(key.to_string())
            .or_insert_with(|| RegistryImageRecord {
                image_key: key.to_string(),
                image_filename: token.to_string(),
                sha256_filename: None,
            });
        entry.image_filename = token.to_string();
    }

    images
        .into_values()
        .filter(|image| !image.image_filename.is_empty())
        .collect()
}

async fn resolve_registry_image(
    image_key: &str,
    registry: &ImageRegistryConfig,
    client: &reqwest::Client,
) -> Result<RegistryImageRecord> {
    if !is_safe_component(image_key) {
        anyhow::bail!("invalid image key {image_key:?}");
    }

    list_registry_images(registry, client)
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

async fn resolve_expected_sha256(
    image: &RegistryImageRecord,
    registry: &ImageRegistryConfig,
    sha_path: &Path,
    image_dir: &Path,
    client: &reqwest::Client,
) -> Option<String> {
    let sha_filename = sha_filename(image);
    match fetch_sha256_sidecar(image, registry, client).await {
        Ok(body) => {
            if let Err(e) = cache_sha_sidecar(&body, image_dir, &sha_filename).await {
                warn!(
                    path = %sha_path.display(),
                    "failed to cache sha256 sidecar: {e}"
                );
            }
            match parse_sha256_sidecar(&body) {
                Some(sha256) => Some(sha256),
                None => {
                    warn!(
                        image = image.image_key,
                        path = %sha_path.display(),
                        "failed to parse registry sha256 sidecar"
                    );
                    None
                }
            }
        }
        Err(e) => {
            warn!(
                image = image.image_key,
                "failed to fetch registry sha256 sidecar: {e}"
            );
            match read_cached_sha256(sha_path).await {
                Ok(sha256) => Some(sha256),
                Err(cache_error) => {
                    warn!(
                        image = image.image_key,
                        path = %sha_path.display(),
                        "failed to read cached sha256 sidecar: {cache_error}"
                    );
                    None
                }
            }
        }
    }
}

async fn fetch_sha256_sidecar(
    image: &RegistryImageRecord,
    registry: &ImageRegistryConfig,
    client: &reqwest::Client,
) -> Result<String> {
    let sha_url = build_registry_url(registry, &sha_filename(image));
    let display_url = redact_url_userinfo(&sha_url);
    let response = apply_basic_auth(client.get(&sha_url), registry)
        .send()
        .await
        .with_context(|| format!("GET {display_url}"))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("sha256 download failed from {display_url} with HTTP {status}");
    }

    response
        .text()
        .await
        .with_context(|| format!("reading sha256 response body from {display_url}"))
}

fn parse_sha256_sidecar(body: &str) -> Option<String> {
    body.split_whitespace().find_map(normalize_sha256)
}

async fn read_cached_sha256(path: &Path) -> Result<String> {
    let body = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("failed to read cached sha256 sidecar at {}", path.display()))?;
    parse_sha256_sidecar(&body).ok_or_else(|| {
        anyhow::anyhow!(
            "cached sha256 sidecar at {} did not contain a valid SHA-256",
            path.display()
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

fn cached_sha_path(cache_root: &Path, image: &RegistryImageRecord) -> PathBuf {
    cache_root.join(&image.image_key).join(sha_filename(image))
}

fn sha_filename(image: &RegistryImageRecord) -> String {
    image
        .sha256_filename
        .clone()
        .unwrap_or_else(|| format!("{}{}", image.image_filename, ".sha256"))
}

fn build_registry_url(registry: &ImageRegistryConfig, filename: &str) -> String {
    format!("{}/{}", registry.url, filename)
}

fn apply_basic_auth(
    builder: reqwest::RequestBuilder,
    registry: &ImageRegistryConfig,
) -> reqwest::RequestBuilder {
    match registry.username.as_deref() {
        Some(username) => builder.basic_auth(username, registry.password.clone()),
        None => builder,
    }
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
    image_filename: &str,
    file: &mut tokio::fs::File,
) -> Result<DownloadResult> {
    let url = build_registry_url(registry, image_filename);
    let display_url = redact_url_userinfo(&url);
    let response = apply_basic_auth(client.get(&url), registry)
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

    fn registry_listing(entries: &[&str]) -> Vec<u8> {
        let body = entries
            .iter()
            .map(|entry| format!("<a href=\"{entry}\">{entry}</a>"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("<html><body>{body}</body></html>").into_bytes()
    }

    #[tokio::test]
    async fn ensure_cached_downloads_and_reuses_cache() -> Result<()> {
        let body = b"hello-image";
        let expected = sha256_bytes(body);

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let list_requests = Arc::new(AtomicUsize::new(0));
        let image_requests = Arc::new(AtomicUsize::new(0));
        let sha_requests = Arc::new(AtomicUsize::new(0));
        let list_requests_bg = Arc::clone(&list_requests);
        let image_requests_bg = Arc::clone(&image_requests);
        let sha_requests_bg = Arc::clone(&sha_requests);
        let body_vec = body.to_vec();
        let sha_body = format!("{expected}  ubuntu.qcow2\n");
        let listing = registry_listing(&["ubuntu.qcow2", "ubuntu.qcow2.sha256"]);

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
                    "/images/" => {
                        list_requests_bg.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", listing.clone())
                    }
                    "/images/ubuntu.qcow2" => {
                        image_requests_bg.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", body_vec.clone())
                    }
                    "/images/ubuntu.qcow2.sha256" => {
                        sha_requests_bg.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", sha_body.clone().into_bytes())
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

        let path_1 = ensure_cached("ubuntu", &registry, cache_root.path(), &client).await?;
        let path_2 = ensure_cached("ubuntu", &registry, cache_root.path(), &client).await?;

        assert_eq!(path_1, path_2);
        assert!(path_1.is_file());
        assert_eq!(list_requests.load(Ordering::SeqCst), 2);
        assert_eq!(image_requests.load(Ordering::SeqCst), 1);
        assert_eq!(sha_requests.load(Ordering::SeqCst), 2);
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
    async fn ensure_cached_warns_but_succeeds_on_sha_mismatch() -> Result<()> {
        let body = b"hello-image";
        let wrong = sha256_bytes(b"wrong");

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let body_vec = body.to_vec();
        let sha_body = format!("{wrong}  ubuntu.qcow2\n");
        let listing = registry_listing(&["ubuntu.qcow2", "ubuntu.qcow2.sha256"]);

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
                    "/images/" => ("200 OK", listing.clone()),
                    "/images/ubuntu.qcow2" => ("200 OK", body_vec.clone()),
                    "/images/ubuntu.qcow2.sha256" => ("200 OK", sha_body.clone().into_bytes()),
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

        let path = ensure_cached("ubuntu", &registry, cache_root.path(), &client).await?;
        assert!(path.is_file());
        assert_eq!(sha256_file(&path).await?, sha256_bytes(body));

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
        let sha_body = format!("{expected}  ubuntu.qcow2\n");
        let listing = registry_listing(&["ubuntu.qcow2", "ubuntu.qcow2.sha256"]);

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
                        "/images/" => ("200 OK", listing.clone()),
                        "/images/ubuntu.qcow2" => ("200 OK", body_vec.clone()),
                        "/images/ubuntu.qcow2.sha256" => ("200 OK", sha_body.clone().into_bytes()),
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

        let path = ensure_cached("ubuntu", &registry, cache_root.path(), &client).await?;
        assert!(path.is_file());

        Ok(())
    }

    #[test]
    fn extract_registry_images_parses_common_index_formats() {
        let images = extract_registry_images(
            r#"
<html>
  <a href="ubuntu.qcow2">ubuntu.qcow2</a>
  <a href="https://example.com/images/broken-nginx-webserver-amd64.qcow2">broken</a>
  <a href="ubuntu.qcow2.sha256">ubuntu.qcow2.sha256</a>
  <Key>nested/arm64_base.qcow2</Key>
</html>
"#,
        );

        assert_eq!(
            images
                .into_iter()
                .map(|image| (image.image_key, image.image_filename, image.sha256_filename))
                .collect::<Vec<_>>(),
            vec![
                (
                    "arm64_base".to_string(),
                    "arm64_base.qcow2".to_string(),
                    None,
                ),
                (
                    "broken-nginx-webserver-amd64".to_string(),
                    "broken-nginx-webserver-amd64.qcow2".to_string(),
                    None,
                ),
                (
                    "ubuntu".to_string(),
                    "ubuntu.qcow2".to_string(),
                    Some("ubuntu.qcow2.sha256".to_string()),
                ),
            ]
        );
    }

    #[tokio::test]
    async fn ensure_cached_rejects_unlisted_image_key() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let listing = registry_listing(&[
            "broken-nginx-webserver-amd64.qcow2",
            "broken-nginx-webserver-amd64.qcow2.sha256",
        ]);

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
                    "/images/" => ("200 OK", listing.clone()),
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
