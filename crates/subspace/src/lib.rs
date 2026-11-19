//! Client of the desktop app's channel to intar (#399).
//!
//! [`SignIn`] signs the learner in through the browser: authorization code
//! with PKCE, returned to a loopback port. [`Subspace`] then starts, reads,
//! ends and reports on local runs with the access token as its bearer
//! credential, and refreshes the token once when the server refuses it.
//!
//! The caller opens the browser and stores the tokens; nothing here touches
//! a keychain or a window.

pub mod contract;

use std::time::{Duration, SystemTime};

use crate::contract::{
    LocalCatalogV1, LocalRunAnswerV1, LocalRunRefusalV1, LocalRunReportV1, LocalRunV1,
    SUBSPACE_OAUTH_CLIENT_ID, SUBSPACE_OAUTH_SCOPE, SUBSPACE_PROTOCOL_VERSION, StartLocalRunV1,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use intar_contracts::bridge_v9::VmStateV3;
use intar_contracts::run_cli::{
    RUN_CLI_MAX_FRAME_BYTES, RunCliRequestV1, RunCliResponseV1, RunCliResultV1,
};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use url::Url;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// No usable sign-in: the learner has to sign in again.
    #[error("signed out")]
    SignedOut,
    /// The server refused the request. `run` is the closed run on `run_closed`.
    #[error("{message} ({code})")]
    Refused {
        status: u16,
        code: String,
        message: String,
        run: Option<Box<LocalRunV1>>,
    },
    /// The browser came back without a usable authorization code.
    #[error("sign-in failed: {0}")]
    SignIn(String),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
    #[error("no random bytes: {0}")]
    Random(String),
}

/// The desktop app's archive routes.
const ARCHIVE: &str = "/api/local/archive";

/// One session's replay, as `dhd` renders it.
pub struct ArchiveCastV1 {
    pub filename: String,
    pub bytes: Vec<u8>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// An archive route's answer as JSON, or the refusal it sent.
async fn archive_answer(
    path: &str,
    response: reqwest::Response,
) -> Result<serde_json::Value, Error> {
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    if status.is_success() {
        return Ok(body);
    }
    let said = |field: &str| {
        body.get(field)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
    };
    Err(Error::Refused {
        status: status.as_u16(),
        code: said("code").to_owned(),
        message: format!("intar refused {path} with {status}: {}", said("error")),
        run: None,
    })
}

/// What the caller stores between launches.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Seconds since the Unix epoch.
    pub expires_at: u64,
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

async fn token_request(
    http: &reqwest::Client,
    base: &Url,
    fields: &[(&str, &str)],
) -> Result<Tokens, Error> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", SUBSPACE_OAUTH_CLIENT_ID)
        .extend_pairs(fields)
        .finish();
    let response = http
        .post(base.join("/api/auth/oauth2/token")?)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?;
    if !response.status().is_success() {
        // The provider refuses a spent code and a revoked refresh token alike.
        return Err(Error::SignedOut);
    }
    let answer: TokenAnswer = response.json().await?;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();
    Ok(Tokens {
        access_token: answer.access_token,
        refresh_token: answer.refresh_token,
        expires_at: now + answer.expires_in.unwrap_or(0),
    })
}

fn random_token() -> Result<String, Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| Error::Random(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// One browser sign-in, from the link to open to the tokens.
pub struct SignIn {
    base: Url,
    listener: TcpListener,
    redirect_uri: String,
    verifier: String,
    state: String,
    authorize_url: Url,
}

impl SignIn {
    /// Listens on a free loopback port and builds the link to open.
    pub async fn begin(base: &Url) -> Result<Self, Error> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let redirect_uri = format!(
            "http://127.0.0.1:{}/callback",
            listener.local_addr()?.port()
        );
        let verifier = random_token()?;
        let state = random_token()?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut authorize_url = base.join("/api/auth/oauth2/authorize")?;
        authorize_url
            .query_pairs_mut()
            .append_pair("client_id", SUBSPACE_OAUTH_CLIENT_ID)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("scope", SUBSPACE_OAUTH_SCOPE)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(Self {
            base: base.clone(),
            listener,
            redirect_uri,
            verifier,
            state,
            authorize_url,
        })
    }

    /// The link the caller opens in the learner's browser.
    pub fn authorize_url(&self) -> &Url {
        &self.authorize_url
    }

    /// Waits for the browser to come back and exchanges the code. It waits
    /// as long as the learner takes; the caller sets the time limit.
    pub async fn finish(self, http: &reqwest::Client) -> Result<Tokens, Error> {
        let code = loop {
            let (mut stream, _) = self.listener.accept().await?;
            let mut buffer = [0_u8; 4096];
            let read = stream.read(&mut buffer).await?;
            let request = String::from_utf8_lossy(&buffer[..read]);
            // `GET /callback?code=…&state=… HTTP/1.1`; anything else (a favicon) is not it.
            let target = request.split_whitespace().nth(1).unwrap_or("");
            let Some(query) = target.strip_prefix("/callback?") else {
                stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    )
                    .await?;
                continue;
            };
            let field = |name: &str| {
                url::form_urlencoded::parse(query.as_bytes())
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.into_owned())
            };
            let outcome = match (field("code"), field("state"), field("error")) {
                (Some(code), Some(state), _) if state == self.state => Ok(code),
                (_, _, Some(error)) => Err(Error::SignIn(error)),
                _ => Err(Error::SignIn(
                    "the browser's answer does not belong to this sign-in".into(),
                )),
            };
            let page = if outcome.is_ok() {
                "You are signed in. You can close this tab and return to Intar."
            } else {
                "Sign-in did not complete. Return to Intar and try again."
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
                page.len(),
            );
            stream.write_all(response.as_bytes()).await?;
            break outcome?;
        };
        token_request(
            http,
            &self.base,
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", &self.redirect_uri),
                ("code_verifier", &self.verifier),
            ],
        )
        .await
    }
}

/// The signed-in channel.
pub struct Subspace {
    http: reqwest::Client,
    base: Url,
    tokens: Mutex<Tokens>,
}

impl Subspace {
    pub fn new(http: reqwest::Client, base: Url, tokens: Tokens) -> Self {
        Self {
            http,
            base,
            tokens: Mutex::new(tokens),
        }
    }

    /// The current tokens, for the caller to store after a call refreshed them.
    pub async fn tokens(&self) -> Tokens {
        self.tokens.lock().await.clone()
    }

    /// The courses the learner sees, with each lecture's scenario and state.
    pub async fn catalog(&self) -> Result<LocalCatalogV1, Error> {
        // The catalog says what this computer can start: a lecture whose
        // machine images are not built for its processor waits.
        let path = format!("/api/local/catalog?arch={}", std::env::consts::ARCH);
        self.call::<(), _>(Method::GET, &path, None, None).await
    }

    /// Starts a local run. The same `idempotency_key` returns the same run.
    pub async fn start_run(
        &self,
        scenario_id: &str,
        organization_id: Option<&str>,
        guest_contracts: &[u32],
        idempotency_key: &str,
    ) -> Result<LocalRunAnswerV1, Error> {
        let body = StartLocalRunV1 {
            protocol: SUBSPACE_PROTOCOL_VERSION,
            scenario_id: scenario_id.to_owned(),
            organization_id: organization_id.map(str::to_owned),
            guest_contracts: guest_contracts.to_vec(),
            arch: std::env::consts::ARCH.to_owned(),
        };
        self.call(
            Method::POST,
            "/api/local/runs",
            Some(&body),
            Some(idempotency_key),
        )
        .await
    }

    pub async fn run(&self, run_id: &str) -> Result<LocalRunAnswerV1, Error> {
        self.call::<(), _>(
            Method::GET,
            &format!("/api/local/runs/{run_id}"),
            None,
            None,
        )
        .await
    }

    pub async fn end_run(&self, run_id: &str) -> Result<LocalRunAnswerV1, Error> {
        self.call::<(), _>(
            Method::POST,
            &format!("/api/local/runs/{run_id}/end"),
            None,
            None,
        )
        .await
    }

    /// Passes on what the learner's `intar` command in a guest asked, for the
    /// machine named `machine`, and returns intar's answer. intar answers a
    /// refused command with an error result the command can render, whatever
    /// the HTTP status; only an answer that is no run CLI response at all is
    /// an [`Error`].
    pub async fn run_cli(
        &self,
        run_id: &str,
        machine: &str,
        request: &RunCliRequestV1,
    ) -> Result<RunCliResponseV1, Error> {
        let path = format!("/api/local/runs/{run_id}/machines/{machine}/cli");
        let response = self.send(Method::POST, &path, Some(request), None).await?;
        let status = response.status();
        let refused = || Error::Refused {
            status: status.as_u16(),
            code: "run_cli".to_owned(),
            message: "intar did not answer the command".to_owned(),
            run: None,
        };
        let bytes = response.bytes().await?;
        // The broker's frame limit; intar keeps its answers below it.
        if bytes.len() > RUN_CLI_MAX_FRAME_BYTES {
            return Err(refused());
        }
        let answer: RunCliResponseV1 = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        // A success-shaped body behind a failed request is not trusted.
        if status.is_success() || matches!(answer.result, RunCliResultV1::Error { .. }) {
            Ok(answer)
        } else {
            Err(refused())
        }
    }

    /// Reports one to all of the run's VMs. A closed run answers
    /// [`Error::Refused`] with code `run_closed` and the run: stop its VMs.
    pub async fn report(
        &self,
        run_id: &str,
        vms: Vec<VmStateV3>,
    ) -> Result<LocalRunAnswerV1, Error> {
        let body = LocalRunReportV1 {
            protocol: SUBSPACE_PROTOCOL_VERSION,
            vms,
        };
        self.call(
            Method::POST,
            &format!("/api/local/runs/{run_id}/report"),
            Some(&body),
            None,
        )
        .await
    }

    /// One manifest or blob of intar's registry (`/v2/...`), which takes the
    /// app's token for what the learner's active local run needs. The caller
    /// reads the body and checks it against its digest.
    pub async fn registry(&self, path: &str) -> Result<reqwest::Response, Error> {
        let response = self.send::<()>(Method::GET, path, None, None).await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        Err(Error::Refused {
            status: status.as_u16(),
            code: "registry".to_owned(),
            message: format!("intar's registry answered {status} for {path}"),
            run: None,
        })
    }

    /// Stores the replay of one machine of a local run that is about to end:
    /// the casts, then the timeline that names them, then the machine is
    /// marked completed. `execution_id` and `vm` are the run view's
    /// `execution_id` and the machine's `runtime_name`. Every step may be
    /// repeated; a cast that is stored already is not sent again.
    pub async fn archive(
        &self,
        execution_id: &str,
        vm: &str,
        casts: &[ArchiveCastV1],
        timeline: &serde_json::Value,
    ) -> Result<(), Error> {
        let base = format!("{ARCHIVE}/{execution_id}/vms/{vm}");
        let manifest: Vec<_> = casts
            .iter()
            .zip(1_u32..)
            .map(|(cast, ordinal)| {
                serde_json::json!({
                    "ordinal": ordinal,
                    "kind": "ssh_recording_segment",
                    "filename": cast.filename,
                    "contentType": "application/x-asciicast; charset=utf-8",
                    "sizeBytes": cast.bytes.len(),
                    "sha256": sha256_hex(&cast.bytes),
                })
            })
            .collect();
        let begin =
            serde_json::json!({ "runId": execution_id, "vmName": vm, "artifacts": manifest });
        self.archive_step(Method::POST, &format!("{ARCHIVE}/begin"), Some(&begin))
            .await?;
        for (cast, ordinal) in casts.iter().zip(1_u32..) {
            let artifact = format!("{base}/artifacts/{ordinal}");
            let started = self
                .archive_step(Method::POST, &format!("{artifact}/multipart-begin"), None)
                .await?;
            if started.get("done").and_then(serde_json::Value::as_bool) == Some(true) {
                continue;
            }
            // One part, the whole cast, with its length: the server takes no other.
            let part = self
                .send_built(Method::PUT, &format!("{artifact}/parts/1"), |request| {
                    request
                        .header("content-length", cast.bytes.len())
                        .body(cast.bytes.clone())
                })
                .await?;
            archive_answer(&format!("{artifact}/parts/1"), part).await?;
            self.archive_step(Method::POST, &format!("{artifact}/complete"), None)
                .await?;
        }
        self.archive_step(Method::POST, &format!("{base}/timeline"), Some(timeline))
            .await?;
        self.archive_step(Method::POST, &format!("{base}/complete"), None)
            .await?;
        Ok(())
    }

    async fn archive_step(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, Error> {
        archive_answer(path, self.send(method, path, body, None).await?).await
    }

    async fn call<B: Serialize, T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        idempotency_key: Option<&str>,
    ) -> Result<T, Error> {
        let response = self.send(method, path, body, idempotency_key).await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response.json().await?);
        }
        let refusal: Option<LocalRunRefusalV1> = response.json().await.ok();
        Err(Error::Refused {
            status: status.as_u16(),
            code: refusal
                .as_ref()
                .and_then(|refusal| refusal.code.clone())
                .unwrap_or_default(),
            message: refusal
                .as_ref()
                .map(|refusal| refusal.error.clone())
                .unwrap_or_default(),
            run: refusal.and_then(|refusal| refusal.run).map(Box::new),
        })
    }

    /// Sends one request with the access token, refreshing it once when the
    /// server refuses it. Any other answer is the caller's to read.
    async fn send<B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        idempotency_key: Option<&str>,
    ) -> Result<reqwest::Response, Error> {
        self.send_built(method.clone(), path, |mut request| {
            // The server takes mutations as JSON only, an empty object included.
            request = match body {
                Some(body) => request.json(body),
                None if method == Method::POST => request
                    .header("content-type", "application/json")
                    .body("{}"),
                None => request,
            };
            match idempotency_key {
                Some(key) => request.header("idempotency-key", key),
                None => request,
            }
        })
        .await
    }

    /// Sends what `build` makes of a request with the access token on it.
    async fn send_built(
        &self,
        method: Method,
        path: &str,
        build: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, Error> {
        let url = self.base.join(path)?;
        // One refresh per call: a second 401 means the sign-in is gone.
        for refreshed in [false, true] {
            let access_token = self.tokens.lock().await.access_token.clone();
            let request = build(
                self.http
                    .request(method.clone(), url.clone())
                    .bearer_auth(&access_token),
            );
            let response = request.send().await?;
            if response.status() != StatusCode::UNAUTHORIZED {
                return Ok(response);
            }
            if refreshed {
                break;
            }
            self.refresh(&access_token).await?;
        }
        Err(Error::SignedOut)
    }

    /// Refreshes unless another call already replaced the refused token: a
    /// refresh token is spent by its first use.
    async fn refresh(&self, refused: &str) -> Result<(), Error> {
        let mut tokens = self.tokens.lock().await;
        if tokens.access_token != refused {
            return Ok(());
        }
        let Some(refresh_token) = tokens.refresh_token.clone() else {
            return Err(Error::SignedOut);
        };
        *tokens = token_request(
            &self.http,
            &self.base,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh_token),
            ],
        )
        .await?;
        Ok(())
    }
}
