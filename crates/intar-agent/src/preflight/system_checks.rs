use super::*;

pub(super) fn push_capacity_check(
    checks: &mut Vec<PreflightCheck>,
    capabilities: &JailerCapabilities,
) {
    let valid = capabilities.total_cpu_millis > 0
        && capabilities.reserved_cpu_millis <= capabilities.total_cpu_millis
        && capabilities.schedulable_cpu_millis
            == capabilities
                .total_cpu_millis
                .saturating_sub(capabilities.reserved_cpu_millis)
        && capabilities.committed_cpu_millis <= capabilities.schedulable_cpu_millis;
    push_bool_check(
        checks,
        "jailerd CPU capacity",
        valid,
        format!(
            "{}m total, {}m reserved, {}m schedulable, {}m committed",
            capabilities.total_cpu_millis,
            capabilities.reserved_cpu_millis,
            capabilities.schedulable_cpu_millis,
            capabilities.committed_cpu_millis
        ),
        format!(
            "invalid capacity: {}m total, {}m reserved, {}m schedulable, {}m committed",
            capabilities.total_cpu_millis,
            capabilities.reserved_cpu_millis,
            capabilities.schedulable_cpu_millis,
            capabilities.committed_cpu_millis
        ),
    );
}

pub(super) fn push_bool_check(
    checks: &mut Vec<PreflightCheck>,
    name: impl Into<String>,
    ready: bool,
    pass_detail: impl Into<String>,
    fail_detail: impl Into<String>,
) {
    checks.push(if ready {
        pass(name, pass_detail)
    } else {
        fail(name, fail_detail)
    });
}

pub(super) fn push_command_check(
    checks: &mut Vec<PreflightCheck>,
    name: &str,
    command: &str,
    path_entries: &[PathBuf],
) {
    match resolve_command(command, path_entries) {
        Some(path) => checks.push(pass(name, format!("found {}", path.display()))),
        None => checks.push(fail(
            name,
            format!("'{}' was not found or is not executable", command),
        )),
    }
}

pub(super) fn push_trusted_helper_check(
    checks: &mut Vec<PreflightCheck>,
    name: &str,
    helper: &Result<PathBuf, String>,
) {
    match helper {
        Ok(path) => checks.push(pass(
            name,
            format!("trusted root-owned helper at {}", path.display()),
        )),
        Err(error) => checks.push(fail(name, error.clone())),
    }
}

pub(super) fn push_char_device_presence_check(
    checks: &mut Vec<PreflightCheck>,
    name: &str,
    path: &Path,
) {
    match path.metadata() {
        Ok(metadata) if is_char_device(&metadata) => checks.push(pass(
            name,
            format!("character device exists at {}", path.display()),
        )),
        Ok(_) => {
            checks.push(fail(
                name,
                format!("'{}' exists but is not a character device", path.display()),
            ));
        }
        Err(_) => {
            checks.push(fail(name, format!("'{}' is missing", path.display())));
        }
    }
}

pub(super) fn push_socket_check(checks: &mut Vec<PreflightCheck>, name: &str, path: &Path) {
    match path.metadata() {
        #[cfg(unix)]
        Ok(metadata) if std::os::unix::fs::FileTypeExt::is_socket(&metadata.file_type()) => {
            checks.push(pass(name, format!("socket exists at {}", path.display())));
        }
        Ok(_) => checks.push(fail(
            name,
            format!("'{}' exists but is not a Unix socket", path.display()),
        )),
        Err(error) => checks.push(fail(
            name,
            format!("'{}' is not ready: {error}", path.display()),
        )),
    }
}

pub(super) fn push_dir_result_check(
    checks: &mut Vec<PreflightCheck>,
    name: &str,
    path: &Result<PathBuf, String>,
) {
    match path {
        Ok(path) => push_dir_check(checks, name, path),
        Err(error) => checks.push(fail(name, error.clone())),
    }
}

pub(super) fn push_vm_work_dir_check(
    checks: &mut Vec<PreflightCheck>,
    cfg: &AgentConfig,
    env: &PreflightEnvironment,
) {
    match cfg.vm_defaults.work_dir.as_ref() {
        Some(path) => push_dir_check(checks, "vm work_dir", path),
        None => push_dir_result_check(checks, "vm work_dir", &env.default_work_root),
    }
}

pub(super) fn push_dir_check(checks: &mut Vec<PreflightCheck>, name: &str, path: &Path) {
    match path.metadata() {
        Ok(metadata) if metadata.is_dir() => {
            checks.push(pass(
                name,
                format!("directory exists at {}", path.display()),
            ));
        }
        Ok(_) => checks.push(fail(
            name,
            format!("'{}' is not a directory", path.display()),
        )),
        Err(error) => checks.push(fail(
            name,
            format!("'{}' is not ready: {}", path.display(), error),
        )),
    }
}

pub(super) fn push_bridge_check(checks: &mut Vec<PreflightCheck>, cfg: &AgentConfig) {
    if !cfg.bridge.enabled {
        checks.push(fail(
            "bridge configuration",
            "bridge.enabled must be true for deployed scenario desired-state convergence",
        ));
        return;
    }
    checks.push(pass(
        "bridge configuration",
        format!(
            "host {} connects to {}",
            cfg.bridge.host_id, cfg.bridge.base_url
        ),
    ));
}

pub(super) fn push_registry_check(checks: &mut Vec<PreflightCheck>, cfg: &AgentConfig) {
    if cfg.image_registry.url.trim().is_empty() {
        checks.push(fail(
            "image registry",
            "image_registry.url must point at the Worker image registry",
        ));
    } else {
        checks.push(pass(
            "image registry",
            format!("using {}", cfg.image_registry.url),
        ));
    }
}

pub(super) async fn query_jailerd_capabilities(
    cfg: &AgentConfig,
) -> Result<JailerCapabilities, String> {
    let socket = cfg.jailer.socket.clone();
    let timeout = Duration::from_secs(cfg.jailer.request_timeout_seconds);
    let request = async move {
        let mut client = AsyncSeqpacketClient::connect(&socket)
            .map_err(|error| format!("failed to connect to {}: {error}", socket.display()))?;
        match client
            .request(JailerRequest::Capabilities)
            .await
            .map_err(|error| format!("Capabilities request failed: {error}"))?
        {
            JailerResponse::Capabilities(capabilities) => Ok(capabilities),
            JailerResponse::Error(error) => Err(format!(
                "jailerd rejected Capabilities: {}: {}",
                error.code, error.message
            )),
            response => Err(format!(
                "jailerd returned an unexpected Capabilities response: {response:?}"
            )),
        }
    };
    tokio::time::timeout(timeout, request).await.map_err(|_| {
        format!(
            "jailerd Capabilities handshake timed out after {} seconds",
            cfg.jailer.request_timeout_seconds
        )
    })?
}

pub(super) fn read_systemd_version(path_entries: &[PathBuf]) -> Result<String, String> {
    let command = resolve_command("systemctl", path_entries)
        .ok_or_else(|| "'systemctl' was not found or is not executable".to_string())?;
    let output = Command::new(&command)
        .arg("--version")
        .output()
        .map_err(|error| format!("failed to run {} --version: {error}", command.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} --version exited with {}",
            command.display(),
            output.status
        ));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("systemctl --version returned non-UTF-8 output: {error}"))?;
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "systemctl --version returned no version line".to_string())
}

pub(super) fn parse_systemd_major_version(value: &str) -> Option<u32> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| !part.is_empty())?
        .parse()
        .ok()
}

pub(super) fn find_trusted_nsenter() -> Result<PathBuf, String> {
    let mut failures = Vec::new();
    for path in [
        Path::new("/usr/bin/nsenter"),
        Path::new("/usr/sbin/nsenter"),
    ] {
        match validate_trusted_root_executable(path) {
            Ok(()) => return Ok(path.to_path_buf()),
            Err(error) => failures.push(format!("{}: {error}", path.display())),
        }
    }
    Err(format!(
        "no trusted nsenter helper matched jailerd's absolute candidates ({})",
        failures.join("; ")
    ))
}

#[cfg(unix)]
pub(super) fn validate_trusted_root_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("not a regular non-symlink file".to_string());
    }
    if metadata.uid() != 0 || metadata.nlink() != 1 || metadata.mode() & 0o022 != 0 {
        return Err("not root-owned, single-link, and non-writable by group/other".to_string());
    }
    if !executable_permissions(&metadata) {
        return Err("not executable".to_string());
    }
    let mut ancestor = path.parent();
    while let Some(directory) = ancestor {
        let metadata = fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
        if !metadata.file_type().is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(format!("untrusted ancestor {}", directory.display()));
        }
        ancestor = directory.parent();
    }
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn validate_trusted_root_executable(_path: &Path) -> Result<(), String> {
    Err("trusted Unix helper validation is unavailable".to_string())
}

pub(super) fn resolve_command(command: &str, path_entries: &[PathBuf]) -> Option<PathBuf> {
    let raw = Path::new(command);
    if raw.is_absolute() || command.contains(std::path::MAIN_SEPARATOR) {
        return is_executable_file(raw).then(|| raw.to_path_buf());
    }

    path_entries
        .iter()
        .map(|entry| entry.join(command))
        .find(|candidate| is_executable_file(candidate))
}

pub(super) fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    executable_permissions(&metadata)
}

#[cfg(unix)]
pub(super) fn is_char_device(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::FileTypeExt;

    metadata.file_type().is_char_device()
}

#[cfg(not(unix))]
pub(super) fn is_char_device(metadata: &std::fs::Metadata) -> bool {
    metadata.is_file()
}

#[cfg(unix)]
pub(super) fn executable_permissions(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
pub(super) fn executable_permissions(_metadata: &std::fs::Metadata) -> bool {
    true
}

pub(super) fn pass(name: impl Into<String>, detail: impl Into<String>) -> PreflightCheck {
    PreflightCheck {
        name: name.into(),
        status: PreflightStatus::Pass,
        detail: detail.into(),
    }
}

pub(super) fn warn(name: impl Into<String>, detail: impl Into<String>) -> PreflightCheck {
    PreflightCheck {
        name: name.into(),
        status: PreflightStatus::Warn,
        detail: detail.into(),
    }
}

pub(super) fn fail(name: impl Into<String>, detail: impl Into<String>) -> PreflightCheck {
    PreflightCheck {
        name: name.into(),
        status: PreflightStatus::Fail,
        detail: detail.into(),
    }
}
