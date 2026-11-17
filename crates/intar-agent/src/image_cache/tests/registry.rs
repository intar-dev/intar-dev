use super::*;

#[test]
fn the_registry_origin_drops_the_configured_path_and_credentials() -> Result<()> {
    for (url, origin) in [
        (
            "https://registry.example/api/images",
            "https://registry.example/",
        ),
        (
            "https://user:pw@registry.example:8443/x?y=1",
            "https://registry.example:8443/",
        ),
        ("http://127.0.0.1:9000/images", "http://127.0.0.1:9000/"),
    ] {
        assert_eq!(
            registry_origin(&registry_config_for_url(url))?.as_str(),
            origin
        );
    }
    for invalid in ["ftp://registry.example/", "/images", "not a url"] {
        assert!(
            registry_origin(&registry_config_for_url(invalid)).is_err(),
            "{invalid}"
        );
    }
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
