//! Fills the local cache with what a run's machine boots from (#397): the
//! spec, the Kino binary, and the machine image with its disk assembled from
//! chunks. Everything comes from intar's registry (`/v2`) by digest, and
//! nothing is kept that does not hash to the digest it was asked for.
//
// ponytail: the agent pulls the same things its own way
// (`intar-agent/src/image_cache/oci.rs`); one shared crate for both is the
// rest of #397. A pull that is cancelled or fails starts the image again:
// resume it from the chunks already written once images are large enough to
// hurt. Files are written on the engine's threads, a few MiB at a time.

use std::cell::Cell;
use std::collections::HashMap;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::Path;

use futures_util::{StreamExt as _, TryStreamExt as _};
use intar_contracts::oci::{
    Architecture, DISK_CHUNK_MEDIA_TYPE, INITRD_MEDIA_TYPE, KERNEL_MEDIA_TYPE, KINO_ARTIFACT_TYPE,
    MACHINE_ARTIFACT_TYPE, MACHINE_CONFIG_MEDIA_TYPE, MachineConfigV1, OciDescriptorV1, OciDigest,
    OciManifestV1,
};
use sha2::{Digest as _, Sha256};
use subspace::Subspace;
use subspace::contract::LocalRunMachineV1;
use zpm::machine::Cache;

// The limits the agent holds its pulls to.
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_KINO_BYTES: u64 = 15 * 1024 * 1024;
const MAX_BOOT_LAYER_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CHUNK_BLOB_BYTES: u64 = 8 * 1024 * 1024;
/// Chunks are 4 MiB of disk; a config that names far larger ones is refused.
const MAX_CHUNK_BYTES: u64 = 64 * 1024 * 1024;
/// Room kept free beside a downloaded image, for the run's own disks.
const SPARE_MIB: u64 = 1024;
/// Disk chunks fetched at once.
const FANOUT: usize = 4;
/// Progress is told about this often, in bytes.
const TELL_EVERY: u64 = 1024 * 1024;

/// Bytes of the image fetched so far, of all it needs.
struct Progress<'a> {
    done: Cell<u64>,
    told: Cell<u64>,
    total: u64,
    tell: &'a dyn Fn(u64, u64),
}

impl Progress<'_> {
    fn add(&self, bytes: u64) {
        let done = self.done.get() + bytes;
        self.done.set(done);
        if done - self.told.get() >= TELL_EVERY || done >= self.total {
            self.told.set(done);
            (self.tell)(done.min(self.total), self.total);
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn unreadable(what: &str) -> String {
    format!("intar sent {what} that this version of the app cannot read.")
}

fn disk(error: std::io::Error) -> String {
    format!("A downloaded file could not be written to this computer: {error}")
}

/// The body of `path`, at most `max` bytes, which must hash to `hex`.
async fn fetch(
    channel: &Subspace,
    path: &str,
    hex: &str,
    max: u64,
    progress: Option<&Progress<'_>>,
) -> Result<Vec<u8>, String> {
    let failed = |error: &dyn std::fmt::Display| format!("The download failed: {error}");
    let mut response = channel
        .registry(path)
        .await
        .map_err(|error| failed(&error))?;
    let mut body = Vec::new();
    while let Some(part) = response.chunk().await.map_err(|error| failed(&error))? {
        body.extend_from_slice(&part);
        if body.len() as u64 > max {
            return Err(unreadable("a file larger than it may be"));
        }
        if let Some(progress) = progress {
            progress.add(part.len() as u64);
        }
    }
    if sha256_hex(&body) != hex {
        return Err("A downloaded file is not the one intar named. Try again.".to_owned());
    }
    Ok(body)
}

/// Writes `bytes` beside `path` and renames them into place, so a file in
/// the cache is always whole.
fn publish(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(disk)?;
    }
    let part = path.with_extension("part");
    std::fs::write(&part, bytes).map_err(disk)?;
    std::fs::rename(&part, path).map_err(disk)
}

fn blob(repository: &str, digest: &OciDigest) -> String {
    format!("/v2/{repository}/blobs/{}", digest.as_str())
}

/// The processor an image's machines have, as Rust names it.
fn image_arch(config: &MachineConfigV1) -> Result<&'static str, String> {
    match config.architecture() {
        Ok(Architecture::Amd64) => Ok("x86_64"),
        Ok(Architecture::Arm64) => Ok("aarch64"),
        Err(_) => Err(unreadable("a machine image")),
    }
}

/// One disk chunk, unpacked: at most `chunk_size` bytes that hash to `raw`.
fn unpack(packed: &[u8], raw: &str, chunk_size: u64) -> Result<Vec<u8>, String> {
    let bad = || unreadable("a machine image");
    let mut bytes = Vec::new();
    zstd::stream::read::Decoder::new(packed)
        .map_err(|_| bad())?
        .take(chunk_size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| bad())?;
    if bytes.is_empty() || bytes.len() as u64 > chunk_size || sha256_hex(&bytes) != raw {
        return Err(bad());
    }
    Ok(bytes)
}

/// Makes sure everything `machine` boots from is in `cache`. `tell` hears
/// how many bytes of the image have arrived, of how many; it hears nothing
/// when the image is here already.
pub async fn pull(
    channel: &Subspace,
    cache: &Cache,
    machine: &LocalRunMachineV1,
    tell: &dyn Fn(u64, u64),
) -> Result<(), String> {
    let digest = |text: &str| {
        OciDigest::try_from(text.to_owned()).map_err(|_| unreadable("a name for a download"))
    };
    let at = |kind: &str, digest: &OciDigest| {
        cache
            .entry(kind, digest.as_str())
            .map_err(|error| error.to_string())
    };
    let (image, spec, kino) = (
        digest(&machine.image)?,
        digest(&machine.spec)?,
        digest(&machine.kino)?,
    );

    let spec_path = at("specs", &spec)?;
    if !spec_path.is_file() {
        let bytes = fetch(
            channel,
            &blob("specs", &spec),
            spec.hex(),
            MAX_MANIFEST_BYTES,
            None,
        )
        .await?;
        publish(&spec_path, &bytes)?;
    }

    let kino_path = at("kino", &kino)?;
    if !kino_path.is_file() {
        let path = format!("/v2/kino/manifests/{}", kino.as_str());
        let manifest = fetch(channel, &path, kino.hex(), MAX_MANIFEST_BYTES, None).await?;
        let manifest: OciManifestV1 =
            serde_json::from_slice(&manifest).map_err(|_| unreadable("a guest program"))?;
        let [binary] = manifest.layers.as_slice() else {
            return Err(unreadable("a guest program"));
        };
        if manifest.artifact_type != KINO_ARTIFACT_TYPE || binary.size > MAX_KINO_BYTES {
            return Err(unreadable("a guest program"));
        }
        let bytes = fetch(
            channel,
            &blob("kino", &binary.digest),
            binary.digest.hex(),
            MAX_KINO_BYTES,
            None,
        )
        .await?;
        publish(&kino_path, &bytes)?;
    }

    if cache.image(image.as_str()).is_ok() {
        return Ok(());
    }
    pull_image(channel, &at("machines", &image)?, &image, tell).await
}

/// The machine image `image` into `dir`: `kernel`, `initrd` when it has one,
/// and `root.raw`. The directory gets its name once all of it is there.
async fn pull_image(
    channel: &Subspace,
    dir: &Path,
    image: &OciDigest,
    tell: &dyn Fn(u64, u64),
) -> Result<(), String> {
    let bad = || unreadable("a machine image");
    let repository = format!("machines/{}", image.hex());
    let path = format!("/v2/{repository}/manifests/{}", image.as_str());
    let manifest = fetch(channel, &path, image.hex(), MAX_MANIFEST_BYTES, None).await?;
    let manifest: OciManifestV1 = serde_json::from_slice(&manifest).map_err(|_| bad())?;
    if manifest.artifact_type != MACHINE_ARTIFACT_TYPE
        || manifest.config.media_type != MACHINE_CONFIG_MEDIA_TYPE
        || manifest.config.size > MAX_MANIFEST_BYTES
    {
        return Err(bad());
    }
    let config = fetch(
        channel,
        &blob(&repository, &manifest.config.digest),
        manifest.config.digest.hex(),
        MAX_MANIFEST_BYTES,
        None,
    )
    .await?;
    let config: MachineConfigV1 = serde_json::from_slice(&config).map_err(|_| bad())?;
    // intar hands this computer images for its own processor; one for another
    // would not boot, so it is refused before anything large is fetched.
    if image_arch(&config)? != std::env::consts::ARCH {
        return Err(
            "This scenario's machine image is for another kind of processor than this computer's."
                .to_owned(),
        );
    }

    let of = |media_type: &str| -> Vec<&OciDescriptorV1> {
        manifest
            .layers
            .iter()
            .filter(|layer| layer.media_type == media_type)
            .collect()
    };
    let (kernels, initrds) = (of(KERNEL_MEDIA_TYPE), of(INITRD_MEDIA_TYPE));
    let ([kernel], [] | [_]) = (kernels.as_slice(), initrds.as_slice()) else {
        return Err(bad());
    };
    let boot_layers: Vec<(&str, &OciDescriptorV1)> = std::iter::once(("kernel", *kernel))
        .chain(initrds.first().map(|initrd| ("initrd", *initrd)))
        .collect();
    if boot_layers
        .iter()
        .any(|(_, layer)| layer.size > MAX_BOOT_LAYER_BYTES)
    {
        return Err(bad());
    }

    // Every chunk is checked before a byte of the disk is fetched. Identical
    // chunks share a layer: it is fetched for the first and copied for the rest.
    let (size, chunk_size) = (config.disk.size_bytes, config.disk.chunk_size);
    if chunk_size == 0 || chunk_size > MAX_CHUNK_BYTES {
        return Err(bad());
    }
    let mut first = HashMap::new();
    let mut total: u64 = boot_layers.iter().map(|(_, layer)| layer.size).sum();
    for (index, layer, raw) in &config.disk.chunks {
        let descriptor = manifest
            .layers
            .get(*layer as usize)
            .filter(|layer| {
                layer.media_type == DISK_CHUNK_MEDIA_TYPE && layer.size <= MAX_CHUNK_BLOB_BYTES
            })
            .ok_or_else(bad)?;
        if index.checked_mul(chunk_size).is_none_or(|at| at >= size) {
            return Err(bad());
        }
        match first.get(layer) {
            None => {
                first.insert(*layer, (*index, raw));
                total += descriptor.size;
            }
            Some((_, same)) if *same == raw => {}
            Some(_) => return Err(bad()),
        }
    }
    // Refuse before anything is written what this computer has no room for:
    // the download unpacks to the disk's chunks, and a run needs room too.
    let needed_mib = (config.disk.chunks.len() as u64 * chunk_size
        + boot_layers.iter().map(|(_, layer)| layer.size).sum::<u64>())
        / (1024 * 1024)
        + SPARE_MIB;
    if let Some(free_mib) = zpm::preflight::Has::measure(dir)
        .disk_mib
        .filter(|free| *free < needed_mib)
    {
        return Err(format!(
            "This scenario needs about {:.1} GB of free disk space, and this computer has {:.1} GB.",
            needed_mib as f32 / 1024.,
            free_mib as f32 / 1024.
        ));
    }
    let progress = Progress {
        done: Cell::new(0),
        told: Cell::new(0),
        total,
        tell,
    };
    tell(0, total);

    let part = dir.with_extension("part");
    let _ = std::fs::remove_dir_all(&part);
    std::fs::create_dir_all(&part).map_err(disk)?;
    for (name, layer) in &boot_layers {
        let bytes = fetch(
            channel,
            &blob(&repository, &layer.digest),
            layer.digest.hex(),
            MAX_BOOT_LAYER_BYTES,
            Some(&progress),
        )
        .await?;
        std::fs::write(part.join(name), bytes).map_err(disk)?;
    }

    // The image's own kernel command line, for zpm to boot it with.
    std::fs::write(part.join(zpm::machine::CMDLINE_FILE), &config.boot.cmdline).map_err(disk)?;

    let mut root = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(part.join("root.raw"))
        .map_err(disk)?;
    // Chunks the config leaves out are holes of zeroes.
    root.set_len(size).map_err(disk)?;
    let (repository, manifest, first, progress) = (&repository, &manifest, &first, &progress);
    let mut chunks = futures_util::stream::iter(config.disk.chunks.iter().map(
        |(index, layer, raw)| async move {
            let (fetched_for, _) = first[layer];
            let bytes = if fetched_for == *index {
                let descriptor = &manifest.layers[*layer as usize];
                let packed = fetch(
                    channel,
                    &blob(repository, &descriptor.digest),
                    descriptor.digest.hex(),
                    MAX_CHUNK_BLOB_BYTES,
                    Some(progress),
                )
                .await?;
                Some(unpack(&packed, raw.as_str(), chunk_size)?)
            } else {
                None
            };
            Ok::<_, String>((*index, fetched_for, bytes))
        },
    ))
    .buffered(FANOUT);
    let mut lengths: HashMap<u64, usize> = HashMap::new();
    while let Some((index, fetched_for, bytes)) = chunks.try_next().await? {
        let bytes = match bytes {
            Some(bytes) => bytes,
            // Written already, for an earlier chunk of the same content.
            None => {
                let mut copy = vec![0; lengths.get(&fetched_for).copied().ok_or_else(bad)?];
                root.seek(SeekFrom::Start(fetched_for * chunk_size))
                    .map_err(disk)?;
                root.read_exact(&mut copy).map_err(disk)?;
                copy
            }
        };
        let at = index * chunk_size;
        if at + bytes.len() as u64 > size {
            return Err(bad());
        }
        root.seek(SeekFrom::Start(at)).map_err(disk)?;
        root.write_all(&bytes).map_err(disk)?;
        lengths.insert(index, bytes.len());
    }
    root.sync_all().map_err(disk)?;
    let _ = std::fs::remove_dir_all(dir);
    std::fs::rename(&part, dir).map_err(disk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use axum::extract::{Path as UrlPath, State};
    use axum::http::StatusCode;
    use intar_contracts::oci::{
        IMAGE_FORMAT, MachineBootV1, MachineDiskV1, OCI_MANIFEST_MEDIA_TYPE, Sha256Hex,
    };
    use subspace::Tokens;

    type Blobs = Arc<Mutex<BTreeMap<String, Vec<u8>>>>;

    /// A registry that serves whatever was put under a digest.
    async fn registry(blobs: Blobs) -> Subspace {
        async fn serve(
            State(blobs): State<Blobs>,
            UrlPath(path): UrlPath<String>,
        ) -> Result<Vec<u8>, StatusCode> {
            let digest = path.rsplit('/').next().unwrap_or_default();
            blobs
                .lock()
                .expect("blobs")
                .get(digest)
                .cloned()
                .ok_or(StatusCode::NOT_FOUND)
        }
        let app = axum::Router::new()
            .route("/v2/{*path}", axum::routing::get(serve))
            .with_state(blobs);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listen");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        tokio::spawn(async move { axum::serve(listener, app).await });
        Subspace::new(
            reqwest::Client::new(),
            base.parse().expect("url"),
            Tokens {
                access_token: "token".into(),
                refresh_token: None,
                expires_at: u64::MAX,
            },
        )
    }

    fn put(blobs: &Blobs, bytes: Vec<u8>) -> OciDigest {
        let digest = OciDigest::try_from(format!("sha256:{}", sha256_hex(&bytes))).expect("digest");
        blobs
            .lock()
            .expect("blobs")
            .insert(digest.as_str().to_owned(), bytes);
        digest
    }

    fn layer(blobs: &Blobs, media_type: &str, bytes: Vec<u8>) -> OciDescriptorV1 {
        OciDescriptorV1 {
            media_type: media_type.to_owned(),
            size: bytes.len() as u64,
            digest: put(blobs, bytes),
        }
    }

    fn manifest(
        blobs: &Blobs,
        artifact_type: &str,
        config: OciDescriptorV1,
        layers: Vec<OciDescriptorV1>,
    ) -> OciDigest {
        let manifest = OciManifestV1 {
            schema_version: 2,
            media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
            artifact_type: artifact_type.to_owned(),
            config,
            layers,
        };
        put(blobs, serde_json::to_vec(&manifest).expect("manifest"))
    }

    #[tokio::test]
    async fn pulls_a_machine_into_the_cache_and_keeps_nothing_it_cannot_verify() {
        const CHUNK: usize = 1024;
        let blobs = Blobs::default();
        let raw_hex = |bytes: &[u8]| Sha256Hex::try_from(sha256_hex(bytes)).expect("hex");
        let packed = |bytes: &[u8]| zstd::encode_all(bytes, 0).expect("zstd");

        // A disk of five chunks: content, a hole, the same content again,
        // other content, and a short last chunk.
        let (a, b, last) = (vec![b'a'; CHUNK], vec![b'b'; CHUNK], vec![b'z'; 100]);
        let kernel = layer(&blobs, KERNEL_MEDIA_TYPE, b"kernel".to_vec());
        let layers = vec![
            kernel,
            layer(&blobs, DISK_CHUNK_MEDIA_TYPE, packed(&a)),
            layer(&blobs, DISK_CHUNK_MEDIA_TYPE, packed(&b)),
            layer(&blobs, DISK_CHUNK_MEDIA_TYPE, packed(&last)),
        ];
        let total: u64 = layers.iter().map(|layer| layer.size).sum();
        // The image is for the computer the test runs on.
        let (own, other) = if std::env::consts::ARCH == "aarch64" {
            (Architecture::Arm64, Architecture::Amd64)
        } else {
            (Architecture::Amd64, Architecture::Arm64)
        };
        let (own, other) = (Some(own), Some(other));
        let disk_for = |architecture, chunks| MachineConfigV1 {
            architecture,
            guest_contract: 3,
            image_format: IMAGE_FORMAT.to_owned(),
            build_key: put(&blobs, b"key".to_vec()),
            boot: MachineBootV1 {
                cmdline: "root=/dev/vda rw console=ttyS0".to_owned(),
            },
            disk: MachineDiskV1 {
                size_bytes: (4 * CHUNK + 100) as u64,
                chunk_size: CHUNK as u64,
                chunks,
            },
        };
        let disk = |chunks| disk_for(own, chunks);
        let image_of = |config: &MachineConfigV1| {
            let config = layer(
                &blobs,
                MACHINE_CONFIG_MEDIA_TYPE,
                serde_json::to_vec(config).expect("config"),
            );
            manifest(&blobs, MACHINE_ARTIFACT_TYPE, config, layers.clone())
        };
        let image = image_of(&disk(vec![
            (0, 1, raw_hex(&a)),
            (2, 1, raw_hex(&a)),
            (3, 2, raw_hex(&b)),
            (4, 3, raw_hex(&last)),
        ]));
        let kino = manifest(
            &blobs,
            KINO_ARTIFACT_TYPE,
            layer(&blobs, "application/json", b"{}".to_vec()),
            vec![layer(&blobs, "application/octet-stream", b"kino".to_vec())],
        );
        let machine = |image: &OciDigest| LocalRunMachineV1 {
            name: "web".into(),
            runtime_name: None,
            image: image.as_str().to_owned(),
            spec: put(&blobs, b"spec".to_vec()).as_str().to_owned(),
            kino: kino.as_str().to_owned(),
            mode: String::new(),
            cpu_millis: 1000,
            memory_mib: 512,
            disk_mib: 1,
            egress: false,
            terminal: false,
            peers: vec![],
        };

        let channel = registry(blobs.clone()).await;
        let home = tempfile::tempdir().expect("dir");
        let cache = Cache::new(home.path());
        let told = Mutex::new(Vec::new());
        let tell = |done, of| told.lock().expect("told").push((done, of));
        pull(&channel, &cache, &machine(&image), &tell)
            .await
            .expect("pull");

        let files = cache.image(image.as_str()).expect("image in the cache");
        assert_eq!(std::fs::read(files.kernel).expect("kernel"), b"kernel");
        assert!(files.initrd.is_none());
        assert_eq!(
            files.cmdline.as_deref(),
            Some("root=/dev/vda rw console=ttyS0")
        );
        let expected = [a.clone(), vec![0; CHUNK], a.clone(), b, last].concat();
        assert_eq!(std::fs::read(files.root).expect("root"), expected);
        assert_eq!(cache.kino(kino.as_str()).expect("kino"), b"kino");
        assert_eq!(cache.spec(&machine(&image).spec).expect("spec"), b"spec");
        // Progress counts each layer once, the shared one too, and ends at all of it.
        let told = told.into_inner().expect("told");
        assert_eq!(told.first(), Some(&(0, total)));
        assert_eq!(told.last(), Some(&(total, total)));

        // Here already: nothing is fetched, so nothing is told.
        let quiet = |_, _| panic!("a cached image tells no progress");
        pull(&channel, &cache, &machine(&image), &quiet)
            .await
            .expect("cached");

        // An image for another processor is refused.
        let foreign = image_of(&disk_for(other, vec![(0, 1, raw_hex(&a))]));
        let none = |_, _| {};
        let refused = pull(&channel, &cache, &machine(&foreign), &none)
            .await
            .expect_err("another processor");
        assert!(refused.contains("another kind of processor"), "{refused}");
        assert!(cache.image(foreign.as_str()).is_err());

        // A chunk that unpacks to something else than the config names, a
        // chunk past the disk's end, and a blob that is not its digest: each
        // is refused and leaves no image behind.
        let wrong_content = image_of(&disk(vec![(0, 1, raw_hex(b"other"))]));
        let past_the_end = image_of(&disk(vec![(5, 1, raw_hex(&a))]));
        let tampered = image_of(&disk(vec![(0, 1, raw_hex(&a))]));
        for (image, tamper) in [
            (wrong_content, false),
            (past_the_end, false),
            (tampered, true),
        ] {
            if tamper {
                let chunk = layers[1].digest.as_str().to_owned();
                blobs
                    .lock()
                    .expect("blobs")
                    .insert(chunk, b"something else".to_vec());
            }
            let none = |_, _| {};
            assert!(
                pull(&channel, &cache, &machine(&image), &none)
                    .await
                    .is_err()
            );
            assert!(cache.image(image.as_str()).is_err());
        }
    }
}
