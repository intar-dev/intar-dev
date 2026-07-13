#![forbid(unsafe_code)]

use std::path::Path;

use anyhow::Result;
use serde::Deserialize;
use std::net::SocketAddr;
use std::path::PathBuf;

const EXAMPLE_TOML: &str = include_str!("../deploy/config.example.toml");

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
pub struct AgentConfig {
    pub server: ServerConfig,
    pub cloud_hypervisor: CloudHypervisorConfig,
    pub jailer: JailerClientConfig,
    pub bridge: BridgeConfig,
    pub ssh_access: SshAccessConfig,
    pub vm_defaults: VmDefaultsConfig,
    pub image_registry: ImageRegistryConfig,
    pub image_cache: ImageCacheConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ServerConfig {
    pub bind: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8080".to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct CloudHypervisorConfig {
    pub spawn_timeout_seconds: u64,
}

impl Default for CloudHypervisorConfig {
    fn default() -> Self {
        Self {
            spawn_timeout_seconds: 10,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct JailerClientConfig {
    /// Root-owned SOCK_SEQPACKET endpoint exposed by intar-jailerd.
    pub socket: PathBuf,
    /// Bound all local privileged requests so bridge reconciliation cannot
    /// hang indefinitely behind an unhealthy supervisor.
    pub request_timeout_seconds: u64,
}

impl Default for JailerClientConfig {
    fn default() -> Self {
        Self {
            socket: PathBuf::from("/run/intar-jailerd/control.sock"),
            request_timeout_seconds: 10,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct BridgeConfig {
    pub enabled: bool,
    pub base_url: String,
    pub host_id: String,
    pub bootstrap_token: String,
    pub heartbeat_interval_seconds: u64,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: String::new(),
            host_id: String::new(),
            bootstrap_token: String::new(),
            heartbeat_interval_seconds: 30,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct SshAccessConfig {
    pub enabled: bool,
    pub public_port_start: u16,
    pub public_port_end: u16,
    pub advertised_host: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct VmDefaultsConfig {
    /// Prefix used for dynamically created tap devices.
    pub tap: String,
    /// Optional working directory for per-VM artifacts.
    pub work_dir: Option<PathBuf>,
    pub resources: VmResourcesConfig,
    pub network: VmNetworkConfig,
}

impl Default for VmDefaultsConfig {
    fn default() -> Self {
        Self {
            tap: "tap0".to_string(),
            work_dir: None,
            resources: VmResourcesConfig::default(),
            network: VmNetworkConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct VmResourcesConfig {
    pub vcpus: u32,
    pub memory_mib: u32,
}

impl Default for VmResourcesConfig {
    fn default() -> Self {
        Self {
            vcpus: 2,
            memory_mib: 2048,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct VmNetworkConfig {
    pub guest_cidr: String,
    pub dns: Vec<String>,
}

impl Default for VmNetworkConfig {
    fn default() -> Self {
        Self {
            guest_cidr: "10.77.0.0/16".to_string(),
            dns: vec!["1.1.1.1".to_string(), "8.8.8.8".to_string()],
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ImageRegistryConfig {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub refresh_interval_minutes: u64,
}

impl Default for ImageRegistryConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: None,
            password: None,
            refresh_interval_minutes: 15,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
pub struct ImageCacheConfig {
    /// Maximum bytes for raw image and direct-boot artifact cache, or unbounded.
    pub max_bytes: Option<u64>,
}

pub fn redact_url_userinfo(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Ok(mut parsed) = reqwest::Url::parse(trimmed) {
        if !parsed.username().is_empty() || parsed.password().is_some() {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            return parsed.to_string();
        }
        return trimmed.to_string();
    }

    manual_redact_url_userinfo(trimmed)
}

fn manual_redact_url_userinfo(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let authority_start = scheme_end + 3;
    let authority_end = url[authority_start..]
        .find(['/', '?', '#'])
        .map(|offset| authority_start + offset)
        .unwrap_or(url.len());
    let authority = &url[authority_start..authority_end];
    let Some(userinfo_end) = authority.rfind('@') else {
        return url.to_string();
    };

    format!(
        "{}{}",
        &url[..authority_start],
        &url[authority_start + userinfo_end + 1..]
    )
}

pub fn load(path: &Path) -> Result<AgentConfig> {
    if !path.is_file() {
        anyhow::bail!(
            "config file not found at {}\n\nExample config:\n{EXAMPLE_TOML}",
            path.display()
        );
    }

    let content = std::fs::read_to_string(path).map_err(|e| {
        anyhow::anyhow!(
            "failed to read config file at {}: {e}\n\nExample config:\n{EXAMPLE_TOML}",
            path.display()
        )
    })?;

    let mut cfg = toml::from_str::<AgentConfig>(&content).map_err(|e| {
        anyhow::anyhow!(
            "failed to parse config TOML at {}: {e}\n\nExample config:\n{EXAMPLE_TOML}",
            path.display()
        )
    })?;

    if cfg.cloud_hypervisor.spawn_timeout_seconds == 0 {
        anyhow::bail!(
            "config value cloud_hypervisor.spawn_timeout_seconds must be >= 1\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }
    if !cfg.jailer.socket.is_absolute() {
        anyhow::bail!(
            "config value jailer.socket must be an absolute path\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }
    if cfg.jailer.request_timeout_seconds == 0 {
        anyhow::bail!(
            "config value jailer.request_timeout_seconds must be >= 1\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }

    cfg.server.bind = cfg.server.bind.trim().to_string();
    if cfg.server.bind.is_empty() {
        anyhow::bail!(
            "config value server.bind must not be empty\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }
    let bind = cfg.server.bind.parse::<SocketAddr>().map_err(|e| {
        anyhow::anyhow!(
            "config value server.bind must be a socket address like 127.0.0.1:8080: {e}\n\nExample config:\n{EXAMPLE_TOML}"
        )
    })?;
    cfg.server.bind = bind.to_string();

    cfg.bridge.base_url = cfg.bridge.base_url.trim_end_matches('/').to_string();
    cfg.bridge.host_id = cfg.bridge.host_id.trim().to_string();
    cfg.bridge.bootstrap_token = cfg.bridge.bootstrap_token.trim().to_string();
    if cfg.bridge.enabled {
        if cfg.bridge.base_url.is_empty() {
            anyhow::bail!(
                "config value bridge.base_url must not be empty when bridge.enabled is true\n\nExample config:\n{EXAMPLE_TOML}"
            );
        }
        if !(cfg.bridge.base_url.starts_with("http://")
            || cfg.bridge.base_url.starts_with("https://"))
        {
            anyhow::bail!(
                "config value bridge.base_url must start with http:// or https://\n\nExample config:\n{EXAMPLE_TOML}"
            );
        }
        if cfg.bridge.host_id.is_empty() {
            anyhow::bail!(
                "config value bridge.host_id must not be empty when bridge.enabled is true\n\nExample config:\n{EXAMPLE_TOML}"
            );
        }
        if !is_safe_image_key(&cfg.bridge.host_id) {
            anyhow::bail!(
                "config value bridge.host_id must match [A-Za-z0-9_-]+\n\nExample config:\n{EXAMPLE_TOML}"
            );
        }
        if cfg.bridge.bootstrap_token.is_empty() {
            anyhow::bail!(
                "config value bridge.bootstrap_token must not be empty when bridge.enabled is true\n\nExample config:\n{EXAMPLE_TOML}"
            );
        }
        if cfg.bridge.heartbeat_interval_seconds == 0 {
            anyhow::bail!(
                "config value bridge.heartbeat_interval_seconds must be >= 1\n\nExample config:\n{EXAMPLE_TOML}"
            );
        }
    }

    cfg.ssh_access.advertised_host = cfg
        .ssh_access
        .advertised_host
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if cfg.ssh_access.enabled {
        if cfg.ssh_access.public_port_start == 0 || cfg.ssh_access.public_port_end == 0 {
            anyhow::bail!(
                "config values ssh_access.public_port_start and ssh_access.public_port_end must be >= 1 when ssh_access.enabled is true\n\nExample config:\n{EXAMPLE_TOML}"
            );
        }
        if cfg.ssh_access.public_port_end < cfg.ssh_access.public_port_start {
            anyhow::bail!(
                "config value ssh_access.public_port_end must be >= ssh_access.public_port_start\n\nExample config:\n{EXAMPLE_TOML}"
            );
        }
    }

    cfg.vm_defaults.tap = cfg.vm_defaults.tap.trim().to_string();
    if cfg.vm_defaults.tap.is_empty() {
        anyhow::bail!(
            "config value vm_defaults.tap must not be empty\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }

    cfg.vm_defaults.network.guest_cidr = cfg.vm_defaults.network.guest_cidr.trim().to_string();
    if cfg.vm_defaults.network.guest_cidr.is_empty() {
        anyhow::bail!(
            "config value vm_defaults.network.guest_cidr must not be empty\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }
    if cfg.vm_defaults.network.dns.is_empty() {
        anyhow::bail!(
            "config value vm_defaults.network.dns must include at least one resolver\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }
    for dns in &mut cfg.vm_defaults.network.dns {
        *dns = dns.trim().to_string();
        if dns.is_empty() {
            anyhow::bail!(
                "config value vm_defaults.network.dns must not contain empty entries\n\nExample config:\n{EXAMPLE_TOML}"
            );
        }
    }
    cfg.image_registry.url = cfg.image_registry.url.trim_end_matches('/').to_string();
    if cfg.image_registry.url.is_empty() {
        anyhow::bail!(
            "config value image_registry.url must not be empty\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }
    if !(cfg.image_registry.url.starts_with("http://")
        || cfg.image_registry.url.starts_with("https://"))
    {
        anyhow::bail!(
            "config value image_registry.url must start with http:// or https://\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }
    cfg.image_registry.username = cfg
        .image_registry
        .username
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    cfg.image_registry.password = cfg
        .image_registry
        .password
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if cfg.image_registry.username.is_none() && cfg.image_registry.password.is_some() {
        anyhow::bail!(
            "config value image_registry.password requires image_registry.username\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }
    if cfg.image_registry.refresh_interval_minutes == 0 {
        anyhow::bail!(
            "config value image_registry.refresh_interval_minutes must be >= 1\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }

    if cfg.image_cache.max_bytes == Some(0) {
        anyhow::bail!(
            "config value image_cache.max_bytes must be >= 1 when set\n\nExample config:\n{EXAMPLE_TOML}"
        );
    }

    Ok(cfg)
}

fn is_safe_image_key(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(crate) fn normalize_sha256(s: &str) -> Option<String> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    if !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(s.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_parses_valid_toml() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[cloud_hypervisor]
spawn_timeout_seconds = 10
[image_registry]
url = "https://example.com/images"
"#,
        )?;

        let cfg = load(&path)?;
        assert_eq!(cfg.cloud_hypervisor.spawn_timeout_seconds, 10);
        assert_eq!(
            cfg.jailer.socket,
            PathBuf::from("/run/intar-jailerd/control.sock")
        );
        Ok(())
    }

    #[test]
    fn load_rejects_unknown_keys() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[cloud_hypervisor]
base_url = "http://127.0.0.1:12345"
[image_registry]
url = "https://example.com/images"
"#,
        )?;

        match load(&path) {
            Ok(_) => anyhow::bail!("expected config load to fail due to unknown key"),
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("unknown field") || msg.contains("unknown key"),
                    "unexpected error message: {msg}"
                );
            }
        }

        Ok(())
    }

    #[test]
    fn load_rejects_relative_jailerd_socket() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[jailer]
socket = "run/intar-jailerd/control.sock"
[image_registry]
url = "https://example.com/images"
"#,
        )?;

        let error = load(&path).expect_err("relative jailerd socket must fail");
        assert!(
            error
                .to_string()
                .contains("jailer.socket must be an absolute path"),
            "unexpected error: {error}"
        );
        Ok(())
    }

    #[test]
    fn load_rejects_zero_jailerd_timeout() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[jailer]
request_timeout_seconds = 0
[image_registry]
url = "https://example.com/images"
"#,
        )?;

        let error = load(&path).expect_err("zero jailerd timeout must fail");
        assert!(
            error
                .to_string()
                .contains("jailer.request_timeout_seconds must be >= 1"),
            "unexpected error: {error}"
        );
        Ok(())
    }

    #[test]
    fn load_errors_on_missing_file() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("missing.toml");

        match load(&path) {
            Ok(_) => anyhow::bail!("expected config load to fail due to missing file"),
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("config file not found"),
                    "unexpected error message: {msg}"
                );
            }
        }

        Ok(())
    }

    #[test]
    fn load_parses_image_registry() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[image_registry]
url = "https://example.com/images/"
username = " demo "
password = " secret "
refresh_interval_minutes = 7
"#,
        )?;

        let cfg = load(&path)?;
        assert_eq!(cfg.image_registry.url, "https://example.com/images");
        assert_eq!(cfg.image_registry.username.as_deref(), Some("demo"));
        assert_eq!(cfg.image_registry.password.as_deref(), Some("secret"));
        assert_eq!(cfg.image_registry.refresh_interval_minutes, 7);
        Ok(())
    }

    #[test]
    fn load_parses_image_cache_limit() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[image_registry]
url = "https://example.com/images"
[image_cache]
max_bytes = 53687091200
"#,
        )?;

        let cfg = load(&path)?;
        assert_eq!(cfg.image_cache.max_bytes, Some(53_687_091_200));
        Ok(())
    }

    #[test]
    fn load_rejects_zero_image_cache_limit() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[image_registry]
url = "https://example.com/images"
[image_cache]
max_bytes = 0
"#,
        )?;

        match load(&path) {
            Ok(_) => anyhow::bail!("expected zero cache limit to fail"),
            Err(error) => {
                let message = error.to_string();
                assert!(
                    message.contains("image_cache.max_bytes must be >= 1"),
                    "unexpected error message: {message}"
                );
            }
        }
        Ok(())
    }

    #[test]
    fn load_parses_server_bind() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[server]
bind = "127.0.0.1:5555"
[image_registry]
url = "https://example.com/images"
"#,
        )?;

        let cfg = load(&path)?;
        assert_eq!(cfg.server.bind, "127.0.0.1:5555");
        Ok(())
    }

    #[test]
    fn redact_url_userinfo_strips_credentials_from_valid_urls() {
        let got = redact_url_userinfo("https://user:secret@example.com/path/image.raw.zst");
        assert_eq!(got, "https://example.com/path/image.raw.zst");
    }

    #[test]
    fn redact_url_userinfo_best_effort_strips_credentials_from_invalid_urls() {
        let got = redact_url_userinfo("https://user:abc%sm@example.com/path/image.raw.zst");
        assert_eq!(got, "https://example.com/path/image.raw.zst");
    }

    #[test]
    fn load_rejects_registry_password_without_username() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[image_registry]
url = "https://example.com/images"
password = "secret"
"#,
        )?;

        match load(&path) {
            Ok(_) => anyhow::bail!("expected config load to fail"),
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("image_registry.password requires image_registry.username"),
                    "unexpected error message: {msg}"
                );
            }
        }

        Ok(())
    }

    #[test]
    fn load_rejects_zero_registry_refresh_interval() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[image_registry]
url = "https://example.com/images"
refresh_interval_minutes = 0
"#,
        )?;

        match load(&path) {
            Ok(_) => anyhow::bail!("expected config load to fail"),
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("image_registry.refresh_interval_minutes must be >= 1"),
                    "unexpected error message: {msg}"
                );
            }
        }

        Ok(())
    }
}
