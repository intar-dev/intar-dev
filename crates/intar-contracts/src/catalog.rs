use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use thiserror::Error;

pub const IMAGE_CHUNK_MANIFEST_SCHEMA_VERSION: u16 = 1;
pub const IMAGE_CHUNK_SIZE_BYTES: u32 = 4 * 1024 * 1024;
pub const IMAGE_CHUNK_ENCODING: &str = "zstd-v1-level-6";
pub const MAX_CHUNKED_IMAGE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
pub const GUEST_BOOTSTRAP_ABI_V1: u16 = 1;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageArchitecture {
    X86_64,
    Aarch64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ImageKey {
    pub scenario: String,
    pub vm: String,
    pub arch: ImageArchitecture,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Mib(pub u32);

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbePhase {
    Boot,
    Scenario,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioDifficulty {
    Easy,
    Medium,
    Hard,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioHintManifestV3 {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body_markdown: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioManifestV4 {
    #[schemars(range(min = 4, max = 4))]
    pub schema_version: u16,
    pub scenario_id: String,
    pub name: String,
    pub title: String,
    pub category: String,
    pub description: String,
    pub difficulty: ScenarioDifficulty,
    pub estimated_minutes: u32,
    pub tags: Vec<String>,
    pub briefing_markdown: String,
    pub solution_markdown: String,
    pub hints: Vec<ScenarioHintManifestV3>,
    pub vms: Vec<ScenarioVmManifestV4>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioVmManifestV4 {
    pub name: String,
    pub image_key: ImageKey,
    pub image_id: String,
    pub image_format: ImageFormat,
    pub image_virtual_size_bytes: u64,
    pub chunk_manifest_sha256: String,
    pub guest_bootstrap_abi: u16,
    pub boot: ScenarioVmBootManifestV4,
    #[schemars(range(min = 1))]
    pub cpu_millis: u32,
    #[schemars(range(min = 1))]
    pub vcpu_count: u16,
    pub memory_mib: Mib,
    pub disk_mib: Mib,
    pub probes: Vec<ScenarioProbeManifestV3>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    RawChunksV1,
    /// Seven-day rollback compatibility. Scenario manifest v4 publication
    /// rejects this format; older retained catalog revisions may still carry
    /// it during the flag-day rollback window.
    RawZstd,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioVmBootManifestV4 {
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub cmdline: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageChunkManifestV1 {
    #[schemars(range(min = 1, max = 1))]
    pub schema_version: u16,
    pub image_id: String,
    pub virtual_size_bytes: u64,
    pub chunk_size_bytes: u32,
    pub encoding: String,
    /// Non-zero chunks in strictly increasing logical-index order. Omitted
    /// indexes are sparse zero chunks.
    pub chunks: Vec<ImageChunkV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageChunkV1 {
    pub index: u32,
    pub raw_size_bytes: u32,
    pub raw_sha256: String,
    pub encoded_size_bytes: u64,
    pub encoded_sha256: String,
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ImageChunkManifestError {
    #[error("unsupported image chunk manifest schema version")]
    UnsupportedSchema,
    #[error("unsupported image chunk size")]
    UnsupportedChunkSize,
    #[error("unsupported image chunk encoding")]
    UnsupportedEncoding,
    #[error("chunked image virtual size is invalid")]
    InvalidVirtualSize,
    #[error("chunk index is duplicated, out of order, or out of range")]
    InvalidChunkIndex,
    #[error("chunk raw size does not match its logical position")]
    InvalidChunkRawSize,
    #[error("chunk encoded size is invalid")]
    InvalidChunkEncodedSize,
    #[error("chunk digest is not lowercase SHA-256")]
    InvalidChunkDigest,
    #[error("chunked image identity does not match its logical chunks")]
    InvalidImageId,
}

impl ImageChunkManifestV1 {
    pub fn validate(&self) -> Result<(), ImageChunkManifestError> {
        if self.schema_version != IMAGE_CHUNK_MANIFEST_SCHEMA_VERSION {
            return Err(ImageChunkManifestError::UnsupportedSchema);
        }
        if self.chunk_size_bytes != IMAGE_CHUNK_SIZE_BYTES {
            return Err(ImageChunkManifestError::UnsupportedChunkSize);
        }
        if self.encoding != IMAGE_CHUNK_ENCODING {
            return Err(ImageChunkManifestError::UnsupportedEncoding);
        }
        if self.virtual_size_bytes == 0 || self.virtual_size_bytes > MAX_CHUNKED_IMAGE_BYTES {
            return Err(ImageChunkManifestError::InvalidVirtualSize);
        }
        if !is_sha256_hex(&self.image_id) {
            return Err(ImageChunkManifestError::InvalidImageId);
        }

        let chunk_count = self.chunk_count();
        let mut previous = None;
        for chunk in &self.chunks {
            if chunk.index >= chunk_count || previous.is_some_and(|value| chunk.index <= value) {
                return Err(ImageChunkManifestError::InvalidChunkIndex);
            }
            previous = Some(chunk.index);
            if chunk.raw_size_bytes != self.raw_size_for_index(chunk.index) {
                return Err(ImageChunkManifestError::InvalidChunkRawSize);
            }
            if chunk.encoded_size_bytes == 0
                || chunk.encoded_size_bytes > u64::from(IMAGE_CHUNK_SIZE_BYTES) * 2
            {
                return Err(ImageChunkManifestError::InvalidChunkEncodedSize);
            }
            if !is_sha256_hex(&chunk.raw_sha256) || !is_sha256_hex(&chunk.encoded_sha256) {
                return Err(ImageChunkManifestError::InvalidChunkDigest);
            }
        }
        if self.compute_image_id()? != self.image_id {
            return Err(ImageChunkManifestError::InvalidImageId);
        }
        Ok(())
    }

    #[must_use]
    pub fn chunk_count(&self) -> u32 {
        let count = self
            .virtual_size_bytes
            .div_ceil(u64::from(IMAGE_CHUNK_SIZE_BYTES));
        count.min(u64::from(u32::MAX)) as u32
    }

    #[must_use]
    pub fn raw_size_for_index(&self, index: u32) -> u32 {
        let offset = u64::from(index) * u64::from(IMAGE_CHUNK_SIZE_BYTES);
        self.virtual_size_bytes
            .saturating_sub(offset)
            .min(u64::from(IMAGE_CHUNK_SIZE_BYTES)) as u32
    }

    pub fn compute_image_id(&self) -> Result<String, ImageChunkManifestError> {
        let mut non_zero = self.chunks.iter().peekable();
        let mut hasher = Sha256::new();
        hasher.update(b"intar-raw-chunks-v1\0");
        hasher.update(self.virtual_size_bytes.to_le_bytes());
        hasher.update(self.chunk_size_bytes.to_le_bytes());
        for index in 0..self.chunk_count() {
            let raw_size = self.raw_size_for_index(index);
            let digest = if non_zero.peek().is_some_and(|chunk| chunk.index == index) {
                let Some(chunk) = non_zero.next() else {
                    return Err(ImageChunkManifestError::InvalidChunkIndex);
                };
                decode_sha256(&chunk.raw_sha256)?
            } else {
                zero_chunk_sha256(raw_size)
            };
            hasher.update(index.to_le_bytes());
            hasher.update(raw_size.to_le_bytes());
            hasher.update(digest);
        }
        Ok(hex_digest(hasher.finalize()))
    }
}

fn zero_chunk_sha256(raw_size: u32) -> [u8; 32] {
    let mut hasher = Sha256::new();
    let zeros = [0_u8; 64 * 1024];
    let mut remaining = raw_size;
    while remaining > 0 {
        let length = remaining.min(zeros.len() as u32);
        hasher.update(&zeros[..length as usize]);
        remaining -= length;
    }
    hasher.finalize().into()
}

fn decode_sha256(value: &str) -> Result<[u8; 32], ImageChunkManifestError> {
    if !is_sha256_hex(value) {
        return Err(ImageChunkManifestError::InvalidChunkDigest);
    }
    let mut output = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = (hex_nibble(pair[0]) << 4) | hex_nibble(pair[1]);
    }
    Ok(output)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn hex_nibble(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        _ => unreachable!("validated lowercase hex"),
    }
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScenarioProbeManifestV3 {
    pub id: String,
    pub phase: ProbePhase,
    pub kind: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_markdown: Option<String>,
    pub hints: Vec<ScenarioHintManifestV3>,
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn sha256(bytes: &[u8]) -> String {
        hex_digest(Sha256::digest(bytes))
    }

    fn valid_manifest() -> ImageChunkManifestV1 {
        let raw = b"end";
        let mut manifest = ImageChunkManifestV1 {
            schema_version: IMAGE_CHUNK_MANIFEST_SCHEMA_VERSION,
            image_id: "0".repeat(64),
            virtual_size_bytes: u64::from(IMAGE_CHUNK_SIZE_BYTES) + raw.len() as u64,
            chunk_size_bytes: IMAGE_CHUNK_SIZE_BYTES,
            encoding: IMAGE_CHUNK_ENCODING.to_owned(),
            chunks: vec![ImageChunkV1 {
                index: 1,
                raw_size_bytes: raw.len() as u32,
                raw_sha256: sha256(raw),
                encoded_size_bytes: 12,
                encoded_sha256: sha256(b"encoded"),
            }],
        };
        manifest.image_id = manifest.compute_image_id().unwrap();
        manifest
    }

    #[test]
    fn chunk_manifest_validates_sparse_zero_chunks_and_short_tail() {
        let manifest = valid_manifest();
        assert_eq!(manifest.chunk_count(), 2);
        assert_eq!(manifest.raw_size_for_index(0), IMAGE_CHUNK_SIZE_BYTES);
        assert_eq!(manifest.raw_size_for_index(1), 3);
        assert_eq!(manifest.validate(), Ok(()));
    }

    #[test]
    fn chunk_manifest_rejects_duplicate_and_out_of_order_indexes() {
        let mut manifest = valid_manifest();
        manifest.chunks.insert(0, manifest.chunks[0].clone());
        assert_eq!(
            manifest.validate(),
            Err(ImageChunkManifestError::InvalidChunkIndex)
        );
    }

    #[test]
    fn chunk_manifest_rejects_wrong_sizes_hashes_and_identity() {
        let mut wrong_size = valid_manifest();
        wrong_size.chunks[0].raw_size_bytes = 2;
        assert_eq!(
            wrong_size.validate(),
            Err(ImageChunkManifestError::InvalidChunkRawSize)
        );

        let mut wrong_hash = valid_manifest();
        wrong_hash.chunks[0].raw_sha256 = "A".repeat(64);
        assert_eq!(
            wrong_hash.validate(),
            Err(ImageChunkManifestError::InvalidChunkDigest)
        );

        let mut wrong_id = valid_manifest();
        wrong_id.image_id = "f".repeat(64);
        assert_eq!(
            wrong_id.validate(),
            Err(ImageChunkManifestError::InvalidImageId)
        );
    }

    #[test]
    fn chunked_image_size_is_bounded() {
        let mut manifest = valid_manifest();
        manifest.virtual_size_bytes = MAX_CHUNKED_IMAGE_BYTES + 1;
        assert_eq!(
            manifest.validate(),
            Err(ImageChunkManifestError::InvalidVirtualSize)
        );
    }
}
