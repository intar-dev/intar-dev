use std::{
    borrow::Cow,
    collections::HashSet,
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::ws::WebSocketUpgrade,
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use russh::{
    Channel, ChannelId, ChannelMsg, ChannelOpenFailure, Preferred, cipher, client, compression,
    kex,
    keys::{
        PrivateKeyWithHashAlg,
        ssh_key::{Algorithm as SshAlgorithm, EcdsaCurve},
    },
    mac,
    server::{self, Auth, Msg, Server as _, Session},
};
use serde::Serialize;
use stargate_core::{
    AdminAuthSettings, IssueTerminalSessionRequest, IssueTerminalSessionResponse,
    IssueWorkspaceAppSessionRequest, IssueWorkspaceAppSessionResponse, NativeTerminalAuthMode,
    RouteMetadata, TerminalSessionMode, TerminalTokenSettings, WebSettings, WorkspaceAppProtocol,
};
use stargate_gateway::{
    GatewayState, SqliteRouteStore, build_admin_router, build_public_router, run_public_ssh_server,
};
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
    assert_eq!(native.ssh_host, "127.0.0.1");
    assert_eq!(native.ssh_port, harness.public_ssh_addr.port());
    assert_eq!(
        native.public_host_key_openssh,
        harness.public_host_public.to_openssh()?
    );

    Ok(())
}

#[tokio::test]
async fn issue_native_terminal_session_rejects_missing_profile_keys() -> Result<()> {
    let harness = Harness::start().await?;
    let response = harness
        .issue_terminal_session_raw(TerminalSessionMode::Native, Vec::new())
        .await?;

    assert_eq!(response.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);

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
async fn delete_route_between_native_auth_and_channel_revokes_session() -> Result<()> {
    let harness = Harness::start().await?;
    harness
        .assert_delete_between_native_auth_and_channel_revokes_session()
        .await?;
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

#[tokio::test]
async fn browser_terminal_closes_at_route_expiry() -> Result<()> {
    let harness = Harness::start().await?;
    let mut websocket = harness
        .open_browser_terminal_with_route_lifetime(Duration::from_secs(3))
        .await?;
    browser_open_terminal(&mut websocket).await?;

    assert_websocket_closes(&mut websocket, Duration::from_secs(5)).await?;
    Ok(())
}

#[tokio::test]
async fn workspace_app_http_and_websocket_are_forwarded_inside_ssh() -> Result<()> {
    let harness = Harness::start().await?;
    let session = harness.issue_workspace_app_session().await?;
    assert!(session.bootstrap_expires_at < session.expires_at);

    let mut bare_url = url::Url::parse(&session.url)?;
    bare_url.set_query(None);
    let response = reqwest::get(bare_url.join("hello")?).await?;
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);

    let browser = harness.bootstrap_workspace_app(&session).await?;

    let response = reqwest::Client::new()
        .get(browser.base_url.join("hello?from=browser")?)
        .header(
            reqwest::header::COOKIE,
            format!("{}; app_session=kept", browser.cookie),
        )
        .header("forwarded", "host=attacker.test")
        .header("x-forwarded-host", "attacker.test")
        .header("x-forwarded-proto", "https")
        .header("x-forwarded-port", "443")
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("private, no-store")
    );
    assert_eq!(
        response
            .headers()
            .get("cloudflare-cdn-cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    let application_cookie = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>();
    assert_eq!(
        application_cookie,
        vec!["application_session=kept; Path=/; HttpOnly; Secure"]
    );
    assert_eq!(
        response.text().await?,
        format!(
            "/hello?from=browser|{}|app_session=kept|{}|http|{}|",
            harness.public_addr,
            harness.public_addr,
            harness.public_addr.port()
        )
    );

    let websocket_url = browser
        .base_url
        .join("echo")?
        .to_string()
        .replacen("http://", "ws://", 1);
    let mut websocket_request = websocket_url.into_client_request()?;
    websocket_request
        .headers_mut()
        .insert("cookie", browser.cookie.parse()?);
    let (mut websocket, _) = connect_async(websocket_request).await?;
    websocket
        .send(Message::Text("through-stargate".into()))
        .await?;
    assert_eq!(
        websocket.next().await.transpose()?,
        Some(Message::Text("through-stargate".into()))
    );

    harness
        .delete_workspace_app_route(&session.route_id)
        .await?;
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
        "workspace application websocket did not close after route deletion"
    );
    let response = reqwest::Client::new()
        .get(browser.base_url.join("hello")?)
        .header(reqwest::header::COOKIE, &browser.cookie)
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn workspace_app_can_override_only_the_guest_virtual_host() -> Result<()> {
    let harness = Harness::start().await?;
    let session = harness
        .issue_workspace_app_session_with_options(
            "wa-virtual-host",
            Some("hello.demo.127.0.0.1.sslip.io"),
        )
        .await?;
    let browser = harness.bootstrap_workspace_app(&session).await?;

    let response = reqwest::Client::new()
        .get(browser.base_url.join("hello")?)
        .header(reqwest::header::COOKIE, &browser.cookie)
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response.text().await?,
        format!(
            "/hello|hello.demo.127.0.0.1.sslip.io||{}|http|{}|",
            harness.public_addr,
            harness.public_addr.port()
        )
    );

    let rotated = harness
        .issue_workspace_app_session_with_options("wa-virtual-host", None)
        .await?;
    let rotated_browser = harness.bootstrap_workspace_app(&rotated).await?;
    let response = reqwest::Client::new()
        .get(rotated_browser.base_url.join("hello")?)
        .header(reqwest::header::COOKIE, &rotated_browser.cookie)
        .send()
        .await?;
    assert_eq!(
        response.text().await?,
        format!(
            "/hello|{}||{}|http|{}|",
            harness.public_addr,
            harness.public_addr,
            harness.public_addr.port()
        )
    );
    Ok(())
}

#[tokio::test]
async fn workspace_app_route_reissue_rotates_browser_authorization() -> Result<()> {
    let harness = Harness::start().await?;
    let first = harness.issue_workspace_app_session().await?;
    let first_browser = harness.bootstrap_workspace_app(&first).await?;

    let second = harness.issue_workspace_app_session().await?;
    let stale = reqwest::Client::new()
        .get(first_browser.base_url.join("hello")?)
        .header(reqwest::header::COOKIE, &first_browser.cookie)
        .send()
        .await?;
    assert_eq!(stale.status(), reqwest::StatusCode::UNAUTHORIZED);

    let second_browser = harness.bootstrap_workspace_app(&second).await?;
    let current = reqwest::Client::new()
        .get(second_browser.base_url.join("hello")?)
        .header(reqwest::header::COOKIE, &second_browser.cookie)
        .send()
        .await?;
    assert_eq!(current.status(), reqwest::StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn workspace_app_browser_cookie_is_bound_to_one_route() -> Result<()> {
    let harness = Harness::start().await?;
    let first = harness
        .issue_workspace_app_session_with_route_id("wa-first-unguessable")
        .await?;
    let first_browser = harness.bootstrap_workspace_app(&first).await?;
    let second = harness
        .issue_workspace_app_session_with_route_id("wa-second-unguessable")
        .await?;
    let mut second_url = url::Url::parse(&second.url)?;
    second_url.set_query(None);
    let (_, first_token) = first_browser
        .cookie
        .split_once('=')
        .context("workspace app cookie missing value")?;
    let forged_cookie = format!("intar-wapp-{}={first_token}", second.route_id);

    let response = reqwest::Client::new()
        .get(second_url)
        .header(reqwest::header::COOKIE, forged_cookie)
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn expired_workspace_app_bootstrap_cannot_mint_a_browser_cookie() -> Result<()> {
    let harness = Harness::start_with_workspace_app_bootstrap_ttl(1).await?;
    let session = harness.issue_workspace_app_session().await?;
    tokio::time::sleep(Duration::from_secs(2)).await;

    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?
        .get(&session.url)
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::SEE_OTHER);
    assert!(!response.headers().contains_key(reqwest::header::SET_COOKIE));
    assert!(
        !response
            .headers()
            .get(reqwest::header::LOCATION)
            .context("missing sanitized location")?
            .to_str()?
            .contains("__intar_bootstrap")
    );
    Ok(())
}

#[tokio::test]
async fn workspace_app_websocket_closes_at_browser_session_expiry() -> Result<()> {
    let harness = Harness::start_with_workspace_app_session_ttl(3).await?;
    let session = harness.issue_workspace_app_session().await?;
    let browser = harness.bootstrap_workspace_app(&session).await?;
    let websocket_url = browser
        .base_url
        .join("echo")?
        .to_string()
        .replacen("http://", "ws://", 1);
    let mut websocket_request = websocket_url.into_client_request()?;
    websocket_request
        .headers_mut()
        .insert("cookie", browser.cookie.parse()?);
    let (mut websocket, _) = connect_async(websocket_request).await?;
    websocket
        .send(Message::Text("before-expiry".into()))
        .await?;
    assert_eq!(
        websocket.next().await.transpose()?,
        Some(Message::Text("before-expiry".into()))
    );

    assert_websocket_closes(&mut websocket, Duration::from_secs(5)).await?;
    Ok(())
}

#[tokio::test]
async fn wildcard_workspace_app_origin_bootstraps_http_and_websocket() -> Result<()> {
    let domain = "example.test";
    let harness = Harness::start_with_workspace_app_domain(Some(domain)).await?;
    let session = harness.issue_workspace_app_session().await?;
    let issued_url = url::Url::parse(&session.url)?;
    let public_host = format!("{}.{}", session.route_id, domain);
    assert_eq!(issued_url.host_str(), Some(public_host.as_str()));
    assert_eq!(issued_url.scheme(), "https");

    let app_reserved_health = reqwest::Client::new()
        .get(format!("http://{}/healthz", harness.public_addr))
        .header(reqwest::header::HOST, &public_host)
        .send()
        .await?;
    assert_eq!(
        app_reserved_health.status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let gateway_health = reqwest::Client::new()
        .get(format!("http://{}/healthz", harness.public_addr))
        .header(reqwest::header::HOST, "ws.example.test")
        .send()
        .await?;
    assert_eq!(gateway_health.status(), reqwest::StatusCode::OK);
    let unknown_host = reqwest::Client::new()
        .get(format!("http://{}/healthz", harness.public_addr))
        .header(reqwest::header::HOST, "garbage.example.test")
        .send()
        .await?;
    assert_eq!(unknown_host.status(), reqwest::StatusCode::NOT_FOUND);
    let uppercase_host = reqwest::Client::new()
        .get(format!("http://{}/healthz", harness.public_addr))
        .header(reqwest::header::HOST, "WA-bad.example.test")
        .send()
        .await?;
    assert_eq!(uppercase_host.status(), reqwest::StatusCode::BAD_REQUEST);
    let non_default_port = reqwest::Client::new()
        .get(format!("http://{}/healthz", harness.public_addr))
        .header(reqwest::header::HOST, format!("{public_host}:8443"))
        .send()
        .await?;
    assert_eq!(non_default_port.status(), reqwest::StatusCode::BAD_REQUEST);

    let bootstrap_url = format!(
        "http://{}/?{}",
        harness.public_addr,
        issued_url.query().context("missing bootstrap query")?
    );
    let bootstrap = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?
        .get(bootstrap_url)
        .header(reqwest::header::HOST, &public_host)
        .send()
        .await?;
    assert_eq!(bootstrap.status(), reqwest::StatusCode::SEE_OTHER);
    assert_eq!(
        bootstrap
            .headers()
            .get("cloudflare-cdn-cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(
        bootstrap
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok()),
        Some("/")
    );
    let set_cookie = bootstrap
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .context("missing wildcard session cookie")?
        .to_str()?;
    assert!(set_cookie.starts_with("__Host-intar-wapp-"));
    assert!(set_cookie.contains("; Secure"));
    assert!(set_cookie.contains("; Path=/"));
    assert!(!set_cookie.to_ascii_lowercase().contains("; domain="));
    let cookie = set_cookie
        .split(';')
        .next()
        .context("empty wildcard session cookie")?;

    let http = reqwest::Client::new()
        .get(format!("http://{}/hello", harness.public_addr))
        .header(reqwest::header::HOST, &public_host)
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await?;
    assert_eq!(http.status(), reqwest::StatusCode::OK);
    assert_eq!(
        http.text().await?,
        format!("/hello|{public_host}||{public_host}|https|443|")
    );
    let explicit_default_port = reqwest::Client::new()
        .get(format!("http://{}/hello", harness.public_addr))
        .header(reqwest::header::HOST, format!("{public_host}:443"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await?;
    assert_eq!(explicit_default_port.status(), reqwest::StatusCode::OK);
    assert_eq!(
        explicit_default_port.text().await?,
        format!("/hello|{public_host}||{public_host}|https|443|")
    );

    for reserved_path in [
        "/healthz".to_owned(),
        "/v1/terminal/ws".to_owned(),
        format!("/v1/workspace-apps/{}/hello", session.route_id),
    ] {
        let response = reqwest::Client::new()
            .get(format!("http://{}{reserved_path}", harness.public_addr))
            .header(reqwest::header::HOST, &public_host)
            .header(reqwest::header::COOKIE, cookie)
            .send()
            .await?;
        assert_eq!(
            response.status(),
            reqwest::StatusCode::NOT_FOUND,
            "{reserved_path} must be handled by the guest application"
        );
    }
    let disabled_path_proxy = reqwest::Client::new()
        .get(format!(
            "http://{}/v1/workspace-apps/{}/hello",
            harness.public_addr, session.route_id
        ))
        .header(reqwest::header::HOST, "ws.example.test")
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await?;
    assert_eq!(disabled_path_proxy.status(), reqwest::StatusCode::NOT_FOUND);

    let mut websocket_request =
        format!("ws://{}/echo", harness.public_addr).into_client_request()?;
    websocket_request
        .headers_mut()
        .insert("host", public_host.parse()?);
    websocket_request
        .headers_mut()
        .insert("cookie", cookie.parse()?);
    let (mut websocket, _) = connect_async(websocket_request).await?;
    websocket
        .send(Message::Text("wildcard-origin".into()))
        .await?;
    assert_eq!(
        websocket.next().await.transpose()?,
        Some(Message::Text("wildcard-origin".into()))
    );
    websocket.close(None).await?;
    Ok(())
}

struct WorkspaceAppBrowserSession {
    base_url: url::Url,
    cookie: String,
}

struct Harness {
    _temp_dir: TempDir,
    admin_task: tokio::task::JoinHandle<()>,
    public_task: tokio::task::JoinHandle<()>,
    public_ssh_task: tokio::task::JoinHandle<()>,
    target_task: tokio::task::JoinHandle<()>,
    app_task: tokio::task::JoinHandle<()>,
    admin_addr: std::net::SocketAddr,
    public_addr: std::net::SocketAddr,
    public_ssh_addr: std::net::SocketAddr,
    target_addr: std::net::SocketAddr,
    app_addr: std::net::SocketAddr,
    route_username: String,
    target_username: String,
    target_host_key: String,
    target_private_key_openssh: String,
    profile_client_private_key_openssh: String,
    profile_client_public_key_openssh: String,
    admin_secret: String,
    allowed_origin: String,
    public_host_public: russh::keys::ssh_key::PublicKey,
}

impl Harness {
    async fn start() -> Result<Self> {
        Self::start_with_workspace_app_domain(None).await
    }

    async fn start_with_workspace_app_domain(
        workspace_app_base_domain: Option<&str>,
    ) -> Result<Self> {
        Self::start_with_workspace_app_settings(workspace_app_base_domain, 60, 15 * 60).await
    }

    async fn start_with_workspace_app_session_ttl(ttl_seconds: u64) -> Result<Self> {
        Self::start_with_workspace_app_settings(None, 60, ttl_seconds).await
    }

    async fn start_with_workspace_app_bootstrap_ttl(ttl_seconds: u64) -> Result<Self> {
        Self::start_with_workspace_app_settings(None, ttl_seconds, 15 * 60).await
    }

    async fn start_with_workspace_app_settings(
        workspace_app_base_domain: Option<&str>,
        workspace_app_bootstrap_ttl_seconds: u64,
        workspace_app_session_ttl_seconds: u64,
    ) -> Result<Self> {
        let _ = tracing_subscriber::fmt()
            .with_env_filter("stargate_gateway=debug,russh=debug")
            .with_test_writer()
            .try_init();
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
        let public_ssh_listener = TokioTcpListener::bind(("127.0.0.1", 0)).await?;
        let public_ssh_addr = public_ssh_listener.local_addr()?;
        let target_addr = free_addr();
        let app_listener = TokioTcpListener::bind(("127.0.0.1", 0)).await?;
        let app_addr = app_listener.local_addr()?;
        let allowed_origin = "https://stargate.example.test".to_owned();

        let mut rng = russh::keys::key::safe_rng();
        let public_host_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)?;
        let public_host_public = public_host_key.public_key().clone();
        let profile_client_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)?;
        let target_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)?;
        let target_private_key_openssh = target_key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)?
            .to_string();

        let public_base_url = if workspace_app_base_domain.is_some() {
            "https://ws.example.test".parse()?
        } else {
            format!("http://{public_addr}").parse()?
        };
        let web = WebSettings {
            bind: public_addr,
            public_base_url,
            public_ssh_host: "127.0.0.1".to_owned(),
            public_ssh_port: public_ssh_addr.port(),
            allowed_origins: vec![allowed_origin.clone()],
            workspace_app_base_domain: workspace_app_base_domain.map(ToOwned::to_owned),
            workspace_app_bootstrap_ttl_seconds,
            workspace_app_session_ttl_seconds,
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
        )?;

        let admin_listener = TokioTcpListener::bind(admin_addr).await?;
        let public_listener = TokioTcpListener::bind(public_addr).await?;
        let admin_router = build_admin_router(gateway.clone());
        let public_router = build_public_router(gateway.clone());

        let admin_task = tokio::spawn(serve_router(admin_listener, admin_router));
        let public_task = tokio::spawn(serve_router(public_listener, public_router));
        let public_gateway = gateway.clone();
        let public_ssh_task = tokio::spawn(async move {
            run_public_ssh_server(public_gateway, public_ssh_listener, public_host_key)
                .await
                .expect("public ssh server");
        });

        let target_host_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)?;
        let target_host_public = target_host_key.public_key().to_openssh()?;
        let target_server = TestTargetServer {
            allowed_username: "ubuntu".to_owned(),
            allowed_public_key: target_key.public_key().clone(),
            host_key: target_host_key,
            direct_channels: Arc::new(Mutex::new(HashSet::new())),
        };
        let target_task =
            tokio::spawn(
                async move { target_server.run(target_addr).await.expect("target server") },
            );
        let app_task = tokio::spawn(serve_router(
            app_listener,
            Router::new()
                .route("/hello", get(workspace_app_http))
                .route("/echo", get(workspace_app_websocket)),
        ));

        let harness = Self {
            _temp_dir: temp_dir,
            admin_task,
            public_task,
            public_ssh_task,
            target_task,
            app_task,
            admin_addr,
            public_addr,
            public_ssh_addr,
            target_addr,
            app_addr,
            route_username: "run-01-web".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_host_key: target_host_public,
            target_private_key_openssh,
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
        let response = self
            .issue_terminal_session_raw(mode, authorized_client_public_keys_openssh)
            .await?;
        assert!(response.status().is_success(), "{}", response.text().await?);
        Ok(response.json().await?)
    }

    async fn issue_terminal_session_raw(
        &self,
        mode: TerminalSessionMode,
        authorized_client_public_keys_openssh: Vec<String>,
    ) -> Result<reqwest::Response> {
        self.issue_terminal_session_raw_with_lifetime(
            mode,
            authorized_client_public_keys_openssh,
            Duration::from_secs(60 * 60),
        )
        .await
    }

    async fn issue_terminal_session_raw_with_lifetime(
        &self,
        mode: TerminalSessionMode,
        authorized_client_public_keys_openssh: Vec<String>,
        route_lifetime: Duration,
    ) -> Result<reqwest::Response> {
        let request = IssueTerminalSessionRequest {
            route_username: self.route_username.clone(),
            target_username: self.target_username.clone(),
            target_ip: "127.0.0.1".to_owned(),
            target_port: self.target_addr.port(),
            target_host_key_openssh: self.target_host_key.clone(),
            target_private_key_openssh: self.target_private_key_openssh.clone(),
            authorized_client_public_keys_openssh,
            route_expires_at: (OffsetDateTime::now_utc()
                + time::Duration::seconds(i64::try_from(route_lifetime.as_secs())?))
            .unix_timestamp(),
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
        Ok(response)
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

    async fn issue_workspace_app_session(&self) -> Result<IssueWorkspaceAppSessionResponse> {
        self.issue_workspace_app_session_with_route_id("wa-01-unguessable")
            .await
    }

    async fn issue_workspace_app_session_with_route_id(
        &self,
        route_id: &str,
    ) -> Result<IssueWorkspaceAppSessionResponse> {
        self.issue_workspace_app_session_with_options(route_id, None)
            .await
    }

    async fn issue_workspace_app_session_with_options(
        &self,
        route_id: &str,
        upstream_host: Option<&str>,
    ) -> Result<IssueWorkspaceAppSessionResponse> {
        let request = IssueWorkspaceAppSessionRequest {
            route_id: route_id.to_owned(),
            target_username: self.target_username.clone(),
            target_ip: "127.0.0.1".to_owned(),
            target_ssh_port: self.target_addr.port(),
            target_host_key_openssh: self.target_host_key.clone(),
            target_private_key_openssh: self.target_private_key_openssh.clone(),
            target_app_port: self.app_addr.port(),
            protocol: WorkspaceAppProtocol::Http,
            upstream_host: upstream_host.map(ToOwned::to_owned),
            route_expires_at: (OffsetDateTime::now_utc() + time::Duration::hours(1))
                .unix_timestamp(),
            metadata: RouteMetadata {
                host_id: Some("host-01".to_owned()),
                run_id: Some("runtime-01".to_owned()),
                vm_id: Some("vm-01".to_owned()),
                user_id: Some("user-01".to_owned()),
            },
        };
        let response = reqwest::Client::new()
            .post(format!(
                "http://{}/v1/workspace-app-sessions",
                self.admin_addr
            ))
            .header("x-stargate-admin-assertion", self.admin_token()?)
            .json(&request)
            .send()
            .await?;
        assert!(response.status().is_success(), "{}", response.text().await?);
        Ok(response.json().await?)
    }

    async fn bootstrap_workspace_app(
        &self,
        session: &IssueWorkspaceAppSessionResponse,
    ) -> Result<WorkspaceAppBrowserSession> {
        let response = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?
            .get(&session.url)
            .send()
            .await?;
        assert_eq!(response.status(), reqwest::StatusCode::SEE_OTHER);
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("no-store")
        );
        assert_eq!(
            response
                .headers()
                .get("referrer-policy")
                .and_then(|v| v.to_str().ok()),
            Some("no-referrer")
        );
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .context("missing sanitized redirect location")?
            .to_str()?;
        assert!(!location.contains("__intar_bootstrap"));
        let set_cookie = response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .context("missing workspace app browser cookie")?
            .to_str()?;
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Lax"));
        assert!(set_cookie.contains("Path=/"));
        assert!(!set_cookie.to_ascii_lowercase().contains("; domain="));
        let cookie = set_cookie
            .split(';')
            .next()
            .context("empty workspace app browser cookie")?
            .to_owned();
        assert!(!cookie.contains("__intar_bootstrap"));

        // Bootstrap capabilities are one-time. Replaying the URL is scrubbed
        // again, but must not mint another browser session.
        let replay = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?
            .get(&session.url)
            .send()
            .await?;
        assert_eq!(replay.status(), reqwest::StatusCode::SEE_OTHER);
        assert!(!replay.headers().contains_key(reqwest::header::SET_COOKIE));

        let mut base_url = url::Url::parse(&session.url)?;
        base_url.set_query(None);
        Ok(WorkspaceAppBrowserSession { base_url, cookie })
    }

    async fn delete_workspace_app_route(&self, route_id: &str) -> Result<()> {
        let response = reqwest::Client::new()
            .delete(format!(
                "http://{}/v1/workspace-app-routes/{route_id}",
                self.admin_addr
            ))
            .header("x-stargate-admin-assertion", self.admin_token()?)
            .send()
            .await?;
        assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
        Ok(())
    }

    async fn public_exec(&self, command: &str) -> Result<String> {
        self.public_exec_with_profile_key(command).await
    }

    async fn public_exec_with_profile_key(&self, command: &str) -> Result<String> {
        let session = self.issue_native_terminal_session(true).await?;
        session.native.context("missing native bundle")?;
        self.ssh_exec(command).await
    }

    async fn assert_delete_terminates_public_session(&self) -> Result<()> {
        let session = self.issue_native_terminal_session(true).await?;
        session.native.context("missing native bundle")?;

        let config = client_config(&self.public_host_public);
        let route_key = Arc::new(russh::keys::decode_secret_key(
            &self.profile_client_private_key_openssh,
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

    async fn assert_delete_between_native_auth_and_channel_revokes_session(&self) -> Result<()> {
        let session = self.issue_native_terminal_session(true).await?;
        session.native.context("missing native bundle")?;

        let config = client_config(&self.public_host_public);
        let route_key = Arc::new(russh::keys::decode_secret_key(
            &self.profile_client_private_key_openssh,
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

        self.delete_route().await?;

        let channel =
            tokio::time::timeout(Duration::from_secs(2), ssh_session.channel_open_session())
                .await
                .context("native SSH channel open hung after route deletion")?;
        assert!(
            channel.is_err(),
            "native SSH opened a target channel after its route was deleted"
        );
        Ok(())
    }

    async fn open_browser_terminal(
        &self,
    ) -> Result<WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>> {
        self.open_browser_terminal_with_route_lifetime(Duration::from_secs(60 * 60))
            .await
    }

    async fn open_browser_terminal_with_route_lifetime(
        &self,
        route_lifetime: Duration,
    ) -> Result<WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>> {
        let response = self
            .issue_terminal_session_raw_with_lifetime(
                TerminalSessionMode::Browser,
                Vec::new(),
                route_lifetime,
            )
            .await?;
        assert!(response.status().is_success(), "{}", response.text().await?);
        let session = response.json::<IssueTerminalSessionResponse>().await?;
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

    async fn ssh_exec(&self, command: &str) -> Result<String> {
        let config = client_config(&self.public_host_public);
        let route_key = Arc::new(russh::keys::decode_secret_key(
            &self.profile_client_private_key_openssh,
            None,
        )?);
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
        self.app_task.abort();
    }
}

async fn assert_websocket_closes(
    websocket: &mut WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    within: Duration,
) -> Result<()> {
    tokio::time::timeout(within, async {
        loop {
            match websocket.next().await {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await
    .context("websocket remained open past its authorization expiry")?;
    Ok(())
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
    direct_channels: Arc<Mutex<HashSet<u32>>>,
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
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if host_to_connect != "127.0.0.1" {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        let Ok(port) = u16::try_from(port_to_connect) else {
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        let Ok(mut target) = tokio::net::TcpStream::connect((host_to_connect, port)).await else {
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        self.direct_channels
            .lock()
            .expect("direct channel mutex")
            .insert(channel.id().number());
        reply.accept().await;
        let direct_channels = self.direct_channels.clone();
        let channel_id = channel.id().number();
        tokio::spawn(async move {
            let mut channel = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut channel, &mut target).await;
            direct_channels
                .lock()
                .expect("direct channel mutex")
                .remove(&channel_id);
        });
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, "shell ready\n")?;
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
        session.data(channel, response.into_bytes())?;
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
        if !self
            .direct_channels
            .lock()
            .expect("direct channel mutex")
            .contains(&channel.number())
        {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }
}

async fn workspace_app_http(uri: axum::http::Uri, headers: HeaderMap) -> Response {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let cookie = headers
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let forwarded_host = headers
        .get("x-forwarded-host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let forwarded_port = headers
        .get("x-forwarded-port")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let forwarded = headers
        .get("forwarded")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let mut response = format!(
        "{uri}|{host}|{cookie}|{forwarded_host}|{forwarded_proto}|{forwarded_port}|{forwarded}"
    )
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "application_session=kept; Domain=attacker.test; Path=/; HttpOnly",
        ),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_static("__Host-intar-wapp-clobber=bad; Path=/; Secure"),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_static("malformed-cookie"),
    );
    response
}

async fn workspace_app_websocket(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(|mut socket| async move {
        while let Some(Ok(message)) = socket.recv().await {
            if matches!(message, axum::extract::ws::Message::Close(_)) {
                break;
            }
            if socket.send(message).await.is_err() {
                break;
            }
        }
    })
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
