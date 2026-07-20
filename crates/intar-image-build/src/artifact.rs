use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct RawZstdArtifact {
    pub raw_path: PathBuf,
    pub compressed_path: PathBuf,
    pub sha256_path: PathBuf,
    pub sha256_hex: String,
    pub virtual_size_bytes: u64,
}

pub fn write_raw_zstd_artifact(
    raw_path: &Path,
    compressed_path: &Path,
    sha256_path: &Path,
) -> Result<RawZstdArtifact> {
    write_raw_zstd_artifact_with_cancel(raw_path, compressed_path, sha256_path, || false)
}

/// Write a raw-zstd artifact while periodically checking whether the caller
/// has cancelled the operation. Partial compressed and checksum files are
/// removed before a cancellation or other write failure is returned.
pub fn write_raw_zstd_artifact_with_cancel(
    raw_path: &Path,
    compressed_path: &Path,
    sha256_path: &Path,
    is_cancelled: impl Fn() -> bool,
) -> Result<RawZstdArtifact> {
    check_cancelled(&is_cancelled)?;
    let raw_metadata = fs::symlink_metadata(raw_path)
        .with_context(|| format!("failed to stat raw image '{}'", raw_path.display()))?;
    if !raw_metadata.is_file() {
        bail!("raw image '{}' is not a regular file", raw_path.display());
    }
    let virtual_size_bytes = raw_metadata.len();
    if virtual_size_bytes == 0 {
        bail!("raw image '{}' is empty", raw_path.display());
    }

    if let Some(parent) = compressed_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create compressed artifact directory '{}'",
                parent.display()
            )
        })?;
    }
    if let Some(parent) = sha256_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!("failed to create checksum directory '{}'", parent.display())
        })?;
    }

    let result = (|| {
        let mut raw = fs::File::open(raw_path)
            .with_context(|| format!("failed to open raw image '{}'", raw_path.display()))?;
        let compressed = fs::File::create(compressed_path).with_context(|| {
            format!(
                "failed to create compressed image '{}'",
                compressed_path.display()
            )
        })?;
        let mut encoder =
            zstd::stream::Encoder::new(compressed, 15).context("failed to create zstd encoder")?;
        encoder
            .include_checksum(true)
            .context("failed to enable zstd frame checksum")?;
        encoder
            .include_contentsize(true)
            .context("failed to enable zstd content size")?;
        encoder
            .set_pledged_src_size(Some(virtual_size_bytes))
            .context("failed to set zstd pledged source size")?;
        copy_with_buffer(&mut raw, &mut encoder, &is_cancelled)?;
        check_cancelled(&is_cancelled)?;
        encoder.finish().context("failed to finish zstd image")?;

        let sha256_hex = sha256_file_hex_with_cancel(compressed_path, &is_cancelled)?;
        check_cancelled(&is_cancelled)?;
        fs::write(
            sha256_path,
            format!(
                "{sha256_hex}  {}\n",
                compressed_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("image.raw.zst")
            ),
        )
        .with_context(|| format!("failed to write checksum '{}'", sha256_path.display()))?;
        Ok(sha256_hex)
    })();
    let sha256_hex = match result {
        Ok(sha256_hex) => sha256_hex,
        Err(error) => {
            let _ = fs::remove_file(compressed_path);
            let _ = fs::remove_file(sha256_path);
            return Err(error);
        }
    };

    Ok(RawZstdArtifact {
        raw_path: raw_path.to_path_buf(),
        compressed_path: compressed_path.to_path_buf(),
        sha256_path: sha256_path.to_path_buf(),
        sha256_hex,
        virtual_size_bytes,
    })
}

/// Expand a raw-zstd image while preserving zero runs as sparse file holes and
/// enforcing the advertised virtual size. Returns the SHA-256 of the expanded
/// raw bytes.
pub fn expand_raw_zstd_sparse(
    compressed_path: &Path,
    raw_path: &Path,
    virtual_size_bytes: u64,
) -> Result<String> {
    expand_raw_zstd_sparse_with_cancel(compressed_path, raw_path, virtual_size_bytes, || false)
}

/// Expand a raw-zstd image while periodically checking whether the caller has
/// cancelled the operation. Any partially expanded raw file is removed.
pub fn expand_raw_zstd_sparse_with_cancel(
    compressed_path: &Path,
    raw_path: &Path,
    virtual_size_bytes: u64,
    is_cancelled: impl Fn() -> bool,
) -> Result<String> {
    check_cancelled(&is_cancelled)?;
    if virtual_size_bytes == 0 {
        bail!("advertised raw-zstd virtual size is zero");
    }
    let input = fs::File::open(compressed_path)
        .with_context(|| format!("failed to open '{}'", compressed_path.display()))?;
    let mut decoder = zstd::stream::read::Decoder::new(input)
        .with_context(|| format!("failed to open zstd stream '{}'", compressed_path.display()))?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(raw_path)
        .with_context(|| format!("failed to create '{}'", raw_path.display()))?;

    let result = (|| {
        let mut written = 0_u64;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            check_cancelled(&is_cancelled)?;
            let read = decoder
                .read(&mut buffer)
                .with_context(|| format!("failed to decompress '{}'", compressed_path.display()))?;
            if read == 0 {
                break;
            }
            written = written
                .checked_add(u64::try_from(read).context("decompressed chunk size overflow")?)
                .context("decompressed image size overflow")?;
            if written > virtual_size_bytes {
                bail!(
                    "decompressed image '{}' exceeds advertised virtual size: {written} > {virtual_size_bytes}",
                    compressed_path.display()
                );
            }
            hasher.update(&buffer[..read]);
            if buffer[..read].iter().all(|byte| *byte == 0) {
                output
                    .seek(SeekFrom::Current(
                        i64::try_from(read).context("sparse seek overflow")?,
                    ))
                    .with_context(|| format!("failed to seek '{}'", raw_path.display()))?;
            } else {
                output
                    .write_all(&buffer[..read])
                    .with_context(|| format!("failed to write '{}'", raw_path.display()))?;
            }
        }
        if written != virtual_size_bytes {
            bail!(
                "decompressed image '{}' size does not match advertised virtual size: {written} != {virtual_size_bytes}",
                compressed_path.display()
            );
        }
        output
            .set_len(virtual_size_bytes)
            .with_context(|| format!("failed to size '{}'", raw_path.display()))?;
        output
            .sync_all()
            .with_context(|| format!("failed to sync '{}'", raw_path.display()))?;
        Ok(hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    })();
    if result.is_err() {
        drop(output);
        let _ = fs::remove_file(raw_path);
    }
    result
}

fn copy_with_buffer(
    reader: &mut fs::File,
    writer: &mut zstd::stream::Encoder<'_, fs::File>,
    is_cancelled: &impl Fn() -> bool,
) -> Result<()> {
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        check_cancelled(is_cancelled)?;
        let read = reader
            .read(&mut buffer)
            .context("failed to read raw image")?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .context("failed to write compressed image")?;
    }
    Ok(())
}

/// Return the SHA-256 hex digest for a file.
///
/// # Errors
/// Returns an error if the file cannot be read.
pub fn sha256_file_hex(path: &Path) -> Result<String> {
    sha256_file_hex_with_cancel(path, &|| false)
}

fn sha256_file_hex_with_cancel(path: &Path, is_cancelled: &impl Fn() -> bool) -> Result<String> {
    let mut file =
        fs::File::open(path).with_context(|| format!("failed to open '{}'", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        check_cancelled(is_cancelled)?;
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("failed to read '{}'", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn check_cancelled(is_cancelled: &impl Fn() -> bool) -> Result<()> {
    if is_cancelled() {
        bail!("raw-zstd artifact operation cancelled");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Read as _;

    use std::cell::Cell;

    use super::{
        expand_raw_zstd_sparse, expand_raw_zstd_sparse_with_cancel, write_raw_zstd_artifact,
        write_raw_zstd_artifact_with_cancel,
    };

    #[test]
    fn raw_zstd_artifact_round_trips_and_hashes_compressed_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let raw_path = temp.path().join("root.raw");
        let compressed_path = temp.path().join("root.raw.zst");
        let checksum_path = temp.path().join("root.raw.zst.sha256");
        let mut raw_bytes = vec![0; 2 * 1024 * 1024];
        raw_bytes[4096..4104].copy_from_slice(b"INTARIMG");
        std::fs::write(&raw_path, &raw_bytes).unwrap();

        let artifact =
            write_raw_zstd_artifact(&raw_path, &compressed_path, &checksum_path).unwrap();

        assert_eq!(artifact.raw_path, raw_path);
        assert_eq!(artifact.compressed_path, compressed_path);
        assert_eq!(artifact.sha256_path, checksum_path);
        assert_eq!(artifact.sha256_hex.len(), 64);
        assert_eq!(artifact.virtual_size_bytes, raw_bytes.len() as u64);
        let checksum = std::fs::read_to_string(&artifact.sha256_path).unwrap();
        assert!(checksum.contains("root.raw.zst"));
        assert!(checksum.starts_with(&artifact.sha256_hex));

        let mut decoder =
            zstd::stream::Decoder::new(std::fs::File::open(&artifact.compressed_path).unwrap())
                .unwrap();
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(decompressed, raw_bytes);
    }

    #[test]
    fn raw_zstd_artifact_rejects_empty_raw_image() {
        let temp = tempfile::tempdir().unwrap();
        let raw_path = temp.path().join("root.raw");
        let compressed_path = temp.path().join("root.raw.zst");
        let checksum_path = temp.path().join("root.raw.zst.sha256");
        std::fs::write(&raw_path, []).unwrap();

        let error =
            write_raw_zstd_artifact(&raw_path, &compressed_path, &checksum_path).unwrap_err();

        assert!(format!("{error:#}").contains("is empty"));
        assert!(!compressed_path.exists());
        assert!(!checksum_path.exists());
    }

    #[test]
    fn sparse_expansion_round_trips_and_rejects_wrong_size() {
        let temp = tempfile::tempdir().unwrap();
        let compressed = temp.path().join("root.raw.zst");
        let expanded = temp.path().join("root.raw");
        let bytes = [
            vec![0_u8; 128 * 1024],
            b"payload".to_vec(),
            vec![0_u8; 128 * 1024],
        ]
        .concat();
        std::fs::write(&compressed, zstd::encode_all(bytes.as_slice(), 0).unwrap()).unwrap();

        let digest = expand_raw_zstd_sparse(&compressed, &expanded, bytes.len() as u64).unwrap();
        assert_eq!(std::fs::read(&expanded).unwrap(), bytes);
        assert_eq!(digest.len(), 64);

        let wrong = temp.path().join("wrong.raw");
        let error = expand_raw_zstd_sparse(&compressed, &wrong, 1024).unwrap_err();
        assert!(error.to_string().contains("advertised virtual size"));
        assert!(!wrong.exists());
    }

    #[test]
    fn cancelled_compression_removes_partial_outputs() {
        let temp = tempfile::tempdir().unwrap();
        let raw_path = temp.path().join("root.raw");
        let compressed_path = temp.path().join("root.raw.zst");
        let checksum_path = temp.path().join("root.raw.zst.sha256");
        std::fs::write(&raw_path, vec![7_u8; 3 * 1024 * 1024]).unwrap();
        let checks = Cell::new(0_u8);

        let error = write_raw_zstd_artifact_with_cancel(
            &raw_path,
            &compressed_path,
            &checksum_path,
            || {
                checks.set(checks.get().saturating_add(1));
                checks.get() >= 3
            },
        )
        .unwrap_err();

        assert!(error.to_string().contains("cancelled"));
        assert!(!compressed_path.exists());
        assert!(!checksum_path.exists());
        assert!(raw_path.exists());
    }

    #[test]
    fn cancelled_expansion_removes_partial_raw_file() {
        let temp = tempfile::tempdir().unwrap();
        let compressed = temp.path().join("root.raw.zst");
        let expanded = temp.path().join("root.raw");
        let bytes = vec![9_u8; 512 * 1024];
        std::fs::write(&compressed, zstd::encode_all(bytes.as_slice(), 0).unwrap()).unwrap();
        let checks = Cell::new(0_u8);

        let error =
            expand_raw_zstd_sparse_with_cancel(&compressed, &expanded, bytes.len() as u64, || {
                checks.set(checks.get().saturating_add(1));
                checks.get() >= 3
            })
            .unwrap_err();

        assert!(error.to_string().contains("cancelled"));
        assert!(!expanded.exists());
        assert!(compressed.exists());
    }
}
