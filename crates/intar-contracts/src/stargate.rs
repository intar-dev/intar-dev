use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    NativeSsh,
    BrowserTerminal,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionMode {
    Browser,
    Native,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeTerminalAuthMode {
    ProfileKeys,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RouteMetadata {
    pub host_id: Option<String>,
    pub run_id: Option<String>,
    pub vm_id: Option<String>,
    pub user_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct IssueTerminalSessionRequest {
    pub route_username: String,
    pub target_username: String,
    pub target_ip: String,
    pub target_port: u16,
    pub target_host_key_openssh: String,
    pub target_private_key_openssh: String,
    #[serde(default)]
    pub authorized_client_public_keys_openssh: Vec<String>,
    pub route_expires_at: i64,
    pub mode: TerminalSessionMode,
    #[serde(default)]
    pub metadata: RouteMetadata,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BrowserTerminalSession {
    pub websocket_url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NativeTerminalSession {
    pub auth_mode: NativeTerminalAuthMode,
    pub authorized_key_count: usize,
    pub ssh_host: String,
    pub ssh_port: u16,
    pub username: String,
    pub public_host_key_openssh: String,
    pub public_host_key_fingerprint_sha256: String,
    pub known_hosts_line: String,
    pub command: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct IssueTerminalSessionResponse {
    pub route_username: String,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser: Option<BrowserTerminalSession>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native: Option<NativeTerminalSession>,
}
