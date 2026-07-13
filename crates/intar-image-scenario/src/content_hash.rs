//! Pure content-hash core shared by the build pipeline (which walks the
//! scenario directory on disk) and the wasm authoring validator (which is
//! handed in-memory file entries). Both must produce byte-identical hashes.

use sha2::{Digest, Sha256};

use crate::ScenarioError;

pub const BUILD_FORMAT_VERSION: &str = "intar-image-build-v2";

#[derive(Debug, Clone)]
pub struct ScenarioContentHashParams<'a> {
    pub scenario_id: &'a str,
    pub base_definition: &'a str,
    pub kino_version: &'a str,
    pub target_arch: &'a str,
}

/// Hash a scenario from in-memory `(relative_path, bytes)` entries. Paths are
/// `/`-separated, relative to the scenario directory; entries are sorted here
/// so callers don't need to pre-sort.
pub fn scenario_content_hash_from_entries(
    params: &ScenarioContentHashParams<'_>,
    entries: &[(String, Vec<u8>)],
) -> Result<String, ScenarioError> {
    if params.scenario_id.trim().is_empty() {
        return Err(ScenarioError::InvalidScenario(
            "scenario_id is required".to_string(),
        ));
    }

    let mut normalized: Vec<(String, &[u8])> = entries
        .iter()
        .map(|(path, bytes)| Ok((normalize_relative_path(path)?, bytes.as_slice())))
        .collect::<Result<_, ScenarioError>>()?;
    normalized.sort_by(|left, right| left.0.cmp(&right.0));

    let mut hasher = Sha256::new();
    hash_field(&mut hasher, "format", BUILD_FORMAT_VERSION.as_bytes());
    hash_field(&mut hasher, "scenario_id", params.scenario_id.as_bytes());
    hash_field(
        &mut hasher,
        "base_definition",
        params.base_definition.as_bytes(),
    );
    hash_field(&mut hasher, "kino_version", params.kino_version.as_bytes());
    hash_field(&mut hasher, "target_arch", params.target_arch.as_bytes());

    for (path, bytes) in normalized {
        let normalized_path = format!("scenarios/{}/{}", params.scenario_id.trim(), path);
        hash_field(&mut hasher, "file_path", normalized_path.as_bytes());
        hash_field(&mut hasher, "file_bytes", bytes);
    }

    Ok(hex_digest(hasher.finalize()))
}

#[must_use]
pub fn sha256_bytes_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_digest(hasher.finalize())
}

/// Normalize a `/`-separated relative path: strips `.` segments, rejects
/// empty paths, absolute paths, `..`, and backslashes. Mirrors the
/// `std::path::Component`-based normalization used on the fs side.
pub fn normalize_relative_path(path: &str) -> Result<String, ScenarioError> {
    if path.contains('\\') {
        return Err(ScenarioError::InvalidScenario(format!(
            "scenario path '{path}' contains unsupported component"
        )));
    }
    let mut parts = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                return Err(ScenarioError::InvalidScenario(format!(
                    "scenario path '{path}' contains unsupported component"
                )));
            }
            value => parts.push(value.to_string()),
        }
    }
    if parts.is_empty() {
        return Err(ScenarioError::InvalidScenario(
            "scenario file path is empty".to_string(),
        ));
    }
    Ok(parts.join("/"))
}

pub fn hash_field(hasher: &mut Sha256, key: &str, value: &[u8]) {
    hasher.update(key.as_bytes());
    hasher.update([0]);
    // Explicit u64: usize::to_le_bytes() is 4 bytes on wasm32 but 8 on
    // x86_64, which made the hash architecture-dependent. u64 matches the
    // bytes every 64-bit native build has always produced.
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
    hasher.update([0xff]);
}

#[must_use]
pub fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::{
        ScenarioContentHashParams, normalize_relative_path, scenario_content_hash_from_entries,
    };

    fn params() -> ScenarioContentHashParams<'static> {
        ScenarioContentHashParams {
            scenario_id: "demo",
            base_definition: "base-def",
            kino_version: "1.2.3",
            target_arch: "amd64",
        }
    }

    #[test]
    fn hash_is_order_independent() {
        let a = scenario_content_hash_from_entries(
            &params(),
            &[
                ("b.txt".to_string(), b"bee".to_vec()),
                ("a.txt".to_string(), b"aye".to_vec()),
            ],
        )
        .unwrap();
        let b = scenario_content_hash_from_entries(
            &params(),
            &[
                ("a.txt".to_string(), b"aye".to_vec()),
                ("b.txt".to_string(), b"bee".to_vec()),
            ],
        )
        .unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn hash_changes_with_content() {
        let a = scenario_content_hash_from_entries(
            &params(),
            &[("a.txt".to_string(), b"one".to_vec())],
        )
        .unwrap();
        let b = scenario_content_hash_from_entries(
            &params(),
            &[("a.txt".to_string(), b"two".to_vec())],
        )
        .unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_traversal_and_empty_paths() {
        assert!(normalize_relative_path("../evil").is_err());
        assert!(normalize_relative_path("").is_err());
        assert!(normalize_relative_path("ok/./fine.txt").is_ok());
        assert!(normalize_relative_path("win\\path").is_err());
    }
}
