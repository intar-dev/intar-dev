use super::*;

#[derive(Clone, Copy)]
pub(super) struct IpNetnsTools<'a> {
    pub(super) nsenter: &'a Path,
    pub(super) ip: &'a Path,
    pub(super) netns_root: &'a Path,
}

pub(super) fn create_test_network(
    tools: IpNetnsTools<'_>,
    namespace: &str,
    host_veth: &str,
    peer_veth: &str,
    seed: &str,
    cleanup: &mut Cleanup,
) -> Result<()> {
    let octet = 1 + (u8::from_str_radix(&seed[..2], 16)? % 250);
    let ip_argument = tools
        .ip
        .to_str()
        .context("trusted ip binary path is not valid UTF-8")?;
    checked_ip_command(
        tools,
        [
            "link", "add", host_veth, "type", "veth", "peer", "name", peer_veth,
        ],
    )?;
    cleanup.host_veth_name = Some(host_veth.to_owned());
    checked_ip_command(tools, ["link", "set", peer_veth, "netns", namespace])?;
    let host_cidr = format!("198.18.{octet}.1/30");
    let peer_cidr = format!("198.18.{octet}.2/30");
    checked_ip_command(
        tools,
        ["address", "add", host_cidr.as_str(), "dev", host_veth],
    )?;
    checked_ip_command(tools, ["link", "set", host_veth, "up"])?;
    checked_ip_command(
        tools,
        [
            "netns",
            "exec",
            namespace,
            ip_argument,
            "link",
            "set",
            "lo",
            "up",
        ],
    )?;
    checked_ip_command(
        tools,
        [
            "netns",
            "exec",
            namespace,
            ip_argument,
            "address",
            "add",
            peer_cidr.as_str(),
            "dev",
            peer_veth,
        ],
    )?;
    checked_ip_command(
        tools,
        [
            "netns",
            "exec",
            namespace,
            ip_argument,
            "link",
            "set",
            peer_veth,
            "up",
        ],
    )?;
    Ok(())
}

pub(super) fn verify_network(
    tools: IpNetnsTools<'_>,
    namespace: &str,
    host_veth: &str,
    peer_veth: &str,
) -> Result<()> {
    let ip_argument = tools
        .ip
        .to_str()
        .context("trusted ip binary path is not valid UTF-8")?;
    ensure!(
        Path::new("/sys/class/net").join(host_veth).is_dir(),
        "self-test host veth is absent"
    );
    let output = checked_ip_command(
        tools,
        [
            "netns",
            "exec",
            namespace,
            ip_argument,
            "-o",
            "link",
            "show",
            peer_veth,
        ],
    )?;
    ensure!(
        String::from_utf8_lossy(&output.stdout).contains(peer_veth),
        "self-test namespace peer is absent"
    );
    let host_namespace = std::fs::metadata("/proc/self/ns/net")?;
    let namespace_inode = verify_host_visible_namespace(tools.netns_root, namespace)?;
    ensure!(
        host_namespace.ino() != namespace_inode,
        "self-test did not create a distinct network namespace"
    );
    Ok(())
}

pub(super) fn delete_test_network(
    nsenter: &Path,
    ip: &Path,
    netns_root: &Path,
    namespace: &str,
    host_veth: Option<&str>,
) -> Result<()> {
    if let Some(host_veth) = host_veth {
        let host_veth_path = Path::new("/sys/class/net").join(host_veth);
        if path_entry_exists(&host_veth_path)? {
            let result = checked_ip_command(
                IpNetnsTools {
                    nsenter,
                    ip,
                    netns_root,
                },
                ["link", "delete", host_veth],
            )
            .map(|_| ());
            accept_delete_outcome(
                result,
                path_entry_exists(&host_veth_path)?,
                "self-test host veth",
            )?;
        }
    }
    let initial_namespace_path = initial_mount_namespace_entry(netns_root, namespace)?;
    if path_entry_exists(&initial_namespace_path)? {
        let result = delete_host_visible_namespace(nsenter, ip, netns_root, namespace);
        accept_delete_outcome(
            result,
            path_entry_exists(&initial_namespace_path)?,
            "self-test network namespace",
        )?;
    }
    Ok(())
}

pub(super) fn accept_delete_outcome<T>(
    result: Result<T>,
    resource_still_exists: bool,
    resource: &str,
) -> Result<()> {
    if !resource_still_exists {
        // A concurrent kernel teardown may report ENODEV after the final
        // state has already been reached. The postcondition is authority.
        return Ok(());
    }
    match result {
        Ok(_) => bail!("{resource} leaked after deletion"),
        Err(error) => Err(error).with_context(|| format!("{resource} deletion failed")),
    }
}

pub(super) fn path_entry_exists(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
    }
}

pub(super) fn trusted_ip_binary() -> Result<PathBuf> {
    for path in ["/usr/bin/ip", "/usr/sbin/ip", "/sbin/ip"] {
        let path = Path::new(path);
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("stat trusted ip candidate {}", path.display()));
            }
        };
        // On merged-/usr distributions, /sbin/ip and /usr/sbin/ip are
        // symlinks to /usr/bin/ip. Never follow those aliases across the
        // privileged boundary; select only an actual regular file whose
        // complete ancestor chain can be validated below.
        if !metadata.is_file() {
            continue;
        }
        validate_trusted_executable_metadata(path, &metadata)?;
        return Ok(path.to_path_buf());
    }
    bail!("could not find a trusted absolute ip binary")
}

pub(super) fn trusted_current_exe() -> Result<TrustedCurrentExe> {
    let executable =
        std::fs::read_link("/proc/self/exe").context("read current jailerd executable link")?;
    validate_current_exe_link(&executable)?;
    let mut file = open_absolute_nofollow(&executable, OFlags::RDONLY)
        .context("open current jailerd executable without symlinks")?;
    let opened = file
        .metadata()
        .context("stat opened current jailerd executable")?;
    validate_trusted_executable_metadata(&executable, &opened)?;
    let running = std::fs::metadata("/proc/self/exe")?;
    ensure!(
        running.dev() == opened.dev() && running.ino() == opened.ino(),
        "opened jailerd executable differs from the running image"
    );
    let sha256 = file_sha256_reader(&mut file)?;
    Ok(TrustedCurrentExe {
        path: executable,
        sha256,
    })
}

pub(super) fn validate_current_exe_link(executable: &Path) -> Result<()> {
    ensure!(
        executable.is_absolute(),
        "current executable link is not absolute"
    );
    let text = executable
        .to_str()
        .context("current executable path is not valid UTF-8")?;
    ensure!(
        !text.ends_with(" (deleted)"),
        "current executable has been deleted"
    );
    ensure!(
        executable.components().all(|component| matches!(
            component,
            std::path::Component::RootDir | std::path::Component::Normal(_)
        )),
        "current executable path contains a non-normal component"
    );
    Ok(())
}

pub(super) fn trusted_executable_sha256(path: &Path) -> Result<String> {
    let mut file = open_absolute_nofollow(path, OFlags::RDONLY)
        .with_context(|| format!("open trusted executable {}", path.display()))?;
    let metadata = file.metadata().context("stat opened trusted executable")?;
    validate_trusted_executable_metadata(path, &metadata)?;
    file_sha256_reader(&mut file)
}

pub(super) fn validate_trusted_executable_metadata(
    path: &Path,
    metadata: &std::fs::Metadata,
) -> Result<()> {
    ensure!(
        metadata.is_file(),
        "trusted executable is not a regular file"
    );
    ensure!(metadata.uid() == 0, "trusted executable is not root-owned");
    ensure!(
        metadata.nlink() == 1,
        "trusted executable must have one hard link"
    );
    ensure!(
        metadata.mode() & 0o022 == 0,
        "trusted executable is group/other writable"
    );
    let mut ancestor = path.parent();
    while let Some(path) = ancestor {
        let metadata = std::fs::symlink_metadata(path)?;
        ensure!(
            metadata.is_dir(),
            "trusted executable ancestor is not a directory"
        );
        ensure!(
            metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
            "trusted executable has an untrusted ancestor"
        );
        ancestor = path.parent();
    }
    Ok(())
}

pub(super) fn checked_command<'a>(
    program: &Path,
    arguments: impl IntoIterator<Item = &'a str>,
) -> Result<Output> {
    let output = run_command(program, arguments)?;
    ensure!(
        output.status.success(),
        "{} failed: {}",
        program.display(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(output)
}

pub(super) fn checked_ip_command<'a>(
    tools: IpNetnsTools<'_>,
    arguments: impl IntoIterator<Item = &'a str>,
) -> Result<Output> {
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    ensure!(
        tools.netns_root == Path::new("/run/netns"),
        "self-test requires netns_root=/run/netns"
    );
    checked_host_mount_ip(
        tools.nsenter,
        tools.ip,
        arguments.iter().copied().map(OsStr::new),
    )
}

pub(super) fn run_command<'a>(
    program: &Path,
    arguments: impl IntoIterator<Item = &'a str>,
) -> Result<Output> {
    Command::new(program)
        .args(arguments)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("execute {}", program.display()))
}

pub(super) fn ensure_trusted_directory(path: &Path) -> Result<()> {
    let mut current = Some(path);
    while let Some(directory) = current {
        let metadata = std::fs::symlink_metadata(directory)?;
        ensure!(metadata.is_dir(), "trusted path is not a directory");
        ensure!(metadata.uid() == 0, "trusted directory is not root-owned");
        ensure!(
            metadata.mode() & 0o022 == 0,
            "trusted directory is writable by group/other"
        );
        current = directory.parent();
    }
    Ok(())
}

pub(super) fn create_root_directory(path: &Path) -> Result<()> {
    if path.exists() {
        return ensure_trusted_directory(path);
    }
    std::fs::create_dir(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    ensure_trusted_directory(path)
}

pub(super) fn validate_root_file_metadata(metadata: &std::fs::Metadata, mode: u32) -> Result<()> {
    ensure!(metadata.is_file(), "trusted file is not a regular file");
    ensure!(metadata.uid() == 0, "trusted file is not root-owned");
    ensure!(
        metadata.nlink() == 1,
        "trusted file must have one hard link"
    );
    ensure!(
        metadata.mode() & 0o777 == mode,
        "trusted file has unexpected permissions"
    );
    Ok(())
}

pub(super) fn write_new_root_file(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        // Keep the file private until all bytes are durable. The root
        // self-test deliberately inherits umask 077, so the requested
        // final mode must be applied through this already-open FD.
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    set_exact_file_mode(&file, mode)?;
    file.sync_all()?;
    validate_root_file_metadata(&file.metadata()?, mode)
}

pub(super) fn set_exact_file_mode(file: &File, mode: u32) -> Result<()> {
    ensure!(
        mode & !0o777 == 0,
        "trusted file mode contains non-permission bits"
    );
    rustix::fs::fchmod(file, Mode::from_raw_mode(mode))
        .context("set exact trusted file permissions")
}

pub(super) fn read_worker_report(path: &Path) -> Result<WorkerReportV1> {
    let metadata = std::fs::symlink_metadata(path)?;
    validate_root_file_metadata(&metadata, 0o600)?;
    ensure!(metadata.len() <= MAX_ATTESTATION_BYTES);
    let bytes = std::fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub(super) fn require_root() -> Result<()> {
    ensure!(
        rustix::process::geteuid() == rustix::process::Uid::ROOT,
        "intar-jailerd self-test must run as root"
    );
    Ok(())
}

pub(super) fn file_sha256_and_metadata(path: &Path) -> Result<(String, std::fs::Metadata)> {
    let mut file = open_absolute_nofollow(path, OFlags::RDONLY)
        .context("open self-test artifact without symlinks")?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "hashed path is not a regular file");
    ensure!(metadata.nlink() == 1, "hashed file must have one link");
    let sha256 = file_sha256_reader(&mut file)?;
    Ok((sha256, metadata))
}

pub(super) fn file_sha256_reader(file: &mut File) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        hasher.update(&buffer[..length]);
    }
    Ok(hex_digest(hasher.finalize()))
}

pub(super) fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let mut encoded = String::with_capacity(bytes.as_ref().len() * 2);
    for byte in bytes.as_ref() {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

pub(super) fn read_trimmed(path: &str) -> Result<String> {
    Ok(std::fs::read_to_string(path)?.trim().to_owned())
}
