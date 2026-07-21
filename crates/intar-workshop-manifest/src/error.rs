use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkshopManifestError {
    #[error("failed to read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse workshop.hcl: {0}")]
    Parse(String),
    #[error("invalid workshop manifest: {0}")]
    Invalid(String),
    #[error("failed to build workshop bundle: {0}")]
    Bundle(String),
}

pub(crate) type Result<T> = std::result::Result<T, WorkshopManifestError>;

pub(crate) fn invalid(message: impl Into<String>) -> WorkshopManifestError {
    WorkshopManifestError::Invalid(message.into())
}
