//! The credential a scenario repository's pipeline pushes its images with
//! (#441). A GitHub OIDC token lives for minutes and an image uploads for
//! longer, so the pipeline trades one for a session token on
//! `POST /registry/v1/pipeline/sessions` and pushes under that.

use std::time::Duration;

use reqwest::StatusCode;
use reqwest::blocking::Client;

use crate::error::{Error, Result};

const SESSIONS_ROUTE: &str = "registry/v1/pipeline/sessions";
/// The bundle of the commit is still being read: the session opens once it is.
const BUNDLE_PENDING_CODE: &str = "bundle_pending";
/// The source has as many sessions open as it may.
const SESSION_LIMIT_CODE: &str = "pipeline_session_limit";
/// How often an open is tried while the bundle is read or the source's
/// sessions are all taken: with the waits the service names (5 s), a few
/// minutes.
const OPEN_ATTEMPTS: u32 = 40;
/// Tries of an open that fails for another passing reason: no answer, a 429
/// or a 5xx.
const FAILED_ATTEMPTS: u32 = 5;
const DEFAULT_WAIT: Duration = Duration::from_secs(5);
const WAIT_CAP: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// An open pipeline session: its token is the registry credential of
/// [`crate::RegistryPusher`].
pub struct PipelineSession {
    token: String,
    close_url: url::Url,
    client: Client,
}

impl PipelineSession {
    /// Opens the session of the run `oidc_token` names, for the bundle `rev`.
    ///
    /// # Errors
    /// Returns the refusal, or the last failure once the tries are used up.
    pub fn open(base_url: &str, oidc_token: &str, rev: &str) -> Result<Self> {
        Self::open_with(base_url, oidc_token, rev, DEFAULT_WAIT)
    }

    pub(crate) fn open_with(
        base_url: &str,
        oidc_token: &str,
        rev: &str,
        default_wait: Duration,
    ) -> Result<Self> {
        #[derive(serde::Deserialize)]
        struct Opened {
            token: String,
        }
        let url = url::Url::parse(&format!(
            "{}/{SESSIONS_ROUTE}",
            base_url.trim().trim_end_matches('/')
        ))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(Error::InvalidConfig("the registry URL must be http(s)"));
        }
        if oidc_token.trim().is_empty() {
            return Err(Error::InvalidConfig("the OIDC token is empty"));
        }
        let client = Client::builder().timeout(REQUEST_TIMEOUT).build()?;
        let body = serde_json::json!({ "rev": rev });
        let mut attempt = 1;
        let mut failures = 0;
        loop {
            let sent = client
                .post(url.clone())
                .bearer_auth(oidc_token.trim())
                .json(&body)
                .send();
            let wait = match sent {
                Ok(response) => {
                    let status = response.status();
                    let wait = retry_after(response.headers());
                    let text = response.text()?;
                    if status.is_success() {
                        let opened: Opened = serde_json::from_str(&text)?;
                        return Ok(Self {
                            token: opened.token,
                            close_url: url.join("sessions/close")?,
                            client,
                        });
                    }
                    // The bundle is still read, or the source has its sessions
                    // all open: other jobs of the same run close theirs soon.
                    let code = code_of(&text);
                    let pending = (status == StatusCode::CONFLICT
                        && code.as_deref() == Some(BUNDLE_PENDING_CODE))
                        || (status == StatusCode::TOO_MANY_REQUESTS
                            && code.as_deref() == Some(SESSION_LIMIT_CODE));
                    let failed = !pending
                        && (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error());
                    failures += u32::from(failed);
                    if !(pending || failed)
                        || attempt >= OPEN_ATTEMPTS
                        || failures >= FAILED_ATTEMPTS
                    {
                        return Err(Error::HttpStatus { status, body: text });
                    }
                    wait.unwrap_or(default_wait)
                }
                Err(error) => {
                    failures += 1;
                    if failures >= FAILED_ATTEMPTS || error.is_builder() {
                        return Err(Error::Http(error));
                    }
                    default_wait
                }
            };
            std::thread::sleep(wait);
            attempt += 1;
        }
    }

    /// The session's token.
    #[must_use]
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Closes the session. It ends by itself after an hour; closing it frees
    /// its place among the source's open sessions at once.
    ///
    /// # Errors
    /// Returns an error when the service does not confirm the close.
    pub fn close(self) -> Result<()> {
        let response = self
            .client
            .post(self.close_url)
            .bearer_auth(&self.token)
            .send()?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        Err(Error::HttpStatus {
            status,
            body: response.text().unwrap_or_default(),
        })
    }
}

fn code_of(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("code")?
        .as_str()
        .map(str::to_owned)
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let seconds: u64 = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(seconds).min(WAIT_CAP))
}
