mod config;
mod error;
mod model;

pub use config::{
    AdminAuthSettings, AssertionAuthSettings, ServerSettings, TerminalTokenSettings, TraceSettings,
    WebSettings,
};
pub use error::{Result, StargateError};
pub use intar_contracts::stargate::{
    BrowserTerminalSession, IssueTerminalSessionRequest, IssueTerminalSessionResponse,
    IssueWorkspaceAppSessionRequest, IssueWorkspaceAppSessionResponse, NativeTerminalAuthMode,
    NativeTerminalSession, RouteMetadata, SessionKind, TerminalSessionMode, WorkspaceAppProtocol,
};
pub use model::{
    RegisteredRoute, RegisteredWorkspaceAppRoute, RouteRecord, WorkspaceAppRouteRecord,
    validate_route_username, validate_target_username, validate_terminal_session_request,
    validate_workspace_app_session_request,
};
