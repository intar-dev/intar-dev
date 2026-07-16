use super::*;

pub(super) fn copy_reader_verified(
    source: &mut File,
    destination: &Path,
    mode: u32,
    expected: Option<&Sha256Digest>,
) -> Result<()> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(destination)
        .with_context(|| format!("create staged file {}", destination.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = source.read(&mut buffer).context("read artifact source")?;
        if length == 0 {
            break;
        }
        output.write_all(&buffer[..length])?;
        hasher.update(&buffer[..length]);
    }
    output.sync_all()?;
    if let Some(expected) = expected {
        let actual = hasher.finalize();
        let mut encoded = String::with_capacity(64);
        for byte in actual {
            use std::fmt::Write as _;
            let _ = write!(encoded, "{byte:02x}");
        }
        if encoded != expected.as_str() {
            bail!(
                "source SHA-256 mismatch: expected {}, got {encoded}",
                expected.as_str()
            )
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn open_source_beneath(
    root: &impl std::os::fd::AsFd,
    relative: &Path,
) -> std::io::Result<std::os::fd::OwnedFd> {
    openat2(
        root,
        relative,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_XDEV,
    )
    .map_err(std::io::Error::from)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn open_source_beneath(
    root: &impl std::os::fd::AsFd,
    relative: &Path,
) -> std::io::Result<std::os::fd::OwnedFd> {
    rustix::fs::openat(
        root,
        relative,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(std::io::Error::from)
}

pub(super) fn copy_verified_path(
    source: &Path,
    destination: &Path,
    expected: Option<&Sha256Digest>,
    mode: u32,
) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;

    let source_fd = open(
        source,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open trusted runtime {}", source.display()))?;
    let mut source_file = File::from(source_fd);
    let before = source_file.metadata().context("stat trusted runtime")?;
    if !before.is_file()
        || before.uid() != 0
        || before.gid() != 0
        || before.nlink() != 1
        || before.mode() & 0o022 != 0
    {
        bail!("trusted runtime must be a root-owned, non-writable regular file with one link")
    }
    copy_reader_verified(&mut source_file, destination, mode, expected)?;
    let after = source_file.metadata().context("restat trusted runtime")?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || after.nlink() != 1
    {
        bail!("trusted runtime changed while it was being copied")
    }
    set_mode(destination, mode)
}

pub(super) fn verify_reader_digest(reader: &mut File, expected: &Sha256Digest) -> Result<()> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = reader.read(&mut buffer).context("read source artifact")?;
        if length == 0 {
            break;
        }
        hasher.update(&buffer[..length]);
    }
    let actual = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in actual {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    if encoded != expected.as_str() {
        bail!(
            "source SHA-256 mismatch: expected {}, got {encoded}",
            expected.as_str()
        )
    }
    Ok(())
}

pub(super) fn create_exclusive_file(path: &Path, mode: u32) -> Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    set_mode(path, mode)
}

pub(super) fn jail_paths(root: &Path, has_initrd: bool) -> JailPathMap {
    JailPathMap {
        host_jail_root: root.to_path_buf(),
        host_api_socket: root.join("run/cloud-hypervisor.sock"),
        host_vsock_socket: root.join("run/kino.vsock"),
        host_kernel: root.join("boot/kernel"),
        host_initrd: has_initrd.then(|| root.join("boot/initrd")),
        host_root_disk: root.join("disks/root.raw"),
        host_runtime_disk: root.join("disks/runtime.raw"),
        host_recording_disk: root.join("disks/recordings.vfat"),
        jailed_api_socket: PathBuf::from("/run/cloud-hypervisor.sock"),
        jailed_vsock_socket: PathBuf::from("/run/kino.vsock"),
        jailed_kernel: PathBuf::from("/boot/kernel"),
        jailed_initrd: has_initrd.then(|| PathBuf::from("/boot/initrd")),
        jailed_root_disk: PathBuf::from("/disks/root.raw"),
        jailed_runtime_disk: PathBuf::from("/disks/runtime.raw"),
        jailed_recording_disk: PathBuf::from("/disks/recordings.vfat"),
        host_serial_log: root.join("logs/serial.log"),
        host_console_log: root.join("logs/console.log"),
        host_stderr_log: root.join("logs/cloud-hypervisor.stderr.log"),
        jailed_serial_log: PathBuf::from("/logs/serial.log"),
        jailed_console_log: PathBuf::from("/logs/console.log"),
    }
}

pub(super) fn generation_directory(config: &JailerdConfig, generation: &ValidatedId) -> PathBuf {
    config
        .jail_root
        .join("cloud-hypervisor")
        .join(generation.as_str())
}

#[cfg(target_os = "linux")]
pub(super) fn open_lifecycle_entry_at(
    parent: &impl std::os::fd::AsFd,
    path: impl rustix::path::Arg,
    flags: OFlags,
) -> rustix::io::Result<OwnedFd> {
    openat2(
        parent,
        path,
        flags | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_XDEV,
    )
}

#[cfg(not(target_os = "linux"))]
pub(super) fn open_lifecycle_entry_at(
    parent: &impl std::os::fd::AsFd,
    path: impl rustix::path::Arg,
    flags: OFlags,
) -> rustix::io::Result<OwnedFd> {
    rustix::fs::openat(
        parent,
        path,
        flags | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
}

pub(super) fn trusted_jail_root_fd(config: &JailerdConfig) -> Result<OwnedFd> {
    let fd = open(
        &config.jail_root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open jail lifecycle root {}", config.jail_root.display()))?;
    validate_root_directory(&fd, "jail lifecycle root")?;
    Ok(fd)
}

pub(super) fn validate_root_directory(
    fd: &impl std::os::fd::AsFd,
    label: &str,
) -> Result<rustix::fs::Stat> {
    let stat = rustix::fs::fstat(fd)?;
    if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::Directory
        || stat.st_uid != 0
        || stat.st_gid != 0
        || stat.st_mode & 0o022 != 0
    {
        bail!("{label} must be a root-owned, non-writable directory")
    }
    Ok(stat)
}

pub(super) fn open_optional_root_directory_at(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
) -> Result<Option<OwnedFd>> {
    match open_lifecycle_entry_at(parent, name, OFlags::RDONLY | OFlags::DIRECTORY) {
        Ok(fd) => {
            validate_root_directory(&fd, "jail lifecycle directory")?;
            Ok(Some(fd))
        }
        Err(error) if error == rustix::io::Errno::NOENT => Ok(None),
        Err(error) => Err(error).context("open jail lifecycle directory"),
    }
}

pub(super) fn ensure_root_directory_at(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
) -> Result<OwnedFd> {
    match rustix::fs::mkdirat(parent, name, Mode::RUSR | Mode::WUSR | Mode::XUSR) {
        Ok(()) => {}
        Err(error) if error == rustix::io::Errno::EXIST => {}
        Err(error) => return Err(error).context("create jail lifecycle directory"),
    }
    let fd = open_lifecycle_entry_at(parent, name, OFlags::RDONLY | OFlags::DIRECTORY)
        .context("open jail lifecycle directory after creation")?;
    validate_root_directory(&fd, "jail lifecycle directory")?;
    rustix::fs::fchmod(&fd, Mode::RUSR | Mode::WUSR | Mode::XUSR)?;
    Ok(fd)
}

pub(super) fn lifecycle_directory_names(fd: &impl std::os::fd::AsFd) -> Result<Vec<CString>> {
    let mut directory = rustix::fs::Dir::read_from(fd).context("open directory stream from fd")?;
    let mut names = Vec::new();
    while let Some(entry) = directory.read() {
        let entry = entry.context("read fd-relative directory entry")?;
        if matches!(entry.file_name().to_bytes(), b"." | b"..") {
            continue;
        }
        names.push(entry.file_name().to_owned());
    }
    Ok(names)
}

pub(super) fn lifecycle_owner_allowed(config: &JailerdConfig, uid: u32, gid: u32) -> bool {
    let uid_allowed = uid == 0
        || uid == config.agent_uid
        || (config.uid_gid_start..=config.uid_gid_end).contains(&uid);
    let gid_allowed = gid == 0
        || gid == config.agent_gid
        || (config.uid_gid_start..=config.uid_gid_end).contains(&gid);
    uid_allowed && gid_allowed
}

pub(super) fn same_lifecycle_object(left: &rustix::fs::Stat, right: &rustix::fs::Stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && rustix::fs::FileType::from_raw_mode(left.st_mode)
            == rustix::fs::FileType::from_raw_mode(right.st_mode)
}

#[cfg(target_os = "linux")]
pub(super) fn open_lifecycle_object_at(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
) -> rustix::io::Result<OwnedFd> {
    open_lifecycle_entry_at(parent, name, OFlags::PATH)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn open_lifecycle_object_at(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
) -> rustix::io::Result<OwnedFd> {
    open_lifecycle_entry_at(parent, name, OFlags::RDONLY)
}

pub(super) fn remove_directory_contents_fd_relative(
    config: &JailerdConfig,
    directory: &impl std::os::fd::AsFd,
    lock_uid: u32,
    lock_gid: u32,
) -> Result<()> {
    rustix::fs::fchown(
        directory,
        Some(rustix::process::Uid::from_raw(lock_uid)),
        Some(rustix::process::Gid::from_raw(lock_gid)),
    )
    .context("lock lifecycle directory owner")?;
    rustix::fs::fchmod(directory, Mode::RUSR | Mode::WUSR | Mode::XUSR)
        .context("lock lifecycle directory mode")?;

    for name in lifecycle_directory_names(directory)? {
        let before = rustix::fs::statat(directory, &name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)
            .context("stat fd-relative lifecycle entry")?;
        let file_type = rustix::fs::FileType::from_raw_mode(before.st_mode);
        if file_type == rustix::fs::FileType::Symlink {
            bail!("refusing to clean a symlink from a jail generation")
        }
        if !lifecycle_owner_allowed(config, before.st_uid, before.st_gid) {
            bail!("refusing to clean a jail entry with an unexpected owner")
        }
        if file_type != rustix::fs::FileType::Directory && before.st_nlink != 1 {
            bail!("refusing to clean a hard-linked jail entry")
        }

        if file_type == rustix::fs::FileType::Directory {
            let child =
                open_lifecycle_entry_at(directory, &name, OFlags::RDONLY | OFlags::DIRECTORY)
                    .context("open child jail directory beneath its pinned parent")?;
            let opened = rustix::fs::fstat(&child)?;
            if !same_lifecycle_object(&before, &opened) {
                bail!("jail directory changed while being opened")
            }
            remove_directory_contents_fd_relative(config, &child, lock_uid, lock_gid)?;
            let current =
                rustix::fs::statat(directory, &name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)?;
            if !same_lifecycle_object(&opened, &current) {
                bail!("jail directory changed before removal")
            }
            rustix::fs::unlinkat(directory, &name, rustix::fs::AtFlags::REMOVEDIR)
                .context("remove empty jail directory by fd")?;
        } else {
            let entry = open_lifecycle_object_at(directory, &name)
                .context("open jail object beneath its pinned parent")?;
            let opened = rustix::fs::fstat(&entry)?;
            if !same_lifecycle_object(&before, &opened) || opened.st_nlink != 1 {
                bail!("jail object changed while being opened")
            }
            let current =
                rustix::fs::statat(directory, &name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)?;
            if !same_lifecycle_object(&opened, &current) || current.st_nlink != 1 {
                bail!("jail object changed before removal")
            }
            rustix::fs::unlinkat(directory, &name, rustix::fs::AtFlags::empty())
                .context("remove jail object by fd")?;
        }
    }
    Ok(())
}

pub(super) fn remove_generation_tree(
    config: &JailerdConfig,
    generation: &ValidatedId,
) -> Result<bool> {
    let jail_root = trusted_jail_root_fd(config)?;
    let Some(parent) = open_optional_root_directory_at(&jail_root, c"cloud-hypervisor")? else {
        return Ok(false);
    };
    let name = CString::new(generation.as_str()).expect("validated generation has no NUL");
    let generation_fd =
        match open_lifecycle_entry_at(&parent, &name, OFlags::RDONLY | OFlags::DIRECTORY) {
            Ok(fd) => fd,
            Err(error) if error == rustix::io::Errno::NOENT => return Ok(false),
            Err(error) => return Err(error).context("open jail generation for cleanup"),
        };
    let opened = validate_root_directory(&generation_fd, "jail generation")?;
    remove_directory_contents_fd_relative(config, &generation_fd, 0, 0)?;
    let current = rustix::fs::statat(&parent, &name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)?;
    if !same_lifecycle_object(&opened, &current) {
        bail!("jail generation changed before final removal")
    }
    rustix::fs::unlinkat(&parent, &name, rustix::fs::AtFlags::REMOVEDIR)
        .context("remove jail generation by fd")?;
    rustix::fs::fsync(&parent)?;
    Ok(true)
}

pub(super) fn quarantine_entry_at(
    jail_root: &impl std::os::fd::AsFd,
    source_parent: &impl std::os::fd::AsFd,
    source_name: &CStr,
    source: &impl std::os::fd::AsFd,
    destination_name: &CStr,
) -> Result<()> {
    let source_stat = validate_root_directory(source, "quarantined jail generation")?;
    let current = rustix::fs::statat(
        source_parent,
        source_name,
        rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
    )?;
    if !same_lifecycle_object(&source_stat, &current) {
        bail!("jail generation changed before quarantine")
    }
    let quarantine = ensure_root_directory_at(jail_root, c"quarantine")?;
    match rustix::fs::statat(
        &quarantine,
        destination_name,
        rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
    ) {
        Err(error) if error == rustix::io::Errno::NOENT => {}
        Ok(_) => bail!("quarantine destination already exists"),
        Err(error) => return Err(error).context("inspect quarantine destination"),
    }
    rustix::fs::renameat(source_parent, source_name, &quarantine, destination_name)
        .context("quarantine jail generation by dirfd")?;
    let destination = open_lifecycle_entry_at(
        &quarantine,
        destination_name,
        OFlags::RDONLY | OFlags::DIRECTORY,
    )?;
    let destination_stat = rustix::fs::fstat(&destination)?;
    if !same_lifecycle_object(&source_stat, &destination_stat) {
        bail!("quarantined jail inode changed during rename")
    }
    rustix::fs::fsync(source_parent)?;
    rustix::fs::fsync(&quarantine)?;
    Ok(())
}

pub(super) fn quarantine_generation(
    config: &JailerdConfig,
    generation: &ValidatedId,
) -> Result<()> {
    let jail_root = trusted_jail_root_fd(config)?;
    let Some(parent) = open_optional_root_directory_at(&jail_root, c"cloud-hypervisor")? else {
        return Ok(());
    };
    let name = CString::new(generation.as_str()).expect("validated generation has no NUL");
    match rustix::fs::statat(&parent, &name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW) {
        Err(error) if error == rustix::io::Errno::NOENT => Ok(()),
        Ok(_) => {
            let source =
                open_lifecycle_entry_at(&parent, &name, OFlags::RDONLY | OFlags::DIRECTORY)?;
            quarantine_entry_at(&jail_root, &parent, &name, &source, &name)
        }
        Err(error) => Err(error).context("inspect jail generation for quarantine"),
    }
}

pub(super) fn identity_reservation_directory_fd(
    config: &JailerdConfig,
    create: bool,
) -> Result<Option<OwnedFd>> {
    let root = trusted_jail_root_fd(config)?;
    let quarantine = if create {
        ensure_root_directory_at(&root, c"quarantine")?
    } else {
        let Some(directory) = open_optional_root_directory_at(&root, c"quarantine")? else {
            return Ok(None);
        };
        directory
    };
    if create {
        Ok(Some(ensure_root_directory_at(
            &quarantine,
            c"reservations",
        )?))
    } else {
        open_optional_root_directory_at(&quarantine, c"reservations")
    }
}

pub(super) fn persist_identity_reservation(
    config: &JailerdConfig,
    generation: &ValidatedId,
    uid: u32,
    gid: u32,
) -> Result<()> {
    if uid != gid || !(config.uid_gid_start..=config.uid_gid_end).contains(&uid) {
        bail!("identity reservation is outside the configured UID/GID range")
    }
    let directory = identity_reservation_directory_fd(config, true)?
        .context("identity reservation directory was not created")?;
    let name = CString::new(format!("{}.json", generation.as_str()))
        .expect("validated reservation name contains no NUL");
    let reservation = IdentityReservationV1 {
        version: 1,
        generation: generation.clone(),
        uid,
        gid,
    };
    match open_lifecycle_entry_at(&directory, &name, OFlags::RDONLY) {
        Ok(_) => {
            let bytes = read_root_metadata_at(&directory, &name)?;
            let existing: IdentityReservationV1 = serde_json::from_slice(&bytes)?;
            if existing != reservation {
                bail!("identity reservation conflicts with an existing generation")
            }
            return Ok(());
        }
        Err(error) if error == rustix::io::Errno::NOENT => {}
        Err(error) => return Err(error).context("inspect existing identity reservation"),
    }

    let temporary = CString::new(format!(".reservation-{}.tmp", Uuid::new_v4()))
        .expect("UUID reservation name contains no NUL");
    let result = (|| -> Result<()> {
        let fd = rustix::fs::openat(
            &directory,
            &temporary,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::RUSR | Mode::WUSR,
        )?;
        let mut file = File::from(fd);
        to_writer(&mut file, &reservation)?;
        file.write_all(b"\n")?;
        rustix::fs::fchmod(&file, Mode::RUSR | Mode::WUSR)?;
        file.sync_all()?;
        validate_root_regular_file(&file, "new identity reservation")?;
        rustix::fs::renameat(&directory, &temporary, &directory, &name)
            .context("publish identity reservation by dirfd")?;
        rustix::fs::fsync(&directory)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = rustix::fs::unlinkat(&directory, &temporary, rustix::fs::AtFlags::empty());
    }
    result
}

pub(super) fn recover_identity_reservations(config: &JailerdConfig) -> Result<BTreeSet<u32>> {
    let Some(directory) = identity_reservation_directory_fd(config, false)? else {
        return Ok(BTreeSet::new());
    };
    let mut identities = BTreeSet::new();
    for name in lifecycle_directory_names(&directory)? {
        let bytes = read_root_metadata_at(&directory, &name)?;
        let reservation: IdentityReservationV1 = serde_json::from_slice(&bytes)?;
        let expected_name = format!("{}.json", reservation.generation);
        if reservation.version != 1
            || reservation.uid != reservation.gid
            || !(config.uid_gid_start..=config.uid_gid_end).contains(&reservation.uid)
            || name.to_bytes() != expected_name.as_bytes()
        {
            bail!("invalid durable identity reservation")
        }
        if !identities.insert(reservation.uid) {
            bail!("duplicate durable identity reservation")
        }
    }
    Ok(identities)
}
