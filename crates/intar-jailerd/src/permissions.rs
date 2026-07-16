use super::*;

pub(super) fn ensure_directory(path: &Path, mode: u32) -> Result<()> {
    if !path.exists() {
        std::fs::create_dir(path)
            .with_context(|| format!("create directory {}", path.display()))?;
    }
    set_mode(path, mode)
}

pub(super) fn set_mode(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .with_context(|| format!("set mode on {}", path.display()))
}

#[cfg(target_os = "linux")]
pub(super) fn set_owner(path: &Path, uid: u32, gid: u32) -> Result<()> {
    rustix::fs::chown(
        path,
        Some(rustix::process::Uid::from_raw(uid)),
        Some(rustix::process::Gid::from_raw(gid)),
    )
    .with_context(|| format!("set owner on {}", path.display()))
}

#[cfg(target_os = "linux")]
pub(super) fn trusted_setfacl_binary() -> Result<PathBuf> {
    let setfacl = ["/usr/bin/setfacl", "/usr/sbin/setfacl"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path_is_root_trusted(path, false))
        .context("trusted setfacl binary is required")?;
    Ok(setfacl)
}

#[cfg(target_os = "linux")]
pub(super) struct PinnedAclTarget {
    fd: OwnedFd,
    before: rustix::fs::Stat,
    expected_uid: u32,
    expected_gid: u32,
    expected_group_class: u32,
    regular_file: bool,
    label: &'static str,
}

#[cfg(target_os = "linux")]
impl PinnedAclTarget {
    pub(super) fn directory(
        fd: OwnedFd,
        expected_uid: u32,
        expected_gid: u32,
        expected_group_class: u32,
        label: &'static str,
    ) -> Result<Self> {
        Self::new(
            fd,
            rustix::fs::FileType::Directory,
            expected_uid,
            expected_gid,
            expected_group_class,
            label,
        )
    }

    pub(super) fn regular_file(
        fd: OwnedFd,
        expected_uid: u32,
        expected_gid: u32,
        expected_group_class: u32,
        label: &'static str,
    ) -> Result<Self> {
        Self::new(
            fd,
            rustix::fs::FileType::RegularFile,
            expected_uid,
            expected_gid,
            expected_group_class,
            label,
        )
    }

    pub(super) fn new(
        fd: OwnedFd,
        expected_type: rustix::fs::FileType,
        expected_uid: u32,
        expected_gid: u32,
        expected_group_class: u32,
        label: &'static str,
    ) -> Result<Self> {
        let before = rustix::fs::fstat(&fd)?;
        ensure!(
            rustix::fs::FileType::from_raw_mode(before.st_mode) == expected_type
                && before.st_uid == expected_uid
                && before.st_gid == expected_gid,
            "{label} identity changed before applying its ACL"
        );
        let regular_file = expected_type == rustix::fs::FileType::RegularFile;
        if regular_file {
            ensure!(
                before.st_nlink == 1,
                "{label} must have exactly one link before applying its ACL"
            );
        }
        Ok(Self {
            fd,
            before,
            expected_uid,
            expected_gid,
            expected_group_class,
            regular_file,
            label,
        })
    }

    pub(super) fn proc_fd_path(&self) -> PathBuf {
        use std::os::fd::AsRawFd as _;

        PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            self.fd.as_raw_fd()
        ))
    }

    pub(super) fn attest_after(&self) -> Result<()> {
        let after = rustix::fs::fstat(&self.fd)?;
        ensure!(
            same_lifecycle_object(&self.before, &after),
            "{} inode changed while applying its ACL",
            self.label
        );
        ensure!(
            after.st_uid == self.expected_uid && after.st_gid == self.expected_gid,
            "{} ownership changed while applying its ACL",
            self.label
        );
        if self.regular_file {
            ensure!(
                after.st_nlink == 1,
                "{} link count changed while applying its ACL",
                self.label
            );
        }
        // The POSIX ACL mask is represented by the group-class mode bits.
        // Owner and other permissions are outside that mask and must remain
        // byte-for-byte equivalent to the pre-batch object.
        ensure!(
            after.st_mode & 0o707 == self.before.st_mode & 0o707,
            "{} owner or other permissions changed while applying its ACL",
            self.label
        );
        ensure!(
            after.st_mode & 0o070 == self.expected_group_class,
            "{} ACL mask differs from the requested group-class permissions",
            self.label
        );
        Ok(())
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SetfaclEdit {
    pub(super) acl: String,
    pub(super) paths: Vec<PathBuf>,
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn agent_acl_edits(
    traversal_paths: Vec<PathBuf>,
    run_path: PathBuf,
    logs_path: PathBuf,
    log_paths: Vec<PathBuf>,
    agent_uid: u32,
    vm_uid: u32,
) -> Vec<SetfaclEdit> {
    vec![
        SetfaclEdit {
            acl: format!("u:{agent_uid}:--x,m::--x"),
            paths: traversal_paths,
        },
        SetfaclEdit {
            acl: format!("u:{agent_uid}:rwx,m::rwx"),
            paths: vec![run_path.clone(), logs_path.clone()],
        },
        // The agent creates Kino's host-side readiness listener in the run
        // directory, while Cloud Hypervisor connects as the unique VM
        // identity. The socket later receives its own fd-pinned access ACL.
        SetfaclEdit {
            acl: format!("d:u:{agent_uid}:rwx,d:u:{vm_uid}:rwx,d:m::rwx"),
            paths: vec![run_path],
        },
        SetfaclEdit {
            acl: format!("d:u:{agent_uid}:rwx,d:m::rwx"),
            paths: vec![logs_path],
        },
        SetfaclEdit {
            acl: format!("u:{agent_uid}:rw-,m::rw-"),
            paths: log_paths,
        },
    ]
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn is_pinned_proc_fd_path(path: &Path) -> bool {
    let Some(value) = path.to_str().and_then(|value| value.strip_prefix("/proc/")) else {
        return false;
    };
    let mut components = value.split('/');
    let Some(pid) = components.next() else {
        return false;
    };
    let Some(fd_directory) = components.next() else {
        return false;
    };
    let Some(fd) = components.next() else {
        return false;
    };
    !pid.is_empty()
        && pid.bytes().all(|byte| byte.is_ascii_digit())
        && fd_directory == "fd"
        && !fd.is_empty()
        && fd.bytes().all(|byte| byte.is_ascii_digit())
        && components.next().is_none()
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn setfacl_batch_arguments(edits: &[SetfaclEdit]) -> Result<Vec<OsString>> {
    ensure!(!edits.is_empty(), "ACL helper batch requires an edit");
    let mut arguments = Vec::new();
    for edit in edits {
        ensure!(!edit.acl.is_empty(), "ACL helper edit is empty");
        ensure!(!edit.paths.is_empty(), "ACL helper edit requires a path");
        ensure!(
            edit.paths.iter().all(|path| is_pinned_proc_fd_path(path)),
            "ACL helper batch accepts only fd-pinned procfs paths"
        );
        arguments.push(OsString::from("--modify"));
        arguments.push(OsString::from(&edit.acl));
        arguments.extend(edit.paths.iter().map(|path| path.as_os_str().to_owned()));
    }
    Ok(arguments)
}

#[cfg(target_os = "linux")]
pub(super) fn run_setfacl_batch(program: &Path, edits: &[SetfaclEdit]) -> Result<()> {
    use std::process::{Command, Stdio};

    let path_count = edits.iter().map(|edit| edit.paths.len()).sum::<usize>();
    let output = Command::new(program)
        .args(setfacl_batch_arguments(edits)?)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("execute trusted ACL helper {}", program.display()))?;
    if !output.status.success() {
        bail!(
            "set {} ACL edit(s) on {path_count} fd-pinned path(s) failed: {}",
            edits.len(),
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn apply_agent_acls(
    config: &JailerdConfig,
    generation: &ValidatedId,
    vm_uid: u32,
    vm_gid: u32,
) -> Result<()> {
    let jail_root = trusted_jail_root_fd(config)?;
    let generation_parent = open_optional_root_directory_at(&jail_root, c"cloud-hypervisor")?
        .context("jail generation parent is missing while applying ACLs")?;
    let generation_name =
        CString::new(generation.as_str()).expect("validated generation contains no NUL");
    let generation_fd = open_lifecycle_entry_at(
        &generation_parent,
        &generation_name,
        OFlags::RDONLY | OFlags::DIRECTORY,
    )
    .context("open jail generation while applying ACLs")?;
    let root_fd =
        open_lifecycle_entry_at(&generation_fd, c"root", OFlags::RDONLY | OFlags::DIRECTORY)
            .context("open jail root while applying ACLs")?;
    let run_fd = open_lifecycle_entry_at(&root_fd, c"run", OFlags::RDONLY | OFlags::DIRECTORY)
        .context("open jail runtime directory while applying ACLs")?;
    let logs_fd = open_lifecycle_entry_at(&root_fd, c"logs", OFlags::RDONLY | OFlags::DIRECTORY)
        .context("open jail log directory while applying ACLs")?;
    let serial_fd = open_lifecycle_entry_at(&logs_fd, c"serial.log", OFlags::RDONLY)
        .context("open serial log while applying ACLs")?;
    let console_fd = open_lifecycle_entry_at(&logs_fd, c"console.log", OFlags::RDONLY)
        .context("open console log while applying ACLs")?;
    let stderr_fd =
        open_lifecycle_entry_at(&logs_fd, c"cloud-hypervisor.stderr.log", OFlags::RDONLY)
            .context("open Cloud Hypervisor stderr log while applying ACLs")?;

    let traversal_targets = [
        PinnedAclTarget::directory(jail_root, 0, 0, 0o010, "jail lifecycle root")?,
        PinnedAclTarget::directory(generation_parent, 0, 0, 0o010, "jail generation parent")?,
        PinnedAclTarget::directory(generation_fd, 0, 0, 0o010, "jail generation")?,
        PinnedAclTarget::directory(root_fd, 0, 0, 0o010, "jail root")?,
    ];
    let run_target =
        PinnedAclTarget::directory(run_fd, vm_uid, vm_gid, 0o070, "jail runtime directory")?;
    let logs_target =
        PinnedAclTarget::directory(logs_fd, vm_uid, vm_gid, 0o070, "jail log directory")?;
    let log_targets = [
        PinnedAclTarget::regular_file(serial_fd, vm_uid, vm_gid, 0o060, "serial log")?,
        PinnedAclTarget::regular_file(console_fd, vm_uid, vm_gid, 0o060, "console log")?,
        PinnedAclTarget::regular_file(
            stderr_fd,
            vm_uid,
            vm_gid,
            0o060,
            "Cloud Hypervisor stderr log",
        )?,
    ];

    let setfacl = trusted_setfacl_binary()?;
    let edits = agent_acl_edits(
        traversal_targets
            .iter()
            .map(PinnedAclTarget::proc_fd_path)
            .collect(),
        run_target.proc_fd_path(),
        logs_target.proc_fd_path(),
        log_targets
            .iter()
            .map(PinnedAclTarget::proc_fd_path)
            .collect(),
        config.agent_uid,
        vm_uid,
    );
    // GNU setfacl accepts repeated command/file groups. Keep the five
    // semantically distinct ACL edits, but execute them in one trusted helper
    // process. Every path is an fd-pinned procfs reference, so a pathname swap
    // cannot redirect any edit while the batch is running.
    run_setfacl_batch(&setfacl, &edits)?;

    for target in &traversal_targets {
        target.attest_after()?;
    }
    run_target.attest_after()?;
    logs_target.attest_after()?;
    for target in &log_targets {
        target.attest_after()?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn grant_agent_api_socket_access(
    config: &JailerdConfig,
    generation: &ValidatedId,
    uid: u32,
    gid: u32,
) -> Result<()> {
    use std::os::fd::AsRawFd as _;

    let jail_root = trusted_jail_root_fd(config)?;
    let generation_parent = open_optional_root_directory_at(&jail_root, c"cloud-hypervisor")?
        .context("jail generation parent is missing")?;
    let generation_name =
        CString::new(generation.as_str()).expect("validated generation contains no NUL");
    let generation_fd = open_lifecycle_entry_at(
        &generation_parent,
        &generation_name,
        OFlags::RDONLY | OFlags::DIRECTORY,
    )
    .context("open jail generation for runtime ACL")?;
    validate_root_directory(&generation_fd, "jail generation")?;
    let root_fd =
        open_lifecycle_entry_at(&generation_fd, c"root", OFlags::RDONLY | OFlags::DIRECTORY)
            .context("open jail root for runtime ACL")?;
    validate_root_directory(&root_fd, "jail root")?;
    let run_fd = open_lifecycle_entry_at(&root_fd, c"run", OFlags::RDONLY | OFlags::DIRECTORY)
        .context("open jail runtime directory")?;
    let run_stat = rustix::fs::fstat(&run_fd)?;
    ensure!(
        rustix::fs::FileType::from_raw_mode(run_stat.st_mode) == rustix::fs::FileType::Directory
            && run_stat.st_uid == uid
            && run_stat.st_gid == gid,
        "jail runtime directory identity changed"
    );

    let socket_fd = open_lifecycle_entry_at(&run_fd, c"cloud-hypervisor.sock", OFlags::PATH)
        .context("open Cloud Hypervisor API socket for runtime ACL")?;
    let before = rustix::fs::fstat(&socket_fd)?;
    validate_runtime_socket(&before, uid, gid)?;

    // Keep the verified socket inode pinned while the trusted helper applies
    // the ACL. Referring to this process's fd prevents a pathname swap from
    // redirecting setfacl; the fd remains open until the helper has exited.
    let pinned_path = PathBuf::from(format!(
        "/proc/{}/fd/{}",
        std::process::id(),
        socket_fd.as_raw_fd()
    ));
    run_setfacl(
        &trusted_setfacl_binary()?,
        &pinned_path,
        &format!("u:{}:rw-,m::rw-", config.agent_uid),
    )?;

    let after = rustix::fs::fstat(&socket_fd)?;
    validate_runtime_socket(&after, uid, gid)?;
    ensure!(
        same_lifecycle_object(&before, &after),
        "pinned Cloud Hypervisor API socket identity changed"
    );
    // POSIX ACL masks are reflected in the group-class mode bits. This catches
    // the exact failure where the named agent entry existed but was rendered
    // ineffective by Cloud Hypervisor's 0700 socket creation mode.
    ensure!(
        after.st_mode & 0o060 == 0o060,
        "Cloud Hypervisor API socket ACL mask does not grant read/write access"
    );

    let current_fd = open_lifecycle_entry_at(&run_fd, c"cloud-hypervisor.sock", OFlags::PATH)
        .context("reopen Cloud Hypervisor API socket after runtime ACL")?;
    let current = rustix::fs::fstat(&current_fd)?;
    validate_runtime_socket(&current, uid, gid)?;
    ensure!(
        same_lifecycle_object(&after, &current),
        "Cloud Hypervisor API socket was replaced while granting agent access"
    );
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn validate_runtime_socket(stat: &rustix::fs::Stat, uid: u32, gid: u32) -> Result<()> {
    ensure!(
        rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::Socket,
        "Cloud Hypervisor API path is not a Unix socket"
    );
    ensure!(
        stat.st_uid == uid && stat.st_gid == gid,
        "Cloud Hypervisor API socket identity changed"
    );
    ensure!(
        stat.st_nlink == 1,
        "Cloud Hypervisor API socket must have exactly one link"
    );
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn run_setfacl(program: &Path, path: &Path, acl: &str) -> Result<()> {
    run_setfacl_many(program, &[path], acl)
}

#[cfg(target_os = "linux")]
pub(super) fn run_setfacl_many(program: &Path, paths: &[&Path], acl: &str) -> Result<()> {
    use std::process::{Command, Stdio};

    ensure!(!paths.is_empty(), "ACL helper requires at least one path");
    let mut command = Command::new(program);
    command
        .args(["--modify", acl, "--"])
        .args(paths)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = command
        .output()
        .with_context(|| format!("execute trusted ACL helper {}", program.display()))?;
    if !output.status.success() {
        bail!(
            "set ACL on {} path(s) failed: {}",
            paths.len(),
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn apply_agent_acls(
    _config: &JailerdConfig,
    _generation: &ValidatedId,
    _vm_uid: u32,
    _vm_gid: u32,
) -> Result<()> {
    bail!("POSIX ACL staging is supported only on Linux")
}

#[cfg(not(target_os = "linux"))]
pub(super) fn grant_agent_api_socket_access(
    _config: &JailerdConfig,
    _generation: &ValidatedId,
    _uid: u32,
    _gid: u32,
) -> Result<()> {
    bail!("runtime socket ACLs are supported only on Linux")
}

#[cfg(not(target_os = "linux"))]
pub(super) fn set_owner(_path: &Path, _uid: u32, _gid: u32) -> Result<()> {
    Ok(())
}
