use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const ROUTE_USERNAME_MAX_LEN: usize = 128;
pub const GENERATION_MAX_LEN: usize = 128;

/// Check the public SSH route name. Stargate prints this value, and the public
/// SSH server matches it against the path of an attach call, so it must stay
/// inside a small, non-ambiguous character set.
pub fn validate_route_username(username: &str) -> Result<(), String> {
    if username.is_empty() || username.len() > ROUTE_USERNAME_MAX_LEN {
        return Err(format!(
            "route_username must be 1..={ROUTE_USERNAME_MAX_LEN} characters"
        ));
    }
    if !username
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(
            "route_username may only contain ASCII letters, digits, '.', '_' and '-'".to_owned(),
        );
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    NativeSsh,
    BrowserTerminal,
    WorkspaceApp,
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

/// The complete SSH endpoint of one scenario VM terminal. Only the admin API
/// carries this value: `private_key_openssh` is the credential that reaches
/// the guest, and the gateway never sends it to a browser or a native client.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TerminalTarget {
    pub username: String,
    pub transport: SshTargetTransport,
    pub host_key_openssh: String,
    pub private_key_openssh: String,
    pub authorized_client_public_keys_openssh: Vec<String>,
}

/// One terminal route. A browser route starts pending: the route exists and a
/// browser socket can connect, but Stargate must not dial the guest yet. An
/// admin attach moves the route to ready, and only then does the PTY and the
/// recording start.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TerminalTargetState {
    Pending,
    Ready(Box<TerminalTarget>),
}

impl TerminalTargetState {
    pub fn ready_target(&self) -> Option<&TerminalTarget> {
        match self {
            Self::Pending => None,
            Self::Ready(target) => Some(target),
        }
    }
}

/// Route identity. Every field is mandatory and non-empty: a pending route
/// must name the host, the run, the VM, and the user that it belongs to.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RouteMetadata {
    pub host_id: String,
    pub run_id: String,
    pub vm_id: String,
    pub user_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct IssueTerminalSessionRequest {
    pub route_username: String,
    /// Opaque route generation. An attach call must repeat this exact string.
    pub generation: String,
    /// `pending` for a browser route. `ready` with the complete endpoint for a
    /// native route.
    pub target: TerminalTargetState,
    pub route_expires_at: i64,
    pub mode: TerminalSessionMode,
    pub metadata: RouteMetadata,
}

/// Stage a ready target on a pending browser route. The gateway stores the
/// target and returns an attachment identifier, but the route is still not
/// ready: no waiter wakes and no socket dials. The control plane activates the
/// attachment after its own admission fence.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StageTerminalTargetRequest {
    pub run_id: String,
    pub vm_id: String,
    pub user_id: String,
    pub generation: String,
    /// The complete target. There is no pending shape on a stage call: a call
    /// that carries no target is a validation error.
    pub target: TerminalTarget,
}

/// The identifier of one staged target. An identical repeat of a stage call
/// returns the same value, so a lost answer is safe to retry.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StageTerminalTargetResponse {
    pub attachment_id: String,
}

/// Activate one staged target. Only this call makes the route ready and wakes
/// the waiting browser socket.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ActivateTerminalTargetRequest {
    pub run_id: String,
    pub vm_id: String,
    pub user_id: String,
    pub generation: String,
    pub attachment_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<BrowserTerminalSession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<NativeTerminalSession>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAppProtocol {
    Http,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct IssueWorkspaceAppSessionRequest {
    /// Random, human-readable identifier generated by the control plane. It
    /// is a public route identity, not an authorization secret, and must not
    /// contain user-provided labels or resource names.
    pub route_id: String,
    /// Refuse to replace an existing route with this identifier.
    #[serde(default)]
    pub create_only: bool,
    pub target_username: String,
    /// Literal IP and port of the guest SSH endpoint already exposed to
    /// Stargate by the VM harness.
    pub transport: SshTargetTransport,
    pub target_host_key_openssh: String,
    pub target_private_key_openssh: String,
    /// Allowlisted application port inside the guest. Stargate reaches it
    /// through an SSH direct-tcpip channel; it is never published on the host.
    pub target_app_port: u16,
    pub protocol: WorkspaceAppProtocol,
    /// Optional virtual-host value sent only to the declared guest service.
    /// The public route hostname remains available as X-Forwarded-Host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_host: Option<String>,
    pub route_expires_at: i64,
    #[serde(default)]
    pub metadata: WorkspaceAppMetadata,
}

/// Workspace app routes keep optional metadata: they carry no terminal route
/// identity, and an absent value is not an authorization decision.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkspaceAppMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vm_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct IssueWorkspaceAppSessionResponse {
    pub route_id: String,
    /// URL containing a short-lived, single-use bootstrap capability. The
    /// public gateway exchanges it for a route-bound browser session and
    /// redirects to the same URL without the capability.
    pub url: String,
    pub bootstrap_expires_at: i64,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostRelayIdentity {
    pub host_id: String,
    pub session_id: String,
    pub credential_generation: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayService {
    Ssh,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RelayTarget {
    pub host: HostRelayIdentity,
    pub owner_id: String,
    pub execution_id: String,
    #[schemars(range(min = 1))]
    pub execution_generation: u64,
    pub vm_id: String,
    pub service: RelayService,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SshTargetTransport {
    Direct { host: String, port: u16 },
    Relay { target: RelayTarget },
}

impl HostRelayIdentity {
    pub fn validate(&self) -> std::io::Result<()> {
        relay_check(
            valid_relay_id(&self.host_id)
                && valid_relay_id(&self.session_id)
                && self.credential_generation > 0,
            "invalid relay host identity",
        )
    }
}
impl RelayTarget {
    pub fn validate(&self) -> std::io::Result<()> {
        self.host.validate()?;
        relay_check(
            [&self.owner_id, &self.execution_id, &self.vm_id]
                .into_iter()
                .all(|id| valid_relay_id(id))
                && self.execution_generation > 0,
            "invalid relay workload identity",
        )
    }
}
impl SshTargetTransport {
    pub fn validate(&self) -> std::io::Result<()> {
        match self {
            Self::Direct { host, port } => relay_check(
                host.parse::<std::net::IpAddr>().is_ok() && *port > 0,
                "direct SSH target requires a literal IP and nonzero port",
            ),
            Self::Relay { target } => target.validate(),
        }
    }
}
fn relay_check(valid: bool, message: &str) -> std::io::Result<()> {
    if valid {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            message,
        ))
    }
}
fn valid_relay_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}
