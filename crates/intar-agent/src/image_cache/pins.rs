use super::*;

use std::collections::BTreeSet;

use intar_contracts::bridge::HostDesiredStateV2;
use intar_contracts::catalog::{ImageArchitecture, ImageKey};

/// `(scenario, vm, architecture, image digest)`.
pub(crate) type ImagePin = (String, String, String, String);
/// `(tools disk digest, size, kino digest, bootstrap ABI)`.
pub(crate) type ToolsPin = (String, u64, String, u16);

/// One pinned image as the registry and the cache know it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PinnedImage {
    pub(crate) image_key: String,
    pub(crate) image_id: String,
}

/// The exact set of cache entries the agent must keep: the desired cache of
/// the control plane and the images of VMs whose desired phase is `Running`.
///
/// The desired cache already retains the rollback-pinned revisions of a key,
/// so the pin set is exactly what the control plane delivered. The cache does
/// not derive, widen, or guess a pin.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RequiredPins {
    pub(crate) images: BTreeSet<ImagePin>,
    pub(crate) guest_tools: BTreeSet<ToolsPin>,
}

impl RequiredPins {
    /// Pins from the desired state alone. Used for change detection.
    pub(crate) fn from_desired_state(desired: &HostDesiredStateV2) -> Self {
        let mut pins = Self::default();
        for image in &desired.cached_images {
            pins.images
                .insert(image_pin(&image.image_key, &image.image_id));
        }
        for tools in &desired.cached_guest_tools {
            pins.guest_tools.insert(guest_tools_pin(tools));
        }
        for vm in desired
            .vms
            .iter()
            .filter(|vm| vm.desired_phase == intar_contracts::bridge::DesiredVmPhase::Running)
        {
            pins.images.insert(image_pin(&vm.image_key, &vm.image_id));
            pins.guest_tools.insert(guest_tools_pin(&vm.guest_tools));
        }
        pins
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.images.is_empty() && self.guest_tools.is_empty()
    }

    /// Every pinned image, whether the control plane lists it in the desired
    /// cache or only through a running VM. A running VM outside the desired
    /// cache is still a pin, so the scrub pass and the repair path must see it.
    pub(crate) fn image_pins(&self) -> impl Iterator<Item = PinnedImage> + '_ {
        self.images
            .iter()
            .map(|(scenario, vm, arch, digest)| PinnedImage {
                image_key: format!("{scenario}-{vm}-{arch}"),
                image_id: digest.clone(),
            })
    }

    /// Whether one registry record is a required pin. The registry record
    /// carries its cache key string and its image digest.
    pub(crate) fn holds_image(&self, cache_key: &str, image_id: &str) -> bool {
        self.images.iter().any(|(scenario, vm, arch, digest)| {
            digest == image_id && format!("{scenario}-{vm}-{arch}") == cache_key
        })
    }
}

pub(crate) fn architecture_slug(arch: &ImageArchitecture) -> &'static str {
    match arch {
        ImageArchitecture::X86_64 => "x86_64",
        ImageArchitecture::Aarch64 => "aarch64",
    }
}

pub(crate) fn image_pin(image_key: &ImageKey, image_id: &str) -> ImagePin {
    (
        image_key.scenario.clone(),
        image_key.vm.clone(),
        architecture_slug(&image_key.arch).to_owned(),
        normalize_sha256(image_id).unwrap_or_else(|| image_id.trim().to_ascii_lowercase()),
    )
}

fn guest_tools_pin(tools: &intar_contracts::bridge::DesiredGuestToolsV1) -> ToolsPin {
    (
        normalize_sha256(&tools.tools_disk_sha256)
            .unwrap_or_else(|| tools.tools_disk_sha256.trim().to_ascii_lowercase()),
        tools.tools_disk_size_bytes,
        normalize_sha256(&tools.kino_sha256)
            .unwrap_or_else(|| tools.kino_sha256.trim().to_ascii_lowercase()),
        tools.bootstrap_abi,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use intar_contracts::bridge::{
        DesiredCachedImageV1, DesiredGuestToolsV1, DesiredVmPhase, DesiredVmV2, HostDesiredStateV2,
        VmResourcesV3,
    };
    use intar_contracts::catalog::Mib;

    fn desired_state(images: Vec<(&str, &str)>, running: Vec<(&str, &str)>) -> HostDesiredStateV2 {
        HostDesiredStateV2 {
            schema_version: intar_contracts::bridge::HOST_DESIRED_STATE_SCHEMA_VERSION,
            host_id: "host-1".to_owned(),
            version: 1,
            generated_at_unix_ms: 0,
            cached_images: images
                .into_iter()
                .map(|(key, digest)| DesiredCachedImageV1 {
                    image_key: parse_key(key),
                    image_id: digest.to_owned(),
                })
                .collect(),
            cached_guest_tools: vec![DesiredGuestToolsV1 {
                tools_disk_sha256: "c".repeat(64),
                tools_disk_size_bytes: 64 * 1024 * 1024,
                kino_sha256: "d".repeat(64),
                bootstrap_abi: GUEST_BOOTSTRAP_ABI_V2,
            }],
            vms: running
                .into_iter()
                .map(|(key, digest)| DesiredVmV2 {
                    run_id: "run-1".to_owned(),
                    vm_name: "vm-1".to_owned(),
                    desired_phase: DesiredVmPhase::Running,
                    image_key: parse_key(key),
                    image_id: digest.to_owned(),
                    guest_tools: DesiredGuestToolsV1 {
                        tools_disk_sha256: "e".repeat(64),
                        tools_disk_size_bytes: 64 * 1024 * 1024,
                        kino_sha256: "f".repeat(64),
                        bootstrap_abi: 1,
                    },
                    resources: VmResourcesV3 {
                        cpu_millis: 1,
                        memory_mib: Mib(1),
                        disk_mib: Mib(1),
                    },
                    ssh_authorized_keys_openssh: vec![],
                    lease_expires_at_unix_ms: 0,
                })
                .collect(),
            builds: Vec::new(),
        }
    }

    fn parse_key(key: &str) -> ImageKey {
        let mut parts = key.split('-');
        ImageKey {
            scenario: parts.next().unwrap_or_default().to_owned(),
            vm: parts.next().unwrap_or_default().to_owned(),
            arch: ImageArchitecture::X86_64,
        }
    }

    #[test]
    fn the_pin_set_is_the_cached_images_and_the_running_vms() {
        let state = desired_state(
            vec![("a-web-x86_64", &"1".repeat(64))],
            vec![("b-web-x86_64", &"2".repeat(64))],
        );
        let pins = RequiredPins::from_desired_state(&state);

        assert_eq!(pins.images.len(), 2);
        assert!(pins.holds_image("a-web-x86_64", &"1".repeat(64)));
        assert!(pins.holds_image("b-web-x86_64", &"2".repeat(64)));
        assert!(!pins.holds_image("c-web-x86_64", &"3".repeat(64)));
    }

    #[test]
    fn an_empty_pin_set_stays_empty() {
        let state = desired_state(Vec::new(), Vec::new());
        let pins = RequiredPins::from_desired_state(&state);

        assert!(!pins.is_empty(), "guest tools pins are still required");
        assert!(pins.images.is_empty());
    }
}
