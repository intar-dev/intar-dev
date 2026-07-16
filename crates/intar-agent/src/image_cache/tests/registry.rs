use super::*;

#[test]
fn registry_urls_resolve_relative_to_the_configured_endpoint() -> Result<()> {
    let registry = registry_config_for_url("https://registry.example/api/images");

    assert_eq!(
        build_registry_url(&registry, "ubuntu/image.raw.zst")?.as_str(),
        "https://registry.example/api/images/ubuntu/image.raw.zst"
    );
    assert_eq!(
        build_registry_url(&registry, "/artifacts/kernel")?.as_str(),
        "https://registry.example/artifacts/kernel"
    );
    assert_eq!(
        build_registry_url(&registry, "https://registry.example:443/artifacts/initrd")?.as_str(),
        "https://registry.example/artifacts/initrd"
    );

    Ok(())
}

#[test]
fn registry_urls_reject_every_cross_origin_variant() {
    let registry = registry_config_for_url("https://registry.example:8443/api/images");
    for candidate in [
        "http://registry.example:8443/image.raw.zst",
        "https://registry.example/image.raw.zst",
        "https://registry.example:9443/image.raw.zst",
        "https://cdn.example:8443/image.raw.zst",
        "//cdn.example:8443/image.raw.zst",
    ] {
        let error = build_registry_url(&registry, candidate)
            .err()
            .map(|error| error.to_string())
            .unwrap_or_default();
        assert!(
            error.contains("does not match configured registry origin"),
            "unexpected result for {candidate}: {error}"
        );
    }
}

#[tokio::test]
async fn registry_auth_is_rejected_before_credentials_reach_an_off_origin_request() -> Result<()> {
    ensure_ring_provider()?;
    let mut registry = registry_config_for_url("https://registry.example/api/images");
    registry.username = Some("registry-user".to_string());
    registry.password = Some("registry-password".to_string());
    let client = reqwest::Client::new();
    let request_url = reqwest::Url::parse("https://attacker.example/image.raw.zst")?;

    let error = apply_registry_auth(
        client.get(request_url.clone()),
        &request_url,
        &registry,
        None,
        &client,
    )
    .await
    .err()
    .map(|error| error.to_string())
    .unwrap_or_default();

    assert!(error.contains("does not match configured registry origin"));
    Ok(())
}

#[tokio::test]
async fn production_registry_client_does_not_follow_redirects() -> Result<()> {
    ensure_ring_provider()?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let requests = Arc::new(AtomicUsize::new(0));
    let requests_bg = Arc::clone(&requests);

    std::thread::spawn(move || {
        for stream in listener.incoming().take(2) {
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(_) => break,
            };
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer);
            let request_number = requests_bg.fetch_add(1, Ordering::SeqCst);
            let response = if request_number == 0 {
                "HTTP/1.1 302 Found\r\nLocation: /redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            } else {
                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            let _ = stream.write_all(response.as_bytes());
        }
    });

    let client = registry_http_client()?;
    let response = client.get(format!("http://{addr}/start")).send().await?;

    assert_eq!(response.status(), reqwest::StatusCode::FOUND);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    Ok(())
}
