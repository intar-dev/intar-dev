//! A repacked disk as an OCI machine image (#311 §6.4): 4 MiB raw chunks,
//! zstd level 6, zero chunks omitted, each encoded chunk a blob named by its
//! SHA-256, in a directory laid out as `sha256/<hex>`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail, ensure};
use intar_contracts::catalog::IMAGE_CHUNK_SIZE_BYTES;
use intar_contracts::guest::GUEST_CONTRACT;
use intar_contracts::oci::verify::{layers_of, verified_image};
use intar_contracts::oci::{
    DISK_CHUNK_MEDIA_TYPE, IMAGE_FORMAT, INITRD_MEDIA_TYPE, KERNEL_MEDIA_TYPE,
    MACHINE_ARTIFACT_TYPE, MACHINE_CONFIG_MEDIA_TYPE, MachineBootV1, MachineConfigV1,
    MachineDiskV1, OCI_MANIFEST_MEDIA_TYPE, OciDescriptorV1, OciDigest, OciManifestV1, Sha256Hex,
    WAKE_CPU_PROFILE_MEDIA_TYPE, WAKE_DELTA_MEDIA_TYPE, WAKE_RAM_CHUNK_MEDIA_TYPE,
    WAKE_STUB_MEDIA_TYPE,
};
use sha2::{Digest as _, Sha256};

use crate::chunked::{scan_raw_image_chunks, write_scanned_chunked_image_artifact};
use crate::qemu::PUBLISHED_BOOT_CMDLINE;

/// A written machine image.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MachineImage {
    pub manifest_digest: OciDigest,
    pub manifest_bytes: u64,
    pub config_bytes: u64,
    /// Non-zero chunks of the disk.
    pub chunk_count: usize,
    /// Distinct encoded chunks: the chunk layers.
    pub chunk_layers: usize,
    pub disk_bytes: u64,
}

/// Chunk `raw` and write the image of `kernel`, `initrd` and its chunks to
/// `output`.
///
/// # Errors
/// Returns an error when the disk cannot be chunked or a blob not written.
pub fn write_machine_image(
    raw: &Path,
    kernel: &Path,
    initrd: &Path,
    build_key: &OciDigest,
    output: &Path,
) -> Result<MachineImage> {
    let mut writer = ImageWriter::new(output)?;
    writer.file(kernel, KERNEL_MEDIA_TYPE)?;
    writer.file(initrd, INITRD_MEDIA_TYPE)?;
    let disk = writer.chunks(raw, DISK_CHUNK_MEDIA_TYPE)?;
    writer.finish(MachineConfigV1 {
        guest_contract: GUEST_CONTRACT,
        image_format: IMAGE_FORMAT.to_owned(),
        build_key: build_key.clone(),
        boot: MachineBootV1 {
            cmdline: PUBLISHED_BOOT_CMDLINE.to_owned(),
        },
        disk: disk.disk,
        wake: None,
    })
}

/// A file's chunks as a config names them.
pub(crate) struct WrittenChunks {
    pub disk: MachineDiskV1,
    pub count: usize,
}

/// The layers of one image as they are written to `output/sha256`.
pub(crate) struct ImageWriter {
    blobs: PathBuf,
    scratch: tempfile::TempDir,
    layers: Vec<OciDescriptorV1>,
    layer_of: BTreeMap<String, u32>,
    chunk_count: usize,
    disk_bytes: u64,
}

impl ImageWriter {
    pub(crate) fn new(output: &Path) -> Result<Self> {
        let blobs = output.join("sha256");
        fs::create_dir_all(&blobs).with_context(|| format!("create {}", blobs.display()))?;
        let scratch = tempfile::Builder::new()
            .prefix(".chunks-")
            .tempdir_in(output)?;
        Ok(Self {
            blobs,
            scratch,
            layers: Vec::new(),
            layer_of: BTreeMap::new(),
            chunk_count: 0,
            disk_bytes: 0,
        })
    }

    pub(crate) fn file(&mut self, path: &Path, media_type: &str) -> Result<OciDescriptorV1> {
        let descriptor = blob_file(path, &self.blobs, media_type)?;
        self.layers.push(descriptor.clone());
        Ok(descriptor)
    }

    pub(crate) fn bytes(&mut self, bytes: &[u8], media_type: &str) -> Result<OciDescriptorV1> {
        let descriptor = blob_bytes(bytes, &self.blobs, media_type)?;
        self.layers.push(descriptor.clone());
        Ok(descriptor)
    }

    /// 4 MiB chunks of `raw`, zero chunks left out, each distinct encoded
    /// chunk one layer of `media_type`.
    pub(crate) fn chunks(&mut self, raw: &Path, media_type: &str) -> Result<WrittenChunks> {
        let scan = scan_raw_image_chunks(raw)?;
        let dir = self.scratch.path().join(format!("{}", self.layers.len()));
        let chunked = write_scanned_chunked_image_artifact(
            &scan,
            &dir.join("chunks"),
            &dir.join("chunks.json"),
            &BTreeMap::new(),
        )?;
        let mut chunks = Vec::with_capacity(chunked.chunks.len());
        for chunk in &chunked.chunks {
            let descriptor = &chunk.descriptor;
            let key = format!("{media_type} {}", descriptor.encoded_sha256);
            let layer = match self.layer_of.get(&key) {
                Some(layer) => *layer,
                None => {
                    let path = chunk
                        .path
                        .as_ref()
                        .context("an encoded chunk has no file")?;
                    let target = self.blobs.join(&descriptor.encoded_sha256);
                    if target.exists() {
                        fs::remove_file(path)?;
                    } else {
                        fs::rename(path, &target)?;
                    }
                    let layer = u32::try_from(self.layers.len()).context("layer count")?;
                    self.layers.push(OciDescriptorV1 {
                        media_type: media_type.to_owned(),
                        digest: digest_of_hex(&descriptor.encoded_sha256)?,
                        size: descriptor.encoded_size_bytes,
                    });
                    self.layer_of.insert(key, layer);
                    layer
                }
            };
            chunks.push((
                u64::from(descriptor.index),
                layer,
                Sha256Hex::try_from(descriptor.raw_sha256.clone()).map_err(anyhow::Error::msg)?,
            ));
        }
        if media_type == DISK_CHUNK_MEDIA_TYPE {
            self.chunk_count = chunks.len();
            self.disk_bytes = scan.virtual_size_bytes;
        }
        Ok(WrittenChunks {
            count: chunks.len(),
            disk: MachineDiskV1 {
                size_bytes: scan.virtual_size_bytes,
                chunk_size: u64::from(IMAGE_CHUNK_SIZE_BYTES),
                chunks,
            },
        })
    }

    pub(crate) fn finish(self, config: MachineConfigV1) -> Result<MachineImage> {
        let config_bytes = serde_json::to_vec(&config)?;
        let chunk_layers = self
            .layers
            .iter()
            .filter(|layer| layer.media_type == DISK_CHUNK_MEDIA_TYPE)
            .count();
        let manifest = OciManifestV1 {
            schema_version: 2,
            media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
            artifact_type: MACHINE_ARTIFACT_TYPE.to_owned(),
            config: blob_bytes(&config_bytes, &self.blobs, MACHINE_CONFIG_MEDIA_TYPE)?,
            layers: self.layers,
        };
        let manifest_bytes = serde_json::to_vec(&manifest)?;
        let manifest_digest =
            blob_bytes(&manifest_bytes, &self.blobs, OCI_MANIFEST_MEDIA_TYPE)?.digest;
        Ok(MachineImage {
            manifest_digest,
            manifest_bytes: manifest_bytes.len() as u64,
            config_bytes: config_bytes.len() as u64,
            chunk_count: self.chunk_count,
            chunk_layers,
            disk_bytes: self.disk_bytes,
        })
    }
}

fn digest_of_hex(hex: &str) -> Result<OciDigest> {
    OciDigest::try_from(format!("sha256:{hex}")).map_err(anyhow::Error::msg)
}

fn blob_bytes(bytes: &[u8], blobs: &Path, media_type: &str) -> Result<OciDescriptorV1> {
    let digest = OciDigest::from_sha256(&Sha256::digest(bytes).into());
    let target = blobs.join(digest.hex());
    if !target.exists() {
        let temporary = blobs.join(format!(".{}.tmp", digest.hex()));
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, &target)?;
    }
    Ok(OciDescriptorV1 {
        media_type: media_type.to_owned(),
        digest,
        size: bytes.len() as u64,
    })
}

fn blob_file(path: &Path, blobs: &Path, media_type: &str) -> Result<OciDescriptorV1> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    blob_bytes(&bytes, blobs, media_type)
}

/// A machine image that passed [`verify_machine_image`].
#[derive(Clone, Debug)]
pub struct VerifiedMachineImage {
    pub manifest: OciManifestV1,
    pub config: MachineConfigV1,
    pub kernel: PathBuf,
    pub initrd: Option<PathBuf>,
}

/// Check the image `digest` in `dir` with the checks jailerd runs before it
/// boots one ([`verified_image`]), plus what jailerd checks while it fetches:
/// every blob's size and SHA-256, and each chunk's decoded SHA-256.
///
/// # Errors
/// Returns the first rule the image breaks.
pub fn verify_machine_image(dir: &Path, digest: &OciDigest) -> Result<VerifiedMachineImage> {
    let blobs = dir.join("sha256");
    let manifest_bytes = read_blob(&blobs, digest, None)?;
    let manifest: OciManifestV1 =
        serde_json::from_slice(&manifest_bytes).context("the manifest is no machine manifest")?;
    let config_bytes = read_blob(&blobs, &manifest.config.digest, Some(manifest.config.size))?;
    let config: MachineConfigV1 =
        serde_json::from_slice(&config_bytes).context("the config is no machine config")?;
    ensure!(
        config.guest_contract == GUEST_CONTRACT && config.image_format == IMAGE_FORMAT,
        "the image is of guest contract {} and format {}",
        config.guest_contract,
        config.image_format
    );
    let first = |media_type: &str| {
        layers_of(&manifest, media_type)
            .first()
            .map(|layer| layer.digest.hex().to_owned())
    };
    let (kernel, initrd) = (first(KERNEL_MEDIA_TYPE), first(INITRD_MEDIA_TYPE));
    let verified = verified_image(
        &manifest,
        &config,
        config_bytes.len() as u64,
        manifest.config.digest.hex(),
        config.disk.size_bytes,
        kernel.as_deref(),
        initrd.as_deref(),
    )
    .map_err(anyhow::Error::msg)?;

    let ram_chunks = verified
        .wake
        .as_ref()
        .map_or(&[][..], |wake| wake.ram_chunks.as_slice());
    for layer in &manifest.layers {
        let chunks = match layer.media_type.as_str() {
            DISK_CHUNK_MEDIA_TYPE => &verified.chunks[..],
            WAKE_RAM_CHUNK_MEDIA_TYPE => ram_chunks,
            KERNEL_MEDIA_TYPE | INITRD_MEDIA_TYPE => {
                read_blob(&blobs, &layer.digest, Some(layer.size))?;
                continue;
            }
            WAKE_STUB_MEDIA_TYPE | WAKE_CPU_PROFILE_MEDIA_TYPE | WAKE_DELTA_MEDIA_TYPE
                if config.wake.is_some() =>
            {
                read_blob(&blobs, &layer.digest, Some(layer.size))?;
                continue;
            }
            other => bail!("layer {} is of unknown type {other}", layer.digest.as_str()),
        };
        ensure!(
            chunks
                .iter()
                .any(|chunk| chunk.encoded_sha256 == layer.digest.hex()),
            "chunk layer {} is named by no chunk",
            layer.digest.as_str()
        );
    }
    for chunk in verified.chunks.iter().chain(ram_chunks) {
        let index = chunk.index;
        let encoded = read_blob(
            &blobs,
            &digest_of_hex(&chunk.encoded_sha256)?,
            Some(chunk.encoded_size_bytes),
        )?;
        let raw = zstd::stream::decode_all(encoded.as_slice())
            .with_context(|| format!("image chunk {index} does not decode"))?;
        ensure!(
            raw.len() as u64 == u64::from(chunk.raw_size_bytes),
            "image chunk {index} decodes to {} bytes",
            raw.len()
        );
        ensure!(
            hex(&Sha256::digest(&raw)) == chunk.raw_sha256,
            "image chunk {index} is not its raw SHA-256"
        );
    }
    if let Some(wake) = &verified.wake {
        ensure!(
            ram_sha256(&blobs, wake)? == wake.ram_sha256,
            "the wake RAM is not its SHA-256"
        );
    }
    let path = |hex: String| blobs.join(hex);
    Ok(VerifiedMachineImage {
        kernel: kernel.map(path).context("kernel")?,
        initrd: initrd.map(path),
        manifest,
        config,
    })
}

/// SHA-256 of the RAM file a verified wake's chunks assemble: zero holes
/// between them.
fn ram_sha256(blobs: &Path, wake: &intar_contracts::oci::verify::VerifiedWake) -> Result<String> {
    let chunk_size = u64::from(IMAGE_CHUNK_SIZE_BYTES);
    let zeros = vec![0_u8; IMAGE_CHUNK_SIZE_BYTES as usize];
    let mut hasher = Sha256::new();
    let mut at = 0_u64;
    for chunk in &wake.ram_chunks {
        let start = u64::from(chunk.index) * chunk_size;
        while at < start {
            hasher.update(&zeros);
            at += chunk_size;
        }
        let encoded = fs::read(blobs.join(&chunk.encoded_sha256))?;
        let raw = zstd::stream::decode_all(encoded.as_slice())?;
        hasher.update(&raw);
        at += raw.len() as u64;
    }
    while at < wake.ram_size_bytes {
        let take = (wake.ram_size_bytes - at).min(chunk_size);
        hasher.update(&zeros[..usize::try_from(take)?]);
        at += take;
    }
    Ok(hex(&hasher.finalize()))
}

/// Write the raw disk of a verified image to `target`, sparse where the image
/// has holes.
///
/// # Errors
/// Returns an error when the image fails verification or the disk cannot be
/// written.
pub fn reconstruct_machine_disk(dir: &Path, digest: &OciDigest, target: &Path) -> Result<()> {
    use std::io::{Seek as _, SeekFrom, Write as _};
    let image = verify_machine_image(dir, digest)?;
    let mut file = fs::File::create(target)?;
    file.set_len(image.config.disk.size_bytes)?;
    for (index, layer_index, _) in &image.config.disk.chunks {
        let layer = &image.manifest.layers[*layer_index as usize];
        let encoded = fs::read(dir.join("sha256").join(layer.digest.hex()))?;
        let raw = zstd::stream::decode_all(encoded.as_slice())?;
        file.seek(SeekFrom::Start(index * u64::from(IMAGE_CHUNK_SIZE_BYTES)))?;
        file.write_all(&raw)?;
    }
    file.sync_all()?;
    Ok(())
}

fn read_blob(blobs: &Path, digest: &OciDigest, size: Option<u64>) -> Result<Vec<u8>> {
    let path = blobs.join(digest.hex());
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .with_context(|| format!("blob {} is missing", digest.as_str()))?;
    ensure!(
        size.is_none_or(|size| size == bytes.len() as u64),
        "blob {} is {} bytes, not {size:?}",
        digest.as_str(),
        bytes.len()
    );
    ensure!(
        hex(&Sha256::digest(&bytes)) == digest.hex(),
        "blob {} is not its digest",
        digest.as_str()
    );
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek as _, SeekFrom, Write as _};

    const CHUNK: u64 = IMAGE_CHUNK_SIZE_BYTES as u64;

    /// A 4.5-chunk disk: data, a hole, the first chunk again, a hole, a tail.
    fn image(dir: &Path) -> (MachineImage, PathBuf) {
        let raw = dir.join("disk.raw");
        let mut file = fs::File::create(&raw).expect("raw");
        file.set_len(4 * CHUNK + CHUNK / 2).expect("size");
        let pattern: Vec<u8> = (0..CHUNK).map(|byte| (byte % 251) as u8).collect();
        file.write_all(&pattern).expect("chunk 0");
        file.seek(SeekFrom::Start(2 * CHUNK)).expect("seek");
        file.write_all(&pattern).expect("chunk 2");
        file.seek(SeekFrom::Start(4 * CHUNK + 7)).expect("seek");
        file.write_all(b"tail").expect("tail");
        drop(file);
        fs::write(dir.join("kernel"), b"kernel").expect("kernel");
        fs::write(dir.join("initrd"), b"initrd").expect("initrd");
        let out = dir.join("out");
        let key = intar_contracts::scenario::base_key();
        let image = write_machine_image(&raw, &dir.join("kernel"), &dir.join("initrd"), &key, &out)
            .expect("image");
        (image, out)
    }

    #[test]
    fn chunks_become_layers_in_first_occurrence_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (image, out) = image(dir.path());
        assert_eq!((image.chunk_count, image.chunk_layers), (3, 2));
        let verified = verify_machine_image(&out, &image.manifest_digest).expect("verified");
        let layers: Vec<&str> = verified
            .manifest
            .layers
            .iter()
            .map(|layer| layer.media_type.as_str())
            .collect();
        assert_eq!(
            layers,
            [
                KERNEL_MEDIA_TYPE,
                INITRD_MEDIA_TYPE,
                DISK_CHUNK_MEDIA_TYPE,
                DISK_CHUNK_MEDIA_TYPE
            ]
        );
        let entries: Vec<(u64, u32)> = verified
            .config
            .disk
            .chunks
            .iter()
            .map(|(index, layer, _)| (*index, *layer))
            .collect();
        assert_eq!(entries, [(0, 2), (2, 2), (4, 3)]);
        assert_eq!(verified.config.disk.size_bytes, 4 * CHUNK + CHUNK / 2);
        assert_eq!(verified.config.boot.cmdline, PUBLISHED_BOOT_CMDLINE);
        assert_eq!(
            verified.config.build_key,
            intar_contracts::scenario::base_key()
        );
        // The config is compact JSON without `wake`.
        let config = fs::read_to_string(
            out.join("sha256")
                .join(verified.manifest.config.digest.hex()),
        )
        .expect("config");
        assert!(!config.contains("wake") && !config.contains('\n'));
        // Exactly the blobs the manifest names, plus itself.
        let names = fs::read_dir(out.join("sha256")).expect("blobs").count();
        assert_eq!(names, verified.manifest.layers.len() + 2);
        assert_eq!(fs::read_dir(&out).expect("out").count(), 1);

        let disk = dir.path().join("rebuilt.raw");
        reconstruct_machine_disk(&out, &image.manifest_digest, &disk).expect("rebuilt");
        assert_eq!(
            fs::read(&disk).expect("rebuilt"),
            fs::read(dir.path().join("disk.raw")).expect("raw")
        );
    }

    #[test]
    fn verification_refuses_a_changed_image() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (image, out) = image(dir.path());
        let blobs = out.join("sha256");
        let verified = verify_machine_image(&out, &image.manifest_digest).expect("verified");

        // A chunk blob that is not its digest.
        let chunk = blobs.join(verified.manifest.layers[3].digest.hex());
        let original = fs::read(&chunk).expect("chunk");
        fs::write(&chunk, b"other").expect("write");
        assert!(verify_machine_image(&out, &image.manifest_digest).is_err());
        fs::write(&chunk, &original).expect("restore");

        // A config naming an initrd as a chunk, re-signed by a new manifest.
        let mut config = verified.config.clone();
        config.disk.chunks[0].1 = 1;
        let mut manifest = verified.manifest.clone();
        let config_bytes = serde_json::to_vec(&config).expect("config");
        manifest.config =
            blob_bytes(&config_bytes, &blobs, MACHINE_CONFIG_MEDIA_TYPE).expect("blob");
        let bytes = serde_json::to_vec(&manifest).expect("manifest");
        let digest = blob_bytes(&bytes, &blobs, OCI_MANIFEST_MEDIA_TYPE)
            .expect("blob")
            .digest;
        let error = verify_machine_image(&out, &digest).expect_err("refused");
        assert!(
            error.to_string().contains("names no chunk layer"),
            "{error}"
        );

        // Chunks out of order.
        let mut config = verified.config.clone();
        config.disk.chunks.swap(0, 1);
        let mut manifest = verified.manifest.clone();
        let config_bytes = serde_json::to_vec(&config).expect("config");
        manifest.config =
            blob_bytes(&config_bytes, &blobs, MACHINE_CONFIG_MEDIA_TYPE).expect("blob");
        let bytes = serde_json::to_vec(&manifest).expect("manifest");
        let digest = blob_bytes(&bytes, &blobs, OCI_MANIFEST_MEDIA_TYPE)
            .expect("blob")
            .digest;
        assert!(verify_machine_image(&out, &digest).is_err());

        // Two kernels.
        let mut manifest = verified.manifest.clone();
        manifest.layers[1].media_type = KERNEL_MEDIA_TYPE.to_owned();
        let bytes = serde_json::to_vec(&manifest).expect("manifest");
        let digest = blob_bytes(&bytes, &blobs, OCI_MANIFEST_MEDIA_TYPE)
            .expect("blob")
            .digest;
        assert!(verify_machine_image(&out, &digest).is_err());
    }
}
