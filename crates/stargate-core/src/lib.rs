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
    NativeTerminalAuthMode, NativeTerminalSession, RouteMetadata, SessionKind, TerminalSessionMode,
};
pub use model::{
    RegisteredRoute, RouteRecord, validate_route_username, validate_target_username,
    validate_terminal_session_request,
};
