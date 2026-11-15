//! Media types and config shapes of the artifacts in the registry.

pub mod verify;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Bumped with every change to the platform base or to how images are built.
pub const IMAGE_FORMAT: &str = "intar-image-3";
/// `artifactType` of a machine image's manifest.
pub const MACHINE_ARTIFACT_TYPE: &str = "application/vnd.intar.machine.v1";
/// A machine image's config blob, a [`MachineConfigV1`].
pub const MACHINE_CONFIG_MEDIA_TYPE: &str = "application/vnd.intar.machine.config.v1+json";
pub const KERNEL_MEDIA_TYPE: &str = "application/vnd.intar.kernel.v1";
pub const INITRD_MEDIA_TYPE: &str = "application/vnd.intar.initrd.v1";
/// One zstd-compressed chunk of the root disk.
pub const DISK_CHUNK_MEDIA_TYPE: &str = "application/vnd.intar.disk.chunk.v1+zstd";
/// `artifactType` of a Kino manifest; its one layer is the static binary and
/// its config a [`KinoConfigV1`].
pub const KINO_ARTIFACT_TYPE: &str = "application/vnd.intar.kino.v1";
/// A machine spec, stored as a plain blob.
pub const MACHINE_SPEC_MEDIA_TYPE: &str = "application/vnd.intar.machine.spec.v1+json";

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// A SHA-256 as 64 lowercase hex digits. Hosts name files after these, so
/// nothing else parses.
#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(try_from = "String", into = "String")]
#[schemars(extend("pattern" = "^[0-9a-f]{64}$"))]
pub struct Sha256Hex(String);

/// An OCI digest of a blob or manifest: `sha256:` and 64 lowercase hex
/// digits.
#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(try_from = "String", into = "String")]
#[schemars(extend("pattern" = "^sha256:[0-9a-f]{64}$"))]
pub struct OciDigest(String);

impl TryFrom<String> for Sha256Hex {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if is_sha256_hex(&value) {
            Ok(Self(value))
        } else {
            Err("expected 64 lowercase hex digits")
        }
    }
}

impl TryFrom<String> for OciDigest {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.strip_prefix("sha256:").is_some_and(is_sha256_hex) {
            Ok(Self(value))
        } else {
            Err("expected sha256: and 64 lowercase hex digits")
        }
    }
}

impl From<Sha256Hex> for String {
    fn from(value: Sha256Hex) -> Self {
        value.0
    }
}

impl From<OciDigest> for String {
    fn from(value: OciDigest) -> Self {
        value.0
    }
}

impl Sha256Hex {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl OciDigest {
    /// The digest whose hash is `sha256`.
    pub fn from_sha256(sha256: &[u8; 32]) -> Self {
        let hex: String = sha256.iter().map(|byte| format!("{byte:02x}")).collect();
        Self(format!("sha256:{hex}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The hex digits after `sha256:`.
    pub fn hex(&self) -> &str {
        &self.0["sha256:".len()..]
    }
}

/// `mediaType` of every manifest stored here.
pub const OCI_MANIFEST_MEDIA_TYPE: &str = "application/vnd.oci.image.manifest.v1+json";

/// A stored OCI image manifest, exactly as the builder writes it: no
/// annotations, no subject. Its digest is the artifact's identity.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OciManifestV1 {
    #[schemars(range(min = 2, max = 2))]
    pub schema_version: u32,
    pub media_type: String,
    pub artifact_type: String,
    pub config: OciDescriptorV1,
    pub layers: Vec<OciDescriptorV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OciDescriptorV1 {
    pub media_type: String,
    pub digest: OciDigest,
    pub size: u64,
}

/// The config blob of a machine image. The image's identity is its
/// manifest's digest.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MachineConfigV1 {
    pub guest_contract: u32,
    pub image_format: String,
    pub build_key: OciDigest,
    pub boot: MachineBootV1,
    pub disk: MachineDiskV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MachineBootV1 {
    pub cmdline: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MachineDiskV1 {
    pub size_bytes: u64,
    pub chunk_size: u64,
    /// `[chunk_index, layer_index, raw_sha256]`; absent indexes are zero
    /// holes.
    pub chunks: Vec<(u64, u32, Sha256Hex)>,
}

/// The config blob of a Kino manifest.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct KinoConfigV1 {
    pub guest_contract: u32,
    pub version: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine_json() -> serde_json::Value {
        let hex = "a".repeat(64);
        serde_json::json!({
            "guest_contract": 3, "image_format": IMAGE_FORMAT, "build_key": format!("sha256:{hex}"),
            "boot": {"cmdline": "console=hvc0 root=LABEL=INTARROOT"},
            "disk": {"size_bytes": 8_589_934_592_u64, "chunk_size": 4_194_304,
                     "chunks": [[0, 2, hex], [1, 3, hex], [5, 2, hex]]},
        })
    }

    #[test]
    fn machine_config_of_the_design_parses() -> Result<(), serde_json::Error> {
        let json = machine_json();
        let config: MachineConfigV1 = serde_json::from_value(json.clone())?;
        assert_eq!(serde_json::to_value(&config)?, json);
        Ok(())
    }

    #[test]
    fn the_machine_manifest_of_the_design_parses_and_is_strict() -> Result<(), serde_json::Error> {
        let digest = |digit: &str| format!("sha256:{}", digit.repeat(64));
        let json = serde_json::json!({
            "schemaVersion": 2, "mediaType": OCI_MANIFEST_MEDIA_TYPE,
            "artifactType": MACHINE_ARTIFACT_TYPE,
            "config": {"mediaType": MACHINE_CONFIG_MEDIA_TYPE, "digest": digest("c"), "size": 61234},
            "layers": [
                {"mediaType": KERNEL_MEDIA_TYPE, "digest": digest("1"), "size": 11_534_336},
                {"mediaType": INITRD_MEDIA_TYPE, "digest": digest("2"), "size": 3_145_728},
                {"mediaType": DISK_CHUNK_MEDIA_TYPE, "digest": digest("3"), "size": 1_137_000},
            ],
        });
        let manifest: OciManifestV1 = serde_json::from_value(json.clone())?;
        assert_eq!(serde_json::to_value(&manifest)?, json);
        let mut annotated = json;
        annotated["annotations"] = serde_json::json!({});
        assert!(serde_json::from_value::<OciManifestV1>(annotated).is_err());
        Ok(())
    }

    #[test]
    fn digests_refuse_anything_but_lowercase_hex() {
        for bad in ["../x", "sha256:../x", &"A".repeat(64), &"a".repeat(63)] {
            let mut json = machine_json();
            json["disk"]["chunks"][0][2] = bad.into();
            assert!(
                serde_json::from_value::<MachineConfigV1>(json).is_err(),
                "{bad}"
            );
            let mut json = machine_json();
            json["build_key"] = bad.into();
            assert!(
                serde_json::from_value::<MachineConfigV1>(json).is_err(),
                "{bad}"
            );
        }
        let schema =
            serde_json::to_value(schemars::schema_for!(MachineConfigV1)).unwrap_or_default();
        assert_eq!(schema["$defs"]["Sha256Hex"]["pattern"], "^[0-9a-f]{64}$");
        assert_eq!(
            schema["$defs"]["OciDigest"]["pattern"],
            "^sha256:[0-9a-f]{64}$"
        );
    }
}
