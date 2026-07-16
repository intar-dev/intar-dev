use super::*;

#[tokio::test]
async fn ensure_cached_raw_removes_tmp_file_after_decompression_error() -> Result<()> {
    let raw_body = b"short";
    let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
    let expected = sha256_bytes(&compressed_body);

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let body_vec = compressed_body.clone();
    let index = registry_index_with_boot(
        &[("ubuntu", &expected, "/agent/registry/images/ubuntu/sha")],
        &"b".repeat(64),
        &"c".repeat(64),
        4096,
    );

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
                "/agent/registry/images/ubuntu/sha" => ("200 OK", body_vec.clone()),
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

    let error = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client)
        .await
        .expect_err("short raw-zstd image should not be cached");

    assert!(format!("{error:#}").contains("advertised virtual size"));
    let image_dir = cache_root.path().join("ubuntu");
    assert!(!image_dir.join(format!("{expected}.raw")).exists());
    assert!(
        !image_dir
            .join(format!("{expected}.raw.verified.json"))
            .exists()
    );
    for entry in std::fs::read_dir(&image_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        assert!(
            !name.contains(".raw.part."),
            "temporary raw cache file was not removed: {name}"
        );
    }

    Ok(())
}

#[tokio::test]
async fn ensure_cached_raw_reuses_preconverted_raw_without_qemu() -> Result<()> {
    let body = b"hello-image";
    let expected = sha256_bytes(body);

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

            let (status, response_body) = match path {
                "/images" => ("200 OK", index.clone()),
                "/agent/registry/images/ubuntu/sha" => ("200 OK", body_vec.clone()),
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
    let raw_dir = cache_root.path().join("ubuntu");
    tokio::fs::create_dir_all(&raw_dir).await?;
    let raw_path = raw_dir.join(format!("{expected}.raw"));
    tokio::fs::write(&raw_path, body).await?;
    write_raw_cache_marker(
        cache_root.path(),
        &raw_cache_record("ubuntu", &expected, body.len() as u64),
        &sha256_bytes(body),
    )
    .await?;
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = registry_config(addr);

    let path = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client).await?;

    assert_eq!(path, raw_path);
    assert_eq!(tokio::fs::read(&path).await?, body);
    assert!(
        cache_root
            .path()
            .join("ubuntu")
            .join("ubuntu.raw.zst")
            .try_exists()
            .is_ok_and(|exists| !exists)
    );

    Ok(())
}

#[tokio::test]
async fn ensure_cached_raw_refreshes_unverified_same_size_raw() -> Result<()> {
    let raw_body = b"hello-image";
    let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
    let expected = sha256_bytes(&compressed_body);

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let body_vec = compressed_body.clone();
    let image_requests = Arc::new(AtomicUsize::new(0));
    let image_requests_bg = Arc::clone(&image_requests);
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

            let (status, response_body) = match path {
                "/images" => ("200 OK", index.clone()),
                "/agent/registry/images/ubuntu/sha" => {
                    image_requests_bg.fetch_add(1, Ordering::SeqCst);
                    ("200 OK", body_vec.clone())
                }
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
    let raw_dir = cache_root.path().join("ubuntu");
    tokio::fs::create_dir_all(&raw_dir).await?;
    let raw_path = raw_dir.join(format!("{expected}.raw"));
    tokio::fs::write(&raw_path, b"bad-cache!!").await?;
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = registry_config(addr);

    let path = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client).await?;

    assert_eq!(path, raw_path);
    assert_eq!(tokio::fs::read(&path).await?, raw_body);
    assert_eq!(image_requests.load(Ordering::SeqCst), 1);
    assert!(
        cache_root
            .path()
            .join("ubuntu")
            .join(format!("{expected}.raw.verified.json"))
            .is_file()
    );

    Ok(())
}

#[tokio::test]
async fn ensure_cached_raw_refreshes_wrong_size_preconverted_raw() -> Result<()> {
    let raw_body = b"hello-image";
    let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
    let expected = sha256_bytes(&compressed_body);

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let body_vec = compressed_body.clone();
    let image_requests = Arc::new(AtomicUsize::new(0));
    let image_requests_bg = Arc::clone(&image_requests);
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

            let (status, response_body) = match path {
                "/images" => ("200 OK", index.clone()),
                "/agent/registry/images/ubuntu/sha" => {
                    image_requests_bg.fetch_add(1, Ordering::SeqCst);
                    ("200 OK", body_vec.clone())
                }
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
    let raw_dir = cache_root.path().join("ubuntu");
    tokio::fs::create_dir_all(&raw_dir).await?;
    let raw_path = raw_dir.join(format!("{expected}.raw"));
    tokio::fs::write(&raw_path, b"truncated").await?;
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = registry_config(addr);

    let path = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client).await?;

    assert_eq!(path, raw_path);
    assert_eq!(tokio::fs::read(&path).await?, raw_body);
    assert_eq!(image_requests.load(Ordering::SeqCst), 1);

    Ok(())
}
