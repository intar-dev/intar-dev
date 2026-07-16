use super::*;

#[tokio::test]
async fn ensure_cached_downloads_and_reuses_cache() -> Result<()> {
    let body = b"hello-image";
    let expected = sha256_bytes(body);

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let list_requests = Arc::new(AtomicUsize::new(0));
    let image_requests = Arc::new(AtomicUsize::new(0));
    let list_requests_bg = Arc::clone(&list_requests);
    let image_requests_bg = Arc::clone(&image_requests);
    let body_vec = body.to_vec();
    let index = registry_index(&[("ubuntu", &expected, "/agent/registry/images/ubuntu/sha")]);

    std::thread::spawn(move || {
        for stream in listener.incoming().take(8) {
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
                "/images" => {
                    list_requests_bg.fetch_add(1, Ordering::SeqCst);
                    ("200 OK", index.clone())
                }
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
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = registry_config(addr);

    let path_1 = ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await?;
    let path_2 = ensure_cached("ubuntu", &registry, None, cache_root.path(), &client).await?;

    assert_eq!(path_1, path_2);
    assert!(path_1.is_file());
    assert_eq!(list_requests.load(Ordering::SeqCst), 2);
    assert_eq!(image_requests.load(Ordering::SeqCst), 1);
    assert!(
        cache_root
            .path()
            .join("ubuntu")
            .join("ubuntu.raw.zst.sha256")
            .is_file()
    );

    Ok(())
}

#[tokio::test]
async fn ensure_cached_raw_decompresses_raw_zstd() -> Result<()> {
    let raw_body = b"hello-image";
    let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
    let expected = sha256_bytes(&compressed_body);

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let body_vec = compressed_body.clone();
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
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = registry_config(addr);

    let path = ensure_cached_raw("ubuntu", &registry, None, cache_root.path(), &client).await?;

    assert_eq!(tokio::fs::read(&path).await?, raw_body);
    assert!(
        cache_root
            .path()
            .join("ubuntu")
            .join("ubuntu.raw.zst")
            .is_file()
    );
    assert!(
        cache_root
            .path()
            .join("ubuntu")
            .join(format!("{expected}.raw.verified.json"))
            .is_file()
    );

    Ok(())
}

#[test]
fn raw_zstd_decompression_round_trips_sparse_image() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let compressed_path = temp.path().join("root.raw.zst");
    let raw_path = temp.path().join("root.raw");
    let virtual_size = 16 * 1024 * 1024;
    let mut raw_body = vec![0u8; virtual_size];
    raw_body[4096..4104].copy_from_slice(b"INTAR001");
    raw_body[(8 * 1024 * 1024)..(8 * 1024 * 1024 + 8)].copy_from_slice(b"INTAR002");
    raw_body[(virtual_size - 8192)..(virtual_size - 8184)].copy_from_slice(b"INTAR003");
    std::fs::write(
        &compressed_path,
        zstd::encode_all(Cursor::new(&raw_body), 0)?,
    )?;
    std::fs::File::create(&raw_path)?;

    let raw_sha256 = decompress_raw_zstd_sparse(&compressed_path, &raw_path, virtual_size as u64)?;

    assert_eq!(std::fs::read(&raw_path)?, raw_body);
    assert_eq!(raw_sha256, sha256_bytes(&raw_body));
    let metadata = std::fs::metadata(&raw_path)?;
    assert_eq!(metadata.len(), virtual_size as u64);

    #[cfg(target_os = "linux")]
    {
        let allocated_bytes = metadata.blocks().saturating_mul(512);
        assert!(
            allocated_bytes < (virtual_size as u64 / 2),
            "expected sparse allocation below half of virtual size, got {allocated_bytes} bytes for {virtual_size}"
        );
    }

    Ok(())
}

#[test]
fn raw_zstd_decompression_rejects_short_stream() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let compressed_path = temp.path().join("short.raw.zst");
    let raw_path = temp.path().join("short.raw");
    std::fs::write(
        &compressed_path,
        zstd::encode_all(Cursor::new(b"short"), 0)?,
    )?;
    std::fs::File::create(&raw_path)?;

    let error = decompress_raw_zstd_sparse(&compressed_path, &raw_path, 4096)
        .expect_err("short raw-zstd stream should be rejected");

    assert!(format!("{error:#}").contains("advertised virtual size"));
    assert!(!raw_path.is_file() || std::fs::metadata(&raw_path)?.len() != 4096);

    Ok(())
}

#[test]
fn raw_zstd_decompression_rejects_oversized_stream_before_declared_size() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let compressed_path = temp.path().join("oversized.raw.zst");
    let raw_path = temp.path().join("oversized.raw");
    let advertised_size = 4096u64;
    let raw_body = vec![1u8; (advertised_size as usize) + 8192];
    std::fs::write(
        &compressed_path,
        zstd::encode_all(Cursor::new(&raw_body), 0)?,
    )?;
    std::fs::File::create(&raw_path)?;

    let error = decompress_raw_zstd_sparse(&compressed_path, &raw_path, advertised_size)
        .expect_err("oversized raw-zstd stream should be rejected");

    assert!(format!("{error:#}").contains("exceeds advertised virtual size"));
    assert!(std::fs::metadata(&raw_path)?.len() <= advertised_size);

    Ok(())
}

#[tokio::test]
async fn ensure_cached_image_downloads_boot_artifacts() -> Result<()> {
    let raw_body = b"hello-image";
    let compressed_body = zstd::encode_all(Cursor::new(raw_body), 0)?;
    let image_sha256 = sha256_bytes(&compressed_body);
    let kernel_body = b"kernel";
    let initrd_body = b"initrd";
    let kernel_sha256 = sha256_bytes(kernel_body);
    let initrd_sha256 = sha256_bytes(initrd_body);
    let image_requests = Arc::new(AtomicUsize::new(0));
    let kernel_requests = Arc::new(AtomicUsize::new(0));
    let initrd_requests = Arc::new(AtomicUsize::new(0));

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    let compressed_body_bg = compressed_body.clone();
    let kernel_body_bg = kernel_body.to_vec();
    let initrd_body_bg = initrd_body.to_vec();
    let kernel_sha256_bg = kernel_sha256.clone();
    let initrd_sha256_bg = initrd_sha256.clone();
    let image_requests_bg = Arc::clone(&image_requests);
    let kernel_requests_bg = Arc::clone(&kernel_requests);
    let initrd_requests_bg = Arc::clone(&initrd_requests);
    let index = registry_index_with_boot(
        &[("ubuntu", &image_sha256, "/agent/registry/images/ubuntu/sha")],
        &kernel_sha256,
        &initrd_sha256,
        raw_body.len() as u64,
    );

    std::thread::spawn(move || {
        for stream in listener.incoming().take(8) {
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
                    ("200 OK", compressed_body_bg.clone())
                }
                path if path == format!("/agent/registry/artifacts/{kernel_sha256_bg}") => {
                    kernel_requests_bg.fetch_add(1, Ordering::SeqCst);
                    ("200 OK", kernel_body_bg.clone())
                }
                path if path == format!("/agent/registry/artifacts/{initrd_sha256_bg}") => {
                    initrd_requests_bg.fetch_add(1, Ordering::SeqCst);
                    ("200 OK", initrd_body_bg.clone())
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
    ensure_ring_provider()?;
    let client = reqwest::Client::new();
    let registry = registry_config(addr);

    let first = Box::pin(ensure_cached_image(
        "ubuntu",
        &registry,
        None,
        cache_root.path(),
        &client,
    ));
    let second = Box::pin(ensure_cached_image(
        "ubuntu",
        &registry,
        None,
        cache_root.path(),
        &client,
    ));
    let (first, second) = tokio::join!(first, second);
    let cached = first?;
    let concurrently_cached = second?;

    assert_eq!(tokio::fs::read(&cached.raw_path).await?, raw_body);
    assert_eq!(tokio::fs::read(&cached.kernel_path).await?, kernel_body);
    assert_eq!(tokio::fs::read(&cached.initrd_path).await?, initrd_body);
    assert_eq!(cached.raw_sha256, sha256_bytes(raw_body));
    assert_eq!(cached.cmdline, "root=/dev/vda rw");
    assert_eq!(cached.virtual_size_bytes, raw_body.len() as u64);
    assert_eq!(concurrently_cached.raw_path, cached.raw_path);
    assert_eq!(concurrently_cached.kernel_path, cached.kernel_path);
    assert_eq!(concurrently_cached.initrd_path, cached.initrd_path);
    assert_eq!(image_requests.load(Ordering::SeqCst), 1);
    assert_eq!(kernel_requests.load(Ordering::SeqCst), 1);
    assert_eq!(initrd_requests.load(Ordering::SeqCst), 1);

    assert!(
        verified_cached_image_metadata(cache_root.path(), "ubuntu", &image_sha256, true,).is_none(),
        "template-capable hosts must not report Ready before jailerd preparation"
    );
    let missing = require_ready_image_launch(cache_root.path(), "ubuntu", Some(&image_sha256))
        .await
        .expect_err("foreground launch must fail when background prewarm is incomplete");
    assert!(format!("{missing:#}").contains("foreground registry fallback is disabled"));
    let prepared_source =
        |name: &str, sha256: &str, access| intar_jailer_protocol::ArtifactSource {
            source_root: intar_jailer_protocol::PREPARED_IMAGE_SOURCE_ROOT,
            relative_path: PathBuf::from(&image_sha256).join(name),
            sha256: Some(
                intar_jailer_protocol::Sha256Digest::parse(sha256.to_owned()).expect("digest"),
            ),
            access,
        };
    let prepared = intar_jailer_protocol::PreparedImageV2Result {
        image_sha256: intar_jailer_protocol::Sha256Digest::parse(image_sha256.clone())?,
        virtual_size_bytes: raw_body.len() as u64,
        root_disk: prepared_source(
            "root.raw",
            &cached.raw_sha256,
            intar_jailer_protocol::ArtifactAccess::ReadWrite,
        ),
        kernel: prepared_source(
            "kernel",
            &kernel_sha256,
            intar_jailer_protocol::ArtifactAccess::ReadOnly,
        ),
        initrd: Some(prepared_source(
            "initrd",
            &initrd_sha256,
            intar_jailer_protocol::ArtifactAccess::ReadOnly,
        )),
        fast_template_store: true,
    };
    mark_template_ready(&cached, &prepared).await?;
    assert!(
        verified_cached_image_metadata(cache_root.path(), "ubuntu", &image_sha256, true,).is_some()
    );
    let request_counts_before_launch = (
        image_requests.load(Ordering::SeqCst),
        kernel_requests.load(Ordering::SeqCst),
        initrd_requests.load(Ordering::SeqCst),
    );
    let ready =
        require_ready_image_launch(cache_root.path(), "ubuntu", Some(&image_sha256)).await?;
    assert_eq!(ready.image, cached);
    assert_eq!(ready.prepared_image, prepared);
    assert_eq!(
        (
            image_requests.load(Ordering::SeqCst),
            kernel_requests.load(Ordering::SeqCst),
            initrd_requests.load(Ordering::SeqCst),
        ),
        request_counts_before_launch,
        "foreground launch descriptor reads must issue no registry requests"
    );

    let stale = require_ready_image_launch(cache_root.path(), "ubuntu", Some(&"f".repeat(64)))
        .await
        .expect_err("desired image digest must fence a stale launch descriptor");
    assert!(format!("{stale:#}").contains("stale launch descriptor"));

    let descriptor_path = launch_descriptor_path_for_raw(&cached.raw_path)?;
    let mut tampered: LaunchDescriptorV1 =
        serde_json::from_slice(&tokio::fs::read(&descriptor_path).await?)?;
    tampered.cmdline = "console=ttyS0 compromised=1".to_string();
    tokio::fs::write(&descriptor_path, serde_json::to_vec(&tampered)?).await?;
    assert!(
        verified_cached_image_metadata(cache_root.path(), "ubuntu", &image_sha256, true,).is_none(),
        "a descriptor that no longer matches the prewarm record must revoke readiness"
    );
    assert!(
        require_ready_image_launch(cache_root.path(), "ubuntu", Some(&image_sha256),)
            .await
            .is_err()
    );

    mark_template_ready(&cached, &prepared).await?;
    remove_launch_descriptor_if_matching(cache_root.path(), "ubuntu", &"f".repeat(64)).await?;
    assert!(
        descriptor_path.is_file(),
        "another image eviction must not revoke Ready"
    );
    remove_launch_descriptor_if_matching(cache_root.path(), "ubuntu", &image_sha256).await?;
    assert!(
        !descriptor_path.exists(),
        "evicting the descriptor's image must revoke Ready"
    );

    Ok(())
}
