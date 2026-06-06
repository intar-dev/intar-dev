use thiserror::Error;

#[derive(Debug, Error)]
pub enum StargateError {
    #[error("validation error: {0}")]
    Validation(String),
    #[error("route already exists for username `{0}`")]
    RouteAlreadyExists(String),
    #[error("route for username `{0}` was not found")]
    RouteNotFound(String),
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
