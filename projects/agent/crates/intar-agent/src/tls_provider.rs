#![forbid(unsafe_code)]

use std::sync::OnceLock;

use anyhow::{Result, anyhow};

static RING_PROVIDER_INIT: OnceLock<Result<(), String>> = OnceLock::new();

pub fn ensure_ring_provider() -> Result<()> {
    match RING_PROVIDER_INIT.get_or_init(init_ring_provider) {
        Ok(()) => Ok(()),
        Err(message) => Err(anyhow!("{message}")),
    }
}

fn init_ring_provider() -> Result<(), String> {
    if rustls::crypto::CryptoProvider::get_default().is_some() {
        return Ok(());
    }

    let _ = rustls::crypto::ring::default_provider().install_default();

    if rustls::crypto::CryptoProvider::get_default().is_some() {
        Ok(())
    } else {
        Err("rustls crypto provider is not installed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_ring_provider_is_idempotent() {
        ensure_ring_provider().expect("ring provider should install");
        ensure_ring_provider().expect("ring provider should remain installed");
    }
}
