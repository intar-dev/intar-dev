//! Wire shapes shared by the scenario source compiler (CLI and builder) and
//! the Worker's source routes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Epoch of the `intar.yaml` source compiler output. Bump it whenever the
/// compiled bundle or meta changes for an unchanged repository tree, so the
/// platform compile digest, and with it every git rev, rotates.
pub const SOURCE_COMPILER_VERSION: &str = "intar-source-compiler-v1";

/// OIDC-authenticated push upload of a compiled source bundle.
pub const SOURCE_BUNDLES_PATH: &str = "/registry/v1/sources/bundles";
/// Public descriptor of the CLI release that compiles source bundles.
pub const SOURCE_COMPILER_PATH: &str = "/registry/v1/sources/compiler";
/// Builder prefix. Both routes are fenced on the `attempt` query parameter:
/// - `GET <prefix>/<compile_id>?attempt=<n>` returns the snapshot;
/// - `POST <prefix>/<compile_id>/result?attempt=<n>` takes the result. A
///   success is `multipart/form-data` with the meta and bundle fields, and a
///   failure is an `application/json` `SourceCompileFailureV1` whose
///   `compile_id` and `attempt` match the path and query. The route tells
///   the two apart by `Content-Type`.
pub const AGENT_SOURCES_PATH: &str = "/agent/registry/sources";

/// Multipart field carrying the bundle meta JSON.
pub const SOURCE_META_FIELD: &str = "meta";
/// Multipart field carrying the compiled bundle archive.
pub const SOURCE_BUNDLE_FIELD: &str = "bundle";

/// `p` plus the first 8 hex characters of the sha256 of the three inputs
/// joined by `\n`. The Worker derives the same value, so a builder or CLI
/// with a different format, compiler or base catalog never matches it.
#[must_use]
pub fn platform_compile_digest(
    format_version: &str,
    compiler_version: &str,
    base_images_sha256: &str,
) -> String {
    let hash = Sha256::digest(format!(
        "{format_version}\n{compiler_version}\n{base_images_sha256}"
    ));
    let hex: String = hash[..4].iter().map(|byte| format!("{byte:02x}")).collect();
    format!("p{hex}")
}

/// `meta.source` of a bundle compiled from an `intar.yaml` repository.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BundleSourceV1 {
    pub scope: String,
    pub courses_root: String,
    pub compiler_version: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceRefusalCode {
    CompilerOutdated,
    Superseded,
    Fenced,
    BindingInactive,
    IssuerUnsupported,
}

/// The body of a refusal named by a `SourceRefusalCode`: the Worker's
/// `AppErrorResponseBody` shape, with a mandatory code. Every other non-2xx
/// answer from a source route is a plain `AppErrorResponseBody` whose `code`
/// is absent or outside this enum, so clients decode it leniently and still
/// print its `error`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SourceRefusalV1 {
    pub error: String,
    pub code: SourceRefusalCode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceCompileErrorCode {
    ManifestMissing,
    ManifestInvalid,
    CoursesRootMissing,
    SubmoduleUnsupported,
    LfsUnsupported,
    BundleTooLarge,
    MetaTooLarge,
    TooManyScenarios,
    CompileFailed,
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE_IMAGES_SHA256: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn platform_compile_digest_matches_a_fixed_vector() {
        // printf 'intar-image-build-v17\nintar-source-compiler-v1\n<sha>' | shasum -a 256
        assert_eq!(
            platform_compile_digest(
                "intar-image-build-v17",
                "intar-source-compiler-v1",
                BASE_IMAGES_SHA256
            ),
            "pe845f1ac"
        );
    }

    #[test]
    fn platform_compile_digest_rotates_with_the_compiler_version() {
        let current = platform_compile_digest(
            "intar-image-build-v17",
            SOURCE_COMPILER_VERSION,
            BASE_IMAGES_SHA256,
        );
        let bumped = platform_compile_digest(
            "intar-image-build-v17",
            &format!("{SOURCE_COMPILER_VERSION}-next"),
            BASE_IMAGES_SHA256,
        );
        assert_ne!(current, bumped);
    }
}
