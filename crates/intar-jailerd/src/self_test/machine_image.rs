//! The self-test's machine image: a raw root disk turned into the chunked OCI
//! image (#312) that `PrepareChunkedImageV3` reads from a blob cache.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read as _, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;

use anyhow::{Context as _, Result};
use intar_contracts::catalog::IMAGE_CHUNK_SIZE_BYTES;
use intar_contracts::guest::GUEST_CONTRACT;
use intar_contracts::oci::{
    DISK_CHUNK_MEDIA_TYPE, IMAGE_FORMAT, INITRD_MEDIA_TYPE, KERNEL_MEDIA_TYPE,
    MACHINE_ARTIFACT_TYPE, MACHINE_CONFIG_MEDIA_TYPE, MachineBootV1, MachineConfigV1,
    MachineDiskV1, OCI_MANIFEST_MEDIA_TYPE, OciDescriptorV1, OciDigest, OciManifestV1, Sha256Hex,
};
use sha2::{Digest as _, Sha256};

/// A machine image in a blob directory, where every blob is a file named by
/// the SHA-256 (hex) of its bytes.
#[derive(Debug)]
pub(crate) struct MachineImage {
    pub(crate) manifest: OciManifestV1,
    /// The SHA-256 of the manifest: the image's identity.
    pub(crate) manifest_sha256: String,
    pub(crate) config: MachineConfigV1,
    pub(crate) config_sha256: String,
    pub(crate) config_bytes: u64,
    pub(crate) kernel_sha256: String,
    pub(crate) initrd_sha256: Option<String>,
}

/// Split `root_disk` into 4 MiB chunks, skip all-zero ones, zstd-encode the
/// rest, and write every blob (kernel, initrd, chunks, config, manifest)
/// into `blobs`. Identical chunks share one layer.
pub(crate) fn build_machine_image(
    root_disk: &Path,
    kernel: &Path,
    initrd: Option<&Path>,
    cmdline: &str,
    blobs: &Path,
) -> Result<MachineImage> {
    let mut layers = Vec::new();
    let kernel_sha256 = put_blob(blobs, &read(kernel)?)?;
    layers.push(descriptor(
        KERNEL_MEDIA_TYPE,
        &kernel_sha256.0,
        kernel_sha256.1,
    )?);
    let initrd_sha256 = initrd
        .map(|path| -> Result<_> {
            let blob = put_blob(blobs, &read(path)?)?;
            layers.push(descriptor(INITRD_MEDIA_TYPE, &blob.0, blob.1)?);
            Ok(blob.0)
        })
        .transpose()?;

    let mut disk = File::open(root_disk)
        .with_context(|| format!("open the self-test root disk {}", root_disk.display()))?;
    let mut disk_hash = Sha256::new();
    let mut layer_of_chunk = BTreeMap::<String, u32>::new();
    let mut chunks = Vec::new();
    let mut size_bytes = 0_u64;
    let mut raw = vec![0_u8; IMAGE_CHUNK_SIZE_BYTES as usize];
    for index in 0_u64.. {
        let length = read_full(&mut disk, &mut raw)?;
        if length == 0 {
            break;
        }
        let raw = &raw[..length];
        size_bytes += length as u64;
        disk_hash.update(raw);
        if raw.iter().all(|byte| *byte == 0) {
            continue;
        }
        let encoded = zstd::encode_all(raw, 3).context("encode a disk chunk")?;
        let (encoded_sha256, encoded_size) = put_blob(blobs, &encoded)?;
        let layer_index = match layer_of_chunk.get(&encoded_sha256) {
            Some(layer_index) => *layer_index,
            None => {
                let layer_index = u32::try_from(layers.len()).context("too many layers")?;
                layers.push(descriptor(
                    DISK_CHUNK_MEDIA_TYPE,
                    &encoded_sha256,
                    encoded_size,
                )?);
                layer_of_chunk.insert(encoded_sha256, layer_index);
                layer_index
            }
        };
        chunks.push((
            index,
            layer_index,
            Sha256Hex::try_from(hex(&Sha256::digest(raw))).map_err(anyhow::Error::msg)?,
        ));
    }

    let config = MachineConfigV1 {
        guest_contract: GUEST_CONTRACT,
        image_format: IMAGE_FORMAT.to_owned(),
        // The self-test has no build; the raw disk stands for its inputs.
        build_key: digest(&hex(&disk_hash.finalize()))?,
        boot: MachineBootV1 {
            cmdline: cmdline.to_owned(),
        },
        disk: MachineDiskV1 {
            size_bytes,
            chunk_size: u64::from(IMAGE_CHUNK_SIZE_BYTES),
            chunks,
        },
        wake: None,
    };
    let (config_sha256, config_bytes) = put_blob(blobs, &serde_json::to_vec(&config)?)?;
    let manifest = OciManifestV1 {
        schema_version: 2,
        media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
        artifact_type: MACHINE_ARTIFACT_TYPE.to_owned(),
        config: descriptor(MACHINE_CONFIG_MEDIA_TYPE, &config_sha256, config_bytes)?,
        layers,
    };
    let (manifest_sha256, _) = put_blob(blobs, &serde_json::to_vec(&manifest)?)?;
    Ok(MachineImage {
        manifest,
        manifest_sha256,
        config,
        config_sha256,
        config_bytes,
        kernel_sha256: kernel_sha256.0,
        initrd_sha256,
    })
}

fn read(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).with_context(|| format!("read {}", path.display()))
}

/// Fill `buffer` unless the file ends first; the bytes read.
fn read_full(file: &mut File, buffer: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(error).context("read the self-test root disk"),
        }
    }
    Ok(filled)
}

/// Write a read-only blob named by its SHA-256 unless it is there already;
/// its hex digest and size.
fn put_blob(blobs: &Path, bytes: &[u8]) -> Result<(String, u64)> {
    let sha256 = hex(&Sha256::digest(bytes));
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(blobs.join(&sha256))
    {
        Ok(mut file) => {
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).context("write a self-test image blob"),
    }
    Ok((sha256, bytes.len() as u64))
}

fn descriptor(media_type: &str, sha256: &str, size: u64) -> Result<OciDescriptorV1> {
    Ok(OciDescriptorV1 {
        media_type: media_type.to_owned(),
        digest: digest(sha256)?,
        size,
    })
}

fn digest(sha256: &str) -> Result<OciDigest> {
    OciDigest::try_from(format!("sha256:{sha256}")).map_err(anyhow::Error::msg)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: usize = 1024 * 1024;

    #[test]
    fn a_disk_becomes_chunk_layers_without_its_holes() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let blobs = dir.path().join("blobs");
        std::fs::create_dir(&blobs)?;
        // Chunk 0 and 2 alike, chunk 1 a zero hole, chunk 3 a 1 MiB tail.
        let pattern = (0..4 * MIB).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let mut disk = pattern.clone();
        disk.extend(vec![0; 4 * MIB]);
        disk.extend(&pattern);
        disk.extend(vec![7; MIB]);
        let (root, kernel, initrd) = (
            dir.path().join("root.raw"),
            dir.path().join("kernel"),
            dir.path().join("initrd"),
        );
        std::fs::write(&root, &disk)?;
        std::fs::write(&kernel, b"kernel bytes")?;
        std::fs::write(&initrd, b"initrd bytes")?;

        let image = build_machine_image(&root, &kernel, Some(&initrd), "console=hvc0", &blobs)?;

        let layers = &image.manifest.layers;
        let media = layers
            .iter()
            .map(|l| l.media_type.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            media,
            [
                KERNEL_MEDIA_TYPE,
                INITRD_MEDIA_TYPE,
                DISK_CHUNK_MEDIA_TYPE,
                DISK_CHUNK_MEDIA_TYPE
            ]
        );
        let chunks = &image.config.disk.chunks;
        assert_eq!(
            chunks.iter().map(|(i, l, _)| (*i, *l)).collect::<Vec<_>>(),
            [(0, 2), (2, 2), (3, 3)],
            "no hole, identical chunks share a layer"
        );
        assert_eq!(image.config.disk.size_bytes, disk.len() as u64);
        // Every blob is named by its bytes, and a chunk decodes to its raw hash.
        for entry in std::fs::read_dir(&blobs)? {
            let entry = entry?;
            let bytes = std::fs::read(entry.path())?;
            assert_eq!(
                entry.file_name().to_string_lossy(),
                hex(&Sha256::digest(&bytes))
            );
        }
        let tail = std::fs::read(blobs.join(layers[3].digest.hex()))?;
        assert_eq!(zstd::decode_all(tail.as_slice())?, vec![7; MIB]);
        assert_eq!(
            hex(&Sha256::digest(std::fs::read(
                blobs.join(&image.manifest_sha256)
            )?)),
            image.manifest_sha256
        );

        // What jailerd verifies before it assembles the template.
        let verified = crate::chunked_templates::verified_image(
            &image.manifest,
            &image.config,
            image.config_bytes,
            &image.config_sha256,
            disk.len() as u64,
            Some(&image.kernel_sha256),
            image.initrd_sha256.as_deref(),
        )?;
        assert_eq!(
            verified
                .chunks
                .iter()
                .map(|chunk| (chunk.index, chunk.raw_size_bytes as usize))
                .collect::<Vec<_>>(),
            [(0, 4 * MIB), (2, 4 * MIB), (3, MIB)]
        );
        Ok(())
    }
}
