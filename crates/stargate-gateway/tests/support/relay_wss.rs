use super::*;
use stargate_core::{
    SshTargetTransport,
    relay::{
        HostRelayIdentity, LocalRelayTargets, RelayService, RelayTarget, binary_websocket,
        connect_host_relay,
    },
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        self,
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    },
};
use tokio_util::sync::CancellationToken;

// These credentials are public test fixtures, never deployment credentials.
const CERT: &[u8] = include_bytes!("relay-cert.der");
const KEY: &[u8] = include_bytes!("relay-key.der");

pub(super) async fn admin(
    h: &Harness,
    action: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response> {
    Ok(reqwest::Client::new()
        .post(format!("http://{}/v1/host-relays/{action}", h.admin_addr))
        .header("x-stargate-admin-assertion", h.admin_token()?)
        .json(body)
        .send()
        .await?)
}

pub(super) async fn connect_test_relay(
    h: &mut Harness,
    target: &RelayTarget,
    credentials: &serde_json::Value,
) -> Result<(
    client::Handle<stargate_core::relay::HostRelayClient>,
    tokio_util::sync::DropGuard,
)> {
    // Local TLS terminator models the production reverse proxy. The host
    // makes this outbound connection; it exposes no listening relay socket.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server = rustls::ServerConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(CERT.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY.to_vec())),
        )?;
    let acceptor = TlsAcceptor::from(Arc::new(server));
    let listener = TokioTcpListener::bind("127.0.0.1:0").await?;
    let tls_addr = listener.local_addr()?;
    let gateway_addr = h.public_addr;
    h.tasks.push((
        "relay_tls",
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    if let Ok(mut tls) = acceptor.accept(stream).await
                        && let Ok(mut http) = tokio::net::TcpStream::connect(gateway_addr).await
                    {
                        let _ = tokio::io::copy_bidirectional(&mut tls, &mut http).await;
                    }
                });
            }
        }),
    ));
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(CERT.to_vec()))?;
    let client = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let mut request =
        format!("wss://localhost:{}/v1/host-relay/ws", tls_addr.port()).into_client_request()?;
    request
        .headers_mut()
        .insert("host", "ws.example.test".parse()?);
    request.headers_mut().insert(
        "authorization",
        format!(
            "Bearer {}",
            credentials["token"]
                .as_str()
                .expect("relay grant bearer token")
        )
        .parse()?,
    );
    let (socket, _) = tokio_tungstenite::connect_async_tls_with_config(
        request,
        None,
        true,
        Some(tokio_tungstenite::Connector::Rustls(Arc::new(client))),
    )
    .await?;
    let local = LocalRelayTargets::default();
    local.assign(
        target.clone(),
        h.target_addr,
        tokio::time::Instant::now() + Duration::from_secs(120),
    )?;
    let cancel = CancellationToken::new();
    let guard = cancel.clone().drop_guard();
    let host = connect_host_relay(
        binary_websocket(socket),
        target.host.clone(),
        russh::keys::ssh_key::PublicKey::from_openssh(
            credentials["gateway_host_key_openssh"]
                .as_str()
                .expect("relay gateway host key"),
        )?,
        local,
        cancel.clone(),
    )
    .await?;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !h.host_relays.is_connected(&target.host) {
            tokio::task::yield_now().await;
        }
    })
    .await?;

    Ok((host, guard))
}

#[tokio::test]
async fn real_wss_relay_serves_native_browser_and_app_and_revokes_all_streams() -> Result<()> {
    let mut h = Harness::start_with_workspace_app_domain(Some("example.test")).await?;
    let target = RelayTarget {
        host: HostRelayIdentity {
            host_id: "host-01".into(),
            session_id: "session-01".into(),
            credential_generation: 1,
        },
        owner_id: "user-01".into(),
        execution_id: "exec-01".into(),
        execution_generation: 7,
        vm_id: "vm-01".into(),
        service: RelayService::Ssh,
    };
    h.relay_transport = Some(SshTargetTransport::Relay {
        target: target.clone(),
    });
    assert!(h.host_relays.open(&target).await.is_err());
    assert_eq!(h.target_connections.load(Ordering::SeqCst), 0);
    let now = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
    let mut grant = serde_json::json!({"identity":target.host,"targets":[target],"session_started_at_unix_ms":now-1_000,"issued_at_unix_ms":now,"expires_at_unix_ms":now+120_000});
    let response = admin(&h, "grant", &grant).await?;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let credentials: serde_json::Value = response.json().await?;
    assert!(
        credentials["websocket_url"]
            .as_str()
            .expect("relay grant websocket URL")
            .starts_with("wss://")
    );

    let (host, _guard) = connect_test_relay(&mut h, &target, &credentials).await?;

    // The route itself contains no IP. All three real public paths use it.
    assert!(
        h.public_exec_with_profile_key("hostname")
            .await?
            .contains("exec:hostname")
    );
    let (native, mut native_channel) = h
        .open_public_shell_with_private_key(&h.profile_client_private_key_openssh)
        .await?;
    wait_for_native_channel_data(&mut native_channel, "shell ready").await?;
    assert!(
        tokio::time::timeout(
            Duration::from_secs(2),
            native.channel_open_direct_tcpip("203.0.113.1", 80, "127.0.0.1", 0)
        )
        .await?
        .is_err(),
        "native clients cannot request arbitrary external forwarding"
    );
    assert!(
        tokio::time::timeout(
            Duration::from_secs(2),
            host.channel_open_direct_tcpip("169.254.169.254", 80, "", 0)
        )
        .await?
        .is_err(),
        "host peers cannot forward into gateway networks"
    );
    h.route_username = "run-01-browser".into();
    let browser = h
        .issue_terminal_session_with_keys(TerminalSessionMode::Browser, vec![])
        .await?
        .browser
        .expect("browser terminal session");
    let mut url = url::Url::parse(&browser.websocket_url)?;
    url.set_scheme("ws").expect("local websocket scheme");
    url.set_host(Some("127.0.0.1"))?;
    url.set_port(Some(h.public_addr.port()))
        .expect("local websocket port");
    let mut browser_request = url.as_str().into_client_request()?;
    browser_request
        .headers_mut()
        .insert("host", "ws.example.test".parse()?);
    browser_request
        .headers_mut()
        .insert("origin", h.allowed_origin.parse()?);
    let (mut browser_socket, _) = connect_async(browser_request).await?;
    h.stage_and_activate_terminal_target()
        .await?
        .error_for_status()?;
    browser_open_terminal(&mut browser_socket).await?;
    browser_socket
        .send(Message::Binary(b"hostname\n".to_vec().into()))
        .await?;
    assert!(
        read_browser_output(&mut browser_socket, "hostname")
            .await?
            .contains("hostname")
    );

    let app = h.issue_workspace_app_session().await?;
    let app_url = url::Url::parse(&app.url)?;
    let app_host = app_url.host_str().expect("workspace app host");
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let bootstrap = http
        .get(format!(
            "http://{}/?{}",
            h.public_addr,
            app_url.query().expect("workspace app bootstrap query")
        ))
        .header("host", app_host)
        .send()
        .await?;
    assert_eq!(bootstrap.status(), reqwest::StatusCode::SEE_OTHER);
    let cookie = bootstrap
        .headers()
        .get("set-cookie")
        .expect("workspace app session cookie")
        .to_str()?
        .split(';')
        .next()
        .expect("workspace app cookie value")
        .to_owned();
    let response = http
        .get(format!("http://{}/hello", h.public_addr))
        .header("host", app_host)
        .header("cookie", &cookie)
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let denied = http
        .request(
            reqwest::Method::CONNECT,
            format!("http://{}/hello", h.public_addr),
        )
        .header("host", app_host)
        .header("cookie", &cookie)
        .send()
        .await?;
    assert_eq!(denied.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);
    let mut app_request = format!("ws://{}/echo", h.public_addr).into_client_request()?;
    app_request.headers_mut().insert("host", app_host.parse()?);
    app_request.headers_mut().insert("cookie", cookie.parse()?);
    let (mut app_socket, _) = connect_async(app_request).await?;
    app_socket.send(Message::Text("relay app".into())).await?;
    assert_eq!(
        app_socket.next().await.transpose()?,
        Some(Message::Text("relay app".into()))
    );

    let renewed: serde_json::Value = admin(&h, "grant", &grant)
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert_eq!(renewed["token"], credentials["token"]);
    assert!(h.host_relays.is_connected(&target.host));
    let mut stale = target.clone();
    stale.execution_generation += 1;
    assert!(h.host_relays.open(&stale).await.is_err());
    stale = target.clone();
    stale.owner_id = "other-owner".into();
    assert!(h.host_relays.open(&stale).await.is_err());
    // Permission removal closes live streams and denies new ones, without
    // restarting the host tunnel or retaining per-client control-plane state.
    grant["targets"] = serde_json::json!([]);
    grant["issued_at_unix_ms"] = serde_json::json!(now + 1);
    admin(&h, "grant", &grant).await?.error_for_status()?;
    wait_for_native_channel_close(&mut native_channel).await?;
    assert_websocket_closes(&mut browser_socket, Duration::from_secs(3)).await?;
    assert_websocket_closes(&mut app_socket, Duration::from_secs(3)).await?;
    assert!(h.host_relays.open(&target).await.is_err());
    assert!(h.host_relays.is_connected(&target.host));
    admin(
        &h,
        "revoke-credentials",
        &serde_json::json!({"host_id":target.host.host_id,"credential_generation":1}),
    )
    .await?
    .error_for_status()?;
    let _ = tokio::time::timeout(Duration::from_secs(2), host).await?;
    assert_eq!(
        admin(&h, "grant", &grant).await?.status(),
        reqwest::StatusCode::CONFLICT
    );
    h.shutdown().await
}

#[tokio::test]
async fn revocation_fences_pending_grants_and_preserves_new_credentials() -> Result<()> {
    let h = Harness::start_with_workspace_app_domain(Some("example.test")).await?;
    let now = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
    let identity = serde_json::json!({"host_id":"host-01","session_id":"session-old","credential_generation":1});
    let mut request = serde_json::json!({"identity":identity,"targets":[],"session_started_at_unix_ms":now-1000,"issued_at_unix_ms":now,"expires_at_unix_ms":now+120_000});
    let unauthorized = reqwest::Client::new()
        .post(format!("http://{}/v1/host-relays/grant", h.admin_addr))
        .json(&request)
        .send()
        .await?;
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
    // A revoke can reach Stargate before the grant it is meant to cancel.
    admin(&h, "revoke", &identity).await?.error_for_status()?;
    assert_eq!(
        admin(&h, "grant", &request).await?.status(),
        reqwest::StatusCode::CONFLICT
    );
    request["identity"]["session_id"] = "session-new".into();
    request["session_started_at_unix_ms"] = (now - 500).into();
    admin(&h, "grant", &request).await?.error_for_status()?;
    admin(
        &h,
        "revoke-credentials",
        &serde_json::json!({"host_id":"host-01","credential_generation":1}),
    )
    .await?
    .error_for_status()?;
    assert_eq!(
        admin(&h, "grant", &request).await?.status(),
        reqwest::StatusCode::CONFLICT
    );
    request["identity"]["credential_generation"] = 2.into();
    request["session_started_at_unix_ms"] = now.into();
    let current: serde_json::Value = admin(&h, "grant", &request)
        .await?
        .error_for_status()?
        .json()
        .await?;
    admin(&h, "revoke", &identity).await?.error_for_status()?;
    admin(
        &h,
        "revoke-credentials",
        &serde_json::json!({"host_id":"host-01","credential_generation":1}),
    )
    .await?
    .error_for_status()?;
    let refreshed: serde_json::Value = admin(&h, "grant", &request)
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert_eq!(current["token"], refreshed["token"]);
    request["expires_at_unix_ms"] = (now + 120_001).into();
    assert_eq!(
        admin(&h, "grant", &request).await?.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    h.shutdown().await
}

#[tokio::test]
async fn same_clock_replacement_closes_old_streams_and_survives_late_revocation() -> Result<()> {
    let mut h = Harness::start_with_workspace_app_domain(Some("example.test")).await?;
    let target = RelayTarget {
        host: HostRelayIdentity {
            host_id: "host-01".into(),
            session_id: "session-01".into(),
            credential_generation: 1,
        },
        owner_id: "user-01".into(),
        execution_id: "exec-01".into(),
        execution_generation: 7,
        vm_id: "vm-01".into(),
        service: RelayService::Ssh,
    };
    h.relay_transport = Some(SshTargetTransport::Relay {
        target: target.clone(),
    });
    let now = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
    let grant = serde_json::json!({"identity":target.host,"targets":[target],
        "session_started_at_unix_ms":now,"issued_at_unix_ms":now,"expires_at_unix_ms":now+120_000});
    let credentials = admin(&h, "grant", &grant)
        .await?
        .error_for_status()?
        .json()
        .await?;
    let (old_host, _old_guard) = connect_test_relay(&mut h, &target, &credentials).await?;
    h.issue_native_terminal_session(true).await?;
    let (_old_client, mut old_channel) = h
        .open_public_shell_with_private_key(&h.profile_client_private_key_openssh)
        .await?;
    wait_for_native_channel_data(&mut old_channel, "shell ready").await?;

    let mut replacement = target.clone();
    replacement.host.session_id = "session-02".into();
    let mut next = grant.clone();
    next["identity"] = serde_json::json!(replacement.host);
    next["targets"] = serde_json::json!([replacement]);
    // Both hellos saw the same wall clock. The DO must advance the session
    // order, and grant issuance must use at least that logical millisecond.
    assert_eq!(
        admin(&h, "grant", &next).await?.status(),
        reqwest::StatusCode::CONFLICT
    );
    next["session_started_at_unix_ms"] = (now + 1).into();
    assert_eq!(
        admin(&h, "grant", &next).await?.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    next["issued_at_unix_ms"] = (now + 1).into();
    let current: serde_json::Value = admin(&h, "grant", &next)
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert_ne!(current["token"], credentials["token"]);
    wait_for_native_channel_close(&mut old_channel).await?;
    let _ = tokio::time::timeout(Duration::from_secs(2), old_host).await?;
    assert!(h.host_relays.open(&target).await.is_err());

    h.relay_transport = Some(SshTargetTransport::Relay {
        target: replacement.clone(),
    });
    let (new_host, _new_guard) = connect_test_relay(&mut h, &replacement, &current).await?;
    h.issue_native_terminal_session(true).await?;
    let (_new_client, mut new_channel) = h
        .open_public_shell_with_private_key(&h.profile_client_private_key_openssh)
        .await?;
    wait_for_native_channel_data(&mut new_channel, "shell ready").await?;
    admin(&h, "revoke", &serde_json::json!(target.host))
        .await?
        .error_for_status()?;
    let refreshed: serde_json::Value = admin(&h, "grant", &next)
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert_eq!(refreshed["token"], current["token"]);
    new_channel
        .data(&b"replacement survives old revoke"[..])
        .await?;
    wait_for_native_channel_data(&mut new_channel, "replacement survives old revoke").await?;
    assert_eq!(
        admin(&h, "grant", &grant).await?.status(),
        reqwest::StatusCode::CONFLICT
    );

    admin(&h, "revoke", &serde_json::json!(replacement.host))
        .await?
        .error_for_status()?;
    wait_for_native_channel_close(&mut new_channel).await?;
    let _ = tokio::time::timeout(Duration::from_secs(2), new_host).await?;
    assert!(h.host_relays.open(&replacement).await.is_err());
    // A revoked grant remains stored until expiry. A newer ordered session
    // must still replace it immediately, without waiting for that expiry.
    next["identity"]["session_id"] = "session-03".into();
    next["targets"][0]["host"]["session_id"] = "session-03".into();
    next["session_started_at_unix_ms"] = (now + 2).into();
    next["issued_at_unix_ms"] = (now + 2).into();
    admin(&h, "grant", &next).await?.error_for_status()?;
    h.shutdown().await
}
