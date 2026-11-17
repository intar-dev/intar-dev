//! The checks a machine image's manifest and config must pass before its
//! chunks are believed: jailerd runs them before it assembles a template and
//! the builder before it pushes. Pure: the caller has already checked the
//! manifest and config bytes against their digests.

use super::{
    DISK_CHUNK_MEDIA_TYPE, INITRD_MEDIA_TYPE, KERNEL_MEDIA_TYPE, MACHINE_ARTIFACT_TYPE,
    MACHINE_CONFIG_MEDIA_TYPE, MachineConfigV1, OCI_MANIFEST_MEDIA_TYPE, OciDescriptorV1,
    OciManifestV1, Sha256Hex,
};
use crate::catalog::{IMAGE_CHUNK_SIZE_BYTES, MAX_CHUNKED_IMAGE_BYTES};

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
    Ok(VerifiedImage {
        virtual_size_bytes: disk.size_bytes,
        chunks,
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
}
