use super::*;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode as Status, header};
use axum::response::{IntoResponse, Response};
use intar_contracts::oci::{IMAGE_FORMAT, OCI_MANIFEST_MEDIA_TYPE};

/// A registry that serves what it holds by digest, to the token it last
/// handed out.
#[derive(Default)]
struct Registry {
    objects: StdMutex<HashMap<String, Vec<u8>>>,
    token: StdMutex<String>,
    exchanges: AtomicUsize,
    requests: StdMutex<Vec<(String, Option<String>)>>,
    /// Answer a range request with the whole object as a range from byte 0.
    wrong_range: AtomicBool,
}

impl Registry {
    fn put(&self, bytes: &[u8]) -> OciDigest {
        let hex = sha256_hex(bytes);
        self.objects
            .lock()
            .expect("objects")
            .insert(hex.clone(), bytes.to_vec());
        OciDigest::try_from(format!("sha256:{hex}")).expect("a digest")
    }

    fn descriptor(&self, media_type: &str, bytes: &[u8]) -> OciDescriptorV1 {
        OciDescriptorV1 {
            media_type: media_type.to_owned(),
            digest: self.put(bytes),
            size: bytes.len() as u64,
        }
    }

    fn requests_for(&self, digest: &OciDigest) -> Vec<Option<String>> {
        let requests = self.requests.lock().expect("requests");
        requests
            .iter()
            .filter(|(path, _)| path.ends_with(digest.as_str()))
            .map(|(_, range)| range.clone())
            .collect()
    }
}

async fn token(State(registry): State<Arc<Registry>>, headers: HeaderMap) -> Response {
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some("Bearer agent-jwt")
    {
        return Status::UNAUTHORIZED.into_response();
    }
    let number = registry.exchanges.fetch_add(1, Ordering::SeqCst) + 1;
    let token = format!("registry-token-{number}");
    registry.token.lock().expect("token").clone_from(&token);
    axum::Json(serde_json::json!({"token": token, "access_token": token, "expires_in": 900}))
        .into_response()
}

async fn object(
    State(registry): State<Arc<Registry>>,
    UrlPath(rest): UrlPath<String>,
    headers: HeaderMap,
) -> Response {
    let header_text = |name| {
        headers
            .get(name)
            .and_then(|value: &axum::http::HeaderValue| value.to_str().ok())
    };
    let expected = format!("Bearer {}", registry.token.lock().expect("token"));
    if header_text(header::AUTHORIZATION) != Some(expected.as_str()) {
        return Status::UNAUTHORIZED.into_response();
    }
    let range = header_text(header::RANGE).map(str::to_owned);
    registry
        .requests
        .lock()
        .expect("requests")
        .push((rest.clone(), range.clone()));
    let hex = rest.rsplit("sha256:").next().unwrap_or_default();
    let Some(bytes) = registry.objects.lock().expect("objects").get(hex).cloned() else {
        return Status::NOT_FOUND.into_response();
    };
    match range.and_then(|range| {
        range
            .strip_prefix("bytes=")?
            .strip_suffix('-')?
            .parse::<usize>()
            .ok()
    }) {
        Some(from) if from < bytes.len() => {
            let from = if registry.wrong_range.load(Ordering::SeqCst) {
                0
            } else {
                from
            };
            let range = format!("bytes {from}-{}/{}", bytes.len() - 1, bytes.len());
            (
                Status::PARTIAL_CONTENT,
                [(header::CONTENT_RANGE, range)],
                bytes[from..].to_vec(),
            )
                .into_response()
        }
        _ => bytes.into_response(),
    }
}

async fn serve() -> (Arc<Registry>, OciRegistry, tempfile::TempDir, BlobStore) {
    crate::tls_provider::ensure_ring_provider().expect("TLS provider");
    let registry = Arc::new(Registry::default());
    let app = axum::Router::new()
        .route("/v2/token", axum::routing::get(token))
        .route("/v2/{*rest}", axum::routing::get(object))
        .with_state(Arc::clone(&registry));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let origin = reqwest::Url::parse(&format!(
        "http://{}",
        listener.local_addr().expect("address")
    ))
    .expect("url");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let client = crate::image_cache::registry_http_client().expect("client");
    let jwt: AgentJwt = Box::new(|| Box::pin(async { Ok("agent-jwt".to_owned()) }));
    let temp = tempfile::tempdir().expect("tempdir");
    let store = BlobStore::new(temp.path());
    (registry, OciRegistry::new(origin, client, jwt), temp, store)
}

/// A machine image of three disk chunks, two of them identical.
fn machine(registry: &Registry) -> (OciDigest, Vec<OciDescriptorV1>) {
    let kernel = registry.descriptor(KERNEL_MEDIA_TYPE, b"kernel bytes");
    let initrd = registry.descriptor(INITRD_MEDIA_TYPE, b"initrd bytes");
    let chunk_a = registry.descriptor(DISK_CHUNK_MEDIA_TYPE, &vec![7; 300_000]);
    let chunk_b = registry.descriptor(DISK_CHUNK_MEDIA_TYPE, b"another chunk");
    let hex = "a".repeat(64);
    let config = serde_json::to_vec(&serde_json::json!({
        "guest_contract": 3, "image_format": IMAGE_FORMAT, "build_key": format!("sha256:{hex}"),
        "boot": {"cmdline": "root=LABEL=INTARROOT"},
        "disk": {"size_bytes": 12 << 20, "chunk_size": 4 << 20,
                 "chunks": [[0, 2, hex], [1, 3, hex], [2, 2, hex]]},
    }))
    .expect("config");
    let layers = vec![kernel, initrd, chunk_a, chunk_b];
    let manifest = OciManifestV1 {
        schema_version: 2,
        media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
        artifact_type: MACHINE_ARTIFACT_TYPE.to_owned(),
        config: registry.descriptor(MACHINE_CONFIG_MEDIA_TYPE, &config),
        layers: layers.clone(),
    };
    (
        registry.put(&serde_json::to_vec(&manifest).expect("manifest")),
        layers,
    )
}

#[tokio::test]
async fn a_machine_image_is_pulled_once_into_the_store() -> Result<()> {
    let (registry, client, _temp, store) = serve().await;
    let (image, layers) = machine(&registry);

    let pulled = client.pull_machine(&image, &store).await?;

    assert_eq!(pulled.kernel, layers[0].digest);
    assert_eq!(pulled.initrd.as_ref(), Some(&layers[1].digest));
    assert_eq!(pulled.config.disk.chunks.len(), 3);
    for digest in layers
        .iter()
        .map(|layer| &layer.digest)
        .chain([&image, &pulled.manifest.config.digest])
    {
        let stored = tokio::fs::read(store.path(digest)).await?;
        assert_eq!(
            sha256_hex(&stored),
            digest.hex(),
            "a stored file is what its name says"
        );
        assert_eq!(
            registry.requests_for(digest).len(),
            1,
            "each digest is fetched once"
        );
    }
    assert_eq!(
        registry.exchanges.load(Ordering::SeqCst),
        1,
        "one token for the whole pull"
    );

    // A second pull reads the manifest again and no blob.
    let before = registry.requests.lock().expect("requests").len();
    client.pull_machine(&image, &store).await?;
    assert_eq!(
        registry.requests.lock().expect("requests").len(),
        before + 1
    );
    Ok(())
}

#[tokio::test]
async fn a_partial_blob_is_continued_and_a_wrong_one_is_dropped() -> Result<()> {
    let (registry, client, _temp, store) = serve().await;
    let content: Vec<u8> = (0..200_000_u32).flat_map(u32::to_le_bytes).collect();
    let blob = registry.descriptor(DISK_CHUNK_MEDIA_TYPE, &content);
    tokio::fs::create_dir_all(store.directory()).await?;
    let part = store
        .directory()
        .join(format!(".{}.part", blob.digest.hex()));
    tokio::fs::write(&part, &content[..300_000]).await?;

    let path = client.blob("machines/x", &blob, &store).await?;

    assert_eq!(tokio::fs::read(&path).await?, content);
    assert_eq!(
        registry.requests_for(&blob.digest),
        [Some("bytes=300000-".to_owned())]
    );
    assert!(!part.exists());

    // A partial file whose bytes are not the blob's: the whole fails its hash
    // and nothing is kept, so the next attempt starts clean.
    let other = registry.descriptor(DISK_CHUNK_MEDIA_TYPE, &vec![1; 1000]);
    let part = store
        .directory()
        .join(format!(".{}.part", other.digest.hex()));
    tokio::fs::write(&part, vec![2; 400]).await?;
    let error = client
        .blob("machines/x", &other, &store)
        .await
        .expect_err("a wrong blob");
    assert!(
        error.to_string().contains("does not hash to its digest"),
        "{error}"
    );
    assert!(
        !super::super::ready::is_definitive_failure(&error),
        "{error}"
    );
    assert!(!part.exists() && !store.path(&other.digest).exists());
    assert_eq!(
        tokio::fs::read(client.blob("machines/x", &other, &store).await?).await?,
        vec![1; 1000]
    );

    // A descriptor that understates the size never publishes the blob.
    let mut short = other.clone();
    short.size = 10;
    tokio::fs::remove_file(store.path(&other.digest)).await?;
    let error = client
        .blob("machines/x", &short, &store)
        .await
        .expect_err("too long");
    assert!(
        error.to_string().contains("longer than its descriptor"),
        "{error}"
    );
    assert!(!store.path(&other.digest).exists());
    Ok(())
}

#[tokio::test]
async fn a_range_answer_from_another_byte_drops_the_partial_blob() -> Result<()> {
    let (registry, client, _temp, store) = serve().await;
    let content: Vec<u8> = (0..5_000_u32).flat_map(u32::to_le_bytes).collect();
    let blob = registry.descriptor(DISK_CHUNK_MEDIA_TYPE, &content);
    tokio::fs::create_dir_all(store.directory()).await?;
    let part = store
        .directory()
        .join(format!(".{}.part", blob.digest.hex()));
    tokio::fs::write(&part, &content[..1_000]).await?;
    registry.wrong_range.store(true, Ordering::SeqCst);

    let error = client
        .blob("machines/x", &blob, &store)
        .await
        .expect_err("a range from another byte");
    assert!(error.to_string().contains("with another range"), "{error}");
    assert!(
        !super::super::ready::is_definitive_failure(&error),
        "{error}"
    );
    assert!(!part.exists() && !store.path(&blob.digest).exists());

    registry.wrong_range.store(false, Ordering::SeqCst);
    let path = client.blob("machines/x", &blob, &store).await?;
    assert_eq!(tokio::fs::read(&path).await?, content);
    Ok(())
}

#[test]
fn content_range_names_its_first_byte() {
    assert_eq!(content_range_start("bytes 300-999/1000"), Some(300));
    assert_eq!(content_range_start("bytes 0-9/*"), Some(0));
    assert_eq!(content_range_start("bytes */1000"), None);
    assert_eq!(content_range_start("items 3-4/5"), None);
}

#[test]
fn only_a_fresh_transfer_that_misses_its_digest_is_definitive() {
    let fresh = anyhow::anyhow!(digest_mismatch_message("/v2/x", false));
    let resumed = anyhow::anyhow!(digest_mismatch_message("/v2/x", true));
    assert!(super::super::ready::is_definitive_failure(&fresh));
    assert!(!super::super::ready::is_definitive_failure(&resumed));
}

#[tokio::test]
async fn an_ended_token_is_exchanged_once_and_unknown_objects_fail() -> Result<()> {
    let (registry, client, _temp, store) = serve().await;
    let blob = registry.descriptor(DISK_CHUNK_MEDIA_TYPE, b"content");
    client.blob("machines/x", &blob, &store).await?;
    // The registry forgets the token, as after a host generation bump.
    registry.token.lock().expect("token").clear();
    let second = registry.descriptor(DISK_CHUNK_MEDIA_TYPE, b"more content");
    client.blob("machines/x", &second, &store).await?;
    assert_eq!(registry.exchanges.load(Ordering::SeqCst), 2);

    let missing = OciDescriptorV1 {
        media_type: DISK_CHUNK_MEDIA_TYPE.to_owned(),
        digest: OciDigest::try_from(format!("sha256:{}", "0".repeat(64))).expect("digest"),
        size: 1,
    };
    let error = client
        .blob("machines/x", &missing, &store)
        .await
        .expect_err("unknown");
    assert!(
        error.to_string().contains("unknown or not granted"),
        "{error}"
    );
    Ok(())
}

#[tokio::test]
async fn other_artifacts_are_named_not_dropped() -> Result<()> {
    let (registry, client, _temp, store) = serve().await;
    let binary = registry.descriptor("application/octet-stream", b"kino binary");
    let kino = OciManifestV1 {
        schema_version: 2,
        media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
        artifact_type: KINO_ARTIFACT_TYPE.to_owned(),
        config: registry.descriptor("application/vnd.intar.kino.config.v1+json", b"{}"),
        layers: vec![binary.clone()],
    };
    let kino = registry.put(&serde_json::to_vec(&kino).expect("manifest"));

    let error = client
        .pull_machine(&kino, &store)
        .await
        .expect_err("not a machine");
    assert!(
        error.to_string().contains("unsupported_artifact"),
        "{error}"
    );
    assert!(
        !store.path(&kino).exists(),
        "a refused manifest is not stored"
    );

    let path = client.pull_kino(&kino, &store).await?;
    assert_eq!(tokio::fs::read(path).await?, b"kino binary");
    let (machine, _) = machine(&registry);
    assert!(client.pull_kino(&machine, &store).await.is_err());

    let spec = registry.put(b"{\"spec\":true}");
    assert_eq!(client.spec(&spec).await?, b"{\"spec\":true}");
    Ok(())
}

fn kino_manifest(registry: &Registry, binary: OciDescriptorV1) -> OciDigest {
    let kino = OciManifestV1 {
        schema_version: 2,
        media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
        artifact_type: KINO_ARTIFACT_TYPE.to_owned(),
        config: registry.descriptor("application/vnd.intar.kino.config.v1+json", b"{}"),
        layers: vec![binary],
    };
    registry.put(&serde_json::to_vec(&kino).expect("manifest"))
}

#[tokio::test]
async fn concurrent_kino_pulls_of_one_digest_all_succeed() -> Result<()> {
    let (registry, client, _temp, store) = serve().await;
    let binary = registry.descriptor("application/octet-stream", &vec![9; 200_000]);
    let kino = kino_manifest(&registry, binary.clone());

    let paths =
        futures_util::future::try_join_all((0..8).map(|_| client.pull_kino(&kino, &store))).await?;

    for path in paths {
        assert_eq!(
            sha256_hex(&tokio::fs::read(path).await?),
            binary.digest.hex()
        );
    }
    assert_eq!(
        sha256_hex(&tokio::fs::read(store.path(&kino)).await?),
        kino.hex()
    );
    assert_eq!(
        registry.requests_for(&binary.digest).len(),
        1,
        "fetched once"
    );
    Ok(())
}

#[tokio::test]
async fn an_oversized_kino_is_refused_before_its_download() -> Result<()> {
    let (registry, client, _temp, store) = serve().await;
    let mut binary = registry.descriptor("application/octet-stream", b"small");
    binary.size = MAX_KINO_BYTES + 1;
    let kino = kino_manifest(&registry, binary.clone());

    let error = client
        .pull_kino(&kino, &store)
        .await
        .expect_err("over the cap");
    assert!(
        error.to_string().contains("over the run disk's limit"),
        "{error}"
    );
    assert!(
        registry.requests_for(&binary.digest).is_empty(),
        "never fetched"
    );
    Ok(())
}

/// A pack: a machine image with a suspended guest's RAM chunk, stub, CPU
/// profile and delta. `grow` raises one RAM chunk's declared size.
fn wake_machine(registry: &Registry, grow: u64) -> (OciDigest, Vec<OciDescriptorV1>) {
    let kernel = registry.descriptor(KERNEL_MEDIA_TYPE, b"kernel bytes");
    let chunk = registry.descriptor(DISK_CHUNK_MEDIA_TYPE, b"disk chunk");
    let mut ram = registry.descriptor(WAKE_RAM_CHUNK_MEDIA_TYPE, b"ram chunk");
    ram.size += grow;
    let stub = registry.descriptor(WAKE_STUB_MEDIA_TYPE, b"stub");
    let profile = registry.descriptor(WAKE_CPU_PROFILE_MEDIA_TYPE, b"{}");
    let delta = registry.descriptor(WAKE_DELTA_MEDIA_TYPE, b"delta");
    let hex = "a".repeat(64);
    let config = serde_json::to_vec(&serde_json::json!({
        "guest_contract": 3, "image_format": IMAGE_FORMAT, "build_key": format!("sha256:{hex}"),
        "boot": {"cmdline": "root=LABEL=INTARROOT"},
        "disk": {"size_bytes": 4 << 20, "chunk_size": 4 << 20, "chunks": [[0, 1, hex]]},
        "wake": {
            "ram": {"size_bytes": 4 << 20, "chunk_size": 4 << 20, "chunks": [[0, 2, hex]], "sha256": hex},
            "pack": {"base": format!("sha256:{hex}"), "ram_sha256": hex},
            "shape": {"memory_bytes": 4 << 20, "boot_vcpus": 1, "max_vcpus": 2, "balloon": true, "max_phys_bits": 36},
            "cpu_profile": profile.digest.as_str(),
            "vmm": {"min_version": "v55.0.0", "built_with": "v55.0.0"},
            "booted_at_unix_ms": 1,
        },
    }))
    .expect("config");
    let layers = vec![kernel, chunk, ram, stub, profile, delta];
    let manifest = OciManifestV1 {
        schema_version: 2,
        media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
        artifact_type: MACHINE_ARTIFACT_TYPE.to_owned(),
        config: registry.descriptor(MACHINE_CONFIG_MEDIA_TYPE, &config),
        layers: layers.clone(),
    };
    (
        registry.put(&serde_json::to_vec(&manifest).expect("manifest")),
        layers,
    )
}

#[tokio::test]
async fn a_suspended_guest_is_pulled_only_when_asked() -> Result<()> {
    let (registry, client, _temp, store) = serve().await;
    let (image, layers) = wake_machine(&registry, 0);

    let pulled = client.pull_machine(&image, &store).await?;
    for layer in &layers[2..] {
        assert!(
            registry.requests_for(&layer.digest).is_empty(),
            "a cold pull leaves {}",
            layer.media_type
        );
    }

    client.pull_wake_layers(&pulled, &store).await?;
    for layer in &layers[2..] {
        let stored = tokio::fs::read(store.path(&layer.digest)).await?;
        assert_eq!(sha256_hex(&stored), layer.digest.hex());
        assert_eq!(registry.requests_for(&layer.digest).len(), 1);
    }
    Ok(())
}

#[tokio::test]
async fn an_oversized_wake_layer_is_refused_before_any_download() -> Result<()> {
    let (registry, client, _temp, store) = serve().await;
    let (image, layers) = wake_machine(&registry, MAX_DISK_CHUNK_BYTES);
    let pulled = client.pull_machine(&image, &store).await?;

    let error = client
        .pull_wake_layers(&pulled, &store)
        .await
        .expect_err("over the cap");
    assert!(error.to_string().contains("over its size limit"), "{error}");
    for layer in &layers[2..] {
        assert!(registry.requests_for(&layer.digest).is_empty());
    }

    // An image without a suspended guest has none to pull.
    let (cold, _) = machine(&registry);
    let cold = client.pull_machine(&cold, &store).await?;
    assert!(client.pull_wake_layers(&cold, &store).await.is_err());
    Ok(())
}
