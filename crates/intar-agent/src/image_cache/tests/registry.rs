use super::*;

use std::net::SocketAddr;
use std::sync::{Condvar, Mutex};

use crate::image_cache::budget::{BACKGROUND_CHUNK_FANOUT, TRANSFER_LIMIT, acquire_transfer_slot};
use intar_contracts::catalog::{
    IMAGE_CHUNK_ENCODING, IMAGE_CHUNK_MANIFEST_SCHEMA_VERSION, IMAGE_CHUNK_SIZE_BYTES, ImageChunkV1,
};

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

/// More chunks than the entry fanout, so the fanout is what limits transfers.
const FIXTURE_CHUNK_COUNT: u32 = 8;

fn encoded_chunk(index: u32) -> Vec<u8> {
    format!("encoded-chunk-{index}").into_bytes()
}

/// One loopback registry that serves a whole chunked image.
///
/// Every chunk response waits until the test opens the gate, so a test can
/// watch how many chunk transfers one cache entry runs at the same time, and
/// which transfer slots it holds while it waits.
struct GatedChunkRegistry {
    addr: SocketAddr,
    image: RegistryImageRecord,
    in_flight: Arc<AtomicUsize>,
    served: Arc<AtomicUsize>,
    gate: Arc<(Mutex<bool>, Condvar)>,
}

impl GatedChunkRegistry {
    fn start() -> Result<Self> {
        let mut chunks = Vec::new();
        for index in 0..FIXTURE_CHUNK_COUNT {
            let encoded = encoded_chunk(index);
            chunks.push(ImageChunkV1 {
                index,
                raw_size_bytes: IMAGE_CHUNK_SIZE_BYTES,
                raw_sha256: sha256_bytes(format!("raw-chunk-{index}").as_bytes()),
                encoded_size_bytes: encoded.len() as u64,
                encoded_sha256: sha256_bytes(&encoded),
            });
        }
        let mut manifest = ImageChunkManifestV1 {
            schema_version: IMAGE_CHUNK_MANIFEST_SCHEMA_VERSION,
            image_id: String::new(),
            virtual_size_bytes: u64::from(IMAGE_CHUNK_SIZE_BYTES) * u64::from(FIXTURE_CHUNK_COUNT),
            chunk_size_bytes: IMAGE_CHUNK_SIZE_BYTES,
            encoding: IMAGE_CHUNK_ENCODING.to_owned(),
            chunks,
        };
        manifest.image_id = manifest.compute_image_id()?;
        let manifest_body = serde_json::to_vec(&manifest)?;
        let chunk_manifest_sha256 = sha256_bytes(&manifest_body);

        let kernel = b"fixture kernel".to_vec();
        let initrd = b"fixture initrd".to_vec();
        let kernel_sha256 = sha256_bytes(&kernel);
        let initrd_sha256 = sha256_bytes(&initrd);
        let mut bodies = HashMap::new();
        bodies.insert("/manifest.json".to_owned(), manifest_body);
        bodies.insert(format!("/agent/registry/artifacts/{kernel_sha256}"), kernel);
        bodies.insert(format!("/agent/registry/artifacts/{initrd_sha256}"), initrd);
        let mut chunk_bodies = HashMap::new();
        for chunk in &manifest.chunks {
            chunk_bodies.insert(
                format!("/chunks/{}", chunk.raw_sha256),
                encoded_chunk(chunk.index),
            );
        }

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        let in_flight = Arc::new(AtomicUsize::new(0));
        let served = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let bodies = Arc::new(bodies);
        let chunk_bodies = Arc::new(chunk_bodies);
        {
            let in_flight = Arc::clone(&in_flight);
            let served = Arc::clone(&served);
            let gate = Arc::clone(&gate);
            let bodies = Arc::clone(&bodies);
            let chunk_bodies = Arc::clone(&chunk_bodies);
            std::thread::spawn(move || {
                for stream in listener.incoming().take(64) {
                    let Ok(mut stream) = stream else { break };
                    let in_flight = Arc::clone(&in_flight);
                    let served = Arc::clone(&served);
                    let gate = Arc::clone(&gate);
                    let bodies = Arc::clone(&bodies);
                    let chunk_bodies = Arc::clone(&chunk_bodies);
                    std::thread::spawn(move || {
                        let mut buffer = [0_u8; 4096];
                        let Ok(read) = stream.read(&mut buffer) else {
                            return;
                        };
                        let request = String::from_utf8_lossy(&buffer[..read]);
                        let path = request
                            .lines()
                            .next()
                            .and_then(|line| line.split_whitespace().nth(1))
                            .unwrap_or("/");
                        let (status, body) = match chunk_bodies.get(path) {
                            Some(body) => {
                                in_flight.fetch_add(1, Ordering::SeqCst);
                                let (open, changed) = &*gate;
                                let mut open = open.lock().expect("chunk gate is poisoned");
                                while !*open {
                                    (open, _) = changed
                                        .wait_timeout(open, Duration::from_secs(60))
                                        .expect("chunk gate is poisoned");
                                }
                                drop(open);
                                in_flight.fetch_sub(1, Ordering::SeqCst);
                                served.fetch_add(1, Ordering::SeqCst);
                                ("200 OK", body.clone())
                            }
                            None => match bodies.get(path) {
                                Some(body) => ("200 OK", body.clone()),
                                None => ("404 Not Found", Vec::new()),
                            },
                        };
                        let header = format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(header.as_bytes());
                        let _ = stream.write_all(&body);
                    });
                }
            });
        }
        Ok(Self {
            addr,
            image: RegistryImageRecord {
                image_key: "fixture".to_owned(),
                image_id: manifest.image_id.clone(),
                image_virtual_size_bytes: manifest.virtual_size_bytes,
                chunk_manifest_sha256,
                guest_bootstrap_abi: GUEST_BOOTSTRAP_ABI_V2,
                boot: RegistryImageBoot {
                    kernel_sha256,
                    initrd_sha256,
                    cmdline: "console=ttyS0".to_owned(),
                },
                manifest_download_url: "/manifest.json".to_owned(),
                chunk_download_base_url: "/chunks".to_owned(),
            },
            in_flight,
            served,
            gate,
        })
    }

    fn config(&self) -> ImageRegistryConfig {
        registry_config(self.addr)
    }

    /// Wait for this many chunk transfers to be in flight at one time.
    async fn wait_for_chunk_transfers(&self, expected: usize, deadline: Duration) -> usize {
        let until = Instant::now() + deadline;
        loop {
            let observed = self.in_flight.load(Ordering::SeqCst);
            if observed >= expected || Instant::now() >= until {
                return observed;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn served_chunks(&self) -> usize {
        self.served.load(Ordering::SeqCst)
    }

    fn open_chunk_gate(&self) {
        let (open, changed) = &*self.gate;
        *open.lock().expect("chunk gate is poisoned") = true;
        changed.notify_all();
    }
}

/// A background image warm must run its chunk transfers at the fanout, and it
/// must leave the last global transfer slot free while it waits: a launch-path
/// transfer cannot queue behind it, and the budget still stops the transfer
/// past the limit.
#[tokio::test]
async fn chunk_transfers_hold_the_fanout_and_leave_the_launch_slot_free() -> Result<()> {
    // The measured budget this test pins: four background chunk transfers
    // plus the one transfer slot that the launch path must always get.
    assert_eq!(BACKGROUND_CHUNK_FANOUT, 4);
    assert_eq!(TRANSFER_LIMIT, 5);
    ensure_ring_provider()?;
    let registry = GatedChunkRegistry::start()?;
    let cache_root = tempfile::tempdir()?;
    let client = reqwest::Client::new();
    let config = registry.config();
    let entry = {
        let image = registry.image.clone();
        let root = cache_root.path().to_path_buf();
        let client = client.clone();
        tokio::spawn(async move {
            ensure_cached_chunked_image_entry(&image, &config, None, &root, &client).await
        })
    };

    // Observe the fanout first, then release the fixture, then assert. A
    // failed assertion must not leave a chunk response waiting on the gate.
    let in_flight = registry
        .wait_for_chunk_transfers(BACKGROUND_CHUNK_FANOUT, Duration::from_secs(10))
        .await;
    // The launch path still takes the reserved transfer slot...
    let launch = tokio::time::timeout(Duration::from_secs(10), acquire_transfer_slot()).await;
    // ...and with the budget full, the transfer past the limit waits for a
    // slot instead of opening another connection.
    let past_budget =
        tokio::time::timeout(Duration::from_millis(250), acquire_transfer_slot()).await;
    let launch_slot_was_free = matches!(launch, Ok(Ok(_)));

    registry.open_chunk_gate();
    let cached = entry.await??;

    assert_eq!(cached.image_id, registry.image.image_id);
    assert_eq!(registry.served_chunks(), FIXTURE_CHUNK_COUNT as usize);
    assert_eq!(
        in_flight, BACKGROUND_CHUNK_FANOUT,
        "four background chunk transfers must make progress together"
    );
    assert!(
        launch_slot_was_free,
        "the launch transfer slot must stay free during a background warm"
    );
    assert!(
        past_budget.is_err(),
        "a transfer past the budget must wait for a slot"
    );
    Ok(())
}
