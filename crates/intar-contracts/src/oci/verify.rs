//! The checks a machine image's manifest and config must pass before its
//! chunks are believed: jailerd runs them before it assembles a template and
//! the builder before it pushes. Pure: the caller has already checked the
//! manifest and config bytes against their digests.

use super::{
    DISK_CHUNK_MEDIA_TYPE, INITRD_MEDIA_TYPE, KERNEL_MEDIA_TYPE, MACHINE_ARTIFACT_TYPE,
    MACHINE_CONFIG_MEDIA_TYPE, MachineConfigV1, OCI_MANIFEST_MEDIA_TYPE, OciDescriptorV1,
    OciManifestV1, Sha256Hex, WAKE_CPU_PROFILE_MEDIA_TYPE, WAKE_DELTA_MEDIA_TYPE,
    WAKE_RAM_CHUNK_MEDIA_TYPE, WAKE_STUB_MEDIA_TYPE, WakeV1,
};
use crate::catalog::{IMAGE_CHUNK_SIZE_BYTES, MAX_CHUNKED_IMAGE_BYTES};

const GIB: u64 = 1024 * 1024 * 1024;
/// Bounds on a suspended guest, far above any lab VM.
const MAX_WAKE_MEMORY_BYTES: u64 = 64 * GIB;
const MAX_WAKE_VCPUS: u32 = 64;
/// x86-64 guest physical address widths cloud-hypervisor accepts.
const MIN_WAKE_PHYS_BITS: u8 = 32;
const MAX_WAKE_PHYS_BITS: u8 = 52;
const MAX_WAKE_DELTA_BYTES: u64 = 4 * GIB;
const MAX_WAKE_STUB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_WAKE_CPU_PROFILE_BYTES: u64 = 1024 * 1024;

/// One non-zero chunk of a file, with everything needed to verify it.
#[derive(Debug, Eq, PartialEq)]
pub struct ImageChunk {
    pub index: u32,
    pub raw_size_bytes: u32,
    pub raw_sha256: String,
    pub encoded_size_bytes: u64,
    pub encoded_sha256: String,
}

/// The chunks of a verified machine image.
#[derive(Debug, Eq, PartialEq)]
pub struct VerifiedImage {
    pub virtual_size_bytes: u64,
    pub chunks: Vec<ImageChunk>,
    pub wake: Option<VerifiedWake>,
}

/// A layer taken whole, by its digest and size.
#[derive(Debug, Eq, PartialEq)]
pub struct WakeLayer {
    pub sha256: String,
    pub size_bytes: u64,
}

/// The suspended guest of a verified machine image.
#[derive(Debug, Eq, PartialEq)]
pub struct VerifiedWake {
    /// The base's RAM file, as its chunks and its whole-file SHA-256.
    pub ram_size_bytes: u64,
    pub ram_sha256: String,
    pub ram_chunks: Vec<ImageChunk>,
    pub stub: WakeLayer,
    pub cpu_profile: WakeLayer,
    /// A pack's delta parts in layer order, and the SHA-256 of the RAM file
    /// they rebuild from the base's.
    pub pack: Option<(Vec<WakeLayer>, String)>,
}

/// Follow the chain the image's identity commits to: the OCI manifest names
/// the machine config and every layer by digest and size; the config maps
/// each non-zero chunk of the disk to a layer and to the SHA-256 of its raw
/// content. The kernel and initrd the caller offers must be the manifest's.
///
/// # Errors
/// Returns the first rule the image breaks.
pub fn verified_image(
    manifest: &OciManifestV1,
    machine: &MachineConfigV1,
    config_bytes: u64,
    config_sha256: &str,
    virtual_size_bytes: u64,
    kernel_sha256: Option<&str>,
    initrd_sha256: Option<&str>,
) -> Result<VerifiedImage, String> {
    ensure(
        manifest.schema_version == 2
            && manifest.media_type == OCI_MANIFEST_MEDIA_TYPE
            && manifest.artifact_type == MACHINE_ARTIFACT_TYPE
            && manifest.config.media_type == MACHINE_CONFIG_MEDIA_TYPE,
        "image manifest is not a machine image",
    )?;
    ensure(
        manifest.config.digest.hex() == config_sha256 && manifest.config.size == config_bytes,
        "machine config is not the one the image manifest names",
    )?;
    let kernels = layers_of(manifest, KERNEL_MEDIA_TYPE);
    let initrds = layers_of(manifest, INITRD_MEDIA_TYPE);
    ensure(
        kernels.len() == 1 && kernels.first().map(|layer| layer.digest.hex()) == kernel_sha256,
        "kernel is not the one the image manifest names",
    )?;
    ensure(
        initrds.len() <= 1 && initrds.first().map(|layer| layer.digest.hex()) == initrd_sha256,
        "initrd is not the one the image manifest names",
    )?;

    let chunk_size = u64::from(IMAGE_CHUNK_SIZE_BYTES);
    let disk = &machine.disk;
    ensure(
        disk.chunk_size == chunk_size
            && disk.size_bytes == virtual_size_bytes
            && disk.size_bytes > 0
            && disk.size_bytes <= MAX_CHUNKED_IMAGE_BYTES,
        "machine config disk geometry does not match the prepare request",
    )?;
    let chunks = verified_chunks(
        manifest,
        &disk.chunks,
        disk.size_bytes,
        DISK_CHUNK_MEDIA_TYPE,
        "image chunk",
    )?;
    // A config without `wake` is a plain machine image, whatever else its
    // manifest lists.
    let wake = machine
        .wake
        .as_ref()
        .map(|wake| verified_wake(manifest, wake))
        .transpose()?;
    Ok(VerifiedImage {
        virtual_size_bytes: disk.size_bytes,
        chunks,
        wake,
    })
}

/// The manifest's layers of `media_type`, in layer order.
#[must_use]
pub fn layers_of<'a>(manifest: &'a OciManifestV1, media_type: &str) -> Vec<&'a OciDescriptorV1> {
    manifest
        .layers
        .iter()
        .filter(|layer| layer.media_type == media_type)
        .collect()
}

fn ensure(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.to_owned())
    }
}

/// `[chunk_index, layer_index, raw_sha256]` of a file of `size_bytes` in
/// 4 MiB chunks: indexes rising and inside the file, each naming a layer of
/// `media_type` whose size a zstd frame of the chunk can have.
fn verified_chunks(
    manifest: &OciManifestV1,
    entries: &[(u64, u32, Sha256Hex)],
    size_bytes: u64,
    media_type: &str,
    label: &str,
) -> Result<Vec<ImageChunk>, String> {
    let chunk_size = u64::from(IMAGE_CHUNK_SIZE_BYTES);
    let mut chunks = Vec::with_capacity(entries.len());
    let mut next_index = 0_u64;
    for (index, layer_index, raw_sha256) in entries {
        let offset = index
            .checked_mul(chunk_size)
            .filter(|offset| *offset < size_bytes && *index >= next_index)
            .ok_or_else(|| format!("{label} {index} is out of order or out of range"))?;
        next_index = index + 1;
        let layer = manifest
            .layers
            .get(*layer_index as usize)
            .filter(|layer| layer.media_type == media_type)
            .ok_or_else(|| format!("{label} {index} names no chunk layer"))?;
        // A zstd frame of a 4 MiB chunk is never twice its size.
        if layer.size == 0 || layer.size > 2 * chunk_size {
            return Err(format!("{label} {index} has an implausible encoded size"));
        }
        chunks.push(ImageChunk {
            index: u32::try_from(*index).map_err(|_| format!("{label} {index} index"))?,
            raw_size_bytes: u32::try_from(chunk_size.min(size_bytes - offset))
                .map_err(|_| format!("{label} {index} size"))?,
            raw_sha256: raw_sha256.as_str().to_owned(),
            encoded_size_bytes: layer.size,
            encoded_sha256: layer.digest.hex().to_owned(),
        });
    }
    Ok(chunks)
}

/// Check `wake` against the manifest the image id commits to: one stub, one
/// CPU profile (the one `wake` names), a RAM file in rising chunks of the
/// disk's size that the shape's memory equals, a bounded shape, and delta
/// parts on a pack only.
///
/// # Errors
/// Returns the first rule the wake breaks.
pub fn verified_wake(manifest: &OciManifestV1, wake: &WakeV1) -> Result<VerifiedWake, String> {
    let layer = |descriptor: &&OciDescriptorV1| WakeLayer {
        sha256: descriptor.digest.hex().to_owned(),
        size_bytes: descriptor.size,
    };
    let stubs = layers_of(manifest, WAKE_STUB_MEDIA_TYPE);
    let profiles = layers_of(manifest, WAKE_CPU_PROFILE_MEDIA_TYPE);
    let ([stub], [profile]) = (stubs.as_slice(), profiles.as_slice()) else {
        return Err("wake needs exactly one stub and one CPU profile layer".to_owned());
    };
    ensure(
        profile.digest == wake.cpu_profile,
        "wake CPU profile is not the one the image manifest names",
    )?;
    ensure(
        stub.size > 0
            && stub.size <= MAX_WAKE_STUB_BYTES
            && profile.size > 0
            && profile.size <= MAX_WAKE_CPU_PROFILE_BYTES,
        "wake stub or CPU profile has an implausible size",
    )?;
    let (ram, shape) = (&wake.ram, &wake.shape);
    ensure(
        ram.chunk_size == u64::from(IMAGE_CHUNK_SIZE_BYTES)
            && ram.size_bytes > 0
            && ram.size_bytes <= MAX_WAKE_MEMORY_BYTES
            && shape.memory_bytes == ram.size_bytes,
        "wake RAM geometry is not sound",
    )?;
    ensure(
        shape.boot_vcpus > 0
            && shape.boot_vcpus <= shape.max_vcpus
            && shape.max_vcpus <= MAX_WAKE_VCPUS,
        "wake vCPU shape is not sound",
    )?;
    ensure(
        (MIN_WAKE_PHYS_BITS..=MAX_WAKE_PHYS_BITS).contains(&shape.max_phys_bits),
        "wake physical address width is not sound",
    )?;
    let ram_chunks = verified_chunks(
        manifest,
        &ram.chunks,
        ram.size_bytes,
        WAKE_RAM_CHUNK_MEDIA_TYPE,
        "wake RAM chunk",
    )?;
    let deltas = layers_of(manifest, WAKE_DELTA_MEDIA_TYPE);
    let pack = match &wake.pack {
        None => {
            ensure(deltas.is_empty(), "a wake base carries no delta")?;
            None
        }
        Some(pack) => {
            let total = deltas.iter().try_fold(0_u64, |total, delta| {
                (delta.size > 0)
                    .then(|| total.checked_add(delta.size))
                    .flatten()
            });
            ensure(
                !deltas.is_empty() && total.is_some_and(|total| total <= MAX_WAKE_DELTA_BYTES),
                "wake pack delta is missing or too large",
            )?;
            Some((
                deltas.iter().map(layer).collect(),
                pack.ram_sha256.as_str().to_owned(),
            ))
        }
    };
    Ok(VerifiedWake {
        ram_size_bytes: ram.size_bytes,
        ram_sha256: ram.sha256.as_str().to_owned(),
        ram_chunks,
        stub: layer(stub),
        cpu_profile: layer(profile),
        pack,
    })
}

#[cfg(test)]
mod tests {
    use super::verified_image;
    use crate::oci::{MachineConfigV1, OciManifestV1};

    const MIB: u64 = 1024 * 1024;

    fn hex(digit: &str) -> String {
        digit.repeat(64)
    }

    /// A 10 MiB disk: chunk 0 full, chunk 1 a zero hole, chunk 2 the 2 MiB
    /// tail; both chunks in one layer (identical content is stored once).
    fn image() -> (serde_json::Value, serde_json::Value) {
        let layer = |media: &str, digit: &str, size: u64| serde_json::json!({"mediaType": media, "digest": format!("sha256:{}", hex(digit)), "size": size});
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "artifactType": "application/vnd.intar.machine.v1",
            "config": layer("application/vnd.intar.machine.config.v1+json", "c", 300),
            "layers": [
                layer("application/vnd.intar.kernel.v1", "1", 11 * MIB),
                layer("application/vnd.intar.initrd.v1", "2", 3 * MIB),
                layer("application/vnd.intar.disk.chunk.v1+zstd", "3", 1000),
            ],
        });
        let machine = serde_json::json!({
            "guest_contract": 3, "image_format": "intar-image-3",
            "build_key": format!("sha256:{}", hex("b")),
            "boot": {"cmdline": "root=LABEL=INTARROOT"},
            "disk": {"size_bytes": 10 * MIB, "chunk_size": 4 * MIB,
                     "chunks": [[0, 2, hex("d")], [2, 2, hex("e")]]},
        });
        (manifest, machine)
    }

    fn verify(
        manifest: &serde_json::Value,
        machine: &serde_json::Value,
    ) -> Result<Vec<(u32, u32)>, String> {
        let manifest: OciManifestV1 =
            serde_json::from_value(manifest.clone()).map_err(|error| error.to_string())?;
        let machine: MachineConfigV1 =
            serde_json::from_value(machine.clone()).map_err(|error| error.to_string())?;
        verified_image(
            &manifest,
            &machine,
            300,
            &hex("c"),
            10 * MIB,
            Some(&hex("1")),
            Some(&hex("2")),
        )
        .map(|image| {
            assert_eq!(image.virtual_size_bytes, 10 * MIB);
            image
                .chunks
                .iter()
                .map(|chunk| (chunk.index, chunk.raw_size_bytes))
                .collect()
        })
        .map_err(|error| format!("{error:#}"))
    }

    #[test]
    fn a_sound_image_yields_its_chunks_with_a_short_tail() {
        let (manifest, machine) = image();
        assert_eq!(
            verify(&manifest, &machine),
            Ok(vec![(0, 4 << 20), (2, 2 << 20)])
        );
    }

    #[test]
    fn every_break_in_the_chain_is_refused() {
        type Break = fn(&mut serde_json::Value, &mut serde_json::Value);
        let broken: [(&str, Break); 12] = [
            ("not a machine image", |m, _| {
                m["artifactType"] = "application/vnd.intar.kino.v1".into()
            }),
            ("not the one the image manifest names", |m, _| {
                m["config"]["size"] = 301.into()
            }),
            ("not the one the image manifest names", |m, _| {
                m["config"]["digest"] = format!("sha256:{}", "f".repeat(64)).into();
            }),
            ("kernel is not the one", |m, _| {
                m["layers"][0]["digest"] = format!("sha256:{}", "f".repeat(64)).into();
            }),
            ("initrd is not the one", |m, _| {
                m["layers"][1]["digest"] = format!("sha256:{}", "f".repeat(64)).into();
            }),
            ("kernel is not the one", |m, _| {
                m["layers"][1]["mediaType"] = "application/vnd.intar.kernel.v1".into()
            }),
            ("disk geometry", |_, c| {
                c["disk"]["chunk_size"] = 4096.into()
            }),
            ("disk geometry", |_, c| {
                c["disk"]["size_bytes"] = (11 * MIB).into()
            }),
            ("out of order or out of range", |_, c| {
                c["disk"]["chunks"][1][0] = 0.into()
            }),
            ("out of order or out of range", |_, c| {
                c["disk"]["chunks"][1][0] = 3.into()
            }),
            ("names no chunk layer", |_, c| {
                c["disk"]["chunks"][0][1] = 0.into()
            }),
            ("implausible encoded size", |m, _| {
                m["layers"][2]["size"] = (9 * MIB).into()
            }),
        ];
        for (expected, change) in broken {
            let (mut manifest, mut machine) = image();
            change(&mut manifest, &mut machine);
            let error = verify(&manifest, &machine).expect_err(expected);
            assert!(
                error.contains(expected),
                "expected `{expected}` in `{error}`"
            );
        }
        // A raw digest that is not hex never reaches a file name.
        let (manifest, mut machine) = image();
        machine["disk"]["chunks"][0][2] = "../../etc/shadow".into();
        assert!(verify(&manifest, &machine).is_err());
    }

    const GIB: u64 = 1024 * MIB;

    /// [`image`] with a suspended guest: a 9 MiB RAM file (chunk 1 a hole)
    /// in layer 3, the stub in 4, the CPU profile in 5 and, on a pack, the
    /// delta in two parts, 6 and 7.
    fn wake_image(pack: bool) -> (serde_json::Value, serde_json::Value) {
        let (mut manifest, mut machine) = image();
        let layer = |media: &str, digit: &str, size: u64| serde_json::json!({"mediaType": media, "digest": format!("sha256:{}", hex(digit)), "size": size});
        let layers = manifest["layers"].as_array_mut().expect("layers");
        layers.push(layer(
            "application/vnd.intar.wake.ram.chunk.v1+zstd",
            "4",
            900,
        ));
        layers.push(layer("application/vnd.intar.wake.stub.v1", "5", 2 * MIB));
        layers.push(layer(
            "application/vnd.intar.wake.cpu-profile.v1+json",
            "6",
            700,
        ));
        if pack {
            layers.push(layer("application/vnd.intar.wake.delta.v1", "7", 3 * GIB));
            layers.push(layer("application/vnd.intar.wake.delta.v1", "8", MIB));
        }
        machine["wake"] = serde_json::json!({
            "ram": {"size_bytes": 9 * MIB, "chunk_size": 4 * MIB,
                    "chunks": [[0, 3, hex("d")], [2, 3, hex("e")]], "sha256": hex("f")},
            "shape": {"memory_bytes": 9 * MIB, "boot_vcpus": 1, "max_vcpus": 2, "balloon": true, "max_phys_bits": 36},
            "cpu_profile": format!("sha256:{}", hex("6")),
            "vmm": {"min_version": "v50.0", "built_with": "v50.0"},
            "booted_at_unix_ms": 1,
        });
        if pack {
            machine["wake"]["pack"] = serde_json::json!({
                "base": format!("sha256:{}", hex("9")), "ram_sha256": hex("a"),
            });
        }
        (manifest, machine)
    }

    /// The RAM chunks, the stub's and profile's digests, and the delta parts.
    type WakeSummary = (Vec<(u32, u32)>, String, String, Option<Vec<u64>>);

    fn verify_wake(
        manifest: &serde_json::Value,
        machine: &serde_json::Value,
    ) -> Result<Option<WakeSummary>, String> {
        let manifest: OciManifestV1 =
            serde_json::from_value(manifest.clone()).map_err(|error| error.to_string())?;
        let machine: MachineConfigV1 =
            serde_json::from_value(machine.clone()).map_err(|error| error.to_string())?;
        let image = verified_image(
            &manifest,
            &machine,
            300,
            &hex("c"),
            10 * MIB,
            Some(&hex("1")),
            Some(&hex("2")),
        )
        .map_err(|error| format!("{error:#}"))?;
        Ok(image.wake.map(|wake| {
            assert_eq!((wake.ram_size_bytes, wake.ram_sha256), (9 * MIB, hex("f")));
            (
                wake.ram_chunks
                    .iter()
                    .map(|chunk| (chunk.index, chunk.raw_size_bytes))
                    .collect(),
                wake.stub.sha256,
                wake.cpu_profile.sha256,
                wake.pack.map(|(parts, ram_sha256)| {
                    assert_eq!(ram_sha256, hex("a"));
                    parts.iter().map(|part| part.size_bytes).collect()
                }),
            )
        }))
    }

    #[test]
    fn a_sound_base_and_a_sound_pack_yield_their_wake() {
        let ram = vec![(0, 4 << 20), (2, 1 << 20)];
        let (manifest, machine) = wake_image(false);
        assert_eq!(
            verify_wake(&manifest, &machine),
            Ok(Some((ram.clone(), hex("5"), hex("6"), None)))
        );
        let (manifest, machine) = wake_image(true);
        assert_eq!(
            verify_wake(&manifest, &machine),
            Ok(Some((ram, hex("5"), hex("6"), Some(vec![3 * GIB, MIB]))))
        );
        // Without `wake` the image is checked exactly as before, whatever
        // else the manifest lists.
        let (manifest, mut machine) = wake_image(true);
        machine
            .as_object_mut()
            .expect("machine config")
            .remove("wake");
        assert_eq!(verify_wake(&manifest, &machine), Ok(None));
    }

    #[test]
    fn every_break_in_a_wake_is_refused() {
        type Break = fn(&mut serde_json::Value, &mut serde_json::Value);
        let broken: [(bool, &str, Break); 20] = [
            (false, "exactly one stub", |m, _| {
                m["layers"][4]["mediaType"] = "application/vnd.intar.kernel.v2".into()
            }),
            (false, "exactly one stub", |m, _| {
                m["layers"][5]["mediaType"] = "application/vnd.intar.wake.stub.v1".into()
            }),
            (false, "CPU profile is not the one", |_, c| {
                c["wake"]["cpu_profile"] = format!("sha256:{}", hex("5")).into()
            }),
            (false, "implausible size", |m, _| {
                m["layers"][4]["size"] = (257 * MIB).into()
            }),
            (false, "implausible size", |m, _| {
                m["layers"][5]["size"] = (2 * MIB).into()
            }),
            (false, "RAM geometry", |_, c| {
                c["wake"]["ram"]["chunk_size"] = 4096.into()
            }),
            (false, "RAM geometry", |_, c| {
                c["wake"]["shape"]["memory_bytes"] = (8 * MIB).into()
            }),
            (false, "RAM geometry", |_, c| {
                c["wake"]["ram"]["size_bytes"] = (65 * GIB).into();
                c["wake"]["shape"]["memory_bytes"] = (65 * GIB).into();
            }),
            (false, "vCPU shape", |_, c| {
                c["wake"]["shape"]["boot_vcpus"] = 3.into()
            }),
            (false, "vCPU shape", |_, c| {
                c["wake"]["shape"]["boot_vcpus"] = 0.into()
            }),
            (false, "vCPU shape", |_, c| {
                c["wake"]["shape"]["max_vcpus"] = 65.into()
            }),
            (false, "physical address width", |_, c| {
                c["wake"]["shape"]["max_phys_bits"] = 31.into()
            }),
            (false, "physical address width", |_, c| {
                c["wake"]["shape"]["max_phys_bits"] = 53.into()
            }),
            (false, "wake RAM chunk 0 is out of order", |_, c| {
                c["wake"]["ram"]["chunks"][1][0] = 0.into()
            }),
            (
                false,
                "wake RAM chunk 3 is out of order or out of range",
                |_, c| c["wake"]["ram"]["chunks"][1][0] = 3.into(),
            ),
            (false, "wake RAM chunk 0 names no chunk layer", |_, c| {
                c["wake"]["ram"]["chunks"][0][1] = 2.into()
            }),
            (
                false,
                "wake RAM chunk 0 has an implausible encoded size",
                |m, _| m["layers"][3]["size"] = (9 * MIB).into(),
            ),
            (false, "a wake base carries no delta", |m, _| {
                let delta = serde_json::json!({"mediaType": "application/vnd.intar.wake.delta.v1", "digest": format!("sha256:{}", hex("7")), "size": 1});
                if let Some(layers) = m["layers"].as_array_mut() {
                    layers.push(delta);
                }
            }),
            (true, "delta is missing or too large", |m, _| {
                m["layers"][7]["size"] = (GIB + 1).into()
            }),
            (true, "delta is missing or too large", |m, _| {
                m["layers"][7]["size"] = 0.into()
            }),
        ];
        for (pack, expected, change) in broken {
            let (mut manifest, mut machine) = wake_image(pack);
            change(&mut manifest, &mut machine);
            let error = verify_wake(&manifest, &machine).expect_err(expected);
            assert!(
                error.contains(expected),
                "expected `{expected}` in `{error}`"
            );
        }
        // A pack without any delta part.
        let (mut manifest, machine) = wake_image(true);
        manifest["layers"]
            .as_array_mut()
            .expect("layers")
            .truncate(6);
        let error = verify_wake(&manifest, &machine).expect_err("no delta");
        assert!(error.contains("delta is missing"), "{error}");
    }
}
