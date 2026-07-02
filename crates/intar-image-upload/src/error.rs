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
            Self::InvalidConfig(_)
            | Self::InvalidKey(_)
            | Self::InvalidPath(_)
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
