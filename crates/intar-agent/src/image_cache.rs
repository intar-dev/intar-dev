#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Semaphore;
use tracing::{debug, error, info, warn};

use crate::config::{
    BridgeConfig, ImageCacheConfig, ImageRegistryConfig, normalize_sha256, redact_url_userinfo,
};
use crate::db::{Db, ImageCacheAccessRow};

const MAX_CONCURRENT_DOWNLOADS: usize = 2;
const RAW_CACHE_MARKER_VERSION: u8 = 1;

pub(crate) fn registry_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("failed to build registry HTTP client")
}

#[derive(Debug, Clone)]
struct RegistryImageRecord {
    image_key: String,
    image_filename: String,
    image_sha256: String,
    image_virtual_size_bytes: u64,
    boot: RegistryImageBoot,
    download_url: String,
}

#[derive(Debug, Clone)]
struct RegistryImageBoot {
    kernel_sha256: String,
    initrd_sha256: String,
    cmdline: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CachedImage {
    pub image_key: String,
    pub image_sha256: String,
    pub raw_path: PathBuf,
    pub kernel_path: PathBuf,
    pub initrd_path: PathBuf,
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub cmdline: String,
    pub virtual_size_bytes: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CacheEntry {
    pub sha: String,
    pub bytes: u64,
    pub last_accessed_at_ms: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct RawCacheMarker {
    schema_version: u8,
    image_key: String,
    image_sha256: String,
    image_virtual_size_bytes: u64,
}

pub fn select_evictions(
    entries: &[CacheEntry],
    protected: &HashSet<String>,
    max_bytes: u64,
) -> Vec<String> {
    let total = entries
        .iter()
        .fold(0_u64, |sum, entry| sum.saturating_add(entry.bytes));
    if total <= max_bytes {
        return Vec::new();
    }

    let mut candidates = entries
        .iter()
        .filter(|entry| !protected.contains(&entry.sha))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.last_accessed_at_ms
            .cmp(&right.last_accessed_at_ms)
            .then_with(|| left.sha.cmp(&right.sha))
    });

    let mut evicted = Vec::new();
    let mut remaining = total;
    for entry in candidates {
        if remaining <= max_bytes {
            break;
        }
        evicted.push(entry.sha.clone());
        remaining = remaining.saturating_sub(entry.bytes);
    }
    evicted
}

#[derive(Debug, Deserialize)]
struct RegistryIndex {
    images: Vec<RegistryIndexImage>,
}

#[derive(Debug, Deserialize)]
struct RegistryIndexImage {
    image_key: String,
    image_sha256: String,
    image_format: String,
    image_virtual_size_bytes: u64,
    boot: RegistryIndexImageBoot,
    download_url: String,
}

#[derive(Debug, Deserialize)]
struct RegistryIndexImageBoot {
    kernel_sha256: String,
    initrd_sha256: String,
    cmdline: String,
}

pub fn spawn_warm_cache_with_bridge(
    registry: ImageRegistryConfig,
    bridge: BridgeConfig,
    cache: ImageCacheConfig,
    db: Db,
) {
    tokio::spawn(async move {
        let cache_root = match default_cache_root() {
            Ok(path) => path,
            Err(e) => {
                error!("failed to determine image cache dir: {e}");
                return;
            }
        };

        let client = match registry_http_client() {
            Ok(client) => client,
            Err(error) => {
                error!(error = %error, "failed to initialize image registry HTTP client");
                return;
            }
        };
        info!(
            cache_root = %cache_root.display(),
            poll_interval_minutes = registry.refresh_interval_minutes,
            registry = %redact_url_userinfo(&registry.url),
            "starting image registry cache worker"
        );

        run_cache_refresh_cycle(
            &registry,
            Some(&bridge),
            &cache,
            Some(&db),
            &cache_root,
            &client,
        )
        .await;

        let mut interval = tokio::time::interval(Duration::from_secs(
            registry.refresh_interval_minutes.saturating_mul(60),
        ));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            interval.tick().await;
            run_cache_refresh_cycle(
                &registry,
                Some(&bridge),
                &cache,
                Some(&db),
                &cache_root,
                &client,
            )
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

        let client = match registry_http_client() {
            Ok(client) => client,
            Err(error) => {
                error!(error = %error, "failed to initialize image registry HTTP client");
                return;
            }
        };
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
            match verified_cached_raw_image_metadata(
                &cache_root,
                &image.image_key,
                &image.image_sha256,
            ) {
                Some(meta) => {
                    present = present.saturating_add(1);
                    info!(
                        image = %image.image_key,
                        path = %path.display(),
                        bytes = meta.len(),
                        "cache present"
                    );
                }
                None if !path.exists() => {
                    missing = missing.saturating_add(1);
                    info!(image = %image.image_key, path = %path.display(), "cache missing");
                }
                None => {
                    unknown = unknown.saturating_add(1);
                    warn!(
                        image = %image.image_key,
                        path = %path.display(),
                        "cache unverified"
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

pub(crate) fn verified_cached_raw_image_metadata(
    cache_root: &Path,
    image_key: &str,
    image_sha256: &str,
) -> Option<std::fs::Metadata> {
    let raw_path = cached_raw_image_path_for_key(cache_root, image_key, image_sha256);
    let metadata = std::fs::metadata(&raw_path).ok()?;
    let marker_path = raw_cache_marker_path_for_key(cache_root, image_key, image_sha256);
    let marker = read_raw_cache_marker_sync(&marker_path).ok()?;
    if marker.schema_version == RAW_CACHE_MARKER_VERSION
        && marker.image_key == image_key
        && marker.image_sha256 == image_sha256
        && marker.image_virtual_size_bytes == metadata.len()
    {
        Some(metadata)
    } else {
        None
    }
}

async fn run_cache_refresh_cycle(
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache: &ImageCacheConfig,
    db: Option<&Db>,
    cache_root: &Path,
    client: &reqwest::Client,
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
            "image registry did not advertise any raw_zstd images"
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
        let db = db.cloned();
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

            match ensure_cached_raw_entry(&image, &registry, bridge.as_ref(), &cache_root, &client)
                .await
            {
                Ok(path) => {
                    if let Some(db) = db.as_ref()
                        && let Err(error) = touch_cached_image_access(db, &image).await
                    {
                        warn!(error = %error, image = %image.image_key, "failed to update image cache access metadata");
                    }
                    info!(path = %path.display(), "cache ready");
                }
                Err(e) => error!("failed to cache image: {e}"),
            }
        }));
    }

    for handle in handles {
        let _ = handle.await;
    }

    info!("image cache refresh finished");
    if let Some(db) = db
        && let Err(error) = evict_cache_if_needed(cache, db, cache_root).await
    {
        warn!(error = %error, cache_root = %cache_root.display(), "image cache eviction failed");
    }
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

#[cfg(test)]
pub async fn ensure_cached_raw(
    image_key: &str,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    let image = resolve_registry_image(image_key, registry, bridge, client).await?;
    ensure_cached_raw_entry(&image, registry, bridge, cache_root, client).await
}

pub async fn ensure_cached_image(
    image_key: &str,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<CachedImage> {
    let image = resolve_registry_image(image_key, registry, bridge, client).await?;
    let raw_path = ensure_cached_raw_entry(&image, registry, bridge, cache_root, client).await?;
    let kernel_path = ensure_cached_artifact(
        &image.boot.kernel_sha256,
        registry,
        bridge,
        cache_root,
        client,
    )
    .await?;
    let initrd_path = ensure_cached_artifact(
        &image.boot.initrd_sha256,
        registry,
        bridge,
        cache_root,
        client,
    )
    .await?;

    Ok(CachedImage {
        image_key: image.image_key,
        image_sha256: image.image_sha256,
        raw_path,
        kernel_path,
        initrd_path,
        kernel_sha256: image.boot.kernel_sha256,
        initrd_sha256: image.boot.initrd_sha256,
        cmdline: image.boot.cmdline,
        virtual_size_bytes: image.image_virtual_size_bytes,
    })
}

pub async fn touch_cached_image(db: &Db, image: &CachedImage) -> Result<()> {
    db.touch_image_cache_entry(ImageCacheAccessRow {
        image_key: image.image_key.clone(),
        image_sha256: image.image_sha256.clone(),
        kernel_sha256: image.kernel_sha256.clone(),
        initrd_sha256: image.initrd_sha256.clone(),
        raw_bytes: i64::try_from(image.virtual_size_bytes)
            .context("cached image virtual size exceeds sqlite INTEGER range")?,
        last_accessed_at_ms: now_unix_ms(),
    })
    .await
}

async fn touch_cached_image_access(db: &Db, image: &RegistryImageRecord) -> Result<()> {
    db.touch_image_cache_entry(ImageCacheAccessRow {
        image_key: image.image_key.clone(),
        image_sha256: image.image_sha256.clone(),
        kernel_sha256: image.boot.kernel_sha256.clone(),
        initrd_sha256: image.boot.initrd_sha256.clone(),
        raw_bytes: i64::try_from(image.image_virtual_size_bytes)
            .context("cached image virtual size exceeds sqlite INTEGER range")?,
        last_accessed_at_ms: now_unix_ms(),
    })
    .await
}

async fn evict_cache_if_needed(cache: &ImageCacheConfig, db: &Db, cache_root: &Path) -> Result<()> {
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

async fn protected_image_shas(db: &Db) -> HashSet<String> {
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

async fn artifact_cache_bytes(cache_root: &Path) -> Result<u64> {
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

async fn evict_unreferenced_artifacts(
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

const ARTIFACT_EVICTION_GRACE: Duration = Duration::from_secs(15 * 60);

fn artifact_within_eviction_grace(metadata: &std::fs::Metadata) -> bool {
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

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

/// Bytes a cache file actually occupies on disk. Raw images are written
/// sparsely, so their logical length vastly overstates disk usage; budgeting
/// on it would evict far below the operator's real `max_bytes`.
fn file_allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
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

async fn ensure_cached_raw_entry(
    image: &RegistryImageRecord,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    let raw_path = cached_raw_image_path(cache_root, image);
    let marker_path = raw_cache_marker_path(cache_root, image);
    match tokio::fs::metadata(&raw_path).await {
        Ok(metadata) if metadata.len() == image.image_virtual_size_bytes => {
            match read_raw_cache_marker(&marker_path).await {
                Ok(marker) if raw_cache_marker_matches(&marker, image, metadata.len()) => {
                    info!(path = %raw_path.display(), "raw image cache hit");
                    return Ok(raw_path);
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
    if let Err(error) = decompress_result {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(error)
            .with_context(|| format!("failed to decompress cached image {}", image.image_key));
    }

    if tokio::fs::metadata(&raw_path).await.is_ok() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        if verified_cached_raw_image_metadata(cache_root, &image.image_key, &image.image_sha256)
            .is_some()
        {
            return Ok(raw_path);
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
    write_raw_cache_marker(cache_root, image)
        .await
        .with_context(|| format!("failed to write raw cache marker for {}", image.image_key))?;
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

async fn ensure_cached_artifact(
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

async fn list_registry_images(
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

fn registry_images_from_index(index: RegistryIndex) -> Vec<RegistryImageRecord> {
    index
        .images
        .into_iter()
        .filter_map(|image| {
            if !is_safe_component(&image.image_key) {
                return None;
            }
            let image_sha256 = normalize_sha256(&image.image_sha256)?;
            if image.image_format != "raw_zstd" || image.image_virtual_size_bytes == 0 {
                return None;
            }
            let kernel_sha256 = normalize_sha256(&image.boot.kernel_sha256)?;
            let initrd_sha256 = normalize_sha256(&image.boot.initrd_sha256)?;
            if image.boot.cmdline.trim().is_empty() {
                return None;
            }
            if image.download_url.trim().is_empty() {
                return None;
            }
            Some(RegistryImageRecord {
                image_filename: format!("{}.raw.zst", image.image_key),
                image_key: image.image_key,
                image_sha256,
                image_virtual_size_bytes: image.image_virtual_size_bytes,
                boot: RegistryImageBoot {
                    kernel_sha256,
                    initrd_sha256,
                    cmdline: image.boot.cmdline,
                },
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
    cached_raw_image_path_for_key(cache_root, &image.image_key, &image.image_sha256)
}

fn cached_raw_image_path_for_key(
    cache_root: &Path,
    image_key: &str,
    image_sha256: &str,
) -> PathBuf {
    cache_root
        .join(image_key)
        .join(format!("{image_sha256}.raw"))
}

fn raw_cache_marker_path(cache_root: &Path, image: &RegistryImageRecord) -> PathBuf {
    raw_cache_marker_path_for_key(cache_root, &image.image_key, &image.image_sha256)
}

fn raw_cache_marker_path_for_key(
    cache_root: &Path,
    image_key: &str,
    image_sha256: &str,
) -> PathBuf {
    cache_root
        .join(image_key)
        .join(format!("{image_sha256}.raw.verified.json"))
}

fn raw_cache_marker_matches(
    marker: &RawCacheMarker,
    image: &RegistryImageRecord,
    actual_size_bytes: u64,
) -> bool {
    marker.schema_version == RAW_CACHE_MARKER_VERSION
        && marker.image_key == image.image_key
        && marker.image_sha256 == image.image_sha256
        && marker.image_virtual_size_bytes == image.image_virtual_size_bytes
        && marker.image_virtual_size_bytes == actual_size_bytes
}

async fn read_raw_cache_marker(path: &Path) -> std::io::Result<RawCacheMarker> {
    let bytes = tokio::fs::read(path).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

fn read_raw_cache_marker_sync(path: &Path) -> std::io::Result<RawCacheMarker> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

async fn write_raw_cache_marker(cache_root: &Path, image: &RegistryImageRecord) -> Result<()> {
    let image_dir = cache_root.join(&image.image_key);
    let marker_path = raw_cache_marker_path(cache_root, image);
    let marker = RawCacheMarker {
        schema_version: RAW_CACHE_MARKER_VERSION,
        image_key: image.image_key.clone(),
        image_sha256: image.image_sha256.clone(),
        image_virtual_size_bytes: image.image_virtual_size_bytes,
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

async fn remove_raw_cache_entry(raw_path: &Path, marker_path: &Path) -> Result<()> {
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

fn sha_filename(image: &RegistryImageRecord) -> String {
    format!("{}.sha256", image.image_filename)
}

fn decompress_raw_zstd_sparse(
    compressed_path: &Path,
    raw_path: &Path,
    virtual_size_bytes: u64,
) -> Result<()> {
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
    Ok(())
}

fn registry_base_url(registry: &ImageRegistryConfig) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(registry.url.trim())
        .with_context(|| "image registry URL is invalid")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        anyhow::bail!("image registry URL must be an absolute HTTP(S) URL");
    }
    Ok(url)
}

fn same_origin(left: &reqwest::Url, right: &reqwest::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn ensure_registry_origin(registry: &ImageRegistryConfig, candidate: &reqwest::Url) -> Result<()> {
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

fn build_registry_url(registry: &ImageRegistryConfig, path_or_url: &str) -> Result<reqwest::Url> {
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

async fn apply_registry_auth(
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
        source_url: url.to_string(),
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
    use std::io::{Cursor, Read, Write};
    use std::net::TcpListener;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::MetadataExt as _;
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

    fn registry_config_for_url(url: &str) -> ImageRegistryConfig {
        ImageRegistryConfig {
            url: url.to_string(),
            username: None,
            password: None,
            refresh_interval_minutes: 15,
        }
    }

    fn registry_index(entries: &[(&str, &str, &str)]) -> Vec<u8> {
        registry_index_with_boot(entries, &"b".repeat(64), &"c".repeat(64), 11)
    }

    fn registry_index_with_boot(
        entries: &[(&str, &str, &str)],
        kernel_sha256: &str,
        initrd_sha256: &str,
        virtual_size_bytes: u64,
    ) -> Vec<u8> {
        let images = entries
            .iter()
            .map(|(image_key, image_sha256, download_url)| {
                format!(
                    r#"{{"image_key":"{image_key}","image_sha256":"{image_sha256}","image_format":"raw_zstd","image_virtual_size_bytes":{virtual_size_bytes},"boot":{{"kernel_sha256":"{kernel_sha256}","initrd_sha256":"{initrd_sha256}","cmdline":"root=/dev/vda rw"}},"download_url":"{download_url}"}}"#
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(r#"{{"images":[{images}]}}"#).into_bytes()
    }

    fn raw_cache_record(
        image_key: &str,
        image_sha256: &str,
        virtual_size_bytes: u64,
    ) -> RegistryImageRecord {
        RegistryImageRecord {
            image_key: image_key.to_string(),
            image_filename: format!("{image_key}.raw.zst"),
            image_sha256: image_sha256.to_string(),
            image_virtual_size_bytes: virtual_size_bytes,
            boot: RegistryImageBoot {
                kernel_sha256: "b".repeat(64),
                initrd_sha256: "c".repeat(64),
                cmdline: "root=/dev/vda rw".to_string(),
            },
            download_url: "/agent/registry/images/ubuntu/sha".to_string(),
        }
    }

    #[test]
    fn registry_urls_resolve_relative_to_the_configured_endpoint() -> Result<()> {
        let registry = registry_config_for_url("https://registry.example/api/images");

        assert_eq!(
            build_registry_url(&registry, "ubuntu/image.raw.zst")?.as_str(),
            "https://registry.example/api/images/ubuntu/image.raw.zst"
        );
        assert_eq!(
            build_registry_url(&registry, "/artifacts/kernel")?.as_str(),
            "https://registry.example/artifacts/kernel"
        );
        assert_eq!(
            build_registry_url(&registry, "https://registry.example:443/artifacts/initrd")?
                .as_str(),
            "https://registry.example/artifacts/initrd"
        );

        Ok(())
    }

    #[test]
    fn registry_urls_reject_every_cross_origin_variant() {
        let registry = registry_config_for_url("https://registry.example:8443/api/images");
        for candidate in [
            "http://registry.example:8443/image.raw.zst",
            "https://registry.example/image.raw.zst",
            "https://registry.example:9443/image.raw.zst",
            "https://cdn.example:8443/image.raw.zst",
            "//cdn.example:8443/image.raw.zst",
        ] {
            let error = build_registry_url(&registry, candidate)
                .err()
                .map(|error| error.to_string())
                .unwrap_or_default();
            assert!(
                error.contains("does not match configured registry origin"),
                "unexpected result for {candidate}: {error}"
            );
        }
    }

    #[tokio::test]
    async fn registry_auth_is_rejected_before_credentials_reach_an_off_origin_request() -> Result<()>
    {
        ensure_ring_provider()?;
        let mut registry = registry_config_for_url("https://registry.example/api/images");
        registry.username = Some("registry-user".to_string());
        registry.password = Some("registry-password".to_string());
        let client = reqwest::Client::new();
        let request_url = reqwest::Url::parse("https://attacker.example/image.raw.zst")?;

        let error = apply_registry_auth(
            client.get(request_url.clone()),
            &request_url,
            &registry,
            None,
            &client,
        )
        .await
        .err()
        .map(|error| error.to_string())
        .unwrap_or_default();

        assert!(error.contains("does not match configured registry origin"));
        Ok(())
    }

    #[tokio::test]
    async fn production_registry_client_does_not_follow_redirects() -> Result<()> {
        ensure_ring_provider()?;
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let requests = Arc::new(AtomicUsize::new(0));
        let requests_bg = Arc::clone(&requests);

        std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let mut buffer = [0_u8; 1024];
                let _ = stream.read(&mut buffer);
                let request_number = requests_bg.fetch_add(1, Ordering::SeqCst);
                let response = if request_number == 0 {
                    "HTTP/1.1 302 Found\r\nLocation: /redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                };
                let _ = stream.write_all(response.as_bytes());
            }
        });

        let client = registry_http_client()?;
        let response = client.get(format!("http://{addr}/start")).send().await?;

        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        Ok(())
    }

    #[test]
    fn select_evictions_keeps_under_budget_cache() {
        let entries = vec![
            CacheEntry {
                sha: "a".repeat(64),
                bytes: 100,
                last_accessed_at_ms: 10,
            },
            CacheEntry {
                sha: "b".repeat(64),
                bytes: 200,
                last_accessed_at_ms: 20,
            },
        ];

        assert!(select_evictions(&entries, &HashSet::new(), 300).is_empty());
    }

    #[test]
    fn select_evictions_skips_protected_entries() {
        let protected_sha = "a".repeat(64);
        let entries = vec![
            CacheEntry {
                sha: protected_sha.clone(),
                bytes: 300,
                last_accessed_at_ms: 10,
            },
            CacheEntry {
                sha: "b".repeat(64),
                bytes: 200,
                last_accessed_at_ms: 20,
            },
            CacheEntry {
                sha: "c".repeat(64),
                bytes: 200,
                last_accessed_at_ms: 30,
            },
        ];
        let protected = HashSet::from([protected_sha.clone()]);

        assert_eq!(
            select_evictions(&entries, &protected, 300),
            vec!["b".repeat(64), "c".repeat(64)]
        );
    }

    #[test]
    fn select_evictions_uses_oldest_access_then_sha() {
        let entries = vec![
            CacheEntry {
                sha: "c".repeat(64),
                bytes: 100,
                last_accessed_at_ms: 10,
            },
            CacheEntry {
                sha: "a".repeat(64),
                bytes: 100,
                last_accessed_at_ms: 10,
            },
            CacheEntry {
                sha: "b".repeat(64),
                bytes: 100,
                last_accessed_at_ms: 20,
            },
        ];

        assert_eq!(
            select_evictions(&entries, &HashSet::new(), 100),
            vec!["a".repeat(64), "c".repeat(64)]
        );
    }

    #[tokio::test]
    async fn evict_unreferenced_artifacts_respects_refcounts_and_grace() -> Result<()> {
        let cache_root = tempfile::tempdir()?;
        let artifact_dir = cache_root.path().join("artifacts");
        std::fs::create_dir_all(&artifact_dir)?;

        let retained_sha = "a".repeat(64);
        let unreferenced_sha = "b".repeat(64);
        let fresh_sha = "c".repeat(64);
        let old_mtime = SystemTime::now() - ARTIFACT_EVICTION_GRACE - Duration::from_secs(60);
        for (sha, mtime) in [
            (&retained_sha, Some(old_mtime)),
            (&unreferenced_sha, Some(old_mtime)),
            // Fresh unreferenced artifact: an in-flight VM create may have
            // just downloaded it before recording its access row.
            (&fresh_sha, None),
        ] {
            let path = artifact_dir.join(sha);
            std::fs::write(&path, b"artifact")?;
            if let Some(mtime) = mtime {
                std::fs::File::options()
                    .write(true)
                    .open(&path)?
                    .set_modified(mtime)?;
            }
        }

        let retained = HashSet::from([retained_sha.clone()]);
        evict_unreferenced_artifacts(cache_root.path(), &retained).await?;

        assert!(
            artifact_dir.join(&retained_sha).exists(),
            "artifact referenced by a retained raw entry must never be evicted"
        );
        assert!(
            !artifact_dir.join(&unreferenced_sha).exists(),
            "old artifact with no retained raw reference must be evicted"
        );
        assert!(
            artifact_dir.join(&fresh_sha).exists(),
            "artifact inside the eviction grace window must be kept"
        );
        Ok(())
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
                .join("ubuntu.raw.zst.sha256")
                .is_file()
        );

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_raw_decompresses_raw_zstd() -> Result<()> {
        let raw_body = b"hello-image";
        let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
        let expected = sha256_bytes(&compressed_body);

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let body_vec = compressed_body.clone();
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
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        let path = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client).await?;

        assert_eq!(tokio::fs::read(&path).await?, raw_body);
        assert!(
            cache_root
                .path()
                .join("ubuntu")
                .join("ubuntu.raw.zst")
                .is_file()
        );
        assert!(
            cache_root
                .path()
                .join("ubuntu")
                .join(format!("{expected}.raw.verified.json"))
                .is_file()
        );

        Ok(())
    }

    #[test]
    fn raw_zstd_decompression_round_trips_sparse_image() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let compressed_path = temp.path().join("root.raw.zst");
        let raw_path = temp.path().join("root.raw");
        let virtual_size = 16 * 1024 * 1024;
        let mut raw_body = vec![0u8; virtual_size];
        raw_body[4096..4104].copy_from_slice(b"INTAR001");
        raw_body[(8 * 1024 * 1024)..(8 * 1024 * 1024 + 8)].copy_from_slice(b"INTAR002");
        raw_body[(virtual_size - 8192)..(virtual_size - 8184)].copy_from_slice(b"INTAR003");
        std::fs::write(
            &compressed_path,
            zstd::encode_all(Cursor::new(&raw_body), 0)?,
        )?;
        std::fs::File::create(&raw_path)?;

        decompress_raw_zstd_sparse(&compressed_path, &raw_path, virtual_size as u64)?;

        assert_eq!(std::fs::read(&raw_path)?, raw_body);
        let metadata = std::fs::metadata(&raw_path)?;
        assert_eq!(metadata.len(), virtual_size as u64);

        #[cfg(target_os = "linux")]
        {
            let allocated_bytes = metadata.blocks().saturating_mul(512);
            assert!(
                allocated_bytes < (virtual_size as u64 / 2),
                "expected sparse allocation below half of virtual size, got {allocated_bytes} bytes for {virtual_size}"
            );
        }

        Ok(())
    }

    #[test]
    fn raw_zstd_decompression_rejects_short_stream() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let compressed_path = temp.path().join("short.raw.zst");
        let raw_path = temp.path().join("short.raw");
        std::fs::write(
            &compressed_path,
            zstd::encode_all(Cursor::new(b"short"), 0)?,
        )?;
        std::fs::File::create(&raw_path)?;

        let error = decompress_raw_zstd_sparse(&compressed_path, &raw_path, 4096)
            .expect_err("short raw-zstd stream should be rejected");

        assert!(format!("{error:#}").contains("advertised virtual size"));
        assert!(!raw_path.is_file() || std::fs::metadata(&raw_path)?.len() != 4096);

        Ok(())
    }

    #[test]
    fn raw_zstd_decompression_rejects_oversized_stream_before_declared_size() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let compressed_path = temp.path().join("oversized.raw.zst");
        let raw_path = temp.path().join("oversized.raw");
        let advertised_size = 4096u64;
        let raw_body = vec![1u8; (advertised_size as usize) + 8192];
        std::fs::write(
            &compressed_path,
            zstd::encode_all(Cursor::new(&raw_body), 0)?,
        )?;
        std::fs::File::create(&raw_path)?;

        let error = decompress_raw_zstd_sparse(&compressed_path, &raw_path, advertised_size)
            .expect_err("oversized raw-zstd stream should be rejected");

        assert!(format!("{error:#}").contains("exceeds advertised virtual size"));
        assert!(std::fs::metadata(&raw_path)?.len() <= advertised_size);

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_image_downloads_boot_artifacts() -> Result<()> {
        let raw_body = b"hello-image";
        let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
        let image_sha256 = sha256_bytes(&compressed_body);
        let kernel_body = b"kernel";
        let initrd_body = b"initrd";
        let kernel_sha256 = sha256_bytes(kernel_body);
        let initrd_sha256 = sha256_bytes(initrd_body);

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let compressed_body_bg = compressed_body.clone();
        let kernel_body_bg = kernel_body.to_vec();
        let initrd_body_bg = initrd_body.to_vec();
        let kernel_sha256_bg = kernel_sha256.clone();
        let initrd_sha256_bg = initrd_sha256.clone();
        let index = registry_index_with_boot(
            &[("ubuntu", &image_sha256, "/agent/registry/images/ubuntu/sha")],
            &kernel_sha256,
            &initrd_sha256,
            raw_body.len() as u64,
        );

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
                    "/images" => ("200 OK", index.clone()),
                    "/agent/registry/images/ubuntu/sha" => ("200 OK", compressed_body_bg.clone()),
                    path if path == format!("/agent/registry/artifacts/{kernel_sha256_bg}") => {
                        ("200 OK", kernel_body_bg.clone())
                    }
                    path if path == format!("/agent/registry/artifacts/{initrd_sha256_bg}") => {
                        ("200 OK", initrd_body_bg.clone())
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

        let cached =
            ensure_cached_image("ubuntu", &registry, None, cache_root.path(), &client).await?;

        assert_eq!(tokio::fs::read(&cached.raw_path).await?, raw_body);
        assert_eq!(tokio::fs::read(&cached.kernel_path).await?, kernel_body);
        assert_eq!(tokio::fs::read(&cached.initrd_path).await?, initrd_body);
        assert_eq!(cached.cmdline, "root=/dev/vda rw");
        assert_eq!(cached.virtual_size_bytes, raw_body.len() as u64);

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_raw_removes_tmp_file_after_decompression_error() -> Result<()> {
        let raw_body = b"short";
        let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
        let expected = sha256_bytes(&compressed_body);

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let body_vec = compressed_body.clone();
        let index = registry_index_with_boot(
            &[("ubuntu", &expected, "/agent/registry/images/ubuntu/sha")],
            &"b".repeat(64),
            &"c".repeat(64),
            4096,
        );

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
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        let error = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client)
            .await
            .expect_err("short raw-zstd image should not be cached");

        assert!(format!("{error:#}").contains("advertised virtual size"));
        let image_dir = cache_root.path().join("ubuntu");
        assert!(!image_dir.join(format!("{expected}.raw")).exists());
        assert!(
            !image_dir
                .join(format!("{expected}.raw.verified.json"))
                .exists()
        );
        for entry in std::fs::read_dir(&image_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            assert!(
                !name.contains(".raw.part."),
                "temporary raw cache file was not removed: {name}"
            );
        }

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
        tokio::fs::write(&raw_path, body).await?;
        write_raw_cache_marker(
            cache_root.path(),
            &raw_cache_record("ubuntu", &expected, body.len() as u64),
        )
        .await?;
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        let path = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client).await?;

        assert_eq!(path, raw_path);
        assert_eq!(tokio::fs::read(&path).await?, body);
        assert!(
            cache_root
                .path()
                .join("ubuntu")
                .join("ubuntu.raw.zst")
                .try_exists()
                .is_ok_and(|exists| !exists)
        );

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_raw_refreshes_unverified_same_size_raw() -> Result<()> {
        let raw_body = b"hello-image";
        let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
        let expected = sha256_bytes(&compressed_body);

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let body_vec = compressed_body.clone();
        let image_requests = Arc::new(AtomicUsize::new(0));
        let image_requests_bg = Arc::clone(&image_requests);
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
        let raw_dir = cache_root.path().join("ubuntu");
        tokio::fs::create_dir_all(&raw_dir).await?;
        let raw_path = raw_dir.join(format!("{expected}.raw"));
        tokio::fs::write(&raw_path, b"bad-cache!!").await?;
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        let path = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client).await?;

        assert_eq!(path, raw_path);
        assert_eq!(tokio::fs::read(&path).await?, raw_body);
        assert_eq!(image_requests.load(Ordering::SeqCst), 1);
        assert!(
            cache_root
                .path()
                .join("ubuntu")
                .join(format!("{expected}.raw.verified.json"))
                .is_file()
        );

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_raw_refreshes_wrong_size_preconverted_raw() -> Result<()> {
        let raw_body = b"hello-image";
        let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
        let expected = sha256_bytes(&compressed_body);

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let body_vec = compressed_body.clone();
        let image_requests = Arc::new(AtomicUsize::new(0));
        let image_requests_bg = Arc::clone(&image_requests);
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
        let raw_dir = cache_root.path().join("ubuntu");
        tokio::fs::create_dir_all(&raw_dir).await?;
        let raw_path = raw_dir.join(format!("{expected}.raw"));
        tokio::fs::write(&raw_path, b"truncated").await?;
        ensure_ring_provider()?;
        let client = reqwest::Client::new();
        let registry = registry_config(addr);

        let path = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client).await?;

        assert_eq!(path, raw_path);
        assert_eq!(tokio::fs::read(&path).await?, raw_body);
        assert_eq!(image_requests.load(Ordering::SeqCst), 1);

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
                .join("ubuntu.raw.zst")
                .exists(),
            "mismatched image must not be installed in cache"
        );

        Ok(())
    }

    #[tokio::test]
    async fn ensure_cached_rejects_missing_registry_sha256() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let index = format!(
            r#"{{"images":[{{"image_key":"ubuntu","image_sha256":"","image_format":"raw_zstd","image_virtual_size_bytes":11,"boot":{{"kernel_sha256":"{}","initrd_sha256":"{}","cmdline":"root=/dev/vda rw"}},"download_url":"/image"}}]}}"#,
            "b".repeat(64),
            "c".repeat(64)
        )
        .into_bytes();

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
                .join("ubuntu.raw.zst")
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
                    image_format: "raw_zstd".to_string(),
                    image_virtual_size_bytes: 11,
                    boot: RegistryIndexImageBoot {
                        kernel_sha256: "b".repeat(64),
                        initrd_sha256: "c".repeat(64),
                        cmdline: "root=/dev/vda rw".to_string(),
                    },
                    download_url: "/agent/registry/images/ubuntu/sha".to_string(),
                },
                RegistryIndexImage {
                    image_key: "../bad".to_string(),
                    image_sha256: sha.clone(),
                    image_format: "raw_zstd".to_string(),
                    image_virtual_size_bytes: 11,
                    boot: RegistryIndexImageBoot {
                        kernel_sha256: "b".repeat(64),
                        initrd_sha256: "c".repeat(64),
                        cmdline: "root=/dev/vda rw".to_string(),
                    },
                    download_url: "/bad".to_string(),
                },
                RegistryIndexImage {
                    image_key: "missing-sha".to_string(),
                    image_sha256: String::new(),
                    image_format: "raw_zstd".to_string(),
                    image_virtual_size_bytes: 11,
                    boot: RegistryIndexImageBoot {
                        kernel_sha256: "b".repeat(64),
                        initrd_sha256: "c".repeat(64),
                        cmdline: "root=/dev/vda rw".to_string(),
                    },
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
                "ubuntu.raw.zst".to_string(),
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
