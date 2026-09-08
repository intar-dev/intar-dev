use std::io::{self, Read};

use intar_image_scenario::hex_digest;
use ring::digest;

const FILE_BUFFER_BYTES: usize = 1024 * 1024;

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

    use super::{sha256_bytes_hex, sha256_reader_hex};

    #[test]
    fn emits_the_standard_sha256_digest_for_bytes_and_reader_inputs() {
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert_eq!(sha256_bytes_hex(b"hello world"), expected);
        assert_eq!(
            sha256_reader_hex(Cursor::new(b"hello world")).unwrap(),
            expected
        );
    }
}
