use std::fs;
use std::io::{self, Read};
use std::path::Path;

use anyhow::{Context as _, Result};
use ring::digest;

const FILE_BUFFER_BYTES: usize = 1024 * 1024;

pub(crate) fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Return the SHA-256 hex digest for a file.
///
/// # Errors
/// Returns an error if the file cannot be read.
pub fn sha256_file_hex(path: &Path) -> Result<String> {
    let mut file =
        fs::File::open(path).with_context(|| format!("failed to open '{}'", path.display()))?;
    sha256_reader_hex(&mut file).with_context(|| format!("failed to read '{}'", path.display()))
}

/// One field of a key: name, NUL, length as 8 little-endian bytes, value,
/// 0xff.
pub(crate) fn hash_field(hasher: &mut sha2::Sha256, key: &str, value: &[u8]) {
    use sha2::Digest as _;
    hasher.update(key.as_bytes());
    hasher.update([0]);
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
    hasher.update([0xff]);
}

pub(crate) fn sha256_bytes_hex(bytes: &[u8]) -> String {
    hex_digest(digest::digest(&digest::SHA256, bytes).as_ref())
}

pub(crate) fn sha256_reader_hex(mut reader: impl Read) -> io::Result<String> {
    let mut hasher = digest::Context::new(&digest::SHA256);
    let mut buffer = vec![0_u8; FILE_BUFFER_BYTES];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(hex_digest(hasher.finish()));
        }
        hasher.update(&buffer[..count]);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Cursor;

    use super::{sha256_bytes_hex, sha256_file_hex, sha256_reader_hex};

    #[test]
    fn emits_the_standard_sha256_digest_for_bytes_and_reader_inputs() {
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert_eq!(sha256_bytes_hex(b"hello world"), expected);
        assert_eq!(
            sha256_reader_hex(Cursor::new(b"hello world")).unwrap(),
            expected
        );
    }

    #[test]
    fn file_digest_remains_sha256() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("payload");
        std::fs::write(&path, b"abc").unwrap();

        assert_eq!(
            sha256_file_hex(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
