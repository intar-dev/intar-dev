use std::io::Write as _;
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::tls_provider::ensure_ring_provider;

use super::*;

#[test]
fn registry_access_token_cache_expires_and_redacts_its_value() {
    let now = Instant::now();
    let mut cache = RegistryAccessTokenCache::default();
    cache.replace("registry-secret".to_owned(), now);

    assert_eq!(cache.get(now).as_deref(), Some("registry-secret"));
    assert!(cache.get(now + REGISTRY_ACCESS_TOKEN_CACHE_TTL).is_none());
    assert!(!format!("{cache:?}").contains("registry-secret"));
    cache.clear();
    assert!(cache.get(now).is_none());
}

fn registry_config_for_url(url: &str) -> ImageRegistryConfig {
    ImageRegistryConfig {
        url: url.to_string(),
        username: None,
        password: None,
        refresh_interval_minutes: 15,
    }
}

mod layout;
mod registry;

#[tokio::test]
async fn a_failed_wake_prepare_leaves_the_image_ready_for_cold_boots() -> Result<()> {
    let image =
        OciDigest::try_from(format!("sha256:{}", "e".repeat(64))).map_err(anyhow::Error::msg)?;
    let cold_runs = AtomicUsize::new(0);
    let cold = || async {
        cold_runs.fetch_add(1, Ordering::SeqCst);
        Ok(())
    };

    // Not wanted: cold only.
    refresh::prepare_warm_or_cold(&image, None::<std::future::Ready<Result<()>>>, cold()).await?;
    assert_eq!(cold_runs.load(Ordering::SeqCst), 1);

    // Prepared with the guest: no cold prepare.
    refresh::prepare_warm_or_cold(&image, Some(async { Ok(()) }), cold()).await?;
    assert_eq!(cold_runs.load(Ordering::SeqCst), 1);
    assert!(ready::wake_prepare_failure(&image).is_none());

    // A requeue is no failure: it stays queued and nothing falls back.
    let requeued = refresh::prepare_warm_or_cold(
        &image,
        Some(async {
            Err(crate::vm::ImagePrepareRequeued {
                message: "boot".to_owned(),
            }
            .into())
        }),
        cold(),
    )
    .await;
    assert!(requeued.is_err());
    assert_eq!(cold_runs.load(Ordering::SeqCst), 1);

    // A failure prepares cold and is kept, so the pass does not retry it.
    refresh::prepare_warm_or_cold(
        &image,
        Some(async { Err(anyhow::anyhow!("jailerd wake_invalid")) }),
        cold(),
    )
    .await?;
    assert_eq!(cold_runs.load(Ordering::SeqCst), 2);
    assert!(ready::wake_prepare_failure(&image).is_some_and(|why| why.contains("wake_invalid")));
    Ok(())
}

#[test]
fn only_a_failure_no_retry_fixes_is_definitive() {
    for definitive in [
        "image_not_found: /v2/x is unknown or not granted to this host",
        "image_denied: GET /v2/x was refused with a fresh registry token",
        "digest_mismatch: /v2/x does not hash to its digest",
        "unsupported_artifact: image format \"intar-image-2\", this agent reads \"intar-image-3\"",
        "guest_contract_mismatch: the image speaks guest contract 2, this agent 3",
    ] {
        let error = anyhow::anyhow!(definitive).context("failed to cache image");
        assert!(ready::is_definitive_failure(&error), "{definitive}");
    }
    for transient in [
        "GET /v2/x failed with HTTP 503 Service Unavailable",
        "registry token exchange failed with HTTP 500",
        "reading /v2/x",
        "jailerd prepare_failed: no space left",
    ] {
        let error = anyhow::anyhow!(transient).context("failed to cache image");
        assert!(!ready::is_definitive_failure(&error), "{transient}");
    }
}
