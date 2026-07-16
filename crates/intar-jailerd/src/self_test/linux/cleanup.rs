use super::*;

pub(super) fn validate_worker_paths(
    report: &Path,
    allowed_dir: &Path,
    denied_path: &Path,
) -> Result<PathBuf> {
    for path in [report, allowed_dir, denied_path] {
        ensure!(
            path.is_absolute(),
            "self-test worker paths must be absolute"
        );
    }
    ensure!(
        report.parent() == Some(allowed_dir),
        "worker report must be directly beneath its allowed directory"
    );
    let root = allowed_dir
        .parent()
        .context("allowed directory has no disposable root")?;
    ensure!(
        denied_path.parent() == Some(root),
        "denied marker must be a sibling of the allowed directory"
    );
    ensure!(
        root.parent().and_then(Path::file_name) == Some(std::ffi::OsStr::new("self-test")),
        "worker paths must be beneath a self-test root"
    );
    Ok(root.to_path_buf())
}

pub(super) fn validate_attestation(attestation: &SelfTestAttestationV2) -> Result<()> {
    ensure!(
        attestation.version == ATTESTATION_VERSION,
        "unsupported self-test attestation version"
    );
    super::validate_sha256(&attestation.config_runtime_fingerprint_sha256)?;
    super::validate_sha256(&attestation.cloud_hypervisor_sha256)?;
    super::validate_sha256(&attestation.intar_jailerd_sha256)?;
    super::validate_sha256(&attestation.intar_jailer_sha256)?;
    ensure!(
        !attestation.boot_id.is_empty(),
        "attestation boot ID is empty"
    );
    ensure!(
        !attestation.kernel_version.is_empty(),
        "attestation kernel version is empty"
    );
    ensure!(
        !attestation.systemd_version.is_empty(),
        "attestation systemd version is empty"
    );
    ensure!(attestation.landlock_abi >= 3, "Landlock ABI 3 is required");
    ensure!(attestation.quota_verified, "CPU quota was not verified");
    ensure!(attestation.burst_verified, "CPU burst was not disabled");
    ensure!(
        attestation.boot_quota_transition_verified,
        "boot-to-steady CPU quota transition was not verified"
    );
    ensure!(
        attestation.network_verified,
        "run networking was not verified"
    );
    ensure!(
        attestation.landlock_negative_access,
        "Landlock negative-access proof is absent"
    );
    ensure!(
        attestation.kvm_accounting_proven,
        "KVM accounting proof is absent"
    );
    ensure!(
        attestation.cloud_hypervisor_lifecycle_verified,
        "jailed Cloud Hypervisor lifecycle proof is absent"
    );
    ensure!(
        attestation.passed_at_unix_s != 0,
        "attestation time is invalid"
    );
    Ok(())
}

pub(super) fn write_attestation(
    config: &JailerdConfig,
    attestation: &SelfTestAttestationV2,
) -> Result<()> {
    let root = open_trusted_attestation_root(config)?;
    let temporary = format!(".{ATTESTATION_FILE}.{}.tmp", Uuid::new_v4());
    let bytes = serde_json::to_vec(attestation)?;
    ensure!(
        bytes.len().saturating_add(1) as u64 <= MAX_ATTESTATION_BYTES,
        "self-test attestation exceeds 64 KiB"
    );
    let mut published = false;
    let operation = (|| -> Result<()> {
        let fd = openat2(
            &root,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
            trusted_child_resolve_flags(),
        )
        .context("create self-test attestation temporary file")?;
        let mut file = File::from(fd);
        validate_root_file_metadata(&file.metadata()?, 0o600)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        renameat_with(
            &root,
            temporary.as_str(),
            &root,
            ATTESTATION_FILE,
            RenameFlags::NOREPLACE,
        )
        .context("publish self-test attestation without replacement")?;
        published = true;
        rustix::fs::fsync(&root).context("sync self-test attestation directory")?;
        Ok(())
    })();
    if operation.is_err() {
        let name = if published {
            ATTESTATION_FILE
        } else {
            temporary.as_str()
        };
        let _ = unlinkat(&root, name, AtFlags::empty());
        let _ = rustix::fs::fsync(&root);
    }
    operation
}

pub(super) fn invalidate_previous_attestation(config: &JailerdConfig) -> Result<()> {
    let root = open_trusted_attestation_root(config)?;
    let file = match open_attestation_file(&root)? {
        Some(file) => file,
        None => return Ok(()),
    };
    // Never make a suspicious attestation disappear as a side effect of a
    // new run.  An operator must inspect and remove a tampered path.
    let original = file.metadata()?;
    validate_root_file_metadata(&original, 0o600)?;
    drop(file);
    let invalidating = format!(".{ATTESTATION_FILE}.{}.invalidating", Uuid::new_v4());
    renameat_with(
        &root,
        ATTESTATION_FILE,
        &root,
        invalidating.as_str(),
        RenameFlags::NOREPLACE,
    )
    .context("reserve previous attestation for invalidation")?;
    let operation = (|| -> Result<()> {
        let moved = openat2(
            &root,
            invalidating.as_str(),
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
            trusted_child_resolve_flags(),
        )?;
        let moved = File::from(moved);
        let current = moved.metadata()?;
        validate_root_file_metadata(&current, 0o600)?;
        ensure!(
            original.dev() == current.dev() && original.ino() == current.ino(),
            "previous attestation changed identity during invalidation"
        );
        drop(moved);
        unlinkat(&root, invalidating.as_str(), AtFlags::empty())
            .context("unlink invalidated self-test attestation")?;
        rustix::fs::fsync(&root).context("sync invalidated self-test attestation")?;
        Ok(())
    })();
    if let Err(error) = operation {
        let restore = renameat_with(
            &root,
            invalidating.as_str(),
            &root,
            ATTESTATION_FILE,
            RenameFlags::NOREPLACE,
        );
        let _ = rustix::fs::fsync(&root);
        return match restore {
            Ok(()) => Err(error),
            Err(restore_error) => Err(error).context(format!(
                "failed to restore previous attestation after invalidation failure: {restore_error}"
            )),
        };
    }
    Ok(())
}

pub(super) fn trusted_child_resolve_flags() -> ResolveFlags {
    ResolveFlags::BENEATH
        | ResolveFlags::NO_SYMLINKS
        | ResolveFlags::NO_MAGICLINKS
        | ResolveFlags::NO_XDEV
}

pub(super) fn open_attestation_file(root: &File) -> Result<Option<File>> {
    match openat2(
        root,
        ATTESTATION_FILE,
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        trusted_child_resolve_flags(),
    ) {
        Ok(fd) => Ok(Some(File::from(fd))),
        Err(error) if error == rustix::io::Errno::NOENT => Ok(None),
        Err(error) => Err(error).context("open self-test attestation beneath trusted root"),
    }
}

pub(super) fn open_trusted_attestation_root(config: &JailerdConfig) -> Result<File> {
    ensure_trusted_directory(&config.jail_root)?;
    let root = open_absolute_nofollow(&config.jail_root, OFlags::RDONLY | OFlags::DIRECTORY)
        .context("open trusted jail root")?;
    let metadata = root.metadata().context("stat opened jail root")?;
    ensure!(metadata.is_dir(), "opened jail root is not a directory");
    ensure!(metadata.uid() == 0, "opened jail root is not root-owned");
    ensure!(
        metadata.mode() & 0o022 == 0,
        "opened jail root is writable by group/other"
    );
    Ok(root)
}

pub(super) fn open_absolute_nofollow(path: &Path, flags: OFlags) -> Result<File> {
    ensure!(path.is_absolute(), "trusted path must be absolute");
    let relative = path
        .strip_prefix(Path::new("/"))
        .context("strip root from trusted path")?;
    ensure!(
        !relative.as_os_str().is_empty()
            && relative
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_))),
        "trusted path must contain only normal components"
    );
    let filesystem_root = open(
        "/",
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    let fd = openat2(
        &filesystem_root,
        relative,
        flags | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )?;
    Ok(File::from(fd))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CleanupIdentityReservationV1 {
    version: u16,
    generation: ValidatedId,
    uid: u32,
    gid: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CleanupOwner {
    Root,
    Vm,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct CleanupDevice {
    major: u32,
    minor: u32,
    mode: u32,
}

#[derive(Debug, Default)]
pub(super) struct CleanupPolicy {
    vm_owners: BTreeMap<String, (u32, u32)>,
}

impl CleanupPolicy {
    fn expected_vm_owner(&self, relative: &[Vec<u8>]) -> Option<(u32, u32)> {
        if relative.len() < 6
            || relative[0] != b"cloud-hypervisor-lifecycle"
            || relative[1] != b"jails"
            || !matches!(relative[2].as_slice(), b"cloud-hypervisor" | b"quarantine")
            || relative[4] != b"root"
        {
            return None;
        }
        let generation = std::str::from_utf8(&relative[3]).ok()?;
        self.vm_owners.get(generation).copied()
    }
}

pub(super) fn remove_disposable_directory(
    directory: &Path,
    uid_gid_start: u32,
    uid_gid_end: u32,
) -> Result<()> {
    ensure!(
        directory.is_absolute(),
        "disposable self-test jail path must be absolute"
    );
    let parent = directory
        .parent()
        .context("disposable self-test jail has no parent")?;
    ensure!(
        parent.file_name() == Some(std::ffi::OsStr::new("self-test")),
        "disposable self-test jail is outside its dedicated cleanup root"
    );
    let cleanup_root = parent
        .parent()
        .context("self-test cleanup root has no trusted parent")?;
    let original_name = directory
        .file_name()
        .context("disposable self-test jail has no file name")?;
    let generation = original_name
        .to_str()
        .context("disposable self-test generation is not UTF-8")?;
    ensure!(
        generation.len() == 32
            && generation
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "disposable self-test jail has an invalid generation name"
    );

    // Pin the configured jail root once, then resolve the dedicated
    // self-test directory beneath it with NO_XDEV as well as the complete
    // anti-symlink constraint set. Every later lookup and mutation is
    // relative to these stable descriptors; cleanup never canonicalizes
    // and reopens a caller-controlled pathname.
    ensure_trusted_directory(cleanup_root)?;
    let cleanup_root_fd = open_absolute_nofollow(cleanup_root, OFlags::RDONLY | OFlags::DIRECTORY)
        .context("open trusted self-test cleanup root")?;
    validate_cleanup_directory(&rustix::fs::fstat(&cleanup_root_fd)?)
        .context("validate trusted self-test cleanup root")?;
    let parent_fd = open_cleanup_directory(&cleanup_root_fd, "self-test")
        .context("open dedicated self-test directory beneath trusted jail root")?;
    validate_cleanup_directory(&rustix::fs::fstat(&parent_fd)?)
        .context("validate disposable self-test parent directory")?;

    let original_fd = open_cleanup_directory(&parent_fd, original_name)
        .context("open disposable self-test jail beneath trusted parent")?;
    let original_stat = rustix::fs::fstat(&original_fd)?;
    validate_cleanup_directory(&original_stat).context("validate disposable self-test jail")?;

    // Detach the operator-visible generation name before recursively
    // deleting anything. RENAME_NOREPLACE makes the transition exclusive;
    // if cleanup later fails we restore the original name when possible.
    let cleanup_name = CString::new(format!(".cleanup-{}", Uuid::new_v4().simple()))?;
    rustix::fs::renameat_with(
        &parent_fd,
        original_name,
        &parent_fd,
        cleanup_name.as_c_str(),
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .context("reserve private disposable self-test cleanup name")?;

    let operation = (|| -> Result<()> {
        rustix::fs::fsync(&parent_fd)?;
        let cleanup_fd = open_cleanup_directory(&parent_fd, cleanup_name.as_c_str())
            .context("reopen renamed disposable self-test jail")?;
        let cleanup_stat = rustix::fs::fstat(&cleanup_fd)?;
        ensure_same_cleanup_object(&original_stat, &cleanup_stat)
            .context("renamed disposable self-test jail changed identity")?;
        let policy = load_cleanup_policy(&cleanup_fd, uid_gid_start, uid_gid_end)?;
        remove_cleanup_directory_contents(&cleanup_fd, &policy, &[])?;

        // Re-resolve and compare immediately before unlinking the final
        // directory entry. This rejects path swaps even by another
        // privileged process instead of deleting the replacement.
        let final_fd = open_cleanup_directory(&parent_fd, cleanup_name.as_c_str())?;
        let final_stat = rustix::fs::fstat(&final_fd)?;
        ensure_same_cleanup_object(&original_stat, &final_stat)?;
        rustix::fs::unlinkat(
            &parent_fd,
            cleanup_name.as_c_str(),
            rustix::fs::AtFlags::REMOVEDIR,
        )?;
        rustix::fs::fsync(&parent_fd)?;
        Ok(())
    })();

    if let Err(operation_error) = operation {
        let restore = rustix::fs::renameat_with(
            &parent_fd,
            cleanup_name.as_c_str(),
            &parent_fd,
            original_name,
            rustix::fs::RenameFlags::NOREPLACE,
        );
        let _ = rustix::fs::fsync(&parent_fd);
        return match restore {
            Ok(()) => Err(operation_error),
            Err(restore_error) => Err(operation_error).context(format!(
                "failed to restore disposable self-test jail name after cleanup failure: {restore_error}"
            )),
        };
    }
    Ok(())
}

pub(super) fn open_cleanup_directory(
    parent: &impl std::os::fd::AsFd,
    name: impl rustix::path::Arg,
) -> Result<std::os::fd::OwnedFd> {
    Ok(openat2(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV,
    )?)
}

pub(super) fn open_cleanup_entry(
    parent: &impl std::os::fd::AsFd,
    name: impl rustix::path::Arg,
) -> Result<std::os::fd::OwnedFd> {
    Ok(openat2(
        parent,
        name,
        // Do not combine O_PATH with O_NOFOLLOW here: openat2 permits a
        // trailing symlink under that exact combination even when
        // RESOLVE_NO_SYMLINKS is set. Without O_NOFOLLOW, any symlink in
        // the lookup fails instead of returning a descriptor for it.
        OFlags::PATH | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV,
    )?)
}

pub(super) fn open_optional_cleanup_directory(
    parent: &impl std::os::fd::AsFd,
    name: &str,
) -> Result<Option<std::os::fd::OwnedFd>> {
    match openat2(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV,
    ) {
        Ok(fd) => {
            validate_cleanup_directory(&rustix::fs::fstat(&fd)?)?;
            Ok(Some(fd))
        }
        Err(error) if error == rustix::io::Errno::NOENT => Ok(None),
        Err(error) => Err(error).context("open optional self-test cleanup directory"),
    }
}

pub(super) fn open_cleanup_regular_file(
    parent: &impl std::os::fd::AsFd,
    name: impl rustix::path::Arg,
) -> Result<std::os::fd::OwnedFd> {
    Ok(openat2(
        parent,
        name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV,
    )?)
}

pub(super) fn load_cleanup_policy(
    cleanup_root: &impl std::os::fd::AsFd,
    uid_gid_start: u32,
    uid_gid_end: u32,
) -> Result<CleanupPolicy> {
    let Some(lifecycle) =
        open_optional_cleanup_directory(cleanup_root, "cloud-hypervisor-lifecycle")?
    else {
        return Ok(CleanupPolicy::default());
    };
    let Some(jails) = open_optional_cleanup_directory(&lifecycle, "jails")? else {
        return Ok(CleanupPolicy::default());
    };
    let Some(quarantine) = open_optional_cleanup_directory(&jails, "quarantine")? else {
        return Ok(CleanupPolicy::default());
    };
    let Some(reservations) = open_optional_cleanup_directory(&quarantine, "reservations")? else {
        return Ok(CleanupPolicy::default());
    };

    let mut policy = CleanupPolicy::default();
    let mut identities = BTreeSet::new();
    let mut stream = rustix::fs::Dir::read_from(&reservations)?;
    let mut names = Vec::new();
    while let Some(entry) = stream.read() {
        let entry = entry?;
        if matches!(entry.file_name().to_bytes(), b"." | b"..") {
            continue;
        }
        names.push(entry.file_name().to_owned());
    }
    drop(stream);

    for name in names {
        let fd = open_cleanup_regular_file(&reservations, name.as_c_str())?;
        let stat = rustix::fs::fstat(&fd)?;
        ensure!(
            rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::RegularFile
                && stat.st_uid == 0
                && stat.st_gid == 0
                && stat.st_nlink == 1
                && stat.st_mode & 0o177 == 0,
            "self-test identity reservation is not a root-owned private one-link regular file"
        );
        let mut bytes = Vec::new();
        File::from(fd)
            .take(MAX_ATTESTATION_BYTES + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_ATTESTATION_BYTES as usize,
            "self-test identity reservation exceeds 64 KiB"
        );
        let reservation: CleanupIdentityReservationV1 = serde_json::from_slice(&bytes)?;
        let generation = reservation.generation.as_str();
        ensure!(
            reservation.version == 1
                && reservation.uid == reservation.gid
                && (uid_gid_start..=uid_gid_end).contains(&reservation.uid)
                && name.to_bytes() == format!("{generation}.json").as_bytes(),
            "invalid self-test identity reservation"
        );
        ensure!(
            identities.insert(reservation.uid),
            "duplicate self-test VM identity reservation"
        );
        ensure!(
            policy
                .vm_owners
                .insert(generation.to_owned(), (reservation.uid, reservation.gid))
                .is_none(),
            "duplicate self-test generation reservation"
        );
    }
    Ok(policy)
}

pub(super) fn validate_cleanup_directory(stat: &rustix::fs::Stat) -> Result<()> {
    ensure!(
        rustix::fs::FileType::from_raw_mode(stat.st_mode).is_dir(),
        "cleanup target is not a directory"
    );
    ensure!(
        stat.st_uid == 0 && stat.st_gid == 0,
        "cleanup directory is not root-owned"
    );
    ensure!(
        stat.st_mode & 0o022 == 0,
        "cleanup directory is writable by group/other"
    );
    ensure!(stat.st_nlink >= 1, "cleanup directory has no links");
    Ok(())
}

pub(super) fn cleanup_jail_relative(relative: &[Vec<u8>]) -> Option<&[Vec<u8>]> {
    if relative.len() < 5
        || relative[0] != b"cloud-hypervisor-lifecycle"
        || relative[1] != b"jails"
        || !matches!(relative[2].as_slice(), b"cloud-hypervisor" | b"quarantine")
        || relative[4] != b"root"
    {
        return None;
    }
    Some(&relative[5..])
}

pub(super) fn cleanup_owner(
    stat: &rustix::fs::Stat,
    relative: &[Vec<u8>],
    policy: &CleanupPolicy,
) -> Result<CleanupOwner> {
    if (stat.st_uid, stat.st_gid) == (0, 0) {
        return Ok(CleanupOwner::Root);
    }
    ensure!(
        policy.expected_vm_owner(relative) == Some((stat.st_uid, stat.st_gid)),
        "cleanup entry has an unexpected owner"
    );
    Ok(CleanupOwner::Vm)
}

pub(super) fn validate_cleanup_tree_directory(
    stat: &rustix::fs::Stat,
    relative: &[Vec<u8>],
    policy: &CleanupPolicy,
) -> Result<CleanupOwner> {
    ensure!(
        rustix::fs::FileType::from_raw_mode(stat.st_mode).is_dir(),
        "cleanup target is not a directory"
    );
    ensure!(stat.st_nlink >= 1, "cleanup directory has no links");
    let owner = cleanup_owner(stat, relative, policy)?;
    if owner == CleanupOwner::Root {
        ensure!(
            stat.st_mode & 0o022 == 0,
            "root-owned cleanup directory is writable by group/other"
        );
    } else {
        ensure!(
            stat.st_mode & 0o002 == 0,
            "VM-owned cleanup directory is other-writable"
        );
    }
    Ok(owner)
}

pub(super) fn expected_cleanup_device(relative: &[Vec<u8>]) -> Option<CleanupDevice> {
    match cleanup_jail_relative(relative)? {
        [dev, kvm] if dev == b"dev" && kvm == b"kvm" => Some(CleanupDevice {
            major: 10,
            minor: 232,
            mode: 0o600,
        }),
        [dev, net, tun] if dev == b"dev" && net == b"net" && tun == b"tun" => Some(CleanupDevice {
            major: 10,
            minor: 200,
            mode: 0o600,
        }),
        [dev, urandom] if dev == b"dev" && urandom == b"urandom" => Some(CleanupDevice {
            major: 1,
            minor: 9,
            mode: 0o400,
        }),
        [dev, null] if dev == b"dev" && null == b"null" => Some(CleanupDevice {
            major: 1,
            minor: 3,
            mode: 0o600,
        }),
        _ => None,
    }
}

pub(super) fn cleanup_socket_allowed(relative: &[Vec<u8>]) -> bool {
    matches!(
        cleanup_jail_relative(relative),
        Some([run, socket])
            if run == b"run"
                && matches!(socket.as_slice(), b"cloud-hypervisor.sock" | b"kino.vsock")
    )
}

pub(super) fn validate_cleanup_leaf(
    stat: &rustix::fs::Stat,
    relative: &[Vec<u8>],
    policy: &CleanupPolicy,
) -> Result<()> {
    ensure!(stat.st_nlink == 1, "cleanup leaf must have one link");
    let owner = cleanup_owner(stat, relative, policy)?;
    let file_type = rustix::fs::FileType::from_raw_mode(stat.st_mode);
    match file_type {
        rustix::fs::FileType::RegularFile => {
            if owner == CleanupOwner::Root {
                ensure!(
                    stat.st_mode & 0o022 == 0,
                    "root-owned cleanup file is writable by group/other"
                );
            } else {
                ensure!(
                    stat.st_mode & 0o002 == 0,
                    "VM-owned cleanup file is other-writable"
                );
            }
        }
        rustix::fs::FileType::CharacterDevice => {
            let expected = expected_cleanup_device(relative)
                .context("cleanup character device is not allowlisted")?;
            ensure!(
                owner == CleanupOwner::Vm
                    && rustix::fs::major(stat.st_rdev) == expected.major
                    && rustix::fs::minor(stat.st_rdev) == expected.minor
                    && stat.st_mode & 0o777 == expected.mode,
                "cleanup character device does not match its allowlist entry"
            );
        }
        rustix::fs::FileType::Socket => {
            ensure!(
                owner == CleanupOwner::Vm
                    && cleanup_socket_allowed(relative)
                    && stat.st_mode & 0o002 == 0,
                "cleanup socket is not allowlisted"
            );
        }
        _ => bail!("cleanup leaf has a forbidden file type"),
    }
    Ok(())
}

pub(super) fn lock_cleanup_directory(
    directory: &impl std::os::fd::AsFd,
) -> Result<rustix::fs::Stat> {
    rustix::fs::fchown(
        directory,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    rustix::fs::fchmod(directory, Mode::RUSR | Mode::WUSR | Mode::XUSR)?;
    let stat = rustix::fs::fstat(directory)?;
    validate_cleanup_directory(&stat)?;
    Ok(stat)
}

pub(super) fn ensure_same_cleanup_object(
    expected: &rustix::fs::Stat,
    actual: &rustix::fs::Stat,
) -> Result<()> {
    ensure!(
        expected.st_dev == actual.st_dev
            && expected.st_ino == actual.st_ino
            && rustix::fs::FileType::from_raw_mode(expected.st_mode)
                == rustix::fs::FileType::from_raw_mode(actual.st_mode)
            && expected.st_uid == actual.st_uid
            && expected.st_gid == actual.st_gid,
        "cleanup target changed identity"
    );
    Ok(())
}

pub(super) fn remove_cleanup_directory_contents(
    directory: &impl std::os::fd::AsFd,
    policy: &CleanupPolicy,
    relative: &[Vec<u8>],
) -> Result<()> {
    let mut stream = rustix::fs::Dir::read_from(directory)?;
    let mut names = Vec::new();
    while let Some(entry) = stream.read() {
        let entry = entry?;
        if matches!(entry.file_name().to_bytes(), b"." | b"..") {
            continue;
        }
        names.push(entry.file_name().to_owned());
    }
    drop(stream);

    for name in names {
        let mut entry_relative = relative.to_vec();
        entry_relative.push(name.to_bytes().to_vec());
        let entry_fd = open_cleanup_entry(directory, name.as_c_str())
            .context("open disposable self-test cleanup entry")?;
        let entry_stat = rustix::fs::fstat(&entry_fd)?;
        let file_type = rustix::fs::FileType::from_raw_mode(entry_stat.st_mode);
        if file_type.is_dir() {
            validate_cleanup_tree_directory(&entry_stat, &entry_relative, policy)?;
            let child_fd = open_cleanup_directory(directory, name.as_c_str())?;
            let child_stat = rustix::fs::fstat(&child_fd)?;
            ensure_same_cleanup_object(&entry_stat, &child_stat)?;
            let locked_stat = lock_cleanup_directory(&child_fd)?;
            remove_cleanup_directory_contents(&child_fd, policy, &entry_relative)?;
            let final_fd = open_cleanup_directory(directory, name.as_c_str())?;
            let final_stat = rustix::fs::fstat(&final_fd)?;
            ensure_same_cleanup_object(&locked_stat, &final_stat)?;
            validate_cleanup_directory(&final_stat)?;
            rustix::fs::unlinkat(directory, name.as_c_str(), rustix::fs::AtFlags::REMOVEDIR)?;
        } else {
            validate_cleanup_leaf(&entry_stat, &entry_relative, policy)?;
            let final_fd = open_cleanup_entry(directory, name.as_c_str())?;
            let final_stat = rustix::fs::fstat(&final_fd)?;
            ensure_same_cleanup_object(&entry_stat, &final_stat)?;
            validate_cleanup_leaf(&final_stat, &entry_relative, policy)?;
            rustix::fs::unlinkat(directory, name.as_c_str(), rustix::fs::AtFlags::empty())?;
        }
    }
    rustix::fs::fsync(directory)?;
    Ok(())
}
