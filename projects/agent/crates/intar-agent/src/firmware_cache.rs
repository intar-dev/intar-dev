#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use futures_util::StreamExt as _;
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Semaphore;
use tracing::{debug, error, info, warn};

use crate::config::{ImageConfig, redact_url_userinfo};

const MAX_CONCURRENT_DOWNLOADS: usize = 2;

pub fn spawn_warm_cache(firmwares: BTreeMap<String, ImageConfig>) {
    if firmwares.is_empty() {
        return;
    }

    tokio::spawn(async move {
        let cache_root = match default_cache_root() {
            Ok(p) => p,
            Err(e) => {
                error!("failed to determine firmware cache dir: {e}");
                return;
            }
        };

        info!(
            cache_root = %cache_root.display(),
            firmware_count = firmwares.len(),
            "starting firmware cache warmup"
        );

        let client = reqwest::Client::new();
        let sem = Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS));

        let mut handles = Vec::with_capacity(firmwares.len());
        for (name, fw) in firmwares {
            let client = client.clone();
            let cache_root = cache_root.clone();
            let sem = Arc::clone(&sem);
            handles.push(tokio::spawn(async move {
                let redacted_url = redact_url_userinfo(&fw.url);
                let span =
                    tracing::info_span!("firmware_cache", firmware = %name, url = %redacted_url);
                let _guard = span.enter();

                let _permit = match sem.acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => return,
                };

                match ensure_cached(&name, &fw, &cache_root, &client).await {
                    Ok(path) => info!(path = %path.display(), "cache ready"),
                    Err(e) => error!("failed to cache firmware: {e}"),
                }
            }));
        }

        for h in handles {
            let _ = h.await;
        }

        info!("firmware cache warmup finished");
    });
}

pub fn spawn_log_cache_state(firmwares: BTreeMap<String, ImageConfig>) {
    if firmwares.is_empty() {
        info!("no firmwares configured; skipping cache state log");
        return;
    }

    tokio::spawn(async move {
        let cache_root = match default_cache_root() {
            Ok(p) => p,
            Err(e) => {
                error!("failed to determine firmware cache dir: {e}");
                return;
            }
        };

        let mut present: usize = 0;
        let mut missing: usize = 0;
        let mut unknown: usize = 0;

        for (name, fw) in firmwares {
            let path = cached_path(&cache_root, &name, &fw.url);
            match tokio::fs::metadata(&path).await {
                Ok(meta) => {
                    present = present.saturating_add(1);
                    info!(
                        firmware = %name,
                        path = %path.display(),
                        bytes = meta.len(),
                        "cache present"
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    missing = missing.saturating_add(1);
                    info!(firmware = %name, path = %path.display(), "cache missing");
                }
                Err(e) => {
                    unknown = unknown.saturating_add(1);
                    warn!(
                        firmware = %name,
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
            "firmware cache state"
        );
    });
}

pub fn default_cache_root() -> Result<PathBuf> {
    let base = dirs::cache_dir().ok_or_else(|| anyhow::anyhow!("cache dir unavailable"))?;
    Ok(base.join("intar-agent").join("firmware"))
}

fn cached_path(cache_root: &Path, firmware_key: &str, url: &str) -> PathBuf {
    let firmware_dir = cache_root.join(firmware_key);

    let mut filename = filename_from_url(url).unwrap_or_else(|| format!("{firmware_key}.bin"));
    if !is_safe_component(&filename) {
        filename = format!("{firmware_key}.bin");
    }

    firmware_dir.join(filename)
}

pub async fn ensure_cached(
    firmware_key: &str,
    spec: &ImageConfig,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    debug!(cache_root = %cache_root.display(), "ensuring firmware is cached");

    let firmware_dir = cache_root.join(firmware_key);
    tokio::fs::create_dir_all(&firmware_dir)
        .await
        .with_context(|| {
            format!(
                "failed to create firmware cache dir at {}",
                firmware_dir.display()
            )
        })?;

    let mut filename =
        filename_from_url(&spec.url).unwrap_or_else(|| format!("{firmware_key}.bin"));
    if !is_safe_component(&filename) {
        filename = format!("{firmware_key}.bin");
    }
    let final_path = firmware_dir.join(&filename);

    if tokio::fs::metadata(&final_path).await.is_ok() {
        debug!(path = %final_path.display(), "cache file exists; verifying sha256");
        match sha256_file(&final_path).await {
            Ok(have) if have == spec.sha256 => {
                info!(path = %final_path.display(), "cache hit");
                return Ok(final_path);
            }
            Ok(_) => {
                warn!(
                    path = %final_path.display(),
                    "cached file sha256 mismatch; re-downloading"
                );
                let _ = tokio::fs::remove_file(&final_path).await;
            }
            Err(e) => {
                warn!(path = %final_path.display(), "failed to hash cached firmware: {e}");
                let _ = tokio::fs::remove_file(&final_path).await;
            }
        }
    }

    let (tmp_path, mut tmp_file) = create_tmp_file(&firmware_dir, &filename).await?;
    info!(tmp_path = %tmp_path.display(), "download start");

    let download_start = std::time::Instant::now();
    let download_res = download_to_file(client, &spec.url, &spec.sha256, &mut tmp_file).await;
    drop(tmp_file);
    let display_url = redact_url_userinfo(&spec.url);

    let bytes = match download_res {
        Ok(b) => b,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(anyhow::anyhow!(
                "failed to download firmware {firmware_key} from {}: {e}",
                display_url
            ));
        }
    };

    info!(
        bytes,
        elapsed_ms = download_start.elapsed().as_millis(),
        "download complete"
    );

    if tokio::fs::metadata(&final_path).await.is_ok() {
        if let Ok(have) = sha256_file(&final_path).await
            && have == spec.sha256
        {
            info!(
                path = %final_path.display(),
                "cache already populated; discarding download"
            );
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Ok(final_path);
        }
        let _ = tokio::fs::remove_file(&final_path).await;
    }

    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .with_context(|| {
            format!(
                "failed to move cached firmware into place at {}",
                final_path.display()
            )
        })?;

    info!(path = %final_path.display(), "cached firmware");

    Ok(final_path)
}

fn filename_from_url(url: &str) -> Option<String> {
    let url = url.trim();
    let url = url.split('#').next().unwrap_or(url);
    let url = url.split('?').next().unwrap_or(url);
    let name = url.rsplit('/').next().unwrap_or("");
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
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
        let open_res = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await;
        match open_res {
            Ok(f) => return Ok((candidate, f)),
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

async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    expected_sha256: &str,
    file: &mut tokio::fs::File,
) -> Result<u64> {
    let display_url = redact_url_userinfo(url);
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {display_url}"))?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("download failed with HTTP {status}");
    }

    let mut bytes: u64 = 0;
    let mut hasher = Sha256::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("reading response body from {display_url}"))?;
        bytes = bytes.saturating_add(chunk.len() as u64);
        file.write_all(&chunk)
            .await
            .with_context(|| "writing firmware to temp file")?;
        hasher.update(&chunk);
    }
    file.flush().await.context("flushing temp file")?;

    let got = to_hex_lower(&hasher.finalize());
    if got != expected_sha256 {
        anyhow::bail!("sha256 mismatch (expected {expected_sha256}, got {got})");
    }

    Ok(bytes)
}

async fn sha256_file(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("failed to open file for hashing at {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .with_context(|| format!("failed reading file for hashing at {}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(to_hex_lower(&hasher.finalize()))
}

fn to_hex_lower(digest: &[u8]) -> String {
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        s.push(nibble_to_hex(b >> 4));
        s.push(nibble_to_hex(b & 0x0f));
    }
    s
}

fn nibble_to_hex(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'a' + (n - 10)) as char,
        _ => '0',
    }
}
