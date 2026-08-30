use super::*;

use std::num::NonZeroU64;
use std::os::unix::fs::MetadataExt as _;

use crate::store_gc::touch_chunked_template;
use intar_contracts::catalog::{IMAGE_CHUNK_SIZE_BYTES, ImageChunkManifestV1, ImageChunkV1};
use intar_jailer_protocol::TrustedDirectorySource;
use reflink_copy::ReflinkBlockBuilder;

const MAX_CHUNK_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

pub(super) fn prepare_chunked_image_template(
    config: &JailerdConfig,
    request: &PrepareChunkedImageV3Request,
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
        )?;
        let kernel =
            copy_template_source(config, &request.kernel, &temporary.join("kernel"), None)?;
        let initrd = request
            .initrd
            .as_ref()
            .map(|source| copy_template_source(config, source, &temporary.join("initrd"), None))
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
            && request.launch.artifacts.initrd == expected.initrd,
        "prepared chunked launch descriptors do not match root-owned metadata"
    );
    Ok(())
}

fn read_verified_chunk_manifest(
    config: &JailerdConfig,
    request: &PrepareChunkedImageV3Request,
) -> Result<ImageChunkManifestV1> {
    let mut file = open_trusted_source(
        config,
        request.manifest.source_root,
        &request.manifest.relative_path,
    )?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(MAX_CHUNK_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_CHUNK_MANIFEST_BYTES,
        "chunk manifest exceeds the bounded size"
    );
    ensure!(
        sha256_digest(&bytes) == request.chunk_manifest_sha256,
        "chunk manifest SHA-256 mismatch"
    );
    let manifest: ImageChunkManifestV1 =
        serde_json::from_slice(&bytes).context("decode chunk manifest")?;
    manifest.validate().context("validate chunk manifest")?;
    ensure!(
        manifest.image_id == request.image_id.as_str()
            && manifest.virtual_size_bytes == request.virtual_size_bytes,
        "chunk manifest identity does not match prepare request"
    );
    Ok(manifest)
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
    manifest: &ImageChunkManifestV1,
    image_id: &Sha256Digest,
    chunk_cache: &OwnedFd,
    chunk_store: &OwnedFd,
    destination: &Path,
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
    chunk: &ImageChunkV1,
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

    let encoded_name = format!("{}.raw.zst", chunk.raw_sha256);
    let encoded_fd = open_source_beneath(chunk_cache, Path::new(&encoded_name))?;
    let mut encoded = File::from(encoded_fd);
    let before = encoded.metadata()?;
    ensure!(
        before.is_file()
            && before.nlink() == 1
            && (before.uid() == 0 || before.uid() == config.agent_uid)
            && (before.gid() == 0 || before.gid() == config.agent_gid)
            && before.mode() & 0o002 == 0
            && before.len() == chunk.encoded_size_bytes,
        "encoded image chunk source is not trusted"
    );
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

fn open_verified_raw_chunk(
    chunk_store: &OwnedFd,
    raw_name: &str,
    chunk: &ImageChunkV1,
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
