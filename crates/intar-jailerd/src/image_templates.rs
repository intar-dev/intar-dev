use super::*;

pub(super) const MAX_IMAGE_TEMPLATE_METADATA_BYTES: usize = 4 * 1024 * 1024;

pub(super) fn open_host_template_artifact(
    config: &JailerdConfig,
    metadata: &HostTemplateMetadataV2,
    name: &CStr,
) -> Result<File> {
    let expected = match name.to_bytes() {
        b"cloud-hypervisor" => &metadata.cloud_hypervisor,
        b"intar-jailer" => &metadata.jailer,
        b"recordings.vfat" => &metadata.blank_recording,
        _ => bail!("host template artifact name is not allowed"),
    };
    let bundle = open_host_template_bundle(config, metadata)?;
    let fd = open_lifecycle_entry_at(&bundle, name, OFlags::RDONLY)?;
    let file = File::from(fd);
    validate_host_template_artifact_metadata(
        &file.metadata()?,
        expected,
        "host template artifact",
    )?;
    Ok(file)
}

pub(super) fn open_template_metadata(
    image_directory: &impl std::os::fd::AsFd,
) -> Result<ImageTemplateMetadataV2> {
    let bytes = read_root_metadata_at_bounded(
        image_directory,
        c"metadata-v2.json",
        MAX_IMAGE_TEMPLATE_METADATA_BYTES,
        "prepared image metadata exceeds bounded size",
    )?;
    decode_template_metadata(&bytes)
}

pub(super) fn decode_template_metadata(bytes: &[u8]) -> Result<ImageTemplateMetadataV2> {
    ensure!(
        bytes.len() <= MAX_IMAGE_TEMPLATE_METADATA_BYTES,
        "prepared image metadata exceeds bounded size"
    );
    serde_json::from_slice(bytes).context("decode prepared image metadata")
}

pub(super) fn copy_template_source(
    config: &JailerdConfig,
    source: &ArtifactSource,
    destination: &Path,
    expected_bytes: Option<u64>,
    lane: Option<&PrepareLane>,
) -> Result<ImageTemplateArtifactV2> {
    use std::os::unix::fs::MetadataExt as _;

    let expected = source
        .sha256
        .as_ref()
        .context("prepared image source digest is missing")?;
    let mut input = open_trusted_source(config, source.source_root, &source.relative_path)?;
    let before = input.metadata().context("stat prepared image source")?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(destination)
        .with_context(|| format!("create image template artifact {}", destination.display()))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = input
            .read(&mut buffer)
            .context("read prepared image source")?;
        if length == 0 {
            break;
        }
        bytes = bytes
            .checked_add(length as u64)
            .context("prepared image size overflow")?;
        hasher.update(&buffer[..length]);
        if buffer[..length].iter().all(|byte| *byte == 0) {
            output.seek(SeekFrom::Current(length as i64))?;
        } else {
            output.write_all(&buffer[..length])?;
        }
        if let Some(lane) = lane {
            // Charge the delta of this read and give the block away, before
            // the loop can hold its locks across a boot. The digest still
            // covers every byte read, so the yield cannot weaken it.
            lane.charge(length as u64)?;
        }
    }
    output.set_len(bytes)?;
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    let actual = Sha256Digest::parse(encoded).expect("SHA-256 encoder is canonical");
    if &actual != expected {
        bail!(
            "source SHA-256 mismatch: expected {}, got {}",
            expected.as_str(),
            actual.as_str()
        )
    }
    if expected_bytes.is_some_and(|expected| expected != bytes) {
        bail!("prepared image source size does not match advertised virtual size")
    }
    rustix::fs::fchmod(&output, Mode::RUSR)?;
    rustix::fs::fchown(
        &output,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    let after = input.metadata().context("restat prepared image source")?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
        || after.nlink() != 1
    {
        bail!("prepared image source changed while it was imported")
    }
    let stat = rustix::fs::fstat(&output)?;
    let artifact = ImageTemplateArtifactV2 {
        sha256: actual,
        bytes,
        device: stat.st_dev as u64,
        inode: stat.st_ino,
    };
    validate_template_artifact_stat(&stat, &artifact, "new image template artifact")?;
    Ok(artifact)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct TrustedDirectoryIdentity {
    pub(super) device: u64,
    pub(super) inode: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct FastTemplateStoreAttestation {
    pub(super) template_store: TrustedDirectoryIdentity,
    pub(super) generation_store: TrustedDirectoryIdentity,
    pub(super) allowed_source_roots: Vec<TrustedDirectoryIdentity>,
}

#[cfg(any(target_os = "linux", test))]
impl FastTemplateStoreAttestation {
    pub(super) fn covers_allowed_source_roots(&self, config: &JailerdConfig) -> bool {
        self.allowed_source_roots.len() == config.allowed_source_roots.len()
    }
}

#[cfg(target_os = "linux")]
pub(super) fn trusted_directory_identity(
    directory: &impl std::os::fd::AsFd,
) -> Result<TrustedDirectoryIdentity> {
    let stat = rustix::fs::fstat(directory)?;
    Ok(TrustedDirectoryIdentity {
        device: stat.st_dev as u64,
        inode: stat.st_ino as u64,
    })
}

#[cfg(target_os = "linux")]
pub(super) fn open_trusted_source_root_fd(config: &JailerdConfig, path: &Path) -> Result<OwnedFd> {
    ensure!(
        path_is_trusted_source_root(path, config.agent_uid, config.agent_gid),
        "configured artifact source root is not trusted: {}",
        path.display()
    );
    let directory = open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open configured artifact source root {}", path.display()))?;
    let stat = rustix::fs::fstat(&directory)?;
    ensure!(
        rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::Directory
            && (stat.st_uid == 0 || stat.st_uid == config.agent_uid)
            && (stat.st_gid == 0 || stat.st_gid == config.agent_gid)
            && stat.st_mode & 0o002 == 0,
        "configured artifact source root identity changed: {}",
        path.display()
    );
    Ok(directory)
}

/// Prove the exact route used by v2 launch staging. The anonymous source inode
/// is root-owned and never receives a directory entry, while the clone lives
/// under a pinned, root-owned generation-store fd and is removed fd-relatively.
/// This makes the readiness probe safe even when the source directory belongs
/// to the unprivileged agent.
#[cfg(target_os = "linux")]
pub(super) fn probe_exact_reflink_route(
    source_directory: &impl std::os::fd::AsFd,
    generation_store: &impl std::os::fd::AsFd,
    label: &str,
) -> Result<()> {
    use std::os::fd::AsRawFd as _;

    let source_fd = rustix::fs::openat(
        source_directory,
        c".",
        OFlags::RDWR | OFlags::TMPFILE | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )
    .with_context(|| format!("create anonymous root-owned {label} reflink probe"))?;
    let mut source = File::from(source_fd);
    source.write_all(b"intar-v2-exact-reflink-probe")?;
    rustix::fs::fchmod(&source, Mode::RUSR)?;
    rustix::fs::fchown(
        &source,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    let source_stat = rustix::fs::fstat(&source)?;
    ensure!(
        rustix::fs::FileType::from_raw_mode(source_stat.st_mode)
            == rustix::fs::FileType::RegularFile
            && source_stat.st_uid == 0
            && source_stat.st_gid == 0
            && source_stat.st_nlink == 0
            && source_stat.st_mode & 0o777 == 0o400,
        "anonymous {label} reflink probe did not retain root-only identity"
    );

    let clone_name = format!(".reflink-route-probe-{}", Uuid::new_v4());
    let source_path = PathBuf::from(format!("/proc/self/fd/{}", source.as_raw_fd()));
    let destination_path = PathBuf::from(format!(
        "/proc/self/fd/{}/{}",
        generation_store.as_fd().as_raw_fd(),
        clone_name
    ));
    let operation = (|| -> Result<()> {
        // Exact clone only. An EXDEV/EOPNOTSUPP result withdraws the entire v2
        // capability; this path must never fall back to byte copying.
        reflink_copy::reflink(&source_path, &destination_path).with_context(|| {
            format!("{label} cannot exact-reflink into the jail generation store")
        })?;
        let destination =
            open_lifecycle_entry_at(generation_store, clone_name.as_str(), OFlags::RDONLY)
                .with_context(|| format!("open cloned {label} reflink probe"))?;
        let destination_stat = rustix::fs::fstat(&destination)?;
        ensure!(
            rustix::fs::FileType::from_raw_mode(destination_stat.st_mode)
                == rustix::fs::FileType::RegularFile
                && destination_stat.st_uid == 0
                && destination_stat.st_gid == 0
                && destination_stat.st_nlink == 1
                && destination_stat.st_mode & 0o777 == 0o400
                && source_stat.st_dev == destination_stat.st_dev
                && source_stat.st_ino != destination_stat.st_ino
                && source_stat.st_size == destination_stat.st_size,
            "{label} reflink probe violated clone identity invariants"
        );
        Ok(())
    })();
    if operation.is_ok() {
        rustix::fs::unlinkat(
            generation_store,
            clone_name.as_str(),
            rustix::fs::AtFlags::empty(),
        )
        .with_context(|| format!("remove cloned {label} reflink probe"))?;
    } else {
        let _ = rustix::fs::unlinkat(
            generation_store,
            clone_name.as_str(),
            rustix::fs::AtFlags::empty(),
        );
    }
    operation
}

#[cfg(target_os = "linux")]
pub(super) fn probe_fast_template_store(
    config: &JailerdConfig,
) -> Result<FastTemplateStoreAttestation> {
    let jail_root = trusted_jail_root_fd(config)?;
    let templates = ensure_root_directory_at(&jail_root, c"templates")?;
    let generation_store = ensure_root_directory_at(&jail_root, c"cloud-hypervisor")?;

    probe_exact_reflink_route(&templates, &generation_store, "root-owned template store")?;
    let mut allowed_source_roots = Vec::with_capacity(config.allowed_source_roots.len());
    for (index, path) in config.allowed_source_roots.iter().enumerate() {
        let source = open_trusted_source_root_fd(config, path)?;
        probe_exact_reflink_route(
            &source,
            &generation_store,
            &format!("allowed source root {index} ({})", path.display()),
        )?;
        allowed_source_roots.push(trusted_directory_identity(&source)?);
    }

    Ok(FastTemplateStoreAttestation {
        template_store: trusted_directory_identity(&templates)?,
        generation_store: trusted_directory_identity(&generation_store)?,
        allowed_source_roots,
    })
}

#[cfg(not(target_os = "linux"))]
pub(super) fn probe_fast_template_store(
    _config: &JailerdConfig,
) -> Result<FastTemplateStoreAttestation> {
    bail!("exact v2 reflink readiness attestation is supported only on Linux")
}

#[cfg(target_os = "linux")]
pub(super) fn validate_fast_template_store_attestation(
    config: &JailerdConfig,
    attestation: &FastTemplateStoreAttestation,
) -> Result<()> {
    ensure!(
        attestation.covers_allowed_source_roots(config),
        "configured source-root set changed after exact-reflink readiness"
    );
    let jail_root = trusted_jail_root_fd(config)?;
    let templates =
        open_lifecycle_entry_at(&jail_root, c"templates", OFlags::RDONLY | OFlags::DIRECTORY)
            .context("open attested template store")?;
    validate_root_directory(&templates, "attested template store")?;
    let generation_store = open_lifecycle_entry_at(
        &jail_root,
        c"cloud-hypervisor",
        OFlags::RDONLY | OFlags::DIRECTORY,
    )
    .context("open attested generation store")?;
    validate_root_directory(&generation_store, "attested generation store")?;
    ensure!(
        trusted_directory_identity(&templates)? == attestation.template_store
            && trusted_directory_identity(&generation_store)? == attestation.generation_store,
        "jail template or generation filesystem identity changed after exact-reflink readiness"
    );
    for ((index, path), expected) in config
        .allowed_source_roots
        .iter()
        .enumerate()
        .zip(&attestation.allowed_source_roots)
    {
        let source = open_trusted_source_root_fd(config, path)?;
        ensure!(
            trusted_directory_identity(&source)? == *expected,
            "allowed source root {index} ({}) changed after exact-reflink readiness",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn validate_fast_template_store_attestation(
    _config: &JailerdConfig,
    _attestation: &FastTemplateStoreAttestation,
) -> Result<()> {
    bail!("exact v2 reflink readiness attestation is supported only on Linux")
}
