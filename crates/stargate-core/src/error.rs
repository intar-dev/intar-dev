use thiserror::Error;

#[derive(Debug, Error)]
pub enum StargateError {
    #[error("validation error: {0}")]
    Validation(String),
    #[error("route for username `{0}` was not found")]
    RouteNotFound(String),
    #[error("workspace application route `{0}` already exists")]
    WorkspaceAppRouteAlreadyExists(String),
    #[error("terminal route conflict: {0}")]
    TerminalRouteConflict(String),
    #[error("a terminal socket is already open for this route generation")]
    TerminalSocketAlreadyOpen,
    #[error("the terminal target did not attach before the deadline")]
    TerminalTargetTimeout,
    #[error("unauthorized")]
    Unauthorized,
    #[error("database error: {0}")]
    Database(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("ssh key error: {0}")]
    SshKey(#[from] russh::keys::Error),
    #[error("ssh public key error: {0}")]
    PublicKey(#[from] russh::keys::ssh_key::Error),
    #[error("utf8 error: {0}")]
    Utf8(#[from] std::str::Utf8Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("internal error: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, StargateError>;
