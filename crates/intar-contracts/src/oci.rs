//! Media types and config shapes of the artifacts in the registry.
//!
//! A wake image is a machine image whose manifest also carries a suspended
//! guest: the RAM file of a base, a pack's delta against it, the stub that
//! jumps to the guest's wake vector, and the CPU profile the base was built
//! under. A puller that cannot wake skips these layers and cold-boots.

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

/// One zstd-compressed chunk of a base's RAM file.
pub const WAKE_RAM_CHUNK_MEDIA_TYPE: &str = "application/vnd.intar.wake.ram.chunk.v1+zstd";
/// A pack's RAM file as an `intar-snapdelta` delta against its base's, or
/// one part of it when the delta is over the blob size limit. Parts are
/// concatenated in layer order.
pub const WAKE_DELTA_MEDIA_TYPE: &str = "application/vnd.intar.wake.delta.v1";
/// The wake stub of a base, given to the VMM as the kernel.
pub const WAKE_STUB_MEDIA_TYPE: &str = "application/vnd.intar.wake.stub.v1";
/// The cloud-hypervisor CPU profile a base was built under.
pub const WAKE_CPU_PROFILE_MEDIA_TYPE: &str = "application/vnd.intar.wake.cpu-profile.v1+json";

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
    /// Set when the manifest also carries a suspended guest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake: Option<WakeV1>,
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

/// The `wake` object of a machine config.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WakeV1 {
    /// The base's RAM file. A pack repeats its base's value, so a host needs
    /// no other manifest to assemble it.
    pub ram: WakeRamV1,
    /// Set on a pack, absent on a base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<WakePackV1>,
    pub shape: WakeShapeV1,
    /// The CPU profile layer. A host wakes the image only when it knows a
    /// profile with this digest and its KVM offers what that profile needs.
    pub cpu_profile: OciDigest,
    pub vmm: WakeVmmV1,
    /// When the base was cold-booted, carried unchanged into every pack.
    /// The guest's certificates date from that boot.
    pub booted_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WakeRamV1 {
    pub size_bytes: u64,
    pub chunk_size: u64,
    /// `[chunk_index, layer_index, raw_sha256]`; absent indexes are zero
    /// holes.
    pub chunks: Vec<(u64, u32, Sha256Hex)>,
    /// SHA-256 of the assembled file, checked once per host.
    pub sha256: Sha256Hex,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WakePackV1 {
    /// Manifest digest of the base the delta applies to. It is a check, not
    /// a reference to fetch: the pack's manifest lists the base's layers.
    pub base: OciDigest,
    /// SHA-256 of the RAM file rebuilt from the base's and the delta. The
    /// build checks it; a start does not hash the file.
    pub ram_sha256: Sha256Hex,
}

/// What the guest was suspended with. A VM's size is chosen at the wake,
/// by the balloon and by adding vCPUs, within this shape.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WakeShapeV1 {
    pub memory_bytes: u64,
    pub boot_vcpus: u32,
    pub max_vcpus: u32,
    pub balloon: bool,
}

/// cloud-hypervisor versions as the VMM reports them (`v55.0.0`), compared
/// number by number.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WakeVmmV1 {
    /// The lowest version that can wake the image.
    #[schemars(regex(pattern = r"^v[0-9]+(\.[0-9]+){1,2}$"))]
    pub min_version: String,
    /// The version that suspended it.
    #[schemars(regex(pattern = r"^v[0-9]+(\.[0-9]+){1,2}$"))]
    pub built_with: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wake_json() -> serde_json::Value {
        let hex = |digit: &str| digit.repeat(64);
        serde_json::json!({
            "ram": {"size_bytes": 4_294_967_296_u64, "chunk_size": 4_194_304, "chunks": [[0, 7, hex("b")]], "sha256": hex("c")},
            "pack": {"base": format!("sha256:{}", hex("a")), "ram_sha256": hex("e")},
            "shape": {"memory_bytes": 4_294_967_296_u64, "boot_vcpus": 2, "max_vcpus": 4, "balloon": true},
            "cpu_profile": format!("sha256:{}", hex("d")),
            "vmm": {"min_version": "v55.0.0", "built_with": "v55.0.0"},
            "booted_at_unix_ms": 1,
        })
    }

    #[test]
    fn wake_round_trips_and_refuses_unknown_fields() -> Result<(), serde_json::Error> {
        let json = wake_json();
        let wake: WakeV1 = serde_json::from_value(json.clone())?;
        assert_eq!(serde_json::to_value(&wake)?, json);

        let mut unknown = json;
        unknown["later"] = true.into();
        assert!(serde_json::from_value::<WakeV1>(unknown).is_err());
        Ok(())
    }

    #[test]
    fn machine_config_of_the_design_parses() -> Result<(), serde_json::Error> {
        let hex = "a".repeat(64);
        let json = serde_json::json!({
            "guest_contract": 3, "image_format": IMAGE_FORMAT, "build_key": format!("sha256:{hex}"),
            "boot": {"cmdline": "console=hvc0 root=LABEL=INTARROOT"},
            "disk": {"size_bytes": 8_589_934_592_u64, "chunk_size": 4_194_304,
                     "chunks": [[0, 2, hex], [1, 3, hex], [5, 2, hex]]},
        });
        let config: MachineConfigV1 = serde_json::from_value(json.clone())?;
        assert_eq!(serde_json::to_value(&config)?, json);
        let mut with_wake = json;
        with_wake["wake"] = wake_json();
        assert!(
            serde_json::from_value::<MachineConfigV1>(with_wake)?
                .wake
                .is_some()
        );
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
            let mut json = wake_json();
            json["ram"]["sha256"] = bad.into();
            assert!(serde_json::from_value::<WakeV1>(json).is_err(), "{bad}");
            let mut json = wake_json();
            json["cpu_profile"] = bad.into();
            assert!(serde_json::from_value::<WakeV1>(json).is_err(), "{bad}");
        }
        let schema = serde_json::to_value(schemars::schema_for!(WakeV1)).unwrap_or_default();
        assert_eq!(schema["$defs"]["Sha256Hex"]["pattern"], "^[0-9a-f]{64}$");
        assert_eq!(
            schema["$defs"]["OciDigest"]["pattern"],
            "^sha256:[0-9a-f]{64}$"
        );
    }
}
