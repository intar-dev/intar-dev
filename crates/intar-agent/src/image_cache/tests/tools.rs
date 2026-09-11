use std::io::{Cursor, Read as _, Write as _};
use std::net::{SocketAddr, TcpListener};

use super::*;

const TOOLS_DISK_BYTES: usize = 64 * 1024 * 1024;

/// Serves one sparse 64 MiB guest tools disk from a loopback origin.
///
/// The fixture counts served requests so a test can prove that a launch
/// reused verified bytes and that a corrupt, replaced, or missing disk was
/// actually repaired instead of being trusted.
struct ToolsDiskRegistry {
    addr: SocketAddr,
    sha256: String,
    requests: Arc<AtomicUsize>,
}

impl ToolsDiskRegistry {
    fn start() -> Result<Self> {
        let mut raw = vec![0u8; TOOLS_DISK_BYTES];
        raw[..8].copy_from_slice(b"INTART01");
        Self::start_with_raw(&raw)
    }

    fn start_with_raw(raw: &[u8]) -> Result<Self> {
        let sha256 = sha256_bytes(raw);
        let body = zstd::encode_all(Cursor::new(raw), 0)?;
        let requests = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let served = Arc::clone(&requests);
        let expected_path = format!("/agent/registry/guest-tools/disks/{sha256}");
        std::thread::spawn(move || {
            for stream in listener.incoming().take(8) {
                let Ok(mut stream) = stream else { break };
                let mut buffer = [0u8; 4096];
                let Ok(read) = stream.read(&mut buffer) else {
                    continue;
                };
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let (status, response) = if path == expected_path {
                    served.fetch_add(1, Ordering::SeqCst);
                    ("200 OK", body.clone())
                } else {
                    ("404 Not Found", Vec::new())
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&response);
            }
        });
        Ok(Self {
            addr,
            sha256,
            requests,
        })
    }

    fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    fn cached_path(&self, cache_root: &Path) -> PathBuf {
        cache_root
            .join("tools")
            .join(format!("{}.ext4", self.sha256))
    }
}

async fn ensure(
    registry: &ToolsDiskRegistry,
    cache_root: &Path,
    client: &reqwest::Client,
    verification: ToolsDiskVerification,
) -> Result<PathBuf> {
    ensure_cached_tools_disk(
        &registry.sha256,
        TOOLS_DISK_BYTES as u64,
        &registry_config(registry.addr),
        None,
        cache_root,
        client,
        verification,
    )
    .await
}

/// Assert the published cache object is the single verified regular file that
/// a launch would stage.
async fn assert_published_disk(registry: &ToolsDiskRegistry, cache_root: &Path) -> Result<PathBuf> {
    let path = registry.cached_path(cache_root);
    let metadata = std::fs::symlink_metadata(&path)?;
    assert!(metadata.file_type().is_file());
    assert_eq!(metadata.len(), TOOLS_DISK_BYTES as u64);
    assert_eq!(sha256_file(&path).await?, registry.sha256);
    assert_eq!(std::fs::read_dir(cache_root.join("tools"))?.count(), 1);
    Ok(path)
}

#[tokio::test]
async fn ensure_cached_tools_disk_creates_and_reuses_verified_raw_output() -> Result<()> {
    ensure_ring_provider()?;
    let registry = ToolsDiskRegistry::start()?;
    let cache_root = tempfile::tempdir()?;
    let client = reqwest::Client::new();

    let first = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;
    let second = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    assert_eq!(second, first);
    assert_eq!(
        first,
        assert_published_disk(&registry, cache_root.path()).await?
    );
    // A second launch reuses the recorded verification instead of reading the
    // full disk or downloading it again.
    assert_eq!(registry.requests(), 1);
    Ok(())
}

#[tokio::test]
async fn ensure_cached_tools_disk_repairs_in_place_corruption_with_restored_mtime() -> Result<()> {
    ensure_ring_provider()?;
    let registry = ToolsDiskRegistry::start()?;
    let cache_root = tempfile::tempdir()?;
    let client = reqwest::Client::new();
    let path = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    let modified = std::fs::metadata(&path)?.modified()?;
    {
        let mut file = std::fs::OpenOptions::new().write(true).open(&path)?;
        file.write_all(b"CORRUPT!")?;
        file.set_modified(modified)?;
    }

    let repaired = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    assert_eq!(repaired, path);
    assert_eq!(
        repaired,
        assert_published_disk(&registry, cache_root.path()).await?
    );
    assert_eq!(registry.requests(), 2);
    Ok(())
}

#[tokio::test]
async fn ensure_cached_tools_disk_repairs_an_atomically_replaced_disk() -> Result<()> {
    ensure_ring_provider()?;
    let registry = ToolsDiskRegistry::start()?;
    let cache_root = tempfile::tempdir()?;
    let client = reqwest::Client::new();
    let path = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    let replacement = cache_root.path().join("tools").join("replacement.ext4");
    std::fs::write(&replacement, vec![0u8; TOOLS_DISK_BYTES])?;
    std::fs::rename(&replacement, &path)?;

    let repaired = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    assert_eq!(repaired, path);
    assert_eq!(
        repaired,
        assert_published_disk(&registry, cache_root.path()).await?
    );
    assert_eq!(registry.requests(), 2);
    Ok(())
}

#[tokio::test]
async fn ensure_cached_tools_disk_rebuilds_a_missing_disk() -> Result<()> {
    ensure_ring_provider()?;
    let registry = ToolsDiskRegistry::start()?;
    let cache_root = tempfile::tempdir()?;
    let client = reqwest::Client::new();
    let path = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    std::fs::remove_file(&path)?;

    let rebuilt = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    assert_eq!(rebuilt, path);
    assert_eq!(
        rebuilt,
        assert_published_disk(&registry, cache_root.path()).await?
    );
    assert_eq!(registry.requests(), 2);
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn ensure_cached_tools_disk_rejects_a_symlinked_disk_without_touching_its_target()
-> Result<()> {
    ensure_ring_provider()?;
    let registry = ToolsDiskRegistry::start()?;
    let cache_root = tempfile::tempdir()?;
    let client = reqwest::Client::new();
    let path = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    let displaced = cache_root.path().join("tools").join("displaced.ext4");
    std::fs::rename(&path, &displaced)?;
    std::os::unix::fs::symlink(&displaced, &path)?;

    let rebuilt = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    assert_eq!(rebuilt, path);
    assert!(std::fs::symlink_metadata(&path)?.file_type().is_file());
    assert_eq!(sha256_file(&path).await?, registry.sha256);
    // Repair removes the link, never the verified file it pointed at.
    assert_eq!(sha256_file(&displaced).await?, registry.sha256);
    assert_eq!(registry.requests(), 2);
    Ok(())
}

#[tokio::test]
async fn ensure_cached_tools_disk_serves_concurrent_callers_from_one_verification() -> Result<()> {
    ensure_ring_provider()?;
    let registry = ToolsDiskRegistry::start()?;
    let cache_root = tempfile::tempdir()?;
    let client = reqwest::Client::new();
    let first = ensure(
        &registry,
        cache_root.path(),
        &client,
        ToolsDiskVerification::ReuseVerified,
    )
    .await?;

    let mut handles = Vec::new();
    for _ in 0..8 {
        let sha256 = registry.sha256.clone();
        let config = registry_config(registry.addr);
        let client = client.clone();
        let root = cache_root.path().to_path_buf();
        handles.push(tokio::spawn(async move {
            ensure_cached_tools_disk(
                &sha256,
                TOOLS_DISK_BYTES as u64,
                &config,
                None,
                &root,
                &client,
                ToolsDiskVerification::ReuseVerified,
            )
            .await
        }));
    }

    for handle in handles {
        assert_eq!(handle.await??, first);
    }
    assert_eq!(
        first,
        assert_published_disk(&registry, cache_root.path()).await?
    );
    assert_eq!(registry.requests(), 1);
    Ok(())
}
