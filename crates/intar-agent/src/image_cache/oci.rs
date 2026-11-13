//! The `/v2` pull client and the blob store (#312 §7.4).
//!
//! Everything the agent pulls is content-addressed: a manifest or blob is
//! kept only after its bytes hash to the digest it was asked for, as
//! `<cache>/oci/sha256/<hex>`. A file in the store is therefore what its name
//! says; jailerd checks again before it uses one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail, ensure};
use futures_util::{StreamExt as _, TryStreamExt as _};
use intar_contracts::oci::{
    DISK_CHUNK_MEDIA_TYPE, INITRD_MEDIA_TYPE, KERNEL_MEDIA_TYPE, KINO_ARTIFACT_TYPE,
    MACHINE_ARTIFACT_TYPE, MACHINE_CONFIG_MEDIA_TYPE, MachineConfigV1, OciDescriptorV1, OciDigest,
    OciManifestV1, WAKE_CPU_PROFILE_MEDIA_TYPE, WAKE_DELTA_MEDIA_TYPE, WAKE_RAM_CHUNK_MEDIA_TYPE,
    WAKE_STUB_MEDIA_TYPE,
};
use reqwest::StatusCode;
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::Mutex;

use super::budget::acquire_transfer_slot;
use super::registry::to_hex_lower;

/// Manifests and configs are small; the registry's own limit is 4 MiB.
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
/// Kino goes onto the 16 MiB run disk beside `boot.json`.
const MAX_KINO_BYTES: u64 = 15 * 1024 * 1024;
/// A kernel or an initrd larger than this is not a plausible machine layer.
const MAX_BOOT_LAYER_BYTES: u64 = 256 * 1024 * 1024;
/// Disk chunks are 4 MiB; one over this is not a chunk this agent reads.
const MAX_DISK_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
/// A CPU profile is a small JSON document.
const MAX_WAKE_CPU_PROFILE_BYTES: u64 = 1024 * 1024;
/// A pack's delta, all parts together; jailerd refuses more.
pub(crate) const MAX_WAKE_DELTA_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// A registry token lives 15 minutes; it is renewed this long before its end.
const TOKEN_MARGIN: Duration = Duration::from_secs(60);
/// Blobs of one image pulled at once; each still takes a global transfer slot.
const BLOB_FANOUT: usize = 4;
const SERVICE: &str = "intar.dev";

/// Where the agent's `agent-connect` JWT comes from.
pub(crate) type AgentJwt = Box<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>>
        + Send
        + Sync,
>;

/// `<root>/oci/sha256/<hex>`: every blob and manifest, by digest.
#[derive(Clone, Debug)]
pub(crate) struct BlobStore {
    directory: PathBuf,
}

impl BlobStore {
    pub(crate) fn new(cache_root: &Path) -> Self {
        Self {
            directory: cache_root.join("oci").join("sha256"),
        }
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn path(&self, digest: &OciDigest) -> PathBuf {
        self.directory.join(digest.hex())
    }

    /// The stored blob, if it is there with the size its descriptor names.
    async fn existing(&self, digest: &OciDigest, size: u64) -> Option<PathBuf> {
        let path = self.path(digest);
        let metadata = tokio::fs::symlink_metadata(&path).await.ok()?;
        (metadata.is_file() && metadata.len() == size).then_some(path)
    }
}

impl std::fmt::Debug for OciRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OciRegistry")
            .field("origin", &self.origin.as_str())
            .finish_non_exhaustive()
    }
}

pub(crate) struct OciRegistry {
    /// Scheme, host and port only.
    origin: reqwest::Url,
    client: reqwest::Client,
    agent_jwt: AgentJwt,
    token: Mutex<Option<(String, Instant)>>,
    /// One writer per blob: the warmer and a launch may want the same one.
    blob_locks: Mutex<HashMap<OciDigest, Arc<Mutex<()>>>>,
}

/// A machine image in the blob store, ready to hand to jailerd.
#[derive(Clone, Debug)]
pub(crate) struct PulledMachine {
    pub(crate) image: OciDigest,
    pub(crate) manifest: OciManifestV1,
    pub(crate) config: MachineConfigV1,
    pub(crate) kernel: OciDigest,
    pub(crate) initrd: Option<OciDigest>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    to_hex_lower(&Sha256::digest(bytes))
}

impl OciRegistry {
    pub(crate) fn new(origin: reqwest::Url, client: reqwest::Client, agent_jwt: AgentJwt) -> Self {
        Self {
            origin,
            client,
            agent_jwt,
            token: Mutex::new(None),
            blob_locks: Mutex::new(HashMap::new()),
        }
    }

    fn url(&self, path: &str) -> Result<reqwest::Url> {
        self.origin
            .join(path)
            .with_context(|| format!("registry path {path}"))
    }

    /// The registry token, exchanged for the agent's JWT and kept until
    /// shortly before it ends. The exchange never extends a lifetime.
    async fn token(&self, refresh: bool) -> Result<String> {
        let mut cached = self.token.lock().await;
        if let Some((token, until)) = cached.as_ref()
            && !refresh
            && Instant::now() < *until
        {
            return Ok(token.clone());
        }
        #[derive(serde::Deserialize)]
        struct TokenResponse {
            token: String,
            expires_in: u64,
        }
        let jwt = (self.agent_jwt)()
            .await
            .context("agent access for the registry")?;
        let mut url = self.url("/v2/token")?;
        // The Worker ignores the scope: a token carries identity only.
        url.query_pairs_mut().append_pair("service", SERVICE);
        let response = self
            .client
            .get(url)
            .bearer_auth(jwt)
            .send()
            .await
            .context("GET /v2/token")?;
        let status = response.status();
        ensure!(
            status.is_success(),
            "registry token exchange failed with HTTP {status}"
        );
        let granted: TokenResponse = response.json().await.context("registry token response")?;
        ensure!(!granted.token.is_empty(), "registry token is empty");
        let lifetime = Duration::from_secs(granted.expires_in).saturating_sub(TOKEN_MARGIN);
        *cached = Some((granted.token.clone(), Instant::now() + lifetime));
        Ok(granted.token)
    }

    /// GET with the registry token; a 401 gets one fresh token and one retry.
    async fn get(&self, path: &str, range_from: u64) -> Result<reqwest::Response> {
        let url = self.url(path)?;
        for refresh in [false, true] {
            let mut request = self
                .client
                .get(url.clone())
                .bearer_auth(self.token(refresh).await?);
            if range_from > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={range_from}-"));
            }
            let response = request
                .send()
                .await
                .with_context(|| format!("GET {path}"))?;
            match response.status() {
                StatusCode::UNAUTHORIZED if !refresh => continue,
                // A denied grant looks exactly like an unknown object.
                StatusCode::NOT_FOUND => bail!("{path} is unknown or not granted to this host"),
                status if status.is_success() => return Ok(response),
                status => bail!("GET {path} failed with HTTP {status}"),
            }
        }
        bail!("GET {path} was refused with a fresh registry token")
    }

    /// A manifest by digest: its bytes, verified.
    async fn manifest(&self, repository: &str, digest: &OciDigest) -> Result<Vec<u8>> {
        let _transfer = acquire_transfer_slot().await?;
        let path = format!("/v2/{repository}/manifests/{}", digest.as_str());
        let mut body = Vec::new();
        let mut stream = self.get(&path, 0).await?.bytes_stream();
        while let Some(part) = stream
            .try_next()
            .await
            .with_context(|| format!("reading {path}"))?
        {
            body.extend_from_slice(&part);
            ensure!(
                body.len() as u64 <= MAX_MANIFEST_BYTES,
                "{path} is over the manifest limit"
            );
        }
        ensure!(
            sha256_hex(&body) == digest.hex(),
            "{path} does not hash to its digest"
        );
        Ok(body)
    }

    /// The one writer lock of a digest: the warmer and launches may want
    /// the same blob or manifest at once.
    async fn digest_lock(&self, digest: &OciDigest) -> Arc<Mutex<()>> {
        Arc::clone(
            self.blob_locks
                .lock()
                .await
                .entry(digest.clone())
                .or_default(),
        )
    }

    /// Verified bytes into the store under their digest, unless they are
    /// there already.
    async fn store_bytes(&self, store: &BlobStore, digest: &OciDigest, bytes: &[u8]) -> Result<()> {
        let lock = self.digest_lock(digest).await;
        let _writer = lock.lock().await;
        if let Some(path) = store.existing(digest, bytes.len() as u64).await
            && super::registry::sha256_file(&path).await? == digest.hex()
        {
            return Ok(());
        }
        tokio::fs::create_dir_all(store.directory())
            .await
            .context("create the blob store")?;
        let part = store.directory().join(format!(".{}.part", digest.hex()));
        tokio::fs::write(&part, bytes)
            .await
            .with_context(|| format!("write {}", part.display()))?;
        tokio::fs::rename(&part, store.path(digest))
            .await
            .context("publish a stored manifest")
    }

    /// One blob into the store. A partial download from an earlier attempt
    /// is continued with a Range request; the whole file is hashed before it
    /// gets its name.
    pub(crate) async fn blob(
        &self,
        repository: &str,
        descriptor: &OciDescriptorV1,
        store: &BlobStore,
    ) -> Result<PathBuf> {
        let (digest, size) = (&descriptor.digest, descriptor.size);
        let lock = self.digest_lock(digest).await;
        let _writer = lock.lock().await;
        if let Some(path) = store.existing(digest, size).await {
            return Ok(path);
        }
        let _transfer = acquire_transfer_slot().await?;
        tokio::fs::create_dir_all(store.directory())
            .await
            .context("create the blob store")?;
        let part = store.directory().join(format!(".{}.part", digest.hex()));
        let mut have = match tokio::fs::symlink_metadata(part.clone()).await {
            Ok(metadata) if metadata.is_file() && metadata.len() < size => metadata.len(),
            Ok(_) => {
                tokio::fs::remove_file(part.clone())
                    .await
                    .context("drop an unusable partial blob")?;
                0
            }
            Err(_) => 0,
        };
        let path = format!("/v2/{repository}/blobs/{}", digest.as_str());
        let response = self.get(&path, have).await?;
        // A server that ignores the range sends the whole blob again.
        if have > 0 && response.status() != StatusCode::PARTIAL_CONTENT {
            have = 0;
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(have > 0)
            .truncate(have == 0)
            .open(part.clone())
            .await
            .with_context(|| format!("open {}", part.display()))?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream
            .try_next()
            .await
            .with_context(|| format!("reading {path}"))?
        {
            have += chunk.len() as u64;
            if have > size {
                drop(file);
                let _ = tokio::fs::remove_file(part.clone()).await;
                bail!("{path} is longer than its descriptor's {size} bytes");
            }
            file.write_all(&chunk).await.context("write a blob")?;
        }
        file.flush().await.context("flush a blob")?;
        drop(file);
        // A short body stays as a partial file for the next attempt.
        ensure!(have == size, "{path} ended after {have} of {size} bytes");
        let actual = super::registry::sha256_file(&part).await?;
        if actual != digest.hex() {
            let _ = tokio::fs::remove_file(part.clone()).await;
            bail!("{path} does not hash to its digest");
        }
        let published = store.path(digest);
        tokio::fs::rename(part.clone(), published.clone())
            .await
            .context("publish a blob")?;
        Ok(published)
    }

    /// A machine image: its manifest, its config, the kernel, the initrd and
    /// every disk chunk, all in the store. Layers of other kinds (a suspended
    /// guest's) are left for whoever needs them.
    pub(crate) async fn pull_machine(
        &self,
        image: &OciDigest,
        store: &BlobStore,
    ) -> Result<PulledMachine> {
        let repository = format!("machines/{}", image.hex());
        let bytes = self.manifest(&repository, image).await?;
        let manifest: OciManifestV1 = serde_json::from_slice(&bytes).with_context(|| {
            format!("unsupported_artifact: {image:?} is not a manifest this agent reads")
        })?;
        ensure!(
            manifest.artifact_type == MACHINE_ARTIFACT_TYPE
                && manifest.config.media_type == MACHINE_CONFIG_MEDIA_TYPE,
            "unsupported_artifact: {} is {}, not a machine image",
            image.as_str(),
            manifest.artifact_type
        );
        self.store_bytes(store, image, &bytes).await?;

        ensure!(
            manifest.config.size <= MAX_MANIFEST_BYTES,
            "machine config is over the limit"
        );
        let config_path = self.blob(&repository, &manifest.config, store).await?;
        let config: MachineConfigV1 = serde_json::from_slice(
            &tokio::fs::read(&config_path)
                .await
                .context("read the machine config")?,
        )
        .context("unsupported_artifact: the machine config is not one this agent reads")?;

        let of = |media_type: &str| -> Vec<&OciDescriptorV1> {
            manifest
                .layers
                .iter()
                .filter(|layer| layer.media_type == media_type)
                .collect()
        };
        let (kernels, initrds) = (of(KERNEL_MEDIA_TYPE), of(INITRD_MEDIA_TYPE));
        let [kernel] = kernels.as_slice() else {
            bail!("unsupported_artifact: a machine image has exactly one kernel layer");
        };
        ensure!(
            initrds.len() <= 1,
            "unsupported_artifact: a machine image has at most one initrd layer"
        );

        // Sizes are what the manifest declares: refuse implausible ones before
        // a byte is fetched.
        ensure!(
            kernels
                .iter()
                .chain(&initrds)
                .all(|layer| layer.size <= MAX_BOOT_LAYER_BYTES),
            "unsupported_artifact: a kernel or initrd layer is over {MAX_BOOT_LAYER_BYTES} bytes"
        );
        ensure!(
            of(DISK_CHUNK_MEDIA_TYPE)
                .iter()
                .all(|layer| layer.size <= MAX_DISK_CHUNK_BYTES),
            "unsupported_artifact: a disk chunk layer is over {MAX_DISK_CHUNK_BYTES} bytes"
        );

        // Identical chunks share a layer, so each digest is pulled once.
        let mut wanted: Vec<&OciDescriptorV1> = vec![kernel];
        wanted.extend(&initrds);
        wanted.extend(of(DISK_CHUNK_MEDIA_TYPE));
        wanted.sort_by(|left, right| left.digest.cmp(&right.digest));
        wanted.dedup_by(|left, right| left.digest == right.digest);
        let repository = repository.as_str();
        let wanted = wanted.into_iter().cloned().collect::<Vec<_>>();
        futures_util::stream::iter(wanted)
            .map(|layer| async move { self.blob(repository, &layer, store).await })
            .buffer_unordered(BLOB_FANOUT)
            .try_collect::<Vec<_>>()
            .await?;
        Ok(PulledMachine {
            image: image.clone(),
            kernel: kernel.digest.clone(),
            initrd: initrds.first().map(|layer| layer.digest.clone()),
            manifest,
            config,
        })
    }

    /// The suspended guest's layers of a pulled machine image: its RAM
    /// chunks, stub, CPU profile and, on a pack, the delta parts. Sizes are
    /// checked before a byte is fetched. The blobs are the image's, so the
    /// manifest's pin protects them like its other layers.
    pub(crate) async fn pull_wake_layers(
        &self,
        pulled: &PulledMachine,
        store: &BlobStore,
    ) -> Result<()> {
        ensure!(
            pulled.config.wake.is_some(),
            "the machine image carries no suspended guest"
        );
        let of = |media_type: &str| -> Vec<&OciDescriptorV1> {
            pulled
                .manifest
                .layers
                .iter()
                .filter(|layer| layer.media_type == media_type)
                .collect()
        };
        let (chunks, stubs, profiles, deltas) = (
            of(WAKE_RAM_CHUNK_MEDIA_TYPE),
            of(WAKE_STUB_MEDIA_TYPE),
            of(WAKE_CPU_PROFILE_MEDIA_TYPE),
            of(WAKE_DELTA_MEDIA_TYPE),
        );
        ensure!(
            stubs.len() == 1 && profiles.len() == 1,
            "unsupported_artifact: a suspended guest has one stub and one CPU profile layer"
        );
        ensure!(
            chunks
                .iter()
                .all(|layer| layer.size <= MAX_DISK_CHUNK_BYTES)
                && stubs.iter().all(|layer| layer.size <= MAX_BOOT_LAYER_BYTES)
                && profiles
                    .iter()
                    .all(|layer| layer.size <= MAX_WAKE_CPU_PROFILE_BYTES)
                && deltas
                    .iter()
                    .try_fold(0_u64, |total, layer| total.checked_add(layer.size))
                    .is_some_and(|total| total <= MAX_WAKE_DELTA_BYTES),
            "unsupported_artifact: a wake layer is over its size limit"
        );
        let mut wanted = chunks;
        wanted.extend(stubs);
        wanted.extend(profiles);
        wanted.extend(deltas);
        wanted.sort_by(|left, right| left.digest.cmp(&right.digest));
        wanted.dedup_by(|left, right| left.digest == right.digest);
        let repository = format!("machines/{}", pulled.image.hex());
        let repository = repository.as_str();
        let wanted = wanted.into_iter().cloned().collect::<Vec<_>>();
        futures_util::stream::iter(wanted)
            .map(|layer| async move { self.blob(repository, &layer, store).await })
            .buffer_unordered(BLOB_FANOUT)
            .try_collect::<Vec<_>>()
            .await?;
        Ok(())
    }

    /// The Kino binary of a pinned Kino manifest, in the store.
    pub(crate) async fn pull_kino(&self, kino: &OciDigest, store: &BlobStore) -> Result<PathBuf> {
        let bytes = self.manifest("kino", kino).await?;
        let manifest: OciManifestV1 =
            serde_json::from_slice(&bytes).context("unsupported_artifact: not a Kino manifest")?;
        let [binary] = manifest.layers.as_slice() else {
            bail!("unsupported_artifact: a Kino manifest has exactly one layer");
        };
        ensure!(
            manifest.artifact_type == KINO_ARTIFACT_TYPE,
            "unsupported_artifact: not a Kino manifest"
        );
        ensure!(
            binary.size <= MAX_KINO_BYTES,
            "the Kino binary is over the run disk's limit"
        );
        // Kept so eviction and the scrub can tell which blob the pin names.
        self.store_bytes(store, kino, &bytes).await?;
        self.blob("kino", binary, store).await
    }

    /// The bytes of a pinned Kino binary, pulled if needed and hashed again
    /// here, manifest and binary both, so what goes onto a run disk is what
    /// the digest names.
    pub(crate) async fn kino_binary(&self, kino: &OciDigest, store: &BlobStore) -> Result<Vec<u8>> {
        let path = self.pull_kino(kino, store).await?;
        let manifest = tokio::fs::read(store.path(kino))
            .await
            .context("read the stored Kino manifest")?;
        ensure!(
            sha256_hex(&manifest) == kino.hex(),
            "the stored Kino manifest does not hash to its digest"
        );
        let manifest: OciManifestV1 = serde_json::from_slice(&manifest)
            .context("unsupported_artifact: not a Kino manifest")?;
        let [binary] = manifest.layers.as_slice() else {
            bail!("unsupported_artifact: a Kino manifest has exactly one layer");
        };
        ensure!(
            binary.size <= MAX_KINO_BYTES,
            "the Kino binary is over the run disk's limit"
        );
        let bytes = tokio::fs::read(&path)
            .await
            .context("read the Kino binary")?;
        ensure!(
            sha256_hex(&bytes) == binary.digest.hex(),
            "the stored Kino binary does not hash to its digest"
        );
        Ok(bytes)
    }

    /// A machine spec blob: its bytes, verified.
    pub(crate) async fn spec(&self, spec: &OciDigest) -> Result<Vec<u8>> {
        let _transfer = acquire_transfer_slot().await?;
        let path = format!("/v2/specs/blobs/{}", spec.as_str());
        let mut body = Vec::new();
        let mut stream = self.get(&path, 0).await?.bytes_stream();
        while let Some(part) = stream
            .try_next()
            .await
            .with_context(|| format!("reading {path}"))?
        {
            body.extend_from_slice(&part);
            ensure!(
                body.len() as u64 <= MAX_MANIFEST_BYTES,
                "{path} is over the spec limit"
            );
        }
        ensure!(
            sha256_hex(&body) == spec.hex(),
            "{path} does not hash to its digest"
        );
        Ok(body)
    }
}

#[cfg(test)]
mod tests;
