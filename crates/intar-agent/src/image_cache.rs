#![forbid(unsafe_code)]

use std::collections::{BTreeMap, HashSet};
use std::io::Read as _;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use intar_contracts::bridge::ImageCachePhase;
use intar_contracts::bridge_v9::CachedImageStateV2;
use intar_contracts::oci::OciDigest;
use intar_jailer_protocol::{
    ArtifactAccess, ArtifactSource, PREPARED_IMAGE_SOURCE_ROOT, PreparedImageV3Result, Sha256Digest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::{Mutex, Notify, Semaphore};
use tracing::{Instrument as _, debug, error, info, warn};

use crate::config::{BridgeConfig, ImageCacheConfig, ImageRegistryConfig, redact_url_userinfo};
use crate::db::Db;

const REGISTRY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REGISTRY_READ_TIMEOUT: Duration = Duration::from_secs(60);
const REGISTRY_ACCESS_TOKEN_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const REGISTRY_ACCESS_TOKEN_REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

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

pub(crate) async fn registry_access_token(
    bridge: &BridgeConfig,
    client: &reqwest::Client,
) -> Result<String> {
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

/// The `/v2` client for the configured registry's origin. Its agent JWT is
/// the bootstrap access token the bridge already holds.
pub(crate) fn oci_registry(
    registry: &ImageRegistryConfig,
    bridge: &BridgeConfig,
    client: reqwest::Client,
) -> Result<OciRegistry> {
    let origin = registry_origin(registry)?;
    let bridge = bridge.clone();
    let token_client = client.clone();
    let agent_jwt: AgentJwt = Box::new(move || {
        let bridge = bridge.clone();
        let client = token_client.clone();
        Box::pin(async move { registry_access_token(&bridge, &client).await })
    });
    Ok(OciRegistry::new(origin, client, agent_jwt))
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
        info!(
            cache_root = %cache_root.display(),
            poll_interval_minutes = registry.refresh_interval_minutes,
            registry = %redact_url_userinfo(&registry.url),
            "starting image registry cache worker"
        );

        let refresh_context = refresh::CacheRefreshContext {
            bridge: &bridge,
            cache: &cache,
            db: &db,
            cache_root: &cache_root,
            vm: &vm,
        };
        // Startup prepares the pinned entries that the agent already knows
        // about. It never starts a full-cache repair: a pass covers only the
        // pins, and the incremental scrub covers them over several bounded
        // passes.
        run_cache_refresh_cycle(refresh_context, refresh::CacheRefreshScope::MissingOnly).await;

        let mut interval = tokio::time::interval(Duration::from_secs(
            registry.refresh_interval_minutes.saturating_mul(60),
        ));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            let scope = tokio::select! {
                _ = interval.tick() => refresh::CacheRefreshScope::Scrub,
                () = CACHE_REFRESH_WAKE.get_or_init(Notify::new).notified() => {
                    refresh::CacheRefreshScope::MissingOnly
                }
            };
            run_cache_refresh_cycle(refresh_context, scope).await;
        }
    });
}

pub fn default_cache_root() -> Result<PathBuf> {
    let base = dirs::cache_dir().ok_or_else(|| anyhow::anyhow!("cache dir unavailable"))?;
    Ok(base.join("intar-agent").join("images"))
}

fn validate_prepared_source(
    source: &ArtifactSource,
    image_hex: &str,
    file_name: &str,
    expected_sha256: &str,
    access: ArtifactAccess,
) -> Result<()> {
    anyhow::ensure!(
        source.source_root == PREPARED_IMAGE_SOURCE_ROOT
            && source.relative_path == PathBuf::from(image_hex).join(file_name)
            && source.sha256.as_ref().map(Sha256Digest::as_str) == Some(expected_sha256)
            && source.access == access,
        "launch descriptor prepared {file_name} source mismatch"
    );
    Ok(())
}

mod ready;
pub(crate) use ready::{
    ReadyImage, check_machine_config, check_prepared_wake, image_failure, mark_template_ready,
    record_image_failure, require_ready_image, sweep_cache_layout,
};
mod priority;
pub(crate) use priority::{
    BootCriticalGuard, begin_vm_boot_critical, vm_boot_critical, wait_for_vm_boot_idle,
};
mod budget;
mod hashing;
mod oci;
use hashing::hash_file_bounded;
pub(crate) use oci::{AgentJwt, BlobStore, MAX_WAKE_DELTA_BYTES, OciRegistry, PulledMachine};
mod pins;
pub(crate) use pins::RequiredPins;
mod refresh;
mod scheduler;
use refresh::*;

mod storage;
use storage::*;
mod registry;
use registry::*;
#[cfg(test)]
mod tests;

/// What the host reports about each pinned image.
pub(crate) fn cached_image_states(
    cache_root: &Path,
    pins: &RequiredPins,
) -> Vec<CachedImageStateV2> {
    let now = now_unix_ms();
    pins.images
        .iter()
        .map(|image| {
            let (phase, error) = if ready::is_image_ready(cache_root, image) {
                (ImageCachePhase::Ready, None)
            } else if let Some(error) = image_failure(image) {
                (ImageCachePhase::Failed, Some(error))
            } else {
                (ImageCachePhase::Missing, None)
            };
            CachedImageStateV2 {
                image: image.clone(),
                phase,
                bytes_on_disk: None,
                error,
                updated_at_unix_ms: now,
            }
        })
        .collect()
}
