use super::*;

#[tokio::test]
async fn ensure_cached_rejects_sha_mismatch() -> Result<()> {
    let body = b"hello-image";
    let wrong = sha256_bytes(b"wrong");

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let body_vec = body.to_vec();
    let index = registry_index(&[("ubuntu", &wrong, "/agent/registry/images/ubuntu/wrong")]);

    std::thread::spawn(move || {
        for stream in listener.incoming().take(4) {
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(_) => break,
            };
            let mut buf = [0u8; 4096];
            let read = match stream.read(&mut buf) {
                Ok(read) => read,
                Err(_) => continue,
            };
            let request = String::from_utf8_lossy(&buf[..read]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");

            let (status, response_body) = match path {
                "/images" => ("200 OK", index.clone()),
                "/agent/registry/images/ubuntu/wrong" => ("200 OK", body_vec.clone()),
                _ => ("404 Not Found", Vec::new()),
            };

            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&response_body);
        }
    });

    let cache_root = tempfile::tempdir()?;
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = registry_config(addr);

    match ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await {
        Ok(path) => anyhow::bail!("expected sha mismatch to fail, cached {}", path.display()),
        Err(error) => {
            let msg = error.to_string();
            assert!(msg.contains("sha256 mismatch"), "unexpected error: {msg}");
        }
    }
    assert!(
        !cache_root
            .path()
            .join("ubuntu")
            .join("ubuntu.raw.zst")
            .exists(),
        "mismatched image must not be installed in cache"
    );

    Ok(())
}

#[tokio::test]
async fn ensure_cached_rejects_missing_registry_sha256() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let index = format!(
        r#"{{"images":[{{"image_key":"ubuntu","image_sha256":"","image_format":"raw_zstd","image_virtual_size_bytes":11,"boot":{{"kernel_sha256":"{}","initrd_sha256":"{}","cmdline":"root=/dev/vda rw"}},"download_url":"/image"}}]}}"#,
        "b".repeat(64),
        "c".repeat(64)
    )
    .into_bytes();

    std::thread::spawn(move || {
        for stream in listener.incoming().take(4) {
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(_) => break,
            };
            let mut buf = [0u8; 4096];
            let read = match stream.read(&mut buf) {
                Ok(read) => read,
                Err(_) => continue,
            };
            let request = String::from_utf8_lossy(&buf[..read]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");

            let (status, response_body) = match path {
                "/images" => ("200 OK", index.clone()),
                _ => ("404 Not Found", Vec::new()),
            };

            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&response_body);
        }
    });

    let cache_root = tempfile::tempdir()?;
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = registry_config(addr);

    match ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await {
        Ok(path) => anyhow::bail!(
            "expected missing registry sha256 to fail, cached {}",
            path.display()
        ),
        Err(error) => {
            let msg = error.to_string();
            assert!(
                msg.contains("is not advertised by registry"),
                "unexpected error: {msg}"
            );
        }
    }
    assert!(
        !cache_root
            .path()
            .join("ubuntu")
            .join("ubuntu.raw.zst")
            .exists(),
        "unverified image must not be installed in cache"
    );

    Ok(())
}

#[tokio::test]
async fn ensure_cached_uses_basic_auth_when_configured() -> Result<()> {
    let body = b"hello-image";
    let expected = sha256_bytes(body);
    let authorization = "Basic ZGVtbzpzZWNyZXQ=".to_string();

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let body_vec = body.to_vec();
    let index = registry_index(&[("ubuntu", &expected, "/agent/registry/images/ubuntu/sha")]);

    std::thread::spawn(move || {
        for stream in listener.incoming().take(4) {
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(_) => break,
            };
            let mut buf = [0u8; 4096];
            let read = match stream.read(&mut buf) {
                Ok(read) => read,
                Err(_) => continue,
            };
            let request = String::from_utf8_lossy(&buf[..read]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");
            let has_auth = request
                .lines()
                .any(|line| line.eq_ignore_ascii_case(&format!("authorization: {authorization}")));

            let (status, response_body) = if !has_auth {
                ("401 Unauthorized", Vec::new())
            } else {
                match path {
                    "/images" => ("200 OK", index.clone()),
                    "/agent/registry/images/ubuntu/sha" => ("200 OK", body_vec.clone()),
                    _ => ("404 Not Found", Vec::new()),
                }
            };

            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&response_body);
        }
    });

    let cache_root = tempfile::tempdir()?;
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = ImageRegistryConfig {
        url: format!("http://{addr}/images"),
        username: Some("demo".to_string()),
        password: Some("secret".to_string()),
        refresh_interval_minutes: 15,
    };

    let path = ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await?;
    assert!(path.is_file());

    Ok(())
}

#[test]
fn registry_images_from_index_discards_invalid_records() {
    let sha = "a".repeat(64);
    let images = registry_images_from_index(RegistryIndex {
        images: vec![
            RegistryIndexImage {
                image_key: "ubuntu".to_string(),
                image_sha256: sha.clone(),
                image_format: "raw_zstd".to_string(),
                image_virtual_size_bytes: 11,
                boot: RegistryIndexImageBoot {
                    kernel_sha256: "b".repeat(64),
                    initrd_sha256: "c".repeat(64),
                    cmdline: "root=/dev/vda rw".to_string(),
                },
                download_url: "/agent/registry/images/ubuntu/sha".to_string(),
            },
            RegistryIndexImage {
                image_key: "../bad".to_string(),
                image_sha256: sha.clone(),
                image_format: "raw_zstd".to_string(),
                image_virtual_size_bytes: 11,
                boot: RegistryIndexImageBoot {
                    kernel_sha256: "b".repeat(64),
                    initrd_sha256: "c".repeat(64),
                    cmdline: "root=/dev/vda rw".to_string(),
                },
                download_url: "/bad".to_string(),
            },
            RegistryIndexImage {
                image_key: "missing-sha".to_string(),
                image_sha256: String::new(),
                image_format: "raw_zstd".to_string(),
                image_virtual_size_bytes: 11,
                boot: RegistryIndexImageBoot {
                    kernel_sha256: "b".repeat(64),
                    initrd_sha256: "c".repeat(64),
                    cmdline: "root=/dev/vda rw".to_string(),
                },
                download_url: "/missing".to_string(),
            },
        ],
    });

    assert_eq!(
        images
            .into_iter()
            .map(|image| {
                (
                    image.image_key,
                    image.image_filename,
                    image.image_sha256,
                    image.download_url,
                )
            })
            .collect::<Vec<_>>(),
        vec![(
            "ubuntu".to_string(),
            "ubuntu.raw.zst".to_string(),
            sha,
            "/agent/registry/images/ubuntu/sha".to_string(),
        )]
    );
}

#[tokio::test]
async fn ensure_cached_rejects_unlisted_image_key() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let sha = "a".repeat(64);
    let index = registry_index(&[(
        "broken-nginx-webserver-amd64",
        &sha,
        "/agent/registry/images/broken-nginx-webserver-amd64/sha",
    )]);

    std::thread::spawn(move || {
        for stream in listener.incoming().take(2) {
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(_) => break,
            };
            let mut buf = [0u8; 4096];
            let read = match stream.read(&mut buf) {
                Ok(read) => read,
                Err(_) => continue,
            };
            let request = String::from_utf8_lossy(&buf[..read]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");

            let (status, response_body) = match path {
                "/images" => ("200 OK", index.clone()),
                _ => ("404 Not Found", Vec::new()),
            };

            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&response_body);
        }
    });

    let cache_root = tempfile::tempdir()?;
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = registry_config(addr);

    match ensure_cached(
        "broken_nginx_webserver_amd64",
        &registry,
        None,
        cache_root.path(),
        &client,
    )
    .await
    {
        Ok(_) => anyhow::bail!("expected unlisted image key to fail"),
        Err(error) => {
            let msg = error.to_string();
            assert!(
                msg.contains("is not advertised by registry"),
                "unexpected error: {msg}"
            );
        }
    }

    Ok(())
}
