use super::*;

use std::num::NonZeroU64;
use std::os::unix::fs::MetadataExt as _;

use crate::store_gc::touch_chunked_template;
use intar_contracts::catalog::{IMAGE_CHUNK_SIZE_BYTES, MAX_CHUNKED_IMAGE_BYTES};
use intar_contracts::oci::{
    DISK_CHUNK_MEDIA_TYPE, INITRD_MEDIA_TYPE, KERNEL_MEDIA_TYPE, MACHINE_ARTIFACT_TYPE,
    MACHINE_CONFIG_MEDIA_TYPE, MachineConfigV1, OCI_MANIFEST_MEDIA_TYPE, OciDescriptorV1,
    OciManifestV1, Sha256Hex, WAKE_CPU_PROFILE_MEDIA_TYPE, WAKE_DELTA_MEDIA_TYPE,
    WAKE_RAM_CHUNK_MEDIA_TYPE, WAKE_STUB_MEDIA_TYPE, WakeV1,
};
use intar_jailer_protocol::TrustedDirectorySource;
use reflink_copy::ReflinkBlockBuilder;

const MAX_CHUNK_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const GIB: u64 = 1024 * 1024 * 1024;
/// Bounds on a suspended guest, far above any lab VM.
const MAX_WAKE_MEMORY_BYTES: u64 = 64 * GIB;
const MAX_WAKE_VCPUS: u32 = 64;
const MAX_WAKE_DELTA_BYTES: u64 = 4 * GIB;
const MAX_WAKE_STUB_BYTES: u64 = 256 * 1024 * 1024;
const MAX_WAKE_CPU_PROFILE_BYTES: u64 = 1024 * 1024;

/// One non-zero chunk of the root disk, with everything needed to verify it.
#[derive(Debug, Eq, PartialEq)]
pub(super) struct ImageChunk {
    pub(super) index: u32,
    pub(super) raw_size_bytes: u32,
    pub(super) raw_sha256: String,
    pub(super) encoded_size_bytes: u64,
    pub(super) encoded_sha256: String,
}

/// The chunks of a verified machine image.
#[derive(Debug, Eq, PartialEq)]
pub(super) struct VerifiedImage {
    pub(super) virtual_size_bytes: u64,
    pub(super) chunks: Vec<ImageChunk>,
    pub(super) wake: Option<VerifiedWake>,
}

/// A layer the template takes whole, by its digest and size.
#[derive(Debug, Eq, PartialEq)]
pub(super) struct WakeLayer {
    pub(super) sha256: String,
    pub(super) size_bytes: u64,
}

/// The suspended guest of a verified machine image.
#[derive(Debug, Eq, PartialEq)]
pub(super) struct VerifiedWake {
    /// The base's RAM file, as its chunks and its whole-file SHA-256.
    pub(super) ram_size_bytes: u64,
    pub(super) ram_sha256: String,
    pub(super) ram_chunks: Vec<ImageChunk>,
    pub(super) stub: WakeLayer,
    pub(super) cpu_profile: WakeLayer,
    /// A pack's delta parts in layer order, and the SHA-256 of the RAM file
    /// they rebuild from the base's.
    pub(super) pack: Option<(Vec<WakeLayer>, String)>,
}

pub(super) fn prepare_chunked_image_template(
    config: &JailerdConfig,
    request: &PrepareChunkedImageV3Request,
    lane: &PrepareLane,
) -> Result<PreparedImageV3Result> {
    request
        .validate()
        .context("validate chunked image request")?;
    if let Ok(metadata) = validate_existing_chunked_template(config, request) {
        return prepared_image_v3_result(&metadata);
    }

    let jail_root = trusted_jail_root_fd(config)?;
    let templates = ensure_root_directory_at(&jail_root, c"templates")?;
    let image_name = CString::new(request.image_id.as_str()).expect("SHA-256 contains no NUL");
    let lock_name = CString::new(format!(".lock-{}", request.image_id.as_str()))
        .expect("SHA-256 lock name contains no NUL");
    let lock_fd = rustix::fs::openat(
        &templates,
        &lock_name,
        OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )?;
    rustix::fs::fchmod(&lock_fd, Mode::RUSR | Mode::WUSR)?;
    rustix::fs::fchown(
        &lock_fd,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    validate_root_regular_file(&lock_fd, "chunked image single-flight lock")?;
    rustix::fs::flock(&lock_fd, rustix::fs::FlockOperation::LockExclusive)?;
    if let Ok(metadata) = validate_existing_chunked_template(config, request) {
        return prepared_image_v3_result(&metadata);
    }
    if rustix::fs::statat(
        &templates,
        &image_name,
        rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
    )
    .is_ok()
    {
        bail!("existing chunked image template does not match the request")
    }

    let manifest = read_verified_chunk_manifest(config, request)?;
    let chunk_cache = open_trusted_chunk_cache(config, &request.chunk_cache_root)?;
    let chunk_store = ensure_root_directory_at(&jail_root, c"chunks")?;
    let temporary_name = format!(".prepare-{}", Uuid::new_v4());
    let temporary = config.jail_root.join("templates").join(&temporary_name);
    rustix::fs::mkdirat(
        &templates,
        temporary_name.as_str(),
        Mode::RUSR | Mode::WUSR | Mode::XUSR,
    )?;

    let operation = (|| -> Result<ImageTemplateMetadataV2> {
        let root_disk = assemble_chunked_root(
            config,
            &manifest,
            &request.image_id,
            &chunk_cache,
            &chunk_store,
            &temporary.join("root.raw"),
            lane,
        )?;
        let kernel = copy_template_source(
            config,
            &request.kernel,
            &temporary.join("kernel"),
            None,
            None,
        )?;
        let initrd = request
            .initrd
            .as_ref()
            .map(|source| {
                copy_template_source(config, source, &temporary.join("initrd"), None, None)
            })
            .transpose()?;
        let wake = manifest
            .wake
            .as_ref()
            .map(|wake| prepare_wake_files(config, wake, &chunk_cache, &temporary, lane))
            .transpose()?;
        let metadata = ImageTemplateMetadataV2 {
            schema_version: IMAGE_TEMPLATE_METADATA_V3,
            image_sha256: request.image_id.clone(),
            chunk_manifest_sha256: Some(request.chunk_manifest_sha256.clone()),
            chunk_raw_sha256s: manifest
                .chunks
                .iter()
                .map(|chunk| Sha256Digest::parse(chunk.raw_sha256.clone()))
                .collect::<Result<Vec<_>, _>>()?,
            virtual_size_bytes: request.virtual_size_bytes,
            root_disk,
            kernel,
            initrd,
            wake,
        };
        let mut metadata_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o400)
            .open(temporary.join("metadata-v2.json"))?;
        to_writer(&mut metadata_file, &metadata)?;
        metadata_file.write_all(b"\n")?;
        rustix::fs::fchmod(&metadata_file, Mode::RUSR)?;
        rustix::fs::fchown(
            &metadata_file,
            Some(rustix::process::Uid::ROOT),
            Some(rustix::process::Gid::ROOT),
        )?;
        rustix::fs::renameat(&templates, temporary_name.as_str(), &templates, &image_name)?;
        #[cfg(target_os = "linux")]
        rustix::fs::syncfs(&templates)?;
        Ok(metadata)
    })();
    if operation.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    let expected = operation?;
    let actual = validate_existing_chunked_template(config, request)?;
    ensure!(
        actual == expected,
        "published chunked template metadata changed"
    );
    prepared_image_v3_result(&actual)
}

pub(super) fn validate_existing_chunked_template(
    config: &JailerdConfig,
    request: &PrepareChunkedImageV3Request,
) -> Result<ImageTemplateMetadataV2> {
    let jail_root = trusted_jail_root_fd(config)?;
    let templates = open_optional_root_directory_at(&jail_root, c"templates")?
        .context("prepared image template root is missing")?;
    let image_name = CString::new(request.image_id.as_str()).expect("SHA-256 contains no NUL");
    let image_directory =
        open_lifecycle_entry_at(&templates, &image_name, OFlags::RDONLY | OFlags::DIRECTORY)?;
    validate_root_directory(&image_directory, "chunked image template")?;
    let metadata = open_template_metadata(&image_directory)?;
    ensure!(
        metadata.schema_version == IMAGE_TEMPLATE_METADATA_V3
            && metadata.image_sha256 == request.image_id
            && metadata.chunk_manifest_sha256.as_ref() == Some(&request.chunk_manifest_sha256)
            && metadata.virtual_size_bytes == request.virtual_size_bytes
            && metadata.root_disk.sha256 == request.image_id
            && request.kernel.sha256.as_ref() == Some(&metadata.kernel.sha256)
            && request
                .initrd
                .as_ref()
                .and_then(|source| source.sha256.as_ref())
                == metadata.initrd.as_ref().map(|artifact| &artifact.sha256),
        "prepared chunked image metadata does not match the request"
    );
    for (name, expected, label) in [
        (
            c"root.raw" as &CStr,
            &metadata.root_disk,
            "chunked root disk",
        ),
        (c"kernel" as &CStr, &metadata.kernel, "chunked kernel"),
    ] {
        let file = open_lifecycle_entry_at(&image_directory, name, OFlags::RDONLY)?;
        validate_template_artifact_stat(&rustix::fs::fstat(&file)?, expected, label)?;
    }
    if let Some(expected) = &metadata.initrd {
        let file = open_lifecycle_entry_at(&image_directory, c"initrd", OFlags::RDONLY)?;
        validate_template_artifact_stat(&rustix::fs::fstat(&file)?, expected, "chunked initrd")?;
    }
    if let Some(wake) = &metadata.wake {
        validate_wake_template(&image_directory, wake)?;
    }
    touch_chunked_template(config, &request.image_id)?;
    Ok(metadata)
}

pub(super) fn validate_prepared_chunked_launch(
    config: &JailerdConfig,
    request: &intar_jailer_protocol::LaunchVmV3Request,
) -> Result<()> {
    let jail_root = trusted_jail_root_fd(config)?;
    let templates = open_optional_root_directory_at(&jail_root, c"templates")?
        .context("prepared image template root is missing")?;
    let image_name = CString::new(request.image_id.as_str()).expect("SHA-256 contains no NUL");
    let image_directory =
        open_lifecycle_entry_at(&templates, &image_name, OFlags::RDONLY | OFlags::DIRECTORY)?;
    validate_root_directory(&image_directory, "chunked image template")?;
    let metadata = open_template_metadata(&image_directory)?;
    ensure!(
        metadata.schema_version == IMAGE_TEMPLATE_METADATA_V3
            && metadata.image_sha256 == request.image_id
            && metadata.chunk_manifest_sha256.as_ref() == Some(&request.chunk_manifest_sha256)
            && metadata.virtual_size_bytes == request.virtual_size_bytes,
        "prepared chunked launch identity does not match root-owned metadata"
    );
    touch_chunked_template(config, &request.image_id)?;
    let expected = prepared_image_v3_result(&metadata)?;
    ensure!(
        request.launch.artifacts.root_disk == expected.root_disk
            && request.launch.artifacts.kernel == expected.kernel
            && request.launch.artifacts.initrd == expected.initrd
            // A launch may cold-boot an image that carries a suspended guest.
            && request
                .launch
                .artifacts
                .wake
                .as_ref()
                .is_none_or(|wake| Some(wake) == expected.wake.as_ref()),
        "prepared chunked launch descriptors do not match root-owned metadata"
    );
    Ok(())
}

/// A source file of at most 4 MiB whose SHA-256 the request names.
fn read_verified_source(
    config: &JailerdConfig,
    source: &ArtifactSource,
    expected: &Sha256Digest,
    label: &str,
) -> Result<Vec<u8>> {
    let mut file = open_trusted_source(config, source.source_root, &source.relative_path)?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(MAX_CHUNK_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_CHUNK_MANIFEST_BYTES,
        "{label} exceeds the bounded size"
    );
    ensure!(
        sha256_digest(&bytes) == *expected,
        "{label} SHA-256 mismatch"
    );
    Ok(bytes)
}

/// Follow the chain the image's identity commits to: the OCI manifest (its
/// digest is the image id) names the machine config and every layer by
/// digest and size; the config maps each non-zero chunk of the disk to a
/// layer and to the SHA-256 of its raw content. Nothing outside that chain
/// is believed: the kernel and initrd the request offers must be the
/// manifest's.
fn read_verified_chunk_manifest(
    config: &JailerdConfig,
    request: &PrepareChunkedImageV3Request,
) -> Result<VerifiedImage> {
    let bytes = read_verified_source(
        config,
        &request.image_manifest,
        &request.image_id,
        "image manifest",
    )?;
    let manifest: OciManifestV1 =
        serde_json::from_slice(&bytes).context("decode image manifest")?;
    let bytes = read_verified_source(
        config,
        &request.manifest,
        &request.chunk_manifest_sha256,
        "machine config",
    )?;
    let machine: MachineConfigV1 =
        serde_json::from_slice(&bytes).context("decode machine config")?;
    verified_image(
        &manifest,
        &machine,
        bytes.len() as u64,
        request.chunk_manifest_sha256.as_str(),
        request.virtual_size_bytes,
        request.kernel.sha256.as_ref().map(Sha256Digest::as_str),
        request
            .initrd
            .as_ref()
            .and_then(|source| source.sha256.as_ref())
            .map(Sha256Digest::as_str),
    )
}

/// The checks of [`read_verified_chunk_manifest`] on already-verified bytes.
pub(super) fn verified_image(
    manifest: &OciManifestV1,
    machine: &MachineConfigV1,
    config_bytes: u64,
    config_sha256: &str,
    virtual_size_bytes: u64,
    kernel_sha256: Option<&str>,
    initrd_sha256: Option<&str>,
) -> Result<VerifiedImage> {
    ensure!(
        manifest.schema_version == 2
            && manifest.media_type == OCI_MANIFEST_MEDIA_TYPE
            && manifest.artifact_type == MACHINE_ARTIFACT_TYPE
            && manifest.config.media_type == MACHINE_CONFIG_MEDIA_TYPE,
        "image manifest is not a machine image"
    );
    ensure!(
        manifest.config.digest.hex() == config_sha256 && manifest.config.size == config_bytes,
        "machine config is not the one the image manifest names"
    );
    let kernels = layers_of(manifest, KERNEL_MEDIA_TYPE);
    let initrds = layers_of(manifest, INITRD_MEDIA_TYPE);
    ensure!(
        kernels.len() == 1 && kernels.first().map(|layer| layer.digest.hex()) == kernel_sha256,
        "kernel is not the one the image manifest names"
    );
    ensure!(
        initrds.len() <= 1 && initrds.first().map(|layer| layer.digest.hex()) == initrd_sha256,
        "initrd is not the one the image manifest names"
    );

    let chunk_size = u64::from(IMAGE_CHUNK_SIZE_BYTES);
    let disk = &machine.disk;
    ensure!(
        disk.chunk_size == chunk_size
            && disk.size_bytes == virtual_size_bytes
            && disk.size_bytes > 0
            && disk.size_bytes <= MAX_CHUNKED_IMAGE_BYTES,
        "machine config disk geometry does not match the prepare request"
    );
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

fn layers_of<'a>(manifest: &'a OciManifestV1, media_type: &str) -> Vec<&'a OciDescriptorV1> {
    manifest
        .layers
        .iter()
        .filter(|layer| layer.media_type == media_type)
        .collect()
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
) -> Result<Vec<ImageChunk>> {
    let chunk_size = u64::from(IMAGE_CHUNK_SIZE_BYTES);
    let mut chunks = Vec::with_capacity(entries.len());
    let mut next_index = 0_u64;
    for (index, layer_index, raw_sha256) in entries {
        let offset = index
            .checked_mul(chunk_size)
            .filter(|offset| *offset < size_bytes && *index >= next_index)
            .with_context(|| format!("{label} {index} is out of order or out of range"))?;
        next_index = index + 1;
        let layer = manifest
            .layers
            .get(*layer_index as usize)
            .filter(|layer| layer.media_type == media_type)
            .with_context(|| format!("{label} {index} names no chunk layer"))?;
        // A zstd frame of a 4 MiB chunk is never twice its size.
        ensure!(
            layer.size > 0 && layer.size <= 2 * chunk_size,
            "{label} {index} has an implausible encoded size"
        );
        chunks.push(ImageChunk {
            index: u32::try_from(*index).context("chunk index")?,
            raw_size_bytes: u32::try_from(chunk_size.min(size_bytes - offset))
                .context("chunk size")?,
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
pub(super) fn verified_wake(manifest: &OciManifestV1, wake: &WakeV1) -> Result<VerifiedWake> {
    let layer = |descriptor: &&OciDescriptorV1| WakeLayer {
        sha256: descriptor.digest.hex().to_owned(),
        size_bytes: descriptor.size,
    };
    let stubs = layers_of(manifest, WAKE_STUB_MEDIA_TYPE);
    let profiles = layers_of(manifest, WAKE_CPU_PROFILE_MEDIA_TYPE);
    let ([stub], [profile]) = (stubs.as_slice(), profiles.as_slice()) else {
        bail!("wake needs exactly one stub and one CPU profile layer")
    };
    ensure!(
        profile.digest == wake.cpu_profile,
        "wake CPU profile is not the one the image manifest names"
    );
    ensure!(
        stub.size > 0
            && stub.size <= MAX_WAKE_STUB_BYTES
            && profile.size > 0
            && profile.size <= MAX_WAKE_CPU_PROFILE_BYTES,
        "wake stub or CPU profile has an implausible size"
    );
    let (ram, shape) = (&wake.ram, &wake.shape);
    ensure!(
        ram.chunk_size == u64::from(IMAGE_CHUNK_SIZE_BYTES)
            && ram.size_bytes > 0
            && ram.size_bytes <= MAX_WAKE_MEMORY_BYTES
            && shape.memory_bytes == ram.size_bytes,
        "wake RAM geometry is not sound"
    );
    ensure!(
        shape.boot_vcpus > 0
            && shape.boot_vcpus <= shape.max_vcpus
            && shape.max_vcpus <= MAX_WAKE_VCPUS,
        "wake vCPU shape is not sound"
    );
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
            ensure!(deltas.is_empty(), "a wake base carries no delta");
            None
        }
        Some(pack) => {
            let total = deltas.iter().try_fold(0_u64, |total, delta| {
                (delta.size > 0)
                    .then(|| total.checked_add(delta.size))
                    .flatten()
            });
            ensure!(
                !deltas.is_empty() && total.is_some_and(|total| total <= MAX_WAKE_DELTA_BYTES),
                "wake pack delta is missing or too large"
            );
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

fn open_trusted_chunk_cache(
    config: &JailerdConfig,
    source: &TrustedDirectorySource,
) -> Result<OwnedFd> {
    source.validate()?;
    let root = config
        .allowed_source_roots
        .get(usize::from(source.source_root))
        .context("chunk cache source-root index is outside configured roots")?;
    let root_fd = open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    let directory = open_source_beneath(&root_fd, &source.relative_path)?;
    let stat = rustix::fs::fstat(&directory)?;
    ensure!(
        rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::Directory
            && (stat.st_uid == 0 || stat.st_uid == config.agent_uid)
            && (stat.st_gid == 0 || stat.st_gid == config.agent_gid)
            && stat.st_mode & 0o002 == 0,
        "chunk cache directory identity is not trusted"
    );
    Ok(directory)
}

fn assemble_chunked_root(
    config: &JailerdConfig,
    manifest: &VerifiedImage,
    image_id: &Sha256Digest,
    chunk_cache: &OwnedFd,
    chunk_store: &OwnedFd,
    destination: &Path,
    lane: &PrepareLane,
) -> Result<ImageTemplateArtifactV2> {
    let root = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(destination)?;
    root.set_len(manifest.virtual_size_bytes)?;
    for chunk in &manifest.chunks {
        let source = ensure_raw_chunk(config, chunk_cache, chunk_store, chunk)?;
        ReflinkBlockBuilder::new(
            &source,
            &root,
            NonZeroU64::new(u64::from(chunk.raw_size_bytes)).context("image chunk size is zero")?,
        )
        .to_offset(u64::from(chunk.index) * u64::from(IMAGE_CHUNK_SIZE_BYTES))
        .reflink_block()
        .with_context(|| format!("FICLONERANGE image chunk {}", chunk.index))?;
        // A copy-on-write clone is metadata-only on the same filesystem, but a
        // cross-filesystem fallback copies the whole chunk. Charge the chunk
        // just placed, then give the foreground launch its turn.
        lane.charge(u64::from(chunk.raw_size_bytes))?;
    }
    root.sync_all()?;
    rustix::fs::fchmod(&root, Mode::RUSR)?;
    rustix::fs::fchown(
        &root,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    let stat = rustix::fs::fstat(&root)?;
    let artifact = ImageTemplateArtifactV2 {
        sha256: image_id.clone(),
        bytes: manifest.virtual_size_bytes,
        device: stat.st_dev as u64,
        inode: stat.st_ino,
    };
    validate_template_artifact_stat(&stat, &artifact, "assembled chunked root")?;
    Ok(artifact)
}

fn ensure_raw_chunk(
    config: &JailerdConfig,
    chunk_cache: &OwnedFd,
    chunk_store: &OwnedFd,
    chunk: &ImageChunk,
) -> Result<File> {
    let raw_name = format!("{}.raw", chunk.raw_sha256);
    let lock_name = format!(".lock-{}", chunk.raw_sha256);
    let lock = rustix::fs::openat(
        chunk_store,
        lock_name,
        OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )?;
    rustix::fs::flock(&lock, rustix::fs::FlockOperation::LockExclusive)?;
    if let Ok(existing) = open_verified_raw_chunk(chunk_store, &raw_name, chunk) {
        return Ok(existing);
    }

    let raw = read_verified_chunk(config, chunk_cache, chunk)?;

    let temporary_name = format!(".chunk-{}", Uuid::new_v4());
    let temporary_path = config.jail_root.join("chunks").join(&temporary_name);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(&temporary_path)?;
    output.write_all(&raw)?;
    output.sync_all()?;
    rustix::fs::fchmod(&output, Mode::RUSR)?;
    rustix::fs::fchown(
        &output,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    drop(output);
    rustix::fs::renameat(chunk_store, &temporary_name, chunk_store, &raw_name)?;
    open_verified_raw_chunk(chunk_store, &raw_name, chunk)
}

/// A blob of the cache, which names every blob by its digest: a regular,
/// singly linked file of the agent or root, not world-writable, of the
/// expected size.
pub(super) fn trusted_blob(
    config: &JailerdConfig,
    chunk_cache: &OwnedFd,
    sha256: &str,
    size_bytes: u64,
) -> Result<(File, std::fs::Metadata)> {
    let file = File::from(open_source_beneath(chunk_cache, Path::new(sha256))?);
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.nlink() == 1
            && (metadata.uid() == 0 || metadata.uid() == config.agent_uid)
            && (metadata.gid() == 0 || metadata.gid() == config.agent_gid)
            && metadata.mode() & 0o002 == 0
            && metadata.len() == size_bytes,
        "encoded image chunk source is not trusted"
    );
    Ok((file, metadata))
}

/// The raw content of one chunk, from its blob in the cache: the blob is a
/// trusted file of the encoded size and digest, and it decodes to the raw
/// size and digest.
pub(super) fn read_verified_chunk(
    config: &JailerdConfig,
    chunk_cache: &OwnedFd,
    chunk: &ImageChunk,
) -> Result<Vec<u8>> {
    let (mut encoded, before) = trusted_blob(
        config,
        chunk_cache,
        &chunk.encoded_sha256,
        chunk.encoded_size_bytes,
    )?;
    let mut encoded_bytes = Vec::with_capacity(chunk.encoded_size_bytes as usize);
    std::io::Read::by_ref(&mut encoded)
        .take(chunk.encoded_size_bytes + 1)
        .read_to_end(&mut encoded_bytes)?;
    ensure!(
        encoded_bytes.len() as u64 == chunk.encoded_size_bytes
            && sha256_digest(&encoded_bytes).as_str() == chunk.encoded_sha256,
        "encoded image chunk hash or size mismatch"
    );
    let after = encoded.metadata()?;
    ensure!(
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "encoded image chunk changed while being read"
    );

    let mut decoder = zstd::stream::read::Decoder::new(encoded_bytes.as_slice())?;
    let mut raw = Vec::with_capacity(chunk.raw_size_bytes as usize);
    decoder
        .by_ref()
        .take(u64::from(chunk.raw_size_bytes) + 1)
        .read_to_end(&mut raw)?;
    ensure!(
        raw.len() == chunk.raw_size_bytes as usize
            && sha256_digest(&raw).as_str() == chunk.raw_sha256,
        "decoded image chunk hash or size mismatch"
    );
    Ok(raw)
}

fn open_verified_raw_chunk(
    chunk_store: &OwnedFd,
    raw_name: &str,
    chunk: &ImageChunk,
) -> Result<File> {
    let fd = rustix::fs::openat(
        chunk_store,
        raw_name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    let mut file = File::from(fd);
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == 0
            && metadata.gid() == 0
            && metadata.nlink() == 1
            && metadata.mode() & 0o777 == 0o400
            && metadata.len() == u64::from(chunk.raw_size_bytes),
        "root-owned raw chunk metadata is invalid"
    );
    let mut bytes = Vec::with_capacity(chunk.raw_size_bytes as usize);
    file.read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() == chunk.raw_size_bytes as usize
            && sha256_digest(&bytes).as_str() == chunk.raw_sha256,
        "root-owned raw chunk hash mismatch"
    );
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
}

fn prepared_image_v3_result(metadata: &ImageTemplateMetadataV2) -> Result<PreparedImageV3Result> {
    let chunk_manifest_sha256 = metadata
        .chunk_manifest_sha256
        .clone()
        .context("chunked template is missing manifest identity")?;
    Ok(PreparedImageV3Result {
        image_id: metadata.image_sha256.clone(),
        chunk_manifest_sha256,
        virtual_size_bytes: metadata.virtual_size_bytes,
        root_disk: template_artifact_source(
            &metadata.image_sha256,
            "root.raw",
            &metadata.root_disk.sha256,
            ArtifactAccess::ReadWrite,
        ),
        kernel: template_artifact_source(
            &metadata.image_sha256,
            "kernel",
            &metadata.kernel.sha256,
            ArtifactAccess::ReadOnly,
        ),
        initrd: metadata.initrd.as_ref().map(|artifact| {
            template_artifact_source(
                &metadata.image_sha256,
                "initrd",
                &artifact.sha256,
                ArtifactAccess::ReadOnly,
            )
        }),
        fast_template_store: true,
        wake: metadata
            .wake
            .as_ref()
            .map(|wake| wake_artifacts(&metadata.image_sha256, wake)),
    })
}

fn sha256_digest(bytes: &[u8]) -> Sha256Digest {
    let digest = Sha256::digest(bytes);
    let encoded = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Sha256Digest::parse(encoded).expect("SHA-256 encoder is canonical")
}
