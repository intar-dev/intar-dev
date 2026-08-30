#![forbid(unsafe_code)]
#![cfg_attr(test, allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use futures_util::StreamExt as _;
use intar_contracts::catalog::ImageChunkManifestV1;
#[cfg(test)]
use intar_jailer_protocol::PreparedImageV2Result;
use intar_jailer_protocol::{
    ArtifactAccess, ArtifactSource, PREPARED_IMAGE_SOURCE_ROOT, PreparedImageV3Result, Sha256Digest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::{Mutex, Notify, Semaphore};
#[cfg(test)]
use tracing::debug;
use tracing::{Instrument as _, error, info, warn};

use crate::config::{
    BridgeConfig, ImageCacheConfig, ImageRegistryConfig, normalize_sha256, redact_url_userinfo,
};
use crate::db::{Db, ImageCacheAccessRow};

const MAX_CONCURRENT_IMAGE_WARMS: usize = 8;
const MAX_CONCURRENT_CACHE_DOWNLOADS: usize = 16;
const REGISTRY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REGISTRY_READ_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(test)]
const RAW_CACHE_MARKER_VERSION: u8 = 3;
#[cfg(test)]
const LAUNCH_DESCRIPTOR_VERSION: u8 = 1;
#[cfg(test)]
const LAUNCH_DESCRIPTOR_FILENAME: &str = "launch-v2.ready.json";

type CacheEntryLockKey = (PathBuf, String);
type CacheEntryLocks = Mutex<HashMap<CacheEntryLockKey, Arc<Mutex<()>>>>;

static CACHE_ENTRY_LOCKS: OnceLock<CacheEntryLocks> = OnceLock::new();
static CACHE_DOWNLOADS: OnceLock<Semaphore> = OnceLock::new();
static CACHE_REFRESH_WAKE: OnceLock<Notify> = OnceLock::new();

pub(crate) fn wake_cache_refresh() {
    CACHE_REFRESH_WAKE.get_or_init(Notify::new).notify_one();
}

fn cache_entry_locks() -> &'static CacheEntryLocks {
    CACHE_ENTRY_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_downloads() -> &'static Semaphore {
    CACHE_DOWNLOADS.get_or_init(|| Semaphore::new(MAX_CONCURRENT_CACHE_DOWNLOADS))
}

async fn cache_entry_lock(cache_root: &Path, key: String) -> Arc<Mutex<()>> {
    let mut locks = cache_entry_locks().lock().await;
    Arc::clone(
        locks
            .entry((cache_root.to_path_buf(), key))
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

pub(crate) fn registry_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(REGISTRY_CONNECT_TIMEOUT)
        // Bound an idle response without imposing a total deadline on large
        // image downloads. Otherwise one stuck warmer can hold a cache key and
        // block every foreground launch that needs the same boot artifact.
        .read_timeout(REGISTRY_READ_TIMEOUT)
        .build()
        .context("failed to build registry HTTP client")
}

#[derive(Debug, Clone)]
struct RegistryImageRecord {
    image_key: String,
    #[cfg(test)]
    image_filename: String,
    #[cfg(test)]
    image_sha256: String,
    image_id: String,
    image_virtual_size_bytes: u64,
    chunk_manifest_sha256: String,
    guest_bootstrap_abi: u16,
    boot: RegistryImageBoot,
    #[cfg(test)]
    download_url: String,
    manifest_download_url: String,
    chunk_download_base_url: String,
}

#[derive(Debug, Clone)]
struct RegistryImageBoot {
    kernel_sha256: String,
    initrd_sha256: String,
    cmdline: String,
}

#[cfg(test)]
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CachedImage {
    pub image_key: String,
    pub image_sha256: String,
    pub raw_path: PathBuf,
    pub raw_sha256: String,
    pub kernel_path: PathBuf,
    pub initrd_path: PathBuf,
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub cmdline: String,
    pub virtual_size_bytes: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CachedChunkedImage {
    pub image_key: String,
    pub image_id: String,
    pub chunk_manifest_path: PathBuf,
    pub chunk_manifest_sha256: String,
    pub chunk_cache_root: PathBuf,
    pub kernel_path: PathBuf,
    pub initrd_path: PathBuf,
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub cmdline: String,
    pub virtual_size_bytes: u64,
    pub guest_bootstrap_abi: u16,
}

#[cfg(test)]
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CacheEntry {
    pub sha: String,
    pub bytes: u64,
    pub last_accessed_at_ms: i64,
}

#[cfg(test)]
#[derive(Debug, Clone, Deserialize, Serialize)]
struct RawCacheMarker {
    schema_version: u8,
    image_key: String,
    image_sha256: String,
    image_virtual_size_bytes: u64,
    raw_sha256: String,
    kernel_sha256: String,
    initrd_sha256: String,
    cmdline: String,
}

#[cfg(test)]
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LaunchDescriptorV1 {
    schema_version: u8,
    image_key: String,
    image_sha256: String,
    raw_path: PathBuf,
    raw_sha256: String,
    image_virtual_size_bytes: u64,
    kernel_path: PathBuf,
    kernel_sha256: String,
    initrd_path: PathBuf,
    initrd_sha256: String,
    cmdline: String,
    prepared_image: PreparedImageV2Result,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ChunkedLaunchDescriptorV1 {
    schema_version: u8,
    image_key: String,
    image_id: String,
    chunk_manifest_path: PathBuf,
    chunk_manifest_sha256: String,
    chunk_cache_root: PathBuf,
    image_virtual_size_bytes: u64,
    guest_bootstrap_abi: u16,
    kernel_path: PathBuf,
    kernel_sha256: String,
    initrd_path: PathBuf,
    initrd_sha256: String,
    cmdline: String,
    prepared_image: PreparedImageV3Result,
}

#[cfg(test)]
#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct LegacyReadyImageLaunch {
    pub image: CachedImage,
    pub prepared_image: PreparedImageV2Result,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct ReadyImageLaunch {
    pub image: CachedChunkedImage,
    pub prepared_image: PreparedImageV3Result,
}

#[cfg(test)]
#[derive(Debug)]
struct CachedRawImage {
    path: PathBuf,
    sha256: String,
}

#[cfg(test)]
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
    #[serde(default)]
    image_id: Option<String>,
    image_format: String,
    image_virtual_size_bytes: u64,
    #[serde(default)]
    chunk_manifest_sha256: Option<String>,
    #[serde(default)]
    guest_bootstrap_abi: Option<u16>,
    boot: RegistryIndexImageBoot,
    #[serde(default)]
    manifest_download_url: Option<String>,
    #[serde(default)]
    chunk_download_base_url: Option<String>,
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
    vm: crate::vm::VmManager,
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

        let refresh_context = refresh::CacheRefreshContext {
            registry: &registry,
            bridge: Some(&bridge),
            cache: &cache,
            db: Some(&db),
            cache_root: &cache_root,
            client: &client,
            vm: &vm,
        };
        run_cache_refresh_cycle(refresh_context, refresh::CacheRefreshScope::FullRepair).await;

        let mut interval = tokio::time::interval(Duration::from_secs(
            registry.refresh_interval_minutes.saturating_mul(60),
        ));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            let scope = tokio::select! {
                _ = interval.tick() => refresh::CacheRefreshScope::FullRepair,
                () = CACHE_REFRESH_WAKE.get_or_init(Notify::new).notified() => {
                    refresh::CacheRefreshScope::MissingOnly
                }
            };
            run_cache_refresh_cycle(refresh_context, scope).await;
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
            let path = cache_root
                .join("manifests")
                .join(format!("{}.json", image.chunk_manifest_sha256));
            match verified_cached_image_metadata(
                &cache_root,
                &image.image_key,
                &image.image_id,
                true,
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

#[cfg(test)]
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
        && normalize_sha256(&marker.raw_sha256).as_deref() == Some(marker.raw_sha256.as_str())
        && normalize_sha256(&marker.kernel_sha256).as_deref() == Some(marker.kernel_sha256.as_str())
        && normalize_sha256(&marker.initrd_sha256).as_deref() == Some(marker.initrd_sha256.as_str())
        && !marker.cmdline.trim().is_empty()
    {
        Some(metadata)
    } else {
        None
    }
}

#[cfg(test)]
pub(crate) fn verified_cached_legacy_image_metadata(
    cache_root: &Path,
    image_key: &str,
    image_sha256: &str,
    require_template: bool,
) -> Option<std::fs::Metadata> {
    let metadata = verified_cached_raw_image_metadata(cache_root, image_key, image_sha256)?;
    if !require_template {
        return Some(metadata);
    }
    let descriptor_path = launch_descriptor_path_for_key(cache_root, image_key);
    regular_cached_file(&descriptor_path, "launch descriptor").ok()?;
    let descriptor: LaunchDescriptorV1 =
        serde_json::from_slice(&std::fs::read(descriptor_path).ok()?).ok()?;
    validate_launch_descriptor(cache_root, image_key, Some(image_sha256), descriptor)
        .ok()
        .map(|ready| ready.1)
}

/// Atomically publish the complete, prevalidated foreground launch contract.
/// The background warmer is the only caller. A launch never updates this file
/// and never falls back to the registry when it is absent or invalid.
#[cfg(test)]
pub(crate) async fn mark_legacy_template_ready(
    image: &CachedImage,
    prepared: &PreparedImageV2Result,
) -> Result<()> {
    let descriptor_path = launch_descriptor_path_for_raw(&image.raw_path)?;
    let directory = descriptor_path
        .parent()
        .context("launch descriptor parent")?;
    let descriptor = LaunchDescriptorV1 {
        schema_version: LAUNCH_DESCRIPTOR_VERSION,
        image_key: image.image_key.clone(),
        image_sha256: image.image_sha256.clone(),
        raw_path: image.raw_path.clone(),
        raw_sha256: image.raw_sha256.clone(),
        image_virtual_size_bytes: image.virtual_size_bytes,
        kernel_path: image.kernel_path.clone(),
        kernel_sha256: image.kernel_sha256.clone(),
        initrd_path: image.initrd_path.clone(),
        initrd_sha256: image.initrd_sha256.clone(),
        cmdline: image.cmdline.clone(),
        prepared_image: prepared.clone(),
    };
    validate_launch_descriptor(
        cache_root_from_cached_image(image)?,
        &image.image_key,
        Some(&image.image_sha256),
        descriptor.clone(),
    )?;

    let (temporary, mut file) = create_tmp_file(directory, LAUNCH_DESCRIPTOR_FILENAME).await?;
    file.write_all(&serde_json::to_vec(&descriptor)?)
        .await
        .context("write launch descriptor")?;
    file.flush().await.context("flush launch descriptor")?;
    file.sync_all().await.context("sync launch descriptor")?;
    drop(file);
    tokio::fs::rename(&temporary, &descriptor_path)
        .await
        .with_context(|| {
            format!(
                "publish atomic launch descriptor {}",
                descriptor_path.display()
            )
        })?;
    Ok(())
}

/// Resolve a foreground launch exclusively from the descriptor published by a
/// completed background prewarm. This intentionally accepts no registry or
/// HTTP client, so a cache miss cannot enter a download or hashing slow path.
#[cfg(test)]
pub(crate) async fn require_ready_legacy_image_launch(
    cache_root: &Path,
    image_key: &str,
    expected_image_sha256: Option<&str>,
) -> Result<LegacyReadyImageLaunch> {
    if !is_safe_component(image_key) {
        anyhow::bail!("invalid image key {image_key:?}");
    }
    let expected_image_sha256 = expected_image_sha256
        .map(|value| {
            normalize_sha256(value)
                .ok_or_else(|| anyhow::anyhow!("invalid expected image sha256 {value:?}"))
        })
        .transpose()?;
    let descriptor_path = launch_descriptor_path_for_key(cache_root, image_key);
    regular_cached_file(&descriptor_path, "launch descriptor").context(
        "prewarmed launch descriptor is unavailable; foreground registry fallback is disabled",
    )?;
    let bytes = tokio::fs::read(&descriptor_path).await.with_context(|| {
        format!(
            "read prewarmed launch descriptor {}; foreground registry fallback is disabled",
            descriptor_path.display()
        )
    })?;
    let descriptor: LaunchDescriptorV1 = serde_json::from_slice(&bytes)
        .with_context(|| format!("decode launch descriptor {}", descriptor_path.display()))?;
    validate_launch_descriptor(
        cache_root,
        image_key,
        expected_image_sha256.as_deref(),
        descriptor,
    )
    .map(|(ready, _)| ready)
}

#[cfg(test)]
fn cache_root_from_cached_image(image: &CachedImage) -> Result<&Path> {
    image
        .raw_path
        .parent()
        .and_then(Path::parent)
        .context("cached raw image is not below an image-key directory")
}

#[cfg(test)]
fn validate_launch_descriptor(
    cache_root: &Path,
    image_key: &str,
    expected_image_sha256: Option<&str>,
    descriptor: LaunchDescriptorV1,
) -> Result<(LegacyReadyImageLaunch, std::fs::Metadata)> {
    anyhow::ensure!(
        descriptor.schema_version == LAUNCH_DESCRIPTOR_VERSION,
        "unsupported launch descriptor schema version {}",
        descriptor.schema_version
    );
    anyhow::ensure!(
        descriptor.image_key == image_key,
        "launch descriptor image key mismatch"
    );
    anyhow::ensure!(
        normalize_sha256(&descriptor.image_sha256).as_deref()
            == Some(descriptor.image_sha256.as_str()),
        "launch descriptor image sha256 is not canonical"
    );
    if let Some(expected) = expected_image_sha256 {
        anyhow::ensure!(
            descriptor.image_sha256 == expected,
            "stale launch descriptor: expected image sha256 {expected}, found {}",
            descriptor.image_sha256
        );
    }
    for (label, sha256) in [
        ("raw", descriptor.raw_sha256.as_str()),
        ("kernel", descriptor.kernel_sha256.as_str()),
        ("initrd", descriptor.initrd_sha256.as_str()),
    ] {
        anyhow::ensure!(
            normalize_sha256(sha256).as_deref() == Some(sha256),
            "launch descriptor {label} sha256 is not canonical"
        );
    }
    anyhow::ensure!(
        descriptor.image_virtual_size_bytes > 0,
        "launch descriptor image virtual size is zero"
    );
    anyhow::ensure!(
        !descriptor.cmdline.trim().is_empty(),
        "launch descriptor kernel command line is empty"
    );

    let expected_raw_path =
        cached_raw_image_path_for_key(cache_root, image_key, &descriptor.image_sha256);
    let expected_kernel_path = cache_root.join("artifacts").join(&descriptor.kernel_sha256);
    let expected_initrd_path = cache_root.join("artifacts").join(&descriptor.initrd_sha256);
    anyhow::ensure!(
        descriptor.raw_path == expected_raw_path
            && descriptor.kernel_path == expected_kernel_path
            && descriptor.initrd_path == expected_initrd_path,
        "launch descriptor contains an unexpected cache path"
    );

    let raw_metadata = regular_cached_file(&descriptor.raw_path, "raw image")?;
    anyhow::ensure!(
        raw_metadata.len() == descriptor.image_virtual_size_bytes,
        "launch descriptor raw image size mismatch"
    );
    let _ = regular_cached_file(&descriptor.kernel_path, "kernel")?;
    let _ = regular_cached_file(&descriptor.initrd_path, "initrd")?;

    let raw_marker_path =
        raw_cache_marker_path_for_key(cache_root, image_key, &descriptor.image_sha256);
    let _ = regular_cached_file(&raw_marker_path, "raw cache marker")?;
    let raw_marker = read_raw_cache_marker_sync(&raw_marker_path)
        .with_context(|| format!("read raw cache marker {}", raw_marker_path.display()))?;
    anyhow::ensure!(
        raw_marker.schema_version == RAW_CACHE_MARKER_VERSION
            && raw_marker.image_key == descriptor.image_key
            && raw_marker.image_sha256 == descriptor.image_sha256
            && raw_marker.image_virtual_size_bytes == descriptor.image_virtual_size_bytes
            && raw_marker.raw_sha256 == descriptor.raw_sha256
            && raw_marker.kernel_sha256 == descriptor.kernel_sha256
            && raw_marker.initrd_sha256 == descriptor.initrd_sha256
            && raw_marker.cmdline == descriptor.cmdline,
        "launch descriptor does not match the verified raw cache record"
    );

    validate_prepared_descriptor(&descriptor)?;
    let image = CachedImage {
        image_key: descriptor.image_key,
        image_sha256: descriptor.image_sha256,
        raw_path: descriptor.raw_path,
        raw_sha256: descriptor.raw_sha256,
        kernel_path: descriptor.kernel_path,
        initrd_path: descriptor.initrd_path,
        kernel_sha256: descriptor.kernel_sha256,
        initrd_sha256: descriptor.initrd_sha256,
        cmdline: descriptor.cmdline,
        virtual_size_bytes: descriptor.image_virtual_size_bytes,
    };
    Ok((
        LegacyReadyImageLaunch {
            image,
            prepared_image: descriptor.prepared_image,
        },
        raw_metadata,
    ))
}

fn regular_cached_file(path: &Path, label: &str) -> Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("stat cached {label} {}", path.display()))?;
    anyhow::ensure!(
        metadata.file_type().is_file() && metadata.len() > 0,
        "cached {label} is not a non-empty regular file"
    );
    Ok(metadata)
}

#[cfg(test)]
fn validate_prepared_descriptor(descriptor: &LaunchDescriptorV1) -> Result<()> {
    let prepared = &descriptor.prepared_image;
    anyhow::ensure!(
        prepared.fast_template_store
            && prepared.image_sha256.as_str() == descriptor.image_sha256
            && prepared.virtual_size_bytes == descriptor.image_virtual_size_bytes,
        "launch descriptor prepared-image identity mismatch"
    );
    validate_prepared_source(
        &prepared.root_disk,
        &descriptor.image_sha256,
        "root.raw",
        &descriptor.raw_sha256,
        ArtifactAccess::ReadWrite,
    )?;
    validate_prepared_source(
        &prepared.kernel,
        &descriptor.image_sha256,
        "kernel",
        &descriptor.kernel_sha256,
        ArtifactAccess::ReadOnly,
    )?;
    let initrd = prepared
        .initrd
        .as_ref()
        .context("launch descriptor prepared image is missing initrd")?;
    validate_prepared_source(
        initrd,
        &descriptor.image_sha256,
        "initrd",
        &descriptor.initrd_sha256,
        ArtifactAccess::ReadOnly,
    )
}

fn validate_prepared_source(
    source: &ArtifactSource,
    image_sha256: &str,
    file_name: &str,
    expected_sha256: &str,
    access: ArtifactAccess,
) -> Result<()> {
    anyhow::ensure!(
        source.source_root == PREPARED_IMAGE_SOURCE_ROOT
            && source.relative_path == PathBuf::from(image_sha256).join(file_name)
            && source.sha256.as_ref().map(Sha256Digest::as_str) == Some(expected_sha256)
            && source.access == access,
        "launch descriptor prepared {file_name} source mismatch"
    );
    Ok(())
}

mod chunked;
use chunked::ensure_cached_chunked_image_entry;
pub(crate) use chunked::{
    ensure_cached_tools_disk, mark_template_ready, require_ready_image_launch, touch_cached_image,
    verified_cached_image_metadata,
};
mod refresh;
use refresh::*;
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
    Ok(
        ensure_cached_raw_entry(&image, registry, bridge, cache_root, client)
            .await?
            .path,
    )
}

#[cfg(test)]
async fn ensure_cached_image(
    image_key: &str,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<CachedImage> {
    let image = resolve_registry_image(image_key, registry, bridge, client).await?;
    ensure_cached_image_entry(&image, registry, bridge, cache_root, client).await
}

#[cfg(test)]
async fn ensure_cached_image_entry(
    image: &RegistryImageRecord,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<CachedImage> {
    // These paths are independent. Prepare them together so a cold raw-image
    // decompression overlaps the small direct-boot artifact downloads. `join!`
    // deliberately lets every branch finish its cleanup if a sibling fails.
    // Boxing keeps the three sizeable async state machines off the Tokio
    // worker stack while they are polled together.
    let raw = Box::pin(ensure_cached_raw_entry(
        image, registry, bridge, cache_root, client,
    ));
    let kernel = Box::pin(ensure_cached_artifact(
        &image.boot.kernel_sha256,
        registry,
        bridge,
        cache_root,
        client,
    ));
    let initrd = Box::pin(ensure_cached_artifact(
        &image.boot.initrd_sha256,
        registry,
        bridge,
        cache_root,
        client,
    ));
    let (raw, kernel_path, initrd_path) = tokio::join!(raw, kernel, initrd);
    let raw = raw?;
    let kernel_path = kernel_path?;
    let initrd_path = initrd_path?;

    Ok(CachedImage {
        image_key: image.image_key.clone(),
        image_sha256: image.image_sha256.clone(),
        raw_path: raw.path,
        raw_sha256: raw.sha256,
        kernel_path,
        initrd_path,
        kernel_sha256: image.boot.kernel_sha256.clone(),
        initrd_sha256: image.boot.initrd_sha256.clone(),
        cmdline: image.boot.cmdline.clone(),
        virtual_size_bytes: image.image_virtual_size_bytes,
    })
}

#[cfg(test)]
pub async fn touch_cached_legacy_image(db: &Db, image: &CachedImage) -> Result<()> {
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

mod storage;
use storage::*;
mod registry;
use registry::*;
#[cfg(test)]
mod tests;
