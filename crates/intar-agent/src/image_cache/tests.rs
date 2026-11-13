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
