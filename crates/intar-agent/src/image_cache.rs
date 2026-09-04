#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use futures_util::StreamExt as _;
use intar_contracts::catalog::ImageChunkManifestV1;
use intar_jailer_protocol::{
    ArtifactAccess, ArtifactSource, PREPARED_IMAGE_SOURCE_ROOT, PreparedImageV3Result, Sha256Digest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::{Mutex, Notify, Semaphore};
use tracing::{Instrument as _, error, info, warn};

use crate::config::{
    BridgeConfig, ImageCacheConfig, ImageRegistryConfig, normalize_sha256, redact_url_userinfo,
};
use crate::db::{Db, ImageCacheAccessRow};

const MAX_CONCURRENT_IMAGE_WARMS: usize = 8;
const MAX_CONCURRENT_CACHE_DOWNLOADS: usize = 16;
const REGISTRY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REGISTRY_READ_TIMEOUT: Duration = Duration::from_secs(60);
const REGISTRY_INDEX_TIMEOUT: Duration = Duration::from_secs(15);
const REGISTRY_ACCESS_TOKEN_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const REGISTRY_ACCESS_TOKEN_REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

type CacheEntryLockKey = (PathBuf, String);
type CacheEntryLocks = Mutex<HashMap<CacheEntryLockKey, Arc<Mutex<()>>>>;

static CACHE_ENTRY_LOCKS: OnceLock<CacheEntryLocks> = OnceLock::new();
static CACHE_DOWNLOADS: OnceLock<Semaphore> = OnceLock::new();
static CACHE_REFRESH_WAKE: OnceLock<Notify> = OnceLock::new();
static REGISTRY_ACCESS_TOKEN: OnceLock<Mutex<RegistryAccessTokenCache>> = OnceLock::new();
static REGISTRY_ACCESS_TOKEN_REFRESH: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Default)]
struct RegistryAccessTokenCache {
    current: Option<CachedRegistryAccessToken>,
}

struct CachedRegistryAccessToken {
    value: String,
    valid_until: Instant,
}

impl std::fmt::Debug for RegistryAccessTokenCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RegistryAccessTokenCache")
            .field("populated", &self.current.is_some())
            .finish()
    }
}

impl RegistryAccessTokenCache {
    fn get(&self, now: Instant) -> Option<String> {
        self.current
            .as_ref()
            .filter(|cached| now < cached.valid_until)
            .map(|cached| cached.value.clone())
    }

    fn replace(&mut self, value: String, now: Instant) {
        self.current = Some(CachedRegistryAccessToken {
            value,
            valid_until: now + REGISTRY_ACCESS_TOKEN_CACHE_TTL,
        });
    }

    fn clear(&mut self) {
        self.current = None;
    }
}

fn registry_access_token_cache() -> &'static Mutex<RegistryAccessTokenCache> {
    REGISTRY_ACCESS_TOKEN.get_or_init(|| Mutex::new(RegistryAccessTokenCache::default()))
}

pub(crate) async fn cache_registry_access_token(access_token: &str) {
    if access_token.is_empty() {
        return;
    }
    registry_access_token_cache()
        .lock()
        .await
        .replace(access_token.to_owned(), Instant::now());
}

pub(crate) async fn clear_registry_access_token() {
    registry_access_token_cache().lock().await.clear();
}

async fn cached_registry_access_token() -> Option<String> {
    registry_access_token_cache()
        .lock()
        .await
        .get(Instant::now())
}

async fn registry_access_token(bridge: &BridgeConfig, client: &reqwest::Client) -> Result<String> {
    if let Some(access_token) = cached_registry_access_token().await {
        return Ok(access_token);
    }

    let _refresh = REGISTRY_ACCESS_TOKEN_REFRESH
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    if let Some(access_token) = cached_registry_access_token().await {
        return Ok(access_token);
    }

    let access_token = match tokio::time::timeout(
        REGISTRY_ACCESS_TOKEN_REFRESH_TIMEOUT,
        bootstrap_agent_access(bridge, client),
    )
    .await
    {
        Ok(Ok(access_token)) => access_token,
        Ok(Err(error)) => {
            if let Some(access_token) = cached_registry_access_token().await {
                return Ok(access_token);
            }
            return Err(error).context("agent access refresh for image registry failed");
        }
        Err(error) => {
            if let Some(access_token) = cached_registry_access_token().await {
                return Ok(access_token);
            }
            return Err(error).context("agent access refresh for image registry timed out");
        }
    };
    anyhow::ensure!(
        !access_token.is_empty(),
        "agent bootstrap returned an empty registry token"
    );
    registry_access_token_cache()
        .lock()
        .await
        .replace(access_token.clone(), Instant::now());
    Ok(access_token)
}

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
        // The scenario host is dual-stack, but one Cloudflare IPv6 anycast
        // route has repeatedly accepted a TLS connection and then stopped
        // acknowledging registry request bytes. Prefer the host's stable IPv4
        // path for bulk cache traffic; Bridge control traffic stays dual-stack.
        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        // Cloudflare's HTTP/2 edge intermittently stopped acknowledging this
        // client's small index request after TLS setup. HTTP/1.1 is stable on
        // both advertised IPv4 edges and chunk objects use independent GETs.
        .http1_only()
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
    image_id: String,
    image_virtual_size_bytes: u64,
    chunk_manifest_sha256: String,
    guest_bootstrap_abi: u16,
    boot: RegistryImageBoot,
    manifest_download_url: String,
    chunk_download_base_url: String,
}

#[derive(Debug, Clone)]
struct RegistryImageBoot {
    kernel_sha256: String,
    initrd_sha256: String,
    cmdline: String,
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

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct ReadyImageLaunch {
    pub image: CachedChunkedImage,
    pub prepared_image: PreparedImageV3Result,
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

fn regular_cached_file(path: &Path, label: &str) -> Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("stat cached {label} {}", path.display()))?;
    anyhow::ensure!(
        metadata.file_type().is_file() && metadata.len() > 0,
        "cached {label} is not a non-empty regular file"
    );
    Ok(metadata)
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

mod storage;
use storage::*;
mod registry;
use registry::*;
#[cfg(test)]
mod tests;
