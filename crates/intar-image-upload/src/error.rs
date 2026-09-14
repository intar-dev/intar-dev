use std::fmt;
use std::io;

#[derive(Debug)]
pub enum Error {
    InvalidConfig(&'static str),
    InvalidKey(String),
    InvalidPath(String),
    Io(io::Error),
    Json(serde_json::Error),
    Http(reqwest::Error),
    Url(url::ParseError),
    HttpStatus {
        status: reqwest::StatusCode,
        body: String,
    },
    /// The registry admission session stopped protecting this upload. A session
    /// whose heartbeats stop leaves its unresolved writer row in place, and that
    /// row keeps blocking every destructive sweep: the registry does not take an
    /// abandoned upload over on a timer, an operator resolves it. A failure here
    /// never replaces the upload error it wraps.
    SessionBroken {
        session_id: String,
        detail: String,
        cause: Option<Box<Error>>,
    },
    /// A chunk the registry no longer stores has no local payload either, so
    /// the bytes exist nowhere and no retry of this upload can succeed. A
    /// builder rebuilds the image instead of retrying the publication; the
    /// chunk is named so the caller can report which reuse it depended on.
    MissingImageChunkPayload {
        raw_sha256: String,
    },
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(message) => write!(f, "invalid upload config: {message}"),
            Self::InvalidKey(key) => write!(f, "invalid upload key: {key}"),
            Self::InvalidPath(path) => write!(f, "invalid upload path: {path}"),
            Self::Io(err) => write!(f, "i/o error: {err}"),
            Self::Json(err) => write!(f, "json error: {err}"),
            Self::Http(err) => write!(f, "http error: {err}"),
            Self::Url(err) => write!(f, "url parse error: {err}"),
            Self::HttpStatus { status, body } => {
                write!(f, "registry publish failed with HTTP {status}: {body}")
            }
            Self::SessionBroken {
                session_id, detail, ..
            } => write!(f, "upload session {session_id} failed: {detail}"),
            Self::MissingImageChunkPayload { raw_sha256 } => write!(
                f,
                "no local payload for image chunk {raw_sha256}, and the registry no longer stores it"
            ),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            Self::Json(err) => Some(err),
            Self::Http(err) => Some(err),
            Self::Url(err) => Some(err),
            Self::SessionBroken {
                cause: Some(cause), ..
            } => Some(cause.as_ref()),
            Self::InvalidConfig(_)
            | Self::InvalidKey(_)
            | Self::InvalidPath(_)
            | Self::MissingImageChunkPayload { .. }
            | Self::SessionBroken { cause: None, .. }
            | Self::HttpStatus { .. } => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<url::ParseError> for Error {
    fn from(value: url::ParseError) -> Self {
        Self::Url(value)
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl From<reqwest::Error> for Error {
    fn from(value: reqwest::Error) -> Self {
        Self::Http(value)
    }
}
