use std::collections::BTreeMap;
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::ops::Range;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, anyhow, bail, ensure};
use intar_contracts::catalog::{
    IMAGE_CHUNK_ENCODING, IMAGE_CHUNK_MANIFEST_SCHEMA_VERSION, IMAGE_CHUNK_SIZE_BYTES,
    ImageChunkManifestV1, ImageChunkV1, MAX_CHUNKED_IMAGE_BYTES,
};
use sha2::{Digest as _, Sha256};

use crate::artifact::sha256_file_hex;
use crate::content_hash::sha256_bytes_hex;

const CHUNK_COMPRESSION_LEVEL: i32 = 6;
const CHUNK_COMPRESSION_WORKERS: usize = 4;

#[derive(Clone, Debug)]
pub struct EncodedImageChunkArtifact {
    pub descriptor: ImageChunkV1,
    /// Present only when this build encoded the chunk. A registry-reused
    /// chunk has verified encoded metadata but no redundant local payload.
    pub path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct ChunkedImageArtifact {
    pub raw_path: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest_sha256: String,
    pub manifest: ImageChunkManifestV1,
    pub chunks: Vec<EncodedImageChunkArtifact>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScannedImageChunk {
    pub index: u32,
    pub raw_size_bytes: u32,
    pub raw_sha256: String,
}

#[derive(Clone, Debug)]
pub struct ScannedChunkedImage {
    pub raw_path: PathBuf,
    pub virtual_size_bytes: u64,
    pub chunks: Vec<ScannedImageChunk>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReusedEncodedImageChunk {
    pub raw_sha256: String,
    pub raw_size_bytes: u32,
    pub encoded_sha256: String,
    pub encoded_size_bytes: u64,
}

#[derive(Clone, Debug)]
struct EncodedChunk {
    raw_sha256: String,
    encoded_sha256: String,
    encoded_size_bytes: u64,
    path: Option<PathBuf>,
}

/// Split a sparse raw image into independently compressed, content-addressed
/// chunks. Zero chunks are represented as holes in the manifest.
///
/// # Errors
/// Returns an error if the raw image is invalid or any chunk cannot be encoded.
pub fn write_chunked_image_artifact(
    raw_path: &Path,
    chunks_dir: &Path,
    manifest_path: &Path,
) -> Result<ChunkedImageArtifact> {
    let scan = scan_raw_image_chunks(raw_path)?;
    write_scanned_chunked_image_artifact(&scan, chunks_dir, manifest_path, &BTreeMap::new())
}

/// Scan one raw image in logical order and hash every non-zero 4 MiB chunk.
///
/// # Errors
/// Returns an error if the raw image is not a bounded regular file or cannot
/// be read completely.
pub fn scan_raw_image_chunks(raw_path: &Path) -> Result<ScannedChunkedImage> {
    let metadata = fs::symlink_metadata(raw_path)
        .with_context(|| format!("failed to stat raw image '{}'", raw_path.display()))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CHUNKED_IMAGE_BYTES {
        bail!(
            "raw image '{}' is not a non-empty bounded regular file",
            raw_path.display()
        );
    }
    let mut raw = fs::File::open(raw_path)
        .with_context(|| format!("failed to open raw image '{}'", raw_path.display()))?;
    let data_extents = discover_data_extents(&raw, metadata.len())?;
    let mut chunks = Vec::new();
    let chunk_size = u64::from(IMAGE_CHUNK_SIZE_BYTES);
    let chunk_count = metadata.len().div_ceil(chunk_size);
    let mut extent_cursor = 0_usize;
    for raw_index in 0..chunk_count {
        let chunk_start = raw_index
            .checked_mul(chunk_size)
            .context("image chunk offset overflow")?;
        let chunk_end = chunk_start.saturating_add(chunk_size).min(metadata.len());
        let length = usize::try_from(chunk_end - chunk_start)
            .context("image chunk size does not fit memory")?;
        if let Some(extents) = data_extents.as_ref() {
            while extents
                .get(extent_cursor)
                .is_some_and(|extent| extent.end <= chunk_start)
            {
                extent_cursor = extent_cursor.saturating_add(1);
            }
            if !extents
                .get(extent_cursor)
                .is_some_and(|extent| extent.start < chunk_end)
            {
                continue;
            }
        }

        raw.seek(SeekFrom::Start(chunk_start))
            .with_context(|| format!("failed to seek raw image '{}'", raw_path.display()))?;
        let mut bytes = vec![0_u8; length];
        raw.read_exact(&mut bytes)
            .with_context(|| format!("failed to read raw image '{}'", raw_path.display()))?;
        if bytes.iter().any(|byte| *byte != 0) {
            chunks.push(ScannedImageChunk {
                index: u32::try_from(raw_index).context("image chunk index overflow")?,
                raw_size_bytes: u32::try_from(length).context("image chunk size overflow")?,
                raw_sha256: sha256_bytes_hex(&bytes),
            });
        }
    }

    Ok(ScannedChunkedImage {
        raw_path: raw_path.to_path_buf(),
        virtual_size_bytes: metadata.len(),
        chunks,
    })
}

fn discover_data_extents(raw: &fs::File, file_len: u64) -> Result<Option<Vec<Range<u64>>>> {
    let mut extents = Vec::new();
    let mut cursor = 0_u64;
    while cursor < file_len {
        let data = match rustix::fs::seek(raw, rustix::fs::SeekFrom::Data(cursor)) {
            Ok(data) => data,
            Err(rustix::io::Errno::NXIO) => break,
            Err(error)
                if error == rustix::io::Errno::INVAL || error == rustix::io::Errno::NOTSUP =>
            {
                return Ok(None);
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to find sparse data extent at byte {cursor}")
                });
            }
        };
        if data >= file_len {
            break;
        }
        let hole = match rustix::fs::seek(raw, rustix::fs::SeekFrom::Hole(data)) {
            Ok(hole) => hole.min(file_len),
            Err(rustix::io::Errno::NXIO) => file_len,
            Err(error)
                if error == rustix::io::Errno::INVAL || error == rustix::io::Errno::NOTSUP =>
            {
                return Ok(None);
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to find sparse hole extent at byte {data}"));
            }
        };
        ensure!(hole > data, "sparse extent did not advance at byte {data}");
        extents.push(data..hole);
        cursor = hole;
    }
    Ok(Some(extents))
}

/// Encode only chunks absent from the registry and publish a complete local
/// manifest using verified metadata for reused chunks.
///
/// # Errors
/// Returns an error if the scan is stale, reused metadata is inconsistent, or
/// a missing chunk cannot be encoded.
pub fn write_scanned_chunked_image_artifact(
    scan: &ScannedChunkedImage,
    chunks_dir: &Path,
    manifest_path: &Path,
    reused: &BTreeMap<String, ReusedEncodedImageChunk>,
) -> Result<ChunkedImageArtifact> {
    let metadata = fs::symlink_metadata(&scan.raw_path)?;
    ensure_scan_is_valid(scan, &metadata)?;
    fs::create_dir_all(chunks_dir).with_context(|| {
        format!(
            "failed to create chunk directory '{}'",
            chunks_dir.display()
        )
    })?;
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!("failed to create manifest directory '{}'", parent.display())
        })?;
    }

    let mut unique = BTreeMap::<String, ScannedImageChunk>::new();
    for chunk in &scan.chunks {
        unique
            .entry(chunk.raw_sha256.clone())
            .or_insert_with(|| chunk.clone());
    }
    let mut encoded = BTreeMap::<String, EncodedChunk>::new();
    let mut missing = Vec::new();
    for (raw_sha256, chunk) in unique {
        if let Some(existing) = reused.get(&raw_sha256) {
            validate_reused_chunk(&raw_sha256, chunk.raw_size_bytes, existing)?;
            encoded.insert(
                raw_sha256.clone(),
                EncodedChunk {
                    raw_sha256,
                    encoded_sha256: existing.encoded_sha256.clone(),
                    encoded_size_bytes: existing.encoded_size_bytes,
                    path: None,
                },
            );
        } else {
            missing.push(chunk);
        }
    }
    for batch in missing.chunks(CHUNK_COMPRESSION_WORKERS) {
        for chunk in encode_batch(batch.to_vec(), &scan.raw_path, chunks_dir)? {
            encoded.insert(chunk.raw_sha256.clone(), chunk);
        }
    }

    let chunks = scan
        .chunks
        .iter()
        .map(|scanned| {
            let encoded = encoded
                .get(&scanned.raw_sha256)
                .context("encoded image chunk metadata is missing")?;
            Ok(EncodedImageChunkArtifact {
                descriptor: ImageChunkV1 {
                    index: scanned.index,
                    raw_size_bytes: scanned.raw_size_bytes,
                    raw_sha256: scanned.raw_sha256.clone(),
                    encoded_size_bytes: encoded.encoded_size_bytes,
                    encoded_sha256: encoded.encoded_sha256.clone(),
                },
                path: encoded.path.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let mut manifest = ImageChunkManifestV1 {
        schema_version: IMAGE_CHUNK_MANIFEST_SCHEMA_VERSION,
        image_id: "0".repeat(64),
        virtual_size_bytes: scan.virtual_size_bytes,
        chunk_size_bytes: IMAGE_CHUNK_SIZE_BYTES,
        encoding: IMAGE_CHUNK_ENCODING.to_owned(),
        chunks: chunks
            .iter()
            .map(|chunk| chunk.descriptor.clone())
            .collect(),
    };
    manifest.image_id = manifest.compute_image_id().map_err(anyhow::Error::from)?;
    manifest.validate().map_err(anyhow::Error::from)?;

    let manifest_bytes = serde_json::to_vec(&manifest).context("serialize chunk manifest")?;
    let manifest_sha256 = sha256_bytes_hex(&manifest_bytes);
    let temporary = manifest_path.with_extension("json.tmp");
    fs::write(&temporary, &manifest_bytes)
        .with_context(|| format!("failed to write chunk manifest '{}'", temporary.display()))?;
    fs::rename(&temporary, manifest_path).with_context(|| {
        format!(
            "failed to publish chunk manifest '{}'",
            manifest_path.display()
        )
    })?;

    Ok(ChunkedImageArtifact {
        raw_path: scan.raw_path.clone(),
        manifest_path: manifest_path.to_path_buf(),
        manifest_sha256,
        manifest,
        chunks,
    })
}

fn ensure_scan_is_valid(scan: &ScannedChunkedImage, metadata: &fs::Metadata) -> Result<()> {
    ensure!(
        metadata.is_file()
            && metadata.len() == scan.virtual_size_bytes
            && (1..=MAX_CHUNKED_IMAGE_BYTES).contains(&scan.virtual_size_bytes),
        "raw image changed after chunk scan"
    );
    let mut previous = None;
    let logical_chunks = scan
        .virtual_size_bytes
        .div_ceil(u64::from(IMAGE_CHUNK_SIZE_BYTES));
    for chunk in &scan.chunks {
        let expected_size = if u64::from(chunk.index) + 1 == logical_chunks {
            u32::try_from(
                scan.virtual_size_bytes
                    - u64::from(chunk.index) * u64::from(IMAGE_CHUNK_SIZE_BYTES),
            )?
        } else {
            IMAGE_CHUNK_SIZE_BYTES
        };
        ensure!(
            previous.is_none_or(|index| chunk.index > index)
                && u64::from(chunk.index) < logical_chunks
                && chunk.raw_size_bytes == expected_size
                && is_sha256(&chunk.raw_sha256),
            "raw image chunk scan is invalid"
        );
        previous = Some(chunk.index);
    }
    Ok(())
}

fn validate_reused_chunk(
    raw_sha256: &str,
    raw_size_bytes: u32,
    reused: &ReusedEncodedImageChunk,
) -> Result<()> {
    ensure!(
        reused.raw_sha256 == raw_sha256
            && reused.raw_size_bytes == raw_size_bytes
            && is_sha256(&reused.raw_sha256)
            && is_sha256(&reused.encoded_sha256)
            && reused.encoded_size_bytes > 0,
        "registry reused image chunk metadata is invalid"
    );
    Ok(())
}

fn encode_batch(
    batch: Vec<ScannedImageChunk>,
    raw_path: &Path,
    chunks_dir: &Path,
) -> Result<Vec<EncodedChunk>> {
    std::thread::scope(|scope| {
        let handles = batch
            .into_iter()
            .map(|chunk| {
                let raw_path = raw_path.to_path_buf();
                let chunks_dir = chunks_dir.to_path_buf();
                scope.spawn(move || encode_chunk(chunk, &raw_path, &chunks_dir))
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| anyhow!("image chunk encoder thread panicked"))?
            })
            .collect()
    })
}

fn encode_chunk(
    chunk: ScannedImageChunk,
    raw_path: &Path,
    chunks_dir: &Path,
) -> Result<EncodedChunk> {
    let mut raw = fs::File::open(raw_path)?;
    raw.seek(SeekFrom::Start(
        u64::from(chunk.index) * u64::from(IMAGE_CHUNK_SIZE_BYTES),
    ))?;
    let mut bytes = vec![0_u8; chunk.raw_size_bytes as usize];
    raw.read_exact(&mut bytes)?;
    ensure!(
        sha256_bytes_hex(&bytes) == chunk.raw_sha256,
        "raw image changed after chunk scan"
    );

    let filename = format!("{}.raw.zst", chunk.raw_sha256);
    let path = chunks_dir.join(filename);
    let temporary = chunks_dir.join(format!(".{}.raw.zst.tmp", chunk.raw_sha256));
    let output = fs::File::create(&temporary)
        .with_context(|| format!("failed to create encoded chunk '{}'", temporary.display()))?;
    let hashing = HashingWriter::new(output);
    let mut encoder = zstd::stream::Encoder::new(hashing, CHUNK_COMPRESSION_LEVEL)
        .context("failed to create image chunk zstd encoder")?;
    encoder
        .include_checksum(true)
        .context("failed to enable image chunk checksum")?;
    encoder
        .include_contentsize(true)
        .context("failed to enable image chunk content size")?;
    encoder
        .set_pledged_src_size(Some(bytes.len() as u64))
        .context("failed to set image chunk content size")?;
    encoder
        .write_all(&bytes)
        .context("failed to encode image chunk")?;
    let hashing = encoder.finish().context("failed to finish image chunk")?;
    let (output, encoded_sha256, encoded_size_bytes) = hashing.finish();
    output
        .sync_all()
        .with_context(|| format!("failed to sync encoded chunk '{}'", temporary.display()))?;
    drop(output);
    if path.exists() {
        ensure!(
            fs::metadata(&path)?.len() == encoded_size_bytes
                && sha256_file_hex(&path)? == encoded_sha256,
            "existing encoded chunk differs from deterministic output"
        );
        fs::remove_file(&temporary)?;
    } else {
        fs::rename(&temporary, &path)
            .with_context(|| format!("failed to publish encoded chunk '{}'", path.display()))?;
    }

    Ok(EncodedChunk {
        raw_sha256: chunk.raw_sha256,
        encoded_size_bytes,
        encoded_sha256,
        path: Some(path),
    })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// Reconstruct a sparse raw image and verify both encoded and raw chunk hashes.
///
/// # Errors
/// Returns an error for a malformed manifest, missing chunk, digest mismatch,
/// truncated stream, oversized stream, or output failure.
pub fn reconstruct_chunked_image(
    manifest: &ImageChunkManifestV1,
    output_path: &Path,
    encoded_path: impl Fn(&ImageChunkV1) -> PathBuf,
) -> Result<()> {
    manifest.validate().map_err(anyhow::Error::from)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output_path)
        .with_context(|| format!("failed to create raw image '{}'", output_path.display()))?;
    output.set_len(manifest.virtual_size_bytes)?;

    let result = (|| -> Result<()> {
        for chunk in &manifest.chunks {
            let path = encoded_path(chunk);
            if sha256_file_hex(&path)? != chunk.encoded_sha256 {
                bail!(
                    "encoded image chunk SHA-256 mismatch at index {}",
                    chunk.index
                );
            }
            let input = fs::File::open(&path)
                .with_context(|| format!("failed to open image chunk '{}'", path.display()))?;
            let mut decoder = zstd::stream::read::Decoder::new(input)
                .with_context(|| format!("failed to decode image chunk '{}'", path.display()))?;
            let mut raw = Vec::with_capacity(chunk.raw_size_bytes as usize);
            decoder
                .by_ref()
                .take(u64::from(chunk.raw_size_bytes) + 1)
                .read_to_end(&mut raw)
                .context("failed to read decoded image chunk")?;
            if raw.len() != chunk.raw_size_bytes as usize {
                bail!("decoded image chunk size mismatch at index {}", chunk.index);
            }
            if sha256_bytes_hex(&raw) != chunk.raw_sha256 {
                bail!("raw image chunk SHA-256 mismatch at index {}", chunk.index);
            }
            output.seek(SeekFrom::Start(
                u64::from(chunk.index) * u64::from(IMAGE_CHUNK_SIZE_BYTES),
            ))?;
            output.write_all(&raw)?;
        }
        output.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        drop(output);
        let _ = fs::remove_file(output_path);
    }
    result
}

struct HashingWriter<W> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(self) -> (W, String, u64) {
        (self.inner, hex_digest(self.hasher.finalize()), self.bytes)
    }
}

impl<W: std::io::Write> std::io::Write for HashingWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.hasher.update(&buffer[..written]);
        self.bytes = self.bytes.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::{Seek as _, SeekFrom, Write as _};

    use super::*;

    #[test]
    fn chunked_artifact_round_trips_sparse_image_and_short_tail() {
        let temp = tempfile::tempdir().unwrap();
        let raw_path = temp.path().join("root.raw");
        let chunks = temp.path().join("chunks");
        let manifest_path = temp.path().join("manifest.json");
        let rebuilt = temp.path().join("rebuilt.raw");
        let mut raw = fs::File::create(&raw_path).unwrap();
        raw.set_len(u64::from(IMAGE_CHUNK_SIZE_BYTES) * 2 + 7)
            .unwrap();
        raw.seek(SeekFrom::Start(u64::from(IMAGE_CHUNK_SIZE_BYTES) + 123))
            .unwrap();
        raw.write_all(b"INTAR").unwrap();
        raw.seek(SeekFrom::Start(u64::from(IMAGE_CHUNK_SIZE_BYTES) * 2))
            .unwrap();
        raw.write_all(b"the-end").unwrap();
        raw.sync_all().unwrap();

        let artifact = write_chunked_image_artifact(&raw_path, &chunks, &manifest_path).unwrap();
        assert_eq!(artifact.manifest.chunk_count(), 3);
        assert_eq!(artifact.manifest.chunks.len(), 2);
        assert_eq!(artifact.manifest.chunks[0].index, 1);
        assert_eq!(artifact.manifest.chunks[1].index, 2);
        assert_eq!(artifact.manifest.chunks[1].raw_size_bytes, 7);
        assert_eq!(artifact.manifest_sha256.len(), 64);

        reconstruct_chunked_image(&artifact.manifest, &rebuilt, |chunk| {
            artifact
                .chunks
                .iter()
                .find(|candidate| candidate.descriptor.index == chunk.index)
                .unwrap()
                .path
                .clone()
                .unwrap()
        })
        .unwrap();
        assert_eq!(fs::read(&rebuilt).unwrap(), fs::read(&raw_path).unwrap());
    }

    #[test]
    fn reconstruction_rejects_truncated_and_tampered_chunks() {
        let temp = tempfile::tempdir().unwrap();
        let raw_path = temp.path().join("root.raw");
        let chunks = temp.path().join("chunks");
        let manifest_path = temp.path().join("manifest.json");
        fs::write(&raw_path, b"not zero").unwrap();
        let artifact = write_chunked_image_artifact(&raw_path, &chunks, &manifest_path).unwrap();
        let encoded = artifact.chunks[0].path.as_ref().unwrap();
        let mut bytes = fs::read(encoded).unwrap();
        bytes.truncate(bytes.len() / 2);
        fs::write(encoded, bytes).unwrap();

        let rebuilt = temp.path().join("rebuilt.raw");
        let error = reconstruct_chunked_image(&artifact.manifest, &rebuilt, |_| encoded.clone())
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("encoded image chunk SHA-256 mismatch")
        );
        assert!(!rebuilt.exists());
    }

    #[test]
    fn registry_reuse_skips_compression_and_duplicate_chunks_share_one_object() {
        let temp = tempfile::tempdir().unwrap();
        let raw_path = temp.path().join("root.raw");
        let chunks_dir = temp.path().join("chunks");
        let manifest_path = temp.path().join("manifest.json");
        let chunk_bytes = vec![0x5a; IMAGE_CHUNK_SIZE_BYTES as usize];
        let mut raw = fs::File::create(&raw_path).unwrap();
        raw.write_all(&chunk_bytes).unwrap();
        raw.write_all(&chunk_bytes).unwrap();
        raw.sync_all().unwrap();

        let scan = scan_raw_image_chunks(&raw_path).unwrap();
        assert_eq!(scan.chunks.len(), 2);
        assert_eq!(scan.chunks[0].raw_sha256, scan.chunks[1].raw_sha256);
        let raw_sha256 = scan.chunks[0].raw_sha256.clone();
        let reused = BTreeMap::from([(
            raw_sha256.clone(),
            ReusedEncodedImageChunk {
                raw_sha256,
                raw_size_bytes: IMAGE_CHUNK_SIZE_BYTES,
                encoded_sha256: "a".repeat(64),
                encoded_size_bytes: 123,
            },
        )]);

        let artifact =
            write_scanned_chunked_image_artifact(&scan, &chunks_dir, &manifest_path, &reused)
                .unwrap();
        assert_eq!(artifact.manifest.chunks.len(), 2);
        assert!(artifact.chunks.iter().all(|chunk| chunk.path.is_none()));
        assert_eq!(fs::read_dir(chunks_dir).unwrap().count(), 0);
        artifact.manifest.validate().unwrap();
    }
}
