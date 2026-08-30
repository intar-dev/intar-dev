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

mod eviction;
mod registry;
mod tools;
