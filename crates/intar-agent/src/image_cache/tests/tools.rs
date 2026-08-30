use std::io::Cursor;

use super::*;

#[tokio::test]
async fn ensure_cached_tools_disk_creates_and_reuses_verified_raw_output() -> Result<()> {
    const TOOLS_DISK_BYTES: usize = 64 * 1024 * 1024;
    let mut raw_body = vec![0u8; TOOLS_DISK_BYTES];
    raw_body[..8].copy_from_slice(b"INTART01");
    let tools_disk_sha256 = sha256_bytes(&raw_body);
    let compressed_body = zstd::encode_all(Cursor::new(&raw_body), 0)?;
    let requests = Arc::new(AtomicUsize::new(0));
    let requests_bg = Arc::clone(&requests);
    let tools_disk_sha256_bg = tools_disk_sha256.clone();
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;

    std::thread::spawn(move || {
        for stream in listener.incoming().take(2) {
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(_) => break,
            };
            let mut buffer = [0u8; 4096];
            let read = match stream.read(&mut buffer) {
                Ok(read) => read,
                Err(_) => continue,
            };
            let request = String::from_utf8_lossy(&buffer[..read]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");
            let expected_path = format!("/agent/registry/guest-tools/disks/{tools_disk_sha256_bg}");
            let (status, response_body) = if path == expected_path {
                requests_bg.fetch_add(1, Ordering::SeqCst);
                ("200 OK", compressed_body.clone())
            } else {
                ("404 Not Found", Vec::new())
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
    let first = ensure_cached_tools_disk(
        &tools_disk_sha256,
        TOOLS_DISK_BYTES as u64,
        &registry,
        None,
        cache_root.path(),
        &client,
    )
    .await?;
    let second = ensure_cached_tools_disk(
        &tools_disk_sha256,
        TOOLS_DISK_BYTES as u64,
        &registry,
        None,
        cache_root.path(),
        &client,
    )
    .await?;

    assert_eq!(first, second);
    assert_eq!(std::fs::metadata(&first)?.len(), TOOLS_DISK_BYTES as u64);
    assert_eq!(sha256_file(&first).await?, tools_disk_sha256);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let cache_entries =
        std::fs::read_dir(cache_root.path().join("tools"))?.collect::<std::io::Result<Vec<_>>>()?;
    assert_eq!(cache_entries.len(), 1);

    Ok(())
}
