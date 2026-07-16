use super::*;

pub(super) fn prepare_jail_files(
    config: &JailerdConfig,
    request: &VmLaunchRequest,
    run_network: &RunNetworkResult,
    generation: &ValidatedId,
    uid: u32,
    gid: u32,
    host_template: Option<&HostTemplateMetadataV2>,
) -> Result<PreparedJail> {
    let generation_dir = generation_directory(config, generation);
    let root = generation_dir.join("root");
    let jail_root = trusted_jail_root_fd(config)?;
    let generation_parent = ensure_root_directory_at(&jail_root, c"cloud-hypervisor")?;
    let generation_name =
        CString::new(generation.as_str()).expect("validated generation name contains no NUL");
    rustix::fs::mkdirat(
        &generation_parent,
        &generation_name,
        Mode::RUSR | Mode::WUSR | Mode::XUSR,
    )
    .context("create exclusive fd-relative jail generation")?;
    let generation_fd = open_lifecycle_entry_at(
        &generation_parent,
        &generation_name,
        OFlags::RDONLY | OFlags::DIRECTORY,
    )?;
    validate_root_directory(&generation_fd, "new jail generation")?;
    rustix::fs::fchmod(&generation_fd, Mode::RUSR | Mode::WUSR | Mode::XUSR)?;
    for (relative, mode) in [
        ("root", 0o711),
        ("root/boot", 0o555),
        ("root/disks", 0o770),
        ("root/run", 0o770),
        ("root/logs", 0o770),
        ("root/dev", 0o755),
        ("root/dev/net", 0o755),
        ("root/proc", 0o555),
    ] {
        ensure_directory(&generation_dir.join(relative), mode)?;
    }

    let operation = (|| -> Result<PreparedJail> {
        let vmm_executable_identity = match host_template {
            Some(metadata) => {
                stage_prepared_template_source_file(
                    open_host_template_artifact(config, metadata, c"cloud-hypervisor")?,
                    &root.join("cloud-hypervisor"),
                    0o555,
                )?;
                stage_prepared_template_source_file(
                    open_host_template_artifact(config, metadata, c"intar-jailer")?,
                    &root.join("intar-jailer"),
                    0o555,
                )?;
                stage_artifacts_v2(
                    config,
                    &request.artifacts,
                    request.root_disk_size_bytes,
                    &root,
                    uid,
                    gid,
                    metadata,
                )?;
                Some(runtime_file_identity(&std::fs::metadata(
                    root.join("cloud-hypervisor"),
                )?))
            }
            None => {
                copy_verified_path(
                    &config.cloud_hypervisor_binary,
                    &root.join("cloud-hypervisor"),
                    Some(&config.cloud_hypervisor_sha256),
                    0o555,
                )?;
                copy_verified_path(
                    &config.jailer_binary,
                    &root.join("intar-jailer"),
                    None,
                    0o555,
                )?;
                stage_artifacts(config, &request.artifacts, &root, uid, gid)?;
                None
            }
        };
        for log in ["serial.log", "console.log", "cloud-hypervisor.stderr.log"] {
            create_exclusive_file(&root.join("logs").join(log), 0o600)?;
            set_owner(&root.join("logs").join(log), uid, gid)?;
        }
        set_owner(&root.join("disks"), 0, 0)?;
        set_mode(&root.join("disks"), 0o755)?;
        for directory in [root.join("run"), root.join("logs")] {
            set_owner(&directory, uid, gid)?;
            set_mode(&directory, 0o700)?;
        }
        apply_agent_acls(config, generation, uid, gid)?;

        if run_network.namespace_name.is_empty()
            || run_network.namespace_name.len() > 64
            || !run_network
                .namespace_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            bail!("invalid derived network namespace name")
        }
        let netns_path = config.netns_root.join(&run_network.namespace_name);
        let spec = JailSpecV1 {
            version: PROTOCOL_VERSION,
            generation: generation.clone(),
            uid,
            gid,
            jail_root: root.clone(),
            netns_path,
            netns_inode: run_network.namespace_inode,
            nofile_limit: 2_048,
            file_size_limit: config.vmm_file_size_limit_bytes,
        };
        spec.validate().context("validate root-owned jail spec")?;
        let spec_path = generation_dir.join("jail-spec-v1.json");
        let mut spec_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&spec_path)
            .context("create exclusive jail spec")?;
        to_writer(&mut spec_file, &spec).context("serialize jail spec")?;
        spec_file.write_all(b"\n").context("terminate jail spec")?;
        spec_file.sync_all().context("sync jail spec")?;
        let root_fd =
            open_lifecycle_entry_at(&generation_fd, c"root", OFlags::RDONLY | OFlags::DIRECTORY)?;
        let root_stat = validate_root_directory(&root_fd, "prepared jail root")?;

        Ok(PreparedJail {
            generation: generation.clone(),
            uid,
            gid,
            spec_path,
            jail_root_inode: Some(root_stat.st_ino),
            vmm_executable_identity,
            paths: jail_paths(&root, request.artifacts.initrd.is_some()),
        })
    })();
    match operation {
        Ok(prepared) => Ok(prepared),
        Err(error) => match remove_generation_tree(config, generation) {
            Ok(_) => Err(error),
            Err(cleanup_error) => {
                quarantine_generation(config, generation).with_context(|| {
                    format!(
                        "jail preparation failed ({error:#}); fd-relative cleanup also failed ({cleanup_error:#})"
                    )
                })?;
                Err(error).context(format!(
                    "jail cleanup failed and the generation was quarantined: {cleanup_error:#}"
                ))
            }
        },
    }
}

pub(super) fn stage_artifacts_v2(
    config: &JailerdConfig,
    artifacts: &SourceArtifacts,
    root_disk_size_bytes: u64,
    root: &Path,
    uid: u32,
    gid: u32,
    host_template: &HostTemplateMetadataV2,
) -> Result<()> {
    validate_template_launch_sources(artifacts)?;
    stage_source(config, &artifacts.kernel, &root.join("boot/kernel"), 0o444)?;
    if let Some(initrd) = &artifacts.initrd {
        stage_source(config, initrd, &root.join("boot/initrd"), 0o444)?;
    }
    stage_source(
        config,
        &artifacts.root_disk,
        &root.join("disks/root.raw"),
        0o600,
    )?;
    let root_disk_path = root.join("disks/root.raw");
    let template_size = std::fs::metadata(&root_disk_path)?.len();
    ensure!(
        root_disk_size_bytes >= template_size,
        "generation root disk cannot be smaller than its prepared template"
    );
    if root_disk_size_bytes > template_size {
        OpenOptions::new()
            .write(true)
            .open(&root_disk_path)
            .context("open cloned generation root disk for expansion")?
            .set_len(root_disk_size_bytes)
            .context("expand cloned generation root disk")?;
    }
    // Runtime state remains per-VM and read-only, but the recording disk is a
    // preformatted root-owned blank. Its agent descriptor is retained solely
    // as the trusted export destination after the cgroup drains.
    artifacts
        .runtime_disk
        .validate()
        .context("validate per-run runtime disk descriptor")?;
    ensure!(
        artifacts.runtime_disk.source_root != PREPARED_IMAGE_SOURCE_ROOT
            && artifacts.runtime_disk.access == ArtifactAccess::ReadOnly,
        "v2 runtime disk must be an agent-owned read-only source"
    );
    let runtime_source = open_trusted_source(
        config,
        artifacts.runtime_disk.source_root,
        &artifacts.runtime_disk.relative_path,
    )?;
    // Runtime configuration is unique per VM but immutable after publication.
    // Clone its extents exactly instead of copying and syncing 16 MiB on every
    // launch; a cross-filesystem host is not fast-launch eligible and fails.
    stage_prepared_template_source_file(runtime_source, &root.join("disks/runtime.raw"), 0o444)?;
    stage_prepared_template_source_file(
        open_host_template_artifact(config, host_template, c"recordings.vfat")?,
        &root.join("disks/recordings.vfat"),
        0o600,
    )?;
    for path in [
        root.join("disks/root.raw"),
        root.join("disks/recordings.vfat"),
    ] {
        set_mode(&path, 0o600)?;
        set_owner(&path, uid, gid)?;
    }
    set_mode(&root.join("disks/runtime.raw"), 0o444)?;
    set_owner(&root.join("disks/runtime.raw"), 0, 0)?;
    Ok(())
}

pub(super) fn stage_artifacts(
    config: &JailerdConfig,
    artifacts: &SourceArtifacts,
    root: &Path,
    uid: u32,
    gid: u32,
) -> Result<()> {
    validate_template_launch_sources(artifacts)?;
    stage_source(config, &artifacts.kernel, &root.join("boot/kernel"), 0o444)?;
    if let Some(initrd) = &artifacts.initrd {
        stage_source(config, initrd, &root.join("boot/initrd"), 0o444)?;
    }
    stage_source(
        config,
        &artifacts.root_disk,
        &root.join("disks/root.raw"),
        0o600,
    )?;
    stage_source(
        config,
        &artifacts.runtime_disk,
        &root.join("disks/runtime.raw"),
        0o600,
    )?;
    stage_source(
        config,
        &artifacts.recording_disk,
        &root.join("disks/recordings.vfat"),
        0o600,
    )?;
    for path in [
        root.join("disks/root.raw"),
        root.join("disks/recordings.vfat"),
    ] {
        set_mode(&path, 0o600)?;
        set_owner(&path, uid, gid)?;
    }
    set_mode(&root.join("disks/runtime.raw"), 0o444)?;
    set_owner(&root.join("disks/runtime.raw"), 0, 0)?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn export_recording_disk(config: &JailerdConfig, record: &VmRecord) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;

    let export = &record.request.artifacts.recording_disk;
    export
        .validate()
        .context("validate recording export descriptor")?;
    let root = config
        .allowed_source_roots
        .get(usize::from(export.source_root))
        .context("recording export source-root index is invalid")?;
    let parent_relative = export
        .relative_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = export
        .relative_path
        .file_name()
        .context("recording export has no file name")?;
    let root_fd = open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    let parent_fd = openat2(
        &root_fd,
        parent_relative,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_XDEV,
    )
    .context("open recording export directory beneath trusted root")?;
    let source_fd = open(
        &record.paths.host_recording_disk,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    let mut source = File::from(source_fd);
    let source_metadata = source.metadata()?;
    if !source_metadata.is_file()
        || source_metadata.nlink() != 1
        || source_metadata.uid() != record.uid
        || source_metadata.gid() != record.gid
        || source_metadata.mode() & 0o077 != 0
    {
        bail!("jailed recording disk ownership or mode changed")
    }
    let temporary = format!(".recording-export-{}", Uuid::new_v4());
    let operation = (|| -> Result<()> {
        let output_fd = rustix::fs::openat(
            &parent_fd,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::RUSR | Mode::WUSR,
        )?;
        let mut output = File::from(output_fd);
        std::io::copy(&mut source, &mut output).context("copy drained recording export")?;
        rustix::fs::fchmod(&output, Mode::RUSR | Mode::WUSR)?;
        rustix::fs::fchown(
            &output,
            Some(rustix::process::Uid::from_raw(config.agent_uid)),
            Some(rustix::process::Gid::from_raw(config.agent_gid)),
        )?;
        output.sync_all()?;
        let after = source.metadata()?;
        if source_metadata.len() != after.len()
            || source_metadata.mtime() != after.mtime()
            || source_metadata.mtime_nsec() != after.mtime_nsec()
        {
            bail!("recording disk changed after VM cgroup drain")
        }
        rustix::fs::renameat(&parent_fd, temporary.as_str(), &parent_fd, file_name)?;
        rustix::fs::fsync(&parent_fd)?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = rustix::fs::unlinkat(&parent_fd, temporary.as_str(), rustix::fs::AtFlags::empty());
    }
    operation
}

#[cfg(not(target_os = "linux"))]
pub(super) fn export_recording_disk(_config: &JailerdConfig, _record: &VmRecord) -> Result<()> {
    bail!("recording export is supported only on Linux")
}

pub(super) fn stage_source(
    config: &JailerdConfig,
    source: &intar_jailer_protocol::ArtifactSource,
    destination: &Path,
    mode: u32,
) -> Result<()> {
    if source.source_root == PREPARED_IMAGE_SOURCE_ROOT {
        let source_file = open_prepared_template_source(config, source)?;
        return stage_prepared_template_source_file(source_file, destination, mode);
    }
    let source_file = open_trusted_source(config, source.source_root, &source.relative_path)?;
    stage_source_file(
        source_file,
        destination,
        mode,
        source.sha256.as_ref(),
        &source.access,
    )
}

pub(super) fn template_source_image(source: &ArtifactSource) -> Option<&str> {
    if source.source_root != PREPARED_IMAGE_SOURCE_ROOT {
        return None;
    }
    let mut components = source.relative_path.components();
    let image = match components.next()? {
        std::path::Component::Normal(value) => value.to_str()?,
        _ => return None,
    };
    let _file = match components.next()? {
        std::path::Component::Normal(value) => value,
        _ => return None,
    };
    components.next().is_none().then_some(image)
}

pub(super) fn validate_template_launch_sources(artifacts: &SourceArtifacts) -> Result<()> {
    let root_template = template_source_image(&artifacts.root_disk);
    let kernel_template = template_source_image(&artifacts.kernel);
    let initrd_template = artifacts.initrd.as_ref().and_then(template_source_image);
    let has_any_template = root_template.is_some()
        || kernel_template.is_some()
        || initrd_template.is_some()
        || artifacts.runtime_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
        || artifacts.recording_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT;
    if !has_any_template {
        return Ok(());
    }
    let image = root_template.context("template-backed launch requires a prepared root disk")?;
    if kernel_template != Some(image)
        || artifacts
            .initrd
            .as_ref()
            .is_some_and(|_| initrd_template != Some(image))
        || artifacts.runtime_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
        || artifacts.recording_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
    {
        bail!(
            "template-backed launch must use one prepared boot bundle and agent-owned runtime disks"
        )
    }
    Ok(())
}

pub(super) fn open_prepared_template_source(
    config: &JailerdConfig,
    source: &ArtifactSource,
) -> Result<File> {
    source
        .validate()
        .context("validate prepared template source")?;
    let mut components = source.relative_path.components();
    let image_component = match components.next() {
        Some(std::path::Component::Normal(value)) => value,
        _ => bail!("prepared template source is missing its image identity"),
    };
    let file_component = match components.next() {
        Some(std::path::Component::Normal(value)) => value,
        _ => bail!("prepared template source is missing its artifact name"),
    };
    if components.next().is_some() {
        bail!("prepared template source path has unexpected components")
    }
    let image_sha256 = Sha256Digest::parse(
        image_component
            .to_str()
            .context("prepared template image identity is not UTF-8")?
            .to_owned(),
    )?;
    let file_name = file_component
        .to_str()
        .context("prepared template artifact name is not UTF-8")?;
    let jail_root = trusted_jail_root_fd(config)?;
    let templates = open_optional_root_directory_at(&jail_root, c"templates")?
        .context("prepared image template root is missing")?;
    let image_name = CString::new(image_sha256.as_str()).expect("SHA-256 contains no NUL");
    let image_directory =
        open_lifecycle_entry_at(&templates, &image_name, OFlags::RDONLY | OFlags::DIRECTORY)
            .context("open root-owned image template")?;
    validate_root_directory(&image_directory, "root-owned image template")?;
    let metadata = open_template_metadata(&image_directory)?;
    if metadata.schema_version != IMAGE_TEMPLATE_METADATA_VERSION
        || metadata.image_sha256 != image_sha256
    {
        bail!("prepared image template metadata identity mismatch")
    }
    let (expected, expected_access) = match file_name {
        "root.raw" => (&metadata.root_disk, ArtifactAccess::ReadWrite),
        "kernel" => (&metadata.kernel, ArtifactAccess::ReadOnly),
        "initrd" => (
            metadata
                .initrd
                .as_ref()
                .context("prepared image does not contain an initrd")?,
            ArtifactAccess::ReadOnly,
        ),
        _ => bail!("prepared template artifact name is not allowed"),
    };
    if source.access != expected_access || source.sha256.as_ref() != Some(&expected.sha256) {
        bail!("prepared template source access or digest does not match root-owned metadata")
    }
    let file_name = CString::new(file_name).expect("fixed artifact names contain no NUL");
    let fd = open_lifecycle_entry_at(&image_directory, &file_name, OFlags::RDONLY)
        .context("open root-owned template artifact")?;
    validate_template_artifact_stat(
        &rustix::fs::fstat(&fd)?,
        expected,
        "root-owned template artifact",
    )?;
    Ok(File::from(fd))
}

pub(super) fn stage_prepared_template_source_file(
    source: File,
    destination: &Path,
    mode: u32,
) -> Result<()> {
    use std::os::fd::AsRawFd as _;
    use std::os::unix::fs::MetadataExt as _;

    let before = source
        .metadata()
        .context("stat root-owned template source")?;
    let temporary = destination.with_file_name(format!(
        ".{}-reflink-{}",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .context("template destination name is not UTF-8")?,
        Uuid::new_v4()
    ));
    let source_path = PathBuf::from(format!("/proc/self/fd/{}", source.as_raw_fd()));
    let operation = (|| -> Result<()> {
        // Exact reflink only: the template capability must never degrade into
        // a multi-GiB copy on the VM launch path.
        reflink_copy::reflink(&source_path, &temporary)
            .with_context(|| format!("clone prepared template to {}", destination.display()))?;
        set_mode(&temporary, mode)?;
        let after = source
            .metadata()
            .context("restat root-owned template source")?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || after.nlink() != 1
        {
            bail!("root-owned template source changed while it was cloned")
        }
        let cloned = std::fs::metadata(&temporary)?;
        if !cloned.is_file()
            || cloned.nlink() != 1
            || cloned.dev() != before.dev()
            || cloned.ino() == before.ino()
            || cloned.len() != before.len()
        {
            bail!("prepared template clone did not preserve filesystem identity invariants")
        }
        std::fs::rename(&temporary, destination)
            .with_context(|| format!("publish cloned template {}", destination.display()))?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    operation
}

pub(super) fn open_trusted_source(
    config: &JailerdConfig,
    source_root: u16,
    relative: &Path,
) -> Result<File> {
    use std::os::unix::fs::MetadataExt as _;

    let root = config
        .allowed_source_roots
        .get(usize::from(source_root))
        .context("artifact source-root index is outside the configured roots")?;
    if relative.is_absolute()
        || relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        bail!("artifact source path must be a traversal-free relative path")
    }
    let root_fd = open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open trusted source root {}", root.display()))?;
    let source_fd = open_source_beneath(&root_fd, relative).with_context(|| {
        format!(
            "open trusted artifact source {}/{}",
            root.display(),
            relative.display()
        )
    })?;
    let file = File::from(source_fd);
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || !(metadata.uid() == 0 || metadata.uid() == config.agent_uid)
        || !(metadata.gid() == 0 || metadata.gid() == config.agent_gid)
        || metadata.mode() & 0o002 != 0
    {
        bail!("artifact source is not a regular file")
    }
    Ok(file)
}

pub(super) fn stage_source_file(
    mut source: File,
    destination: &Path,
    mode: u32,
    expected: Option<&Sha256Digest>,
    access: &intar_jailer_protocol::ArtifactAccess,
) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;

    let before = source.metadata().context("stat opened artifact source")?;
    let temporary = destination.with_file_name(format!(
        ".{}-staging-{}",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .context("artifact destination name is not UTF-8")?,
        Uuid::new_v4()
    ));

    let operation = (|| -> Result<()> {
        if matches!(access, intar_jailer_protocol::ArtifactAccess::ReadWrite) {
            reflink_open_file_exact(&mut source, &temporary)?;
            if let Some(expected) = expected {
                let mut staged = File::open(&temporary)?;
                verify_reader_digest(&mut staged, expected)?;
            }
        } else {
            copy_reader_verified(&mut source, &temporary, mode, expected)?;
        }
        let after = source.metadata().context("restat opened artifact source")?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || after.nlink() != 1
        {
            bail!("artifact source changed while it was being staged")
        }
        set_mode(&temporary, mode)?;
        std::fs::rename(&temporary, destination)
            .with_context(|| format!("publish staged file {}", destination.display()))?;
        File::open(
            destination
                .parent()
                .context("artifact destination parent")?,
        )?
        .sync_all()?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    operation
}

#[cfg(target_os = "linux")]
pub(super) fn reflink_open_file_exact(source: &mut File, destination: &Path) -> Result<()> {
    use std::os::fd::AsRawFd as _;

    let source_path = PathBuf::from(format!("/proc/self/fd/{}", source.as_raw_fd()));
    reflink_copy::reflink(&source_path, destination)
        .with_context(|| format!("exact-reflink staged disk {}", destination.display()))?;
    File::open(destination)?.sync_all()?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn reflink_open_file_exact(_source: &mut File, _destination: &Path) -> Result<()> {
    bail!("exact-reflink disk staging is supported only on Linux")
}
