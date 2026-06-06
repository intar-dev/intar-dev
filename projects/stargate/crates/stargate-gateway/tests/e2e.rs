use std::{borrow::Cow, net::TcpListener, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use russh::{
    ChannelId, ChannelMsg, CryptoVec, Preferred, cipher, client, compression, kex,
    keys::{
        PrivateKeyWithHashAlg,
        ssh_key::{Algorithm as SshAlgorithm, EcdsaCurve, rand_core::OsRng},
    },
    mac,
    server::{self, Auth, Msg, Server as _, Session},
};
use serde::Serialize;
use stargate_core::{
    AdminAuthSettings, IssueTerminalSessionRequest, IssueTerminalSessionResponse,
    NativeTerminalAuthMode, RouteMetadata, TerminalSessionMode, TerminalTokenSettings, WebSettings,
};
use stargate_gateway::{
    GatewayState, build_admin_router, build_public_router, run_public_ssh_server,
};
use stargate_store_sqlite::SqliteRouteStore;
use tempfile::TempDir;
use time::OffsetDateTime;
use tokio::net::TcpListener as TokioTcpListener;
use tokio_tungstenite::{
    WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

#[tokio::test]
async fn issue_native_terminal_session_happy_path() -> Result<()> {
    let harness = Harness::start().await?;
    let session = harness.issue_native_terminal_session(true).await?;
    let native = session.native.context("missing native session bundle")?;

    assert_eq!(native.username, harness.route_username);
    assert_eq!(native.auth_mode, NativeTerminalAuthMode::ProfileKeys);
    assert_eq!(native.authorized_key_count, 1);
    assert!(native.private_key_openssh.is_none());
    assert_eq!(native.ssh_host, "127.0.0.1");
    assert_eq!(native.ssh_port, harness.public_ssh_addr.port());
    assert_eq!(
        native.public_host_key_openssh,
        harness.public_host_public.to_openssh()?
    );

    Ok(())
}

#[tokio::test]
async fn issue_native_terminal_session_falls_back_to_issued_key() -> Result<()> {
    let harness = Harness::start().await?;
    let session = harness.issue_native_terminal_session(false).await?;
    let native = session.native.context("missing native session bundle")?;

    assert_eq!(native.auth_mode, NativeTerminalAuthMode::IssuedKey);
    assert_eq!(native.authorized_key_count, 1);
    assert!(native.private_key_openssh.is_some());

    Ok(())
}

#[tokio::test]
async fn public_ssh_happy_path() -> Result<()> {
    let harness = Harness::start().await?;
    let output = harness.public_exec("hostname").await?;
    assert!(output.contains("exec:hostname"), "{output}");
    Ok(())
}

#[tokio::test]
async fn public_ssh_profile_key_route_happy_path() -> Result<()> {
    let harness = Harness::start().await?;
    let output = harness.public_exec_with_profile_key("hostname").await?;
    assert!(output.contains("exec:hostname"), "{output}");
    Ok(())
}

#[tokio::test]
async fn browser_terminal_happy_path() -> Result<()> {
    let harness = Harness::start().await?;
    let mut websocket = harness.open_browser_terminal().await?;

    browser_open_terminal(&mut websocket).await?;
    websocket
        .send(Message::Binary(b"hostname\n".to_vec().into()))
        .await?;

    let output = read_browser_output(&mut websocket, "hostname").await?;
    assert!(output.contains("hostname"), "{output}");

    websocket.close(None).await?;
    Ok(())
}

#[tokio::test]
async fn delete_route_terminates_public_ssh_session() -> Result<()> {
    let harness = Harness::start().await?;
    harness.assert_delete_terminates_public_session().await?;
    Ok(())
}

#[tokio::test]
async fn delete_route_terminates_browser_terminal_session() -> Result<()> {
    let harness = Harness::start().await?;
    let mut websocket = harness.open_browser_terminal().await?;
    browser_open_terminal(&mut websocket).await?;

    harness.delete_route().await?;

    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match websocket.next().await {
                Some(Ok(Message::Close(_))) | None => return Ok::<(), anyhow::Error>(()),
                Some(Ok(_)) => continue,
                Some(Err(error)) => return Err(error.into()),
            }
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "browser terminal did not close after route deletion"
    );

    Ok(())
}

struct Harness {
    _temp_dir: TempDir,
    admin_task: tokio::task::JoinHandle<()>,
    public_task: tokio::task::JoinHandle<()>,
    public_ssh_task: tokio::task::JoinHandle<()>,
    target_task: tokio::task::JoinHandle<()>,
    admin_addr: std::net::SocketAddr,
    public_addr: std::net::SocketAddr,
    public_ssh_addr: std::net::SocketAddr,
    target_addr: std::net::SocketAddr,
    route_username: String,
    target_username: String,
    target_host_key: String,
    profile_client_private_key_openssh: String,
    profile_client_public_key_openssh: String,
    admin_secret: String,
    allowed_origin: String,
    public_host_public: russh::keys::ssh_key::PublicKey,
}

impl Harness {
    async fn start() -> Result<Self> {
        let temp_dir = tempfile::tempdir()?;
        let database_path = temp_dir.path().join("stargate.db");
        let store = SqliteRouteStore::connect(&database_path).await?;
        let admin_auth = AdminAuthSettings {
            assertion_header: "x-stargate-admin-assertion".to_owned(),
            audience: "stargate-admin".to_owned(),
            issuer: "https://issuer.test".to_owned(),
            jwks_url: None,
            hs256_secret: Some("admin-secret".to_owned()),
        };

        let admin_addr = free_addr();
        let public_addr = free_addr();
        let public_ssh_addr = free_addr();
        let target_addr = free_addr();
        let allowed_origin = "https://stargate.example.test".to_owned();

        let public_host_key =
            russh::keys::PrivateKey::random(&mut OsRng, russh::keys::ssh_key::Algorithm::Ed25519)?;
        let public_host_public = public_host_key.public_key().clone();
        let profile_client_key =
            russh::keys::PrivateKey::random(&mut OsRng, russh::keys::ssh_key::Algorithm::Ed25519)?;
        let target_key =
            russh::keys::PrivateKey::random(&mut OsRng, russh::keys::ssh_key::Algorithm::Ed25519)?;
        let target_key_path = temp_dir.path().join("target_id");
        std::fs::write(
            &target_key_path,
            target_key.to_openssh(russh::keys::ssh_key::LineEnding::LF)?,
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&target_key_path)?.permissions();
            permissions.set_mode(0o600);
            std::fs::set_permissions(&target_key_path, permissions)?;
        }

        let web = WebSettings {
            bind: public_addr,
            public_base_url: format!("http://{public_addr}").parse()?,
            public_ssh_host: "127.0.0.1".to_owned(),
            public_ssh_port: public_ssh_addr.port(),
            allowed_origins: vec![allowed_origin.clone()],
        };
        let gateway = GatewayState::new(
            store,
            admin_auth.clone(),
            &web,
            public_host_public.clone(),
            TerminalTokenSettings {
                issuer: "stargate".to_owned(),
                audience: "stargate-terminal".to_owned(),
                hs256_secret: "terminal-secret".to_owned(),
            },
            PathBuf::from("ssh"),
            PathBuf::from("ssh-keyscan"),
            target_key_path,
        )?;

        let admin_listener = TokioTcpListener::bind(admin_addr).await?;
        let public_listener = TokioTcpListener::bind(public_addr).await?;
        let admin_router = build_admin_router(gateway.clone());
        let public_router = build_public_router(gateway.clone());

        let admin_task = tokio::spawn(serve_router(admin_listener, admin_router));
        let public_task = tokio::spawn(serve_router(public_listener, public_router));
        let public_gateway = gateway.clone();
        let public_ssh_task = tokio::spawn(async move {
            run_public_ssh_server(public_gateway, public_ssh_addr, public_host_key)
                .await
                .expect("public ssh server");
        });

        let target_host_key =
            russh::keys::PrivateKey::random(&mut OsRng, russh::keys::ssh_key::Algorithm::Ed25519)?;
        let target_host_public = target_host_key.public_key().to_openssh()?;
        let target_server = TestTargetServer {
            allowed_username: "ubuntu".to_owned(),
            allowed_public_key: target_key.public_key().clone(),
            host_key: target_host_key,
        };
        let target_task =
            tokio::spawn(
                async move { target_server.run(target_addr).await.expect("target server") },
            );

        let harness = Self {
            _temp_dir: temp_dir,
            admin_task,
            public_task,
            public_ssh_task,
            target_task,
            admin_addr,
            public_addr,
            public_ssh_addr,
            target_addr,
            route_username: "run-01-web".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_host_key: target_host_public,
            profile_client_private_key_openssh: profile_client_key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)?
                .to_string(),
            profile_client_public_key_openssh: profile_client_key.public_key().to_openssh()?,
            admin_secret: "admin-secret".to_owned(),
            allowed_origin,
            public_host_public,
        };

        harness.wait_ready().await?;
        Ok(harness)
    }

    async fn wait_ready(&self) -> Result<()> {
        let client = reqwest::Client::new();
        for _ in 0..100 {
            let admin = client
                .get(format!("http://{}/healthz", self.admin_addr))
                .send()
                .await;
            let public = client
                .get(format!("http://{}/healthz", self.public_addr))
                .send()
                .await;
            let public_ssh = tokio::net::TcpStream::connect(self.public_ssh_addr).await;
            if admin.is_ok() && public.is_ok() && public_ssh.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        anyhow::bail!("services did not become ready")
    }

    async fn issue_terminal_session(
        &self,
        mode: TerminalSessionMode,
    ) -> Result<IssueTerminalSessionResponse> {
        self.issue_terminal_session_with_keys(mode, Vec::new())
            .await
    }

    async fn issue_native_terminal_session(
        &self,
        use_profile_keys: bool,
    ) -> Result<IssueTerminalSessionResponse> {
        let authorized_client_public_keys_openssh = if use_profile_keys {
            vec![self.profile_client_public_key_openssh.clone()]
        } else {
            Vec::new()
        };
        self.issue_terminal_session_with_keys(
            TerminalSessionMode::Native,
            authorized_client_public_keys_openssh,
        )
        .await
    }

    async fn issue_terminal_session_with_keys(
        &self,
        mode: TerminalSessionMode,
        authorized_client_public_keys_openssh: Vec<String>,
    ) -> Result<IssueTerminalSessionResponse> {
        let request = IssueTerminalSessionRequest {
            route_username: self.route_username.clone(),
            target_username: self.target_username.clone(),
            target_ip: "127.0.0.1".to_owned(),
            target_port: self.target_addr.port(),
            target_host_key_openssh: Some(self.target_host_key.clone()),
            authorized_client_public_keys_openssh,
            route_expires_at: OffsetDateTime::now_utc() + time::Duration::hours(1),
            mode,
            metadata: RouteMetadata {
                host_id: Some("host-01".to_owned()),
                run_id: Some("run-01".to_owned()),
                vm_id: Some("vm-01".to_owned()),
                user_id: Some("user-01".to_owned()),
            },
        };
        let response = reqwest::Client::new()
            .post(format!("http://{}/v1/terminal-sessions", self.admin_addr))
            .header("x-stargate-admin-assertion", self.admin_token()?)
            .json(&request)
            .send()
            .await?;
        assert!(response.status().is_success(), "{}", response.text().await?);
        Ok(response.json().await?)
    }

    async fn delete_route(&self) -> Result<()> {
        let response = reqwest::Client::new()
            .delete(format!(
                "http://{}/v1/routes/{}",
                self.admin_addr, self.route_username
            ))
            .header("x-stargate-admin-assertion", self.admin_token()?)
            .send()
            .await?;
        assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
        Ok(())
    }

    async fn public_exec(&self, command: &str) -> Result<String> {
        let session = self.issue_native_terminal_session(false).await?;
        let native = session.native.context("missing native bundle")?;
        self.ssh_exec(native, command).await
    }

    async fn public_exec_with_profile_key(&self, command: &str) -> Result<String> {
        let session = self.issue_native_terminal_session(true).await?;
        let native = session.native.context("missing native bundle")?;
        self.ssh_exec(native, command).await
    }

    async fn assert_delete_terminates_public_session(&self) -> Result<()> {
        let session = self.issue_native_terminal_session(false).await?;
        let native = session.native.context("missing native bundle")?;

        let config = client_config(&self.public_host_public);
        let route_key = Arc::new(russh::keys::decode_secret_key(
            native
                .private_key_openssh
                .as_deref()
                .context("missing private key")?,
            None,
        )?);
        let mut ssh_session = russh::client::connect(
            config,
            self.public_ssh_addr,
            TestClient {
                expected_server_key: self.public_host_public.clone(),
            },
        )
        .await?;
        let auth_result = ssh_session
            .authenticate_publickey(
                &self.route_username,
                PrivateKeyWithHashAlg::new(route_key, None),
            )
            .await?;
        assert!(auth_result.success());

        let mut channel = ssh_session.channel_open_session().await?;
        channel
            .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Success) | Some(ChannelMsg::Data { .. }) => return Ok(()),
                    Some(ChannelMsg::Failure) => anyhow::bail!("shell request failed"),
                    Some(_) => continue,
                    None => anyhow::bail!("channel closed before shell started"),
                }
            }
        })
        .await
        .context("timed out waiting for shell start")??;

        self.delete_route().await?;

        let closed = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => return,
                    Some(_) => continue,
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "session did not close after route deletion");

        Ok(())
    }

    async fn open_browser_terminal(
        &self,
    ) -> Result<WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>> {
        let session = self
            .issue_terminal_session(TerminalSessionMode::Browser)
            .await?;
        let browser = session.browser.context("missing browser bundle")?;
        let mut request = browser.websocket_url.into_client_request()?;
        request.headers_mut().insert(
            "origin",
            self.allowed_origin
                .parse()
                .context("invalid origin header")?,
        );
        let (websocket, _) = connect_async(request).await?;
        Ok(websocket)
    }

    async fn ssh_exec(
        &self,
        native: stargate_core::NativeTerminalSession,
        command: &str,
    ) -> Result<String> {
        let config = client_config(&self.public_host_public);
        let route_key = if native.auth_mode == NativeTerminalAuthMode::ProfileKeys {
            Arc::new(russh::keys::decode_secret_key(
                &self.profile_client_private_key_openssh,
                None,
            )?)
        } else {
            Arc::new(russh::keys::decode_secret_key(
                native
                    .private_key_openssh
                    .as_deref()
                    .context("missing private key")?,
                None,
            )?)
        };
        let mut session = russh::client::connect(
            config,
            self.public_ssh_addr,
            TestClient {
                expected_server_key: self.public_host_public.clone(),
            },
        )
        .await?;
        let auth_result = session
            .authenticate_publickey(
                &self.route_username,
                PrivateKeyWithHashAlg::new(route_key, None),
            )
            .await?;
        assert!(auth_result.success());

        let mut channel = session.channel_open_session().await?;
        channel.exec(true, command).await?;
        let mut output = String::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => output.push_str(std::str::from_utf8(&data)?),
                ChannelMsg::ExtendedData { data, .. } => {
                    output.push_str(std::str::from_utf8(&data)?)
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    assert_eq!(exit_status, 0);
                    break;
                }
                _ => {}
            }
        }
        Ok(output)
    }

    fn admin_token(&self) -> Result<String> {
        #[derive(Serialize)]
        struct Claims<'a> {
            iss: &'a str,
            aud: &'a str,
            exp: u64,
            sub: &'a str,
        }

        Ok(encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                iss: "https://issuer.test",
                aud: "stargate-admin",
                exp: u64::MAX / 2,
                sub: "worker",
            },
            &EncodingKey::from_secret(self.admin_secret.as_bytes()),
        )?)
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.admin_task.abort();
        self.public_task.abort();
        self.public_ssh_task.abort();
        self.target_task.abort();
    }
}

async fn browser_open_terminal(
    websocket: &mut WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) -> Result<()> {
    websocket
        .send(Message::Text(
            serde_json::json!({
                "type": "open",
                "cols": 80,
                "rows": 24,
            })
            .to_string()
            .into(),
        ))
        .await?;

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match websocket.next().await {
                Some(Ok(Message::Text(text))) if text.contains("\"ready\"") => return Ok(()),
                Some(Ok(_)) => continue,
                Some(Err(error)) => return Err(error.into()),
                None => anyhow::bail!("websocket closed before ready"),
            }
        }
    })
    .await
    .context("timed out waiting for browser terminal readiness")?
}

async fn read_browser_output(
    websocket: &mut WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    expected: &str,
) -> Result<String> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut output = String::new();
        loop {
            match websocket.next().await {
                Some(Ok(Message::Binary(data))) => {
                    output.push_str(std::str::from_utf8(data.as_ref())?);
                    if output.contains(expected) {
                        return Ok(output);
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    if text.contains("\"error\"") {
                        anyhow::bail!("browser terminal error: {text}");
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.into()),
                None => anyhow::bail!("browser terminal closed unexpectedly"),
            }
        }
    })
    .await
    .context("timed out waiting for browser terminal output")?
}

async fn serve_router(listener: TokioTcpListener, router: Router) {
    axum::serve(listener, router).await.expect("router serve");
}

fn free_addr() -> std::net::SocketAddr {
    TcpListener::bind(("127.0.0.1", 0))
        .expect("bind ephemeral")
        .local_addr()
        .expect("local addr")
}

fn client_config(expected_server_key: &russh::keys::ssh_key::PublicKey) -> Arc<client::Config> {
    let mut config = client::Config::default();
    if matches!(
        expected_server_key.algorithm(),
        SshAlgorithm::Ecdsa {
            curve: EcdsaCurve::NistP384
        }
    ) {
        config.preferred = Preferred {
            kex: Cow::Borrowed(&[kex::ECDH_SHA2_NISTP384]),
            key: Cow::Borrowed(&[SshAlgorithm::Ecdsa {
                curve: EcdsaCurve::NistP384,
            }]),
            cipher: Cow::Borrowed(&[cipher::AES_256_GCM]),
            mac: Cow::Borrowed(&[mac::HMAC_SHA512_ETM]),
            compression: Cow::Borrowed(&[compression::NONE]),
        };
    }
    Arc::new(config)
}

#[derive(Clone)]
struct TestTargetServer {
    allowed_username: String,
    allowed_public_key: russh::keys::ssh_key::PublicKey,
    host_key: russh::keys::PrivateKey,
}

impl TestTargetServer {
    async fn run(self, addr: std::net::SocketAddr) -> Result<()> {
        let mut config = russh::server::Config::default();
        config.keys.push(self.host_key.clone());
        let config = Arc::new(config);
        let mut server = self;
        server.run_on_address(config, addr).await?;
        Ok(())
    }
}

impl server::Server for TestTargetServer {
    type Handler = Self;

    fn new_client(&mut self, _peer_addr: Option<std::net::SocketAddr>) -> Self::Handler {
        self.clone()
    }
}

impl server::Handler for TestTargetServer {
    type Error = anyhow::Error;

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        if user == self.allowed_username && public_key == &self.allowed_public_key {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(
            channel,
            CryptoVec::from("shell ready\n".as_bytes().to_vec()),
        )?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let response = format!("exec:{}\n", std::str::from_utf8(data)?);
        session.data(channel, CryptoVec::from(response.into_bytes()))?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, CryptoVec::from(data.to_vec()))?;
        Ok(())
    }
}

struct TestClient {
    expected_server_key: russh::keys::ssh_key::PublicKey,
}

impl client::Handler for TestClient {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(server_public_key == &self.expected_server_key)
    }
}
