//! Media types and config shapes of the artifacts in the registry.
//!
//! A wake image is a machine image whose manifest also carries a suspended
//! guest: the RAM file of a base, a pack's delta against it, the stub that
//! jumps to the guest's wake vector, and the CPU profile the base was built
//! under. A puller that cannot wake skips these layers and cold-boots.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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

/// The `wake` object of a machine config.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WakeV1 {
    /// Manifest digest (`sha256:<hex>`) of the base this pack's delta
    /// applies to; absent on a base. A delta is never applied to another
    /// base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    pub ram: WakeRamV1,
    pub shape: WakeShapeV1,
    pub cpu: WakeCpuV1,
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
    /// The base's RAM file as `[chunk_index, layer_index, raw_sha256]`;
    /// absent indexes are zero holes.
    pub chunks: Vec<(u64, u32, String)>,
    /// SHA-256 (hex) of the RAM file the VMM is given: the base's on a
    /// base, the one rebuilt from base and delta on a pack.
    pub sha256: String,
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

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WakeCpuV1 {
    /// Blob digest (`sha256:<hex>`) of the CPU profile layer.
    pub profile: String,
    /// What a host's KVM must offer a guest to wake this image, so a host
    /// can decide before it pulls.
    pub requires: Vec<CpuidBitsV1>,
}

/// Bits of one CPUID register that must all be set.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CpuidBitsV1 {
    pub leaf: u32,
    pub sub_leaf: u32,
    pub register: CpuidRegister,
    pub mask: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CpuidRegister {
    Eax,
    Ebx,
    Ecx,
    Edx,
}

/// cloud-hypervisor versions, as the VMM reports them.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WakeVmmV1 {
    /// The lowest version that can wake the image.
    pub min_version: String,
    /// The version that suspended it.
    pub built_with: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_round_trips_and_refuses_unknown_fields() -> Result<(), serde_json::Error> {
        let json = serde_json::json!({
            "base": "sha256:aa",
            "ram": {"size_bytes": 4_294_967_296_u64, "chunk_size": 4_194_304, "chunks": [[0, 7, "bb"]], "sha256": "cc"},
            "shape": {"memory_bytes": 4_294_967_296_u64, "boot_vcpus": 2, "max_vcpus": 4, "balloon": true},
            "cpu": {"profile": "sha256:dd", "requires": [{"leaf": 1, "sub_leaf": 0, "register": "ecx", "mask": 1}]},
            "vmm": {"min_version": "v55.0", "built_with": "v55.0"},
            "booted_at_unix_ms": 1,
        });
        let wake: WakeV1 = serde_json::from_value(json.clone())?;
        assert_eq!(serde_json::to_value(&wake)?, json);

        let mut unknown = json;
        unknown["later"] = true.into();
        assert!(serde_json::from_value::<WakeV1>(unknown).is_err());
        Ok(())
    }
}
