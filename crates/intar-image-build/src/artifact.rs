use std::fs;
use std::io::Read as _;
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
        std::io::copy(&mut raw, &mut encoder).context("failed to compress raw image")?;
        encoder.finish().context("failed to finish zstd image")?;

        let sha256_hex = sha256_file_hex(compressed_path)?;
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

/// Return the SHA-256 hex digest for a file.
///
/// # Errors
/// Returns an error if the file cannot be read.
pub fn sha256_file_hex(path: &Path) -> Result<String> {
    let mut file =
        fs::File::open(path).with_context(|| format!("failed to open '{}'", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Read as _;

    use super::write_raw_zstd_artifact;

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
    fn write_failure_removes_partial_outputs() {
        let temp = tempfile::tempdir().unwrap();
        let raw_path = temp.path().join("root.raw");
        let compressed_path = temp.path().join("root.raw.zst");
        let checksum_path = temp.path().join("checksum-directory");
        std::fs::write(&raw_path, b"raw image").unwrap();
        std::fs::create_dir(&checksum_path).unwrap();

        let error =
            write_raw_zstd_artifact(&raw_path, &compressed_path, &checksum_path).unwrap_err();

        assert!(error.to_string().contains("failed to write checksum"));
        assert!(!compressed_path.exists());
        assert!(checksum_path.is_dir());
        assert!(raw_path.exists());
    }
}
