mod config;
mod error;
pub mod relay;
mod terminal;
mod workspace_app;

pub use config::{
    AdminAuthSettings, AssertionAuthSettings, ServerSettings, TerminalTokenSettings, TraceSettings,
    WebSettings,
};
pub use error::{Result, StargateError};
pub use intar_contracts::stargate::{
    ActivateTerminalTargetRequest, BrowserTerminalSession, IssueTerminalSessionRequest,
    IssueTerminalSessionResponse, IssueWorkspaceAppSessionRequest,
    IssueWorkspaceAppSessionResponse, NativeTerminalAuthMode, NativeTerminalSession, RouteMetadata,
    SessionKind, SshTargetTransport, StageTerminalTargetRequest, StageTerminalTargetResponse,
    TerminalSessionMode, TerminalTarget, TerminalTargetState, WorkspaceAppMetadata,
    WorkspaceAppProtocol, validate_route_username,
};
pub use terminal::{
    ROUTE_TTL, StoredTarget, StoredTerminalRoute, allows_client_public_key,
    authorized_client_public_keys, new_attachment_id, parse_target_host_key,
    parse_target_private_key, validate_activate_request, validate_stage_request,
    validate_target_username, validate_terminal_session_request,
};
pub use workspace_app::{
    RegisteredWorkspaceAppRoute, WorkspaceAppRouteRecord, validate_workspace_app_route_id,
    validate_workspace_app_session_request,
};
