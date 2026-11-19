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

#[test]
fn an_image_of_this_format_or_the_next_is_read_and_no_other() {
    let config = |format: &str| -> intar_contracts::oci::MachineConfigV1 {
        serde_json::from_value(serde_json::json!({
            "guest_contract": intar_contracts::guest::GUEST_CONTRACT,
            "image_format": format,
            "build_key": format!("sha256:{}", "a".repeat(64)),
            "boot": { "cmdline": "root=/dev/vda" },
            "disk": { "size_bytes": 4096, "chunk_size": 4096, "chunks": [] },
        }))
        .expect("config")
    };
    for read in [intar_contracts::oci::IMAGE_FORMAT, "intar-image-3"] {
        assert!(ready::check_machine_config(&config(read)).is_ok(), "{read}");
    }
    for refused in ["intar-image-2", "intar-image-5", ""] {
        let error = ready::check_machine_config(&config(refused)).expect_err(refused);
        assert!(ready::is_definitive_failure(
            &error.context("failed to cache image")
        ));
    }
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
