use std::net::SocketAddr;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AssertionAuthSettings {
    #[serde(default = "default_assertion_header")]
    pub assertion_header: String,
    pub audience: String,
    pub issuer: String,
    pub jwks_url: Option<url::Url>,
    pub hs256_secret: Option<String>,
}

pub type AdminAuthSettings = AssertionAuthSettings;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WebSettings {
    pub bind: SocketAddr,
    pub public_base_url: url::Url,
    pub public_ssh_host: String,
    #[serde(default = "default_public_ssh_port")]
    pub public_ssh_port: u16,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// Optional wildcard suffix used for private workspace applications.
    /// `workshop-apps.intar.dev` produces
    /// `https://<route-id>.workshop-apps.intar.dev/`.
    #[serde(default)]
    pub workspace_app_base_domain: Option<String>,
    /// Time available to exchange the one-time capability returned by the
    /// workspace-app issuance API.
    #[serde(default = "default_workspace_app_bootstrap_ttl_seconds")]
    pub workspace_app_bootstrap_ttl_seconds: u64,
    /// Maximum lifetime of the opaque, route-bound browser session. The
    /// effective lifetime is also capped by the route expiry.
    #[serde(default = "default_workspace_app_session_ttl_seconds")]
    pub workspace_app_session_ttl_seconds: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TerminalTokenSettings {
    pub issuer: String,
    pub audience: String,
    pub hs256_secret: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TraceSettings {
    #[serde(default = "default_log_filter")]
    pub filter: String,
    #[serde(default)]
    pub json: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServerSettings {
    pub admin_bind: SocketAddr,
    pub ssh_bind: SocketAddr,
    pub web: WebSettings,
    pub database_path: PathBuf,
    pub host_key_path: PathBuf,
    pub admin_auth: AdminAuthSettings,
    pub terminal_tokens: TerminalTokenSettings,
    #[serde(default = "default_state_dir")]
    pub state_dir: PathBuf,
    #[serde(default)]
    pub trace: Option<TraceSettings>,
}

fn default_assertion_header() -> String {
    "cf-access-jwt-assertion".to_owned()
}

fn default_log_filter() -> String {
    "info,stargate=debug".to_owned()
}

fn default_public_ssh_port() -> u16 {
    22
}

fn default_workspace_app_bootstrap_ttl_seconds() -> u64 {
    60
}

fn default_workspace_app_session_ttl_seconds() -> u64 {
    15 * 60
}

fn default_state_dir() -> PathBuf {
    PathBuf::from("/var/lib/stargate")
}
