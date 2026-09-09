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

use crate::artifact::sha256_file_hex;
use crate::sha256::sha256_bytes_hex;

const CHUNK_COMPRESSION_LEVEL: i32 = 6;
const CHUNK_COMPRESSION_WORKERS: usize = 4;
pub(crate) const MAX_CHUNK_READS_IN_FLIGHT: usize = 8;

#[derive(Clone, Debug)]
pub(crate) struct ImageChunkRead {
    pub(crate) offset: u64,
    pub(crate) length: usize,
}

/// Reads logical raw-image chunks from one immutable source.
///
/// A reader can return only byte ranges that it knows are all zero. Ranges
/// with incomplete or unavailable allocation information stay unreadable by
/// this interface and are read normally by the scanner.
pub(crate) trait ImageChunkReader {
    fn virtual_size_bytes(&mut self) -> Result<u64>;

    fn known_zero_ranges(&mut self) -> Result<Option<Vec<Range<u64>>>>;

    /// Reads the supplied chunks in request order.
    ///
    /// Implementations must reject a short or failed read. The caller limits
    /// each request to one image chunk and each batch to eight requests.
    fn read_chunks(&mut self, reads: &[ImageChunkRead]) -> Result<Vec<Vec<u8>>>;
}

struct FileImageChunkReader {
    raw_path: PathBuf,
    raw: fs::File,
    virtual_size_bytes: u64,
    data_extents: Option<Vec<Range<u64>>>,
}

impl FileImageChunkReader {
    fn open(raw_path: &Path) -> Result<Self> {
        let metadata = fs::symlink_metadata(raw_path)
            .with_context(|| format!("failed to stat raw image '{}'", raw_path.display()))?;
        validate_virtual_size(raw_path, &metadata)?;
        let raw = fs::File::open(raw_path)
            .with_context(|| format!("failed to open raw image '{}'", raw_path.display()))?;
        let data_extents = discover_data_extents(&raw, metadata.len())?;
        Ok(Self {
            raw_path: raw_path.to_path_buf(),
            raw,
            virtual_size_bytes: metadata.len(),
            data_extents,
        })
    }
}

impl ImageChunkReader for FileImageChunkReader {
    fn virtual_size_bytes(&mut self) -> Result<u64> {
        Ok(self.virtual_size_bytes)
    }

    fn known_zero_ranges(&mut self) -> Result<Option<Vec<Range<u64>>>> {
        Ok(self.data_extents.as_ref().map(|data_extents| {
            zero_ranges_from_data_extents(data_extents, self.virtual_size_bytes)
        }))
    }

    fn read_chunks(&mut self, reads: &[ImageChunkRead]) -> Result<Vec<Vec<u8>>> {
        ensure!(
            reads.len() <= MAX_CHUNK_READS_IN_FLIGHT,
            "too many raw image reads in one batch"
        );
        reads
            .iter()
            .map(|read| {
                let mut bytes = vec![0_u8; read.length];
                self.raw
                    .seek(SeekFrom::Start(read.offset))
                    .with_context(|| {
                        format!("failed to seek raw image '{}'", self.raw_path.display())
                    })?;
                self.raw.read_exact(&mut bytes).with_context(|| {
                    format!("failed to read raw image '{}'", self.raw_path.display())
                })?;
                Ok(bytes)
            })
            .collect()
    }
}

#[derive(Clone, Debug)]
pub struct EncodedImageChunkArtifact {
    pub descriptor: ImageChunkV1,
    /// Present only when this build encoded the chunk. A registry-reused
    /// chunk has verified encoded metadata but no redundant local payload.
    pub path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct ChunkedImageArtifact {
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
    let mut raw = FileImageChunkReader::open(raw_path)?;
    scan_image_chunks(&mut raw, raw_path.to_path_buf())
}

pub(crate) fn scan_image_chunks(
    reader: &mut impl ImageChunkReader,
    source_label: PathBuf,
) -> Result<ScannedChunkedImage> {
    let started = std::time::Instant::now();
    let virtual_size_bytes = reader.virtual_size_bytes()?;
    ensure!(
        (1..=MAX_CHUNKED_IMAGE_BYTES).contains(&virtual_size_bytes),
        "raw image '{}' is not non-empty and bounded",
        source_label.display()
    );
    let mut zero_ranges = reader.known_zero_ranges()?.unwrap_or_default();
    normalize_ranges(&mut zero_ranges, virtual_size_bytes)?;
    let mut chunks = Vec::new();
    let chunk_size = u64::from(IMAGE_CHUNK_SIZE_BYTES);
    let chunk_count = virtual_size_bytes.div_ceil(chunk_size);
    let mut reads = Vec::with_capacity(MAX_CHUNK_READS_IN_FLIGHT);
    for raw_index in 0..chunk_count {
        let chunk_start = raw_index
            .checked_mul(chunk_size)
            .context("image chunk offset overflow")?;
        let chunk_end = chunk_start
            .saturating_add(chunk_size)
            .min(virtual_size_bytes);
        let length = usize::try_from(chunk_end - chunk_start)
            .context("image chunk size does not fit memory")?;
        if range_is_covered(&zero_ranges, chunk_start, chunk_end) {
            continue;
        }
        reads.push((
            ScannedImageChunk {
                index: u32::try_from(raw_index).context("image chunk index overflow")?,
                raw_size_bytes: u32::try_from(length).context("image chunk size overflow")?,
                raw_sha256: String::new(),
            },
            ImageChunkRead {
                offset: chunk_start,
                length,
            },
        ));
        if reads.len() == MAX_CHUNK_READS_IN_FLIGHT {
            hash_read_batch(reader, &mut chunks, std::mem::take(&mut reads))?;
        }
    }
    if !reads.is_empty() {
        hash_read_batch(reader, &mut chunks, reads)?;
    }
    chunks.sort_by_key(|chunk| chunk.index);

    eprintln!(
        "[intar-build-metric] phase=chunk_scan elapsed_ms={} raw_bytes={} non_zero_chunks={} path={}",
        started.elapsed().as_millis(),
        virtual_size_bytes,
        chunks.len(),
        source_label.display()
    );
    Ok(ScannedChunkedImage {
        raw_path: source_label,
        virtual_size_bytes,
        chunks,
    })
}

fn hash_read_batch(
    reader: &mut impl ImageChunkReader,
    chunks: &mut Vec<ScannedImageChunk>,
    reads: Vec<(ScannedImageChunk, ImageChunkRead)>,
) -> Result<()> {
    let requests = reads
        .iter()
        .map(|(_, read)| read.clone())
        .collect::<Vec<_>>();
    let bytes = reader.read_chunks(&requests)?;
    ensure!(
        bytes.len() == reads.len(),
        "raw image reader returned an incomplete batch"
    );
    for ((mut chunk, read), bytes) in reads.into_iter().zip(bytes) {
        ensure!(
            bytes.len() == read.length,
            "raw image reader returned a partial chunk at index {}",
            chunk.index
        );
        if bytes.iter().any(|byte| *byte != 0) {
            chunk.raw_sha256 = sha256_bytes_hex(&bytes);
            chunks.push(chunk);
        }
    }
    Ok(())
}

fn validate_virtual_size(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CHUNKED_IMAGE_BYTES {
        bail!(
            "raw image '{}' is not a non-empty bounded regular file",
            path.display()
        );
    }
    Ok(())
}

fn zero_ranges_from_data_extents(
    data_extents: &[Range<u64>],
    virtual_size_bytes: u64,
) -> Vec<Range<u64>> {
    let mut zero_ranges = Vec::new();
    let mut cursor = 0_u64;
    for extent in data_extents {
        if cursor < extent.start {
            zero_ranges.push(cursor..extent.start);
        }
        cursor = cursor.max(extent.end);
    }
    if cursor < virtual_size_bytes {
        zero_ranges.push(cursor..virtual_size_bytes);
    }
    zero_ranges
}

fn normalize_ranges(ranges: &mut Vec<Range<u64>>, virtual_size_bytes: u64) -> Result<()> {
    ranges.sort_by_key(|range| range.start);
    let mut normalized: Vec<Range<u64>> = Vec::with_capacity(ranges.len());
    for range in ranges.drain(..) {
        ensure!(
            range.start < range.end && range.end <= virtual_size_bytes,
            "raw image reader returned an invalid zero extent"
        );
        if let Some(previous) = normalized.last_mut()
            && range.start <= previous.end
        {
            previous.end = previous.end.max(range.end);
        } else {
            normalized.push(range);
        }
    }
    *ranges = normalized;
    Ok(())
}

fn range_is_covered(ranges: &[Range<u64>], start: u64, end: u64) -> bool {
    ranges
        .iter()
        .find(|range| range.end > start)
        .is_some_and(|range| range.start <= start && range.end >= end)
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
    let mut raw = FileImageChunkReader::open(&scan.raw_path)?;
    write_scanned_chunked_image_artifact_from_reader(
        scan,
        &mut raw,
        chunks_dir,
        manifest_path,
        reused,
    )
}

pub(crate) fn write_scanned_chunked_image_artifact_from_reader(
    scan: &ScannedChunkedImage,
    reader: &mut impl ImageChunkReader,
    chunks_dir: &Path,
    manifest_path: &Path,
    reused: &BTreeMap<String, ReusedEncodedImageChunk>,
) -> Result<ChunkedImageArtifact> {
    let _compute = crate::compute::acquire();
    ensure_scan_is_valid(scan, reader.virtual_size_bytes()?)?;
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
    for batch in missing.chunks(MAX_CHUNK_READS_IN_FLIGHT) {
        let reads = batch.iter().map(chunk_read).collect::<Result<Vec<_>>>()?;
        let bytes = reader.read_chunks(&reads)?;
        ensure!(
            bytes.len() == batch.len(),
            "raw image reader returned an incomplete batch"
        );
        let missing = batch
            .iter()
            .cloned()
            .zip(bytes)
            .map(|(chunk, bytes)| {
                ensure!(
                    bytes.len() == chunk.raw_size_bytes as usize,
                    "raw image reader returned a partial chunk at index {}",
                    chunk.index
                );
                Ok((chunk, bytes))
            })
            .collect::<Result<Vec<_>>>()?;
        for compression_batch in missing.chunks(CHUNK_COMPRESSION_WORKERS) {
            for chunk in encode_batch(compression_batch.to_vec(), chunks_dir)? {
                encoded.insert(chunk.raw_sha256.clone(), chunk);
            }
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
        manifest_path: manifest_path.to_path_buf(),
        manifest_sha256,
        manifest,
        chunks,
    })
}

fn ensure_scan_is_valid(scan: &ScannedChunkedImage, virtual_size_bytes: u64) -> Result<()> {
    ensure!(
        virtual_size_bytes == scan.virtual_size_bytes
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

fn chunk_read(chunk: &ScannedImageChunk) -> Result<ImageChunkRead> {
    Ok(ImageChunkRead {
        offset: u64::from(chunk.index)
            .checked_mul(u64::from(IMAGE_CHUNK_SIZE_BYTES))
            .context("image chunk offset overflow")?,
        length: chunk.raw_size_bytes as usize,
    })
}

fn encode_batch(
    batch: Vec<(ScannedImageChunk, Vec<u8>)>,
    chunks_dir: &Path,
) -> Result<Vec<EncodedChunk>> {
    std::thread::scope(|scope| {
        let handles = batch
            .into_iter()
            .map(|(chunk, bytes)| {
                let chunks_dir = chunks_dir.to_path_buf();
                scope.spawn(move || encode_chunk(chunk, bytes, &chunks_dir))
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
    bytes: Vec<u8>,
    chunks_dir: &Path,
) -> Result<EncodedChunk> {
    ensure!(
        bytes.len() == chunk.raw_size_bytes as usize
            && sha256_bytes_hex(&bytes) == chunk.raw_sha256,
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
    hasher: ring::digest::Context,
    bytes: u64,
}

impl<W> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: ring::digest::Context::new(&ring::digest::SHA256),
            bytes: 0,
        }
    }

    fn finish(self) -> (W, String, u64) {
        (
            self.inner,
            intar_image_scenario::hex_digest(self.hasher.finish()),
            self.bytes,
        )
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::{Seek as _, SeekFrom, Write as _};

    use super::*;

    struct MemoryChunkReader {
        bytes: Vec<u8>,
        zero_ranges: Option<Vec<Range<u64>>>,
        reads: Vec<Vec<ImageChunkRead>>,
        fail_reads: bool,
        short_reads: bool,
    }

    impl MemoryChunkReader {
        fn new(bytes: Vec<u8>, zero_ranges: Option<Vec<Range<u64>>>) -> Self {
            Self {
                bytes,
                zero_ranges,
                reads: Vec::new(),
                fail_reads: false,
                short_reads: false,
            }
        }
    }

    impl ImageChunkReader for MemoryChunkReader {
        fn virtual_size_bytes(&mut self) -> Result<u64> {
            Ok(self.bytes.len() as u64)
        }

        fn known_zero_ranges(&mut self) -> Result<Option<Vec<Range<u64>>>> {
            Ok(self.zero_ranges.clone())
        }

        fn read_chunks(&mut self, reads: &[ImageChunkRead]) -> Result<Vec<Vec<u8>>> {
            if self.fail_reads {
                bail!("test reader failed")
            }
            self.reads.push(reads.to_vec());
            reads
                .iter()
                .map(|read| {
                    let start = usize::try_from(read.offset)?;
                    let end = start
                        .checked_add(read.length)
                        .context("test read overflow")?;
                    let mut bytes = self.bytes[start..end].to_vec();
                    if self.short_reads {
                        bytes.pop();
                    }
                    Ok(bytes)
                })
                .collect()
        }
    }

    #[test]
    fn generic_reader_skips_only_complete_known_zero_chunks_and_sorts_descriptors() {
        let chunk_size = IMAGE_CHUNK_SIZE_BYTES as usize;
        let mut bytes = vec![0_u8; chunk_size * 3];
        bytes[chunk_size + 1] = 1;
        bytes[chunk_size * 2 + 3] = 2;
        let mut reader = MemoryChunkReader::new(
            bytes,
            Some(vec![
                0..u64::from(IMAGE_CHUNK_SIZE_BYTES),
                u64::from(IMAGE_CHUNK_SIZE_BYTES)
                    ..u64::from(IMAGE_CHUNK_SIZE_BYTES).saturating_add(1),
            ]),
        );

        let scan = scan_image_chunks(&mut reader, PathBuf::from("memory.raw")).unwrap();

        assert_eq!(
            scan.chunks
                .iter()
                .map(|chunk| chunk.index)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(reader.reads.len(), 1);
        assert_eq!(reader.reads[0].len(), 2);
        assert_eq!(reader.reads[0][0].offset, u64::from(IMAGE_CHUNK_SIZE_BYTES));
        assert_eq!(
            reader.reads[0][1].offset,
            u64::from(IMAGE_CHUNK_SIZE_BYTES) * 2
        );
    }

    #[test]
    fn generic_reader_rejects_partial_or_failed_reads() {
        let mut partial = MemoryChunkReader::new(vec![7_u8; IMAGE_CHUNK_SIZE_BYTES as usize], None);
        partial.short_reads = true;
        let partial_error =
            scan_image_chunks(&mut partial, PathBuf::from("partial.raw")).unwrap_err();
        assert!(format!("{partial_error:#}").contains("partial chunk"));

        let mut failed = MemoryChunkReader::new(vec![7_u8; IMAGE_CHUNK_SIZE_BYTES as usize], None);
        failed.fail_reads = true;
        let failed_error = scan_image_chunks(&mut failed, PathBuf::from("failed.raw")).unwrap_err();
        assert!(format!("{failed_error:#}").contains("test reader failed"));
    }

    #[test]
    fn generic_reader_rechecks_raw_bytes_before_encoding() {
        let temp = tempfile::tempdir().unwrap();
        let mut reader = MemoryChunkReader::new(vec![9_u8; IMAGE_CHUNK_SIZE_BYTES as usize], None);
        let scan = scan_image_chunks(&mut reader, PathBuf::from("memory.raw")).unwrap();
        reader.bytes[0] = 8;

        let error = write_scanned_chunked_image_artifact_from_reader(
            &scan,
            &mut reader,
            &temp.path().join("chunks"),
            &temp.path().join("manifest.json"),
            &BTreeMap::new(),
        )
        .unwrap_err();

        assert!(format!("{error:#}").contains("raw image changed after chunk scan"));
    }

    #[test]
    fn generic_reader_does_not_read_again_when_every_chunk_is_reused() {
        let temp = tempfile::tempdir().unwrap();
        let mut reader = MemoryChunkReader::new(vec![5_u8; IMAGE_CHUNK_SIZE_BYTES as usize], None);
        let scan = scan_image_chunks(&mut reader, PathBuf::from("memory.raw")).unwrap();
        let chunk = scan.chunks[0].clone();
        let reads_after_scan = reader.reads.len();
        reader.fail_reads = true;
        let reused = BTreeMap::from([(
            chunk.raw_sha256.clone(),
            ReusedEncodedImageChunk {
                raw_sha256: chunk.raw_sha256.clone(),
                raw_size_bytes: chunk.raw_size_bytes,
                encoded_sha256: "a".repeat(64),
                encoded_size_bytes: 1,
            },
        )]);

        let artifact = write_scanned_chunked_image_artifact_from_reader(
            &scan,
            &mut reader,
            &temp.path().join("chunks"),
            &temp.path().join("manifest.json"),
            &reused,
        )
        .unwrap();

        assert_eq!(reader.reads.len(), reads_after_scan);
        assert!(artifact.chunks[0].path.is_none());
    }

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
        assert_eq!(
            fs::read_to_string(&manifest_path).unwrap(),
            concat!(
                "{\"schema_version\":1,\"image_id\":\"3ae0e8bd5ec864376ef15abe470777f14cb23f2db6dfd4bf16cf622d1dce4f5f\",",
                "\"virtual_size_bytes\":8388615,\"chunk_size_bytes\":4194304,\"encoding\":\"zstd-v1-level-6\",",
                "\"chunks\":[{\"index\":1,\"raw_size_bytes\":4194304,\"raw_sha256\":\"67d2c808e32117cebe56c7ed5c5ad0e92ffd0ab1099e6c19f6635d6f67b71633\",",
                "\"encoded_size_bytes\":161,\"encoded_sha256\":\"d06e9beb15f1f6d5e7c655ab043cddb43d25415151a78208465f5fa3db7efa65\"},",
                "{\"index\":2,\"raw_size_bytes\":7,\"raw_sha256\":\"9c6b05ffd41a215e1d774b1c999b7770f1b054d080670b81fa2959e3e7e2a18c\",",
                "\"encoded_size_bytes\":20,\"encoded_sha256\":\"6b30afc041019684127fc80883c345aaf5784e7c877b934bde41518484593fb4\"}]}"
            )
        );
        assert_eq!(
            artifact.manifest_sha256,
            "ef3f8eb00ad2ef21748195a70459bb112894d4786b13a728f64e7536c4ecb982"
        );

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
