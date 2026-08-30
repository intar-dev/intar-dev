use super::*;

pub(super) fn source_file_identity(metadata: &std::fs::Metadata) -> SourceFileIdentityV2 {
    use std::os::unix::fs::MetadataExt as _;

    SourceFileIdentityV2 {
        device: metadata.dev(),
        inode: metadata.ino(),
        bytes: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
    }
}

pub(super) fn validate_host_template_artifact_metadata(
    metadata: &std::fs::Metadata,
    expected: &HostTemplateArtifactV2,
    label: &str,
) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;

    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.gid() != 0
        || metadata.nlink() != 1
        || metadata.mode() & 0o222 != 0
    {
        bail!("{label} ownership, link count, mode, or file type changed")
    }
    let file_identity = source_file_identity(metadata);
    if file_identity != expected.identity {
        bail!("{label} pinned inode identity or timestamps changed")
    }
    Ok(())
}

pub(super) fn runtime_file_identity(metadata: &std::fs::Metadata) -> RuntimeFileIdentity {
    use std::os::unix::fs::MetadataExt as _;

    RuntimeFileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        bytes: metadata.len(),
    }
}

pub(super) fn digest_reader(reader: &mut File) -> Result<Sha256Digest> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = reader.read(&mut buffer).context("read template artifact")?;
        if length == 0 {
            break;
        }
        hasher.update(&buffer[..length]);
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(Sha256Digest::parse(encoded).expect("SHA-256 encoder is canonical"))
}

pub(super) fn host_template_bundle_sha256(
    cloud_hypervisor: &Sha256Digest,
    jailer: &Sha256Digest,
    blank_recording: &Sha256Digest,
) -> Sha256Digest {
    let mut hasher = Sha256::new();
    hasher.update(b"intar-host-template-v2\0");
    for digest in [cloud_hypervisor, jailer, blank_recording] {
        hasher.update(digest.as_str().as_bytes());
        hasher.update(b"\0");
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    Sha256Digest::parse(encoded).expect("SHA-256 encoder is canonical")
}

pub(super) fn template_artifact_source(
    image_sha256: &Sha256Digest,
    file_name: &str,
    sha256: &Sha256Digest,
    access: ArtifactAccess,
) -> ArtifactSource {
    ArtifactSource {
        source_root: PREPARED_IMAGE_SOURCE_ROOT,
        relative_path: PathBuf::from(image_sha256.as_str()).join(file_name),
        sha256: Some(sha256.clone()),
        access,
    }
}

pub(super) fn prepared_image_result(metadata: &ImageTemplateMetadataV2) -> PreparedImageV2Result {
    PreparedImageV2Result {
        image_sha256: metadata.image_sha256.clone(),
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
    }
}

pub(super) fn request_template_identity_matches(
    request: &PrepareImageV2Request,
    metadata: &ImageTemplateMetadataV2,
) -> bool {
    metadata.schema_version == IMAGE_TEMPLATE_METADATA_V2
        && metadata.image_sha256 == request.image_sha256
        && metadata.chunk_manifest_sha256.is_none()
        && metadata.chunk_raw_sha256s.is_empty()
        && metadata.virtual_size_bytes == request.virtual_size_bytes
        && request.root_disk.sha256.as_ref() == Some(&metadata.root_disk.sha256)
        && request.kernel.sha256.as_ref() == Some(&metadata.kernel.sha256)
        && request
            .initrd
            .as_ref()
            .and_then(|source| source.sha256.as_ref())
            == metadata.initrd.as_ref().map(|artifact| &artifact.sha256)
}

pub(super) fn validate_template_artifact_stat(
    stat: &rustix::fs::Stat,
    expected: &ImageTemplateArtifactV2,
    label: &str,
) -> Result<()> {
    if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
        || stat.st_uid != 0
        || stat.st_gid != 0
        || stat.st_nlink != 1
        || stat.st_mode & 0o222 != 0
        || stat_device_u64(stat) != Some(expected.device)
        || stat.st_ino != expected.inode
        || stat.st_size < 0
        || stat.st_size as u64 != expected.bytes
    {
        bail!("{label} identity, ownership, link count, mode, or size changed")
    }
    Ok(())
}

pub(super) fn stat_device_u64(stat: &rustix::fs::Stat) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        Some(stat.st_dev)
    }
    #[cfg(not(target_os = "linux"))]
    {
        u64::try_from(stat.st_dev).ok()
    }
}

pub(super) fn open_trusted_runtime_source(path: &Path) -> Result<File> {
    use std::os::unix::fs::MetadataExt as _;

    let fd = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open trusted runtime source {}", path.display()))?;
    let file = File::from(fd);
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.gid() != 0
        || metadata.nlink() != 1
        || metadata.mode() & 0o022 != 0
    {
        bail!("trusted runtime source must be root-owned, non-writable, regular, and single-linked")
    }
    Ok(file)
}

pub(super) fn validate_runtime_source_identity(
    path: &Path,
    expected: &SourceFileIdentityV2,
) -> Result<()> {
    let file = open_trusted_runtime_source(path)?;
    if &source_file_identity(&file.metadata()?) != expected {
        bail!("trusted runtime source inode identity changed after template preparation")
    }
    Ok(())
}

pub(super) fn copy_runtime_template_source(
    path: &Path,
    destination: &Path,
    expected: Option<&Sha256Digest>,
) -> Result<(SourceFileIdentityV2, HostTemplateArtifactV2)> {
    let mut source = open_trusted_runtime_source(path)?;
    let before = source_file_identity(&source.metadata()?);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(destination)
        .with_context(|| format!("create runtime template {}", destination.display()))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = source
            .read(&mut buffer)
            .context("read trusted runtime source")?;
        if length == 0 {
            break;
        }
        output.write_all(&buffer[..length])?;
        hasher.update(&buffer[..length]);
        bytes = bytes
            .checked_add(length as u64)
            .context("runtime template size overflow")?;
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    let actual = Sha256Digest::parse(encoded).expect("SHA-256 encoder is canonical");
    if expected.is_some_and(|expected| expected != &actual) {
        bail!("trusted runtime source digest does not match its root-owned pin")
    }
    rustix::fs::fchmod(&output, Mode::RUSR)?;
    rustix::fs::fchown(
        &output,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    if source_file_identity(&source.metadata()?) != before {
        bail!("trusted runtime source changed while its template was prepared")
    }
    let artifact = HostTemplateArtifactV2 {
        sha256: actual,
        identity: source_file_identity(&output.metadata()?),
    };
    validate_host_template_artifact_metadata(
        &output.metadata()?,
        &artifact,
        "new runtime template",
    )?;
    if artifact.identity.bytes != bytes {
        bail!("new runtime template size changed")
    }
    Ok((before, artifact))
}

pub(super) fn create_blank_recording_template(
    destination: &Path,
) -> Result<HostTemplateArtifactV2> {
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(destination)
        .with_context(|| format!("create blank recording template {}", destination.display()))?;
    let digest = format_blank_recording(&mut output)?;
    rustix::fs::fchmod(&output, Mode::RUSR)?;
    rustix::fs::fchown(
        &output,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    let artifact = HostTemplateArtifactV2 {
        sha256: digest,
        identity: source_file_identity(&output.metadata()?),
    };
    validate_host_template_artifact_metadata(
        &output.metadata()?,
        &artifact,
        "new blank recording template",
    )?;
    if artifact.identity.bytes != BLANK_RECORDING_BYTES {
        bail!("blank recording template size changed")
    }
    Ok(artifact)
}

pub(super) fn format_blank_recording(output: &mut File) -> Result<Sha256Digest> {
    output.set_len(BLANK_RECORDING_BYTES)?;
    fatfs::format_volume(
        &mut *output,
        fatfs::FormatVolumeOptions::new()
            .volume_id(BLANK_RECORDING_VOLUME_ID)
            .volume_label(BLANK_RECORDING_LABEL),
    )
    .context("format root-owned blank recording template")?;
    output.seek(SeekFrom::Start(0))?;
    digest_reader(output)
}

pub(super) fn read_optional_host_template_metadata(
    config: &JailerdConfig,
) -> Result<Option<HostTemplateMetadataV2>> {
    let jail_root = trusted_jail_root_fd(config)?;
    let Some(templates) = open_optional_root_directory_at(&jail_root, c"templates")? else {
        return Ok(None);
    };
    let pointer = CString::new(HOST_TEMPLATE_POINTER).expect("fixed pointer name has no NUL");
    match open_lifecycle_entry_at(&templates, &pointer, OFlags::RDONLY) {
        Ok(fd) => {
            validate_root_regular_file(&fd, "host template pointer")?;
            let mut bytes = Vec::new();
            File::from(fd)
                .take((intar_jailer_protocol::MAX_FRAME_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() > intar_jailer_protocol::MAX_FRAME_BYTES {
                bail!("host template pointer exceeds frame limit")
            }
            Ok(Some(
                serde_json::from_slice(&bytes).context("decode host template pointer")?,
            ))
        }
        Err(error) if error == rustix::io::Errno::NOENT => Ok(None),
        Err(error) => Err(error).context("open host template pointer"),
    }
}

pub(super) fn read_host_template_bundle(
    config: &JailerdConfig,
    bundle_sha256: &Sha256Digest,
) -> Result<(OwnedFd, HostTemplateBundleMetadataV2)> {
    let jail_root = trusted_jail_root_fd(config)?;
    let templates = open_optional_root_directory_at(&jail_root, c"templates")?
        .context("host template root is missing")?;
    let host = open_optional_root_directory_at(&templates, c"host-v2")?
        .context("host template bundle root is missing")?;
    let bundle_name =
        CString::new(bundle_sha256.as_str()).expect("SHA-256 bundle name contains no NUL");
    let bundle = open_lifecycle_entry_at(&host, &bundle_name, OFlags::RDONLY | OFlags::DIRECTORY)
        .context("open content-addressed host template bundle")?;
    validate_root_directory(&bundle, "host template bundle")?;
    let persisted: HostTemplateBundleMetadataV2 =
        serde_json::from_slice(&read_root_metadata_at(&bundle, c"metadata-v2.json")?)
            .context("decode host template bundle metadata")?;
    Ok((bundle, persisted))
}

pub(super) fn open_host_template_bundle(
    config: &JailerdConfig,
    metadata: &HostTemplateMetadataV2,
) -> Result<OwnedFd> {
    let (bundle, persisted) = read_host_template_bundle(config, &metadata.bundle_sha256)?;
    if persisted != HostTemplateBundleMetadataV2::from(metadata) {
        bail!("host template bundle metadata differs from its pinned pointer")
    }
    Ok(bundle)
}

pub(super) fn validate_host_template_bundle(
    config: &JailerdConfig,
    metadata: &HostTemplateMetadataV2,
) -> Result<()> {
    if metadata.schema_version != HOST_TEMPLATE_METADATA_VERSION
        || metadata.blank_recording.identity.bytes != BLANK_RECORDING_BYTES
        || metadata.bundle_sha256
            != host_template_bundle_sha256(
                &metadata.cloud_hypervisor.sha256,
                &metadata.jailer.sha256,
                &metadata.blank_recording.sha256,
            )
    {
        bail!("host template metadata identity is invalid")
    }
    let bundle = open_host_template_bundle(config, metadata)?;
    for (name, artifact, label) in [
        (
            c"cloud-hypervisor" as &CStr,
            &metadata.cloud_hypervisor,
            "Cloud Hypervisor template",
        ),
        (
            c"intar-jailer" as &CStr,
            &metadata.jailer,
            "jailer template",
        ),
        (
            c"recordings.vfat" as &CStr,
            &metadata.blank_recording,
            "blank recording template",
        ),
    ] {
        let fd = open_lifecycle_entry_at(&bundle, name, OFlags::RDONLY)
            .with_context(|| format!("open {label}"))?;
        let file = File::from(fd);
        validate_host_template_artifact_metadata(&file.metadata()?, artifact, label)?;
        if name == c"recordings.vfat" {
            let filesystem = fatfs::FileSystem::new(file, fatfs::FsOptions::new())
                .context("open blank recording template filesystem")?;
            if filesystem.volume_id() != BLANK_RECORDING_VOLUME_ID
                || filesystem.volume_label_as_bytes() != BLANK_RECORDING_DISPLAY_LABEL
                || filesystem.read_volume_label_from_root_dir_as_bytes()?
                    != Some(BLANK_RECORDING_LABEL)
            {
                bail!("blank recording template VFAT identity is invalid")
            }
        }
    }
    Ok(())
}

pub(super) fn validate_host_template(
    config: &JailerdConfig,
    expected: &HostTemplateMetadataV2,
) -> Result<()> {
    let pointer = read_optional_host_template_metadata(config)?
        .context("root-owned host template pointer is missing")?;
    if &pointer != expected {
        bail!("root-owned host template pointer changed after readiness")
    }
    validate_host_template_bundle(config, &pointer)?;
    if pointer.cloud_hypervisor.sha256 != config.cloud_hypervisor_sha256 {
        bail!("host runtime template differs from the configured Cloud Hypervisor pin")
    }
    validate_runtime_source_identity(
        &config.cloud_hypervisor_binary,
        &pointer.cloud_hypervisor_source,
    )?;
    validate_runtime_source_identity(&config.jailer_binary, &pointer.jailer_source)?;
    Ok(())
}

pub(super) fn source_was_atomically_replaced(
    current: &SourceFileIdentityV2,
    previous: &SourceFileIdentityV2,
    label: &str,
) -> Result<bool> {
    if current == previous {
        return Ok(false);
    }
    if current.device == previous.device && current.inode == previous.inode {
        bail!("{label} changed in place; refusing to rotate its pinned host template")
    }
    Ok(true)
}

pub(super) fn host_runtime_sources_were_replaced(
    config: &JailerdConfig,
    previous: &HostTemplateMetadataV2,
) -> Result<bool> {
    let cloud = open_trusted_runtime_source(&config.cloud_hypervisor_binary)?;
    let jailer = open_trusted_runtime_source(&config.jailer_binary)?;
    let cloud_replaced = source_was_atomically_replaced(
        &source_file_identity(&cloud.metadata()?),
        &previous.cloud_hypervisor_source,
        "Cloud Hypervisor source",
    )?;
    let jailer_replaced = source_was_atomically_replaced(
        &source_file_identity(&jailer.metadata()?),
        &previous.jailer_source,
        "jailer source",
    )?;
    Ok(cloud_replaced || jailer_replaced)
}

pub(super) fn write_root_owned_json<T: Serialize>(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
    value: &T,
    label: &str,
) -> Result<()> {
    let fd = rustix::fs::openat(
        parent,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR,
    )?;
    let mut file = File::from(fd);
    to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    rustix::fs::fchmod(&file, Mode::RUSR)?;
    rustix::fs::fchown(
        &file,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    file.sync_all()?;
    validate_root_regular_file(&file, label)?;
    Ok(())
}

pub(super) fn prepare_or_validate_host_template(
    config: &JailerdConfig,
) -> Result<HostTemplateMetadataV2> {
    let previous = match read_optional_host_template_metadata(config)? {
        Some(metadata) => match validate_host_template(config, &metadata) {
            Ok(()) => return Ok(metadata),
            Err(validation_error) => {
                // A normal package upgrade atomically replaces root-owned
                // binaries. Rotate only when the old pointer and bundle are
                // themselves intact and at least one trusted source has a new
                // inode. Same-inode mutation and malformed/tampered template
                // state remain fail-closed.
                validate_host_template_bundle(config, &metadata)
                    .context("existing host template is not safe to rotate")?;
                if !host_runtime_sources_were_replaced(config, &metadata)? {
                    return Err(validation_error)
                        .context("host template validation failed without a package replacement");
                }
                Some(metadata)
            }
        },
        None => None,
    };

    let jail_root = trusted_jail_root_fd(config)?;
    let templates = ensure_root_directory_at(&jail_root, c"templates")?;
    let host = ensure_root_directory_at(&templates, c"host-v2")?;
    let temporary_name = format!(".prepare-{}", Uuid::new_v4());
    rustix::fs::mkdirat(
        &host,
        temporary_name.as_str(),
        Mode::RUSR | Mode::WUSR | Mode::XUSR,
    )
    .context("create temporary host template bundle")?;
    let temporary = config
        .jail_root
        .join("templates")
        .join(HOST_TEMPLATE_DIRECTORY)
        .join(&temporary_name);
    let pointer_temporary_name = format!(".{HOST_TEMPLATE_POINTER}-{}", Uuid::new_v4());
    let operation = (|| -> Result<HostTemplateMetadataV2> {
        let (cloud_hypervisor_source, cloud_hypervisor) = copy_runtime_template_source(
            &config.cloud_hypervisor_binary,
            &temporary.join("cloud-hypervisor"),
            Some(&config.cloud_hypervisor_sha256),
        )?;
        let (jailer_source, jailer) = copy_runtime_template_source(
            &config.jailer_binary,
            &temporary.join("intar-jailer"),
            None,
        )?;
        let blank_recording = create_blank_recording_template(&temporary.join("recordings.vfat"))?;
        let mut metadata = HostTemplateMetadataV2 {
            schema_version: HOST_TEMPLATE_METADATA_VERSION,
            bundle_sha256: host_template_bundle_sha256(
                &cloud_hypervisor.sha256,
                &jailer.sha256,
                &blank_recording.sha256,
            ),
            cloud_hypervisor_source,
            jailer_source,
            cloud_hypervisor,
            jailer,
            blank_recording,
        };
        let temporary_fd = open_lifecycle_entry_at(
            &host,
            temporary_name.as_str(),
            OFlags::RDONLY | OFlags::DIRECTORY,
        )?;
        validate_root_directory(&temporary_fd, "temporary host template bundle")?;
        write_root_owned_json(
            &temporary_fd,
            c"metadata-v2.json",
            &HostTemplateBundleMetadataV2::from(&metadata),
            "new host template bundle metadata",
        )?;
        let bundle_name = CString::new(metadata.bundle_sha256.as_str())?;
        match rustix::fs::renameat(&host, temporary_name.as_str(), &host, &bundle_name) {
            Ok(()) => {}
            Err(rustix::io::Errno::EXIST | rustix::io::Errno::NOTEMPTY) => {
                std::fs::remove_dir_all(&temporary)?;
                let (_, existing) = read_host_template_bundle(config, &metadata.bundle_sha256)
                    .context("open existing content-addressed host template")?;
                if existing.schema_version != HOST_TEMPLATE_METADATA_VERSION
                    || existing.bundle_sha256 != metadata.bundle_sha256
                    || existing.cloud_hypervisor.sha256 != metadata.cloud_hypervisor.sha256
                    || existing.jailer.sha256 != metadata.jailer.sha256
                    || existing.blank_recording.sha256 != metadata.blank_recording.sha256
                {
                    bail!("existing content-addressed host template has mismatched digests")
                }
                // The same content may be reached after an atomic package
                // reinstall. Reuse the already durable template inodes while
                // pinning the replacement source identities in the new
                // pointer.
                metadata.cloud_hypervisor = existing.cloud_hypervisor;
                metadata.jailer = existing.jailer;
                metadata.blank_recording = existing.blank_recording;
                validate_host_template_bundle(config, &metadata)
                    .context("validate existing content-addressed host template")?;
            }
            Err(error) => return Err(error).context("publish content-addressed host template"),
        }
        // Make the complete content-addressed bundle durable before any
        // reader can observe a pointer to it.
        #[cfg(target_os = "linux")]
        rustix::fs::syncfs(&host).context("sync content-addressed host template bundle")?;
        #[cfg(not(target_os = "linux"))]
        File::open(
            config
                .jail_root
                .join("templates")
                .join(HOST_TEMPLATE_DIRECTORY),
        )?
        .sync_all()?;

        let pointer_name = CString::new(HOST_TEMPLATE_POINTER)?;
        let pointer_temporary = CString::new(pointer_temporary_name.as_str())?;
        write_root_owned_json(
            &templates,
            &pointer_temporary,
            &metadata,
            "new host template pointer",
        )
        .context("write next host template pointer")?;
        let current = read_optional_host_template_metadata(config)?;
        if current.as_ref() != previous.as_ref() {
            bail!("host template pointer changed during atomic rotation")
        }
        rustix::fs::renameat(&templates, &pointer_temporary, &templates, &pointer_name)
            .context("atomically publish host template pointer")?;
        rustix::fs::fsync(&templates).context("sync host template pointer directory")?;
        #[cfg(target_os = "linux")]
        rustix::fs::syncfs(&templates).context("sync host template store")?;
        #[cfg(not(target_os = "linux"))]
        File::open(config.jail_root.join("templates"))?.sync_all()?;
        Ok(metadata)
    })();
    if operation.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
        let _ = rustix::fs::unlinkat(
            &templates,
            pointer_temporary_name.as_str(),
            rustix::fs::AtFlags::empty(),
        );
    }
    let metadata = operation?;
    validate_host_template(config, &metadata)?;
    Ok(metadata)
}
