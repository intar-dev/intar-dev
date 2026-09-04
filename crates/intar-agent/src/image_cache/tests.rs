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

mod registry;
mod tools;
