use std::path::{Path, PathBuf};
use std::{env, fs};

use crate::config::AgentConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreflightStatus {
    Pass,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightCheck {
    pub name: String,
    pub status: PreflightStatus,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightReport {
    pub checks: Vec<PreflightCheck>,
}

impl PreflightReport {
    #[must_use]
    pub fn failure_count(&self) -> usize {
        self.checks
            .iter()
            .filter(|check| check.status == PreflightStatus::Fail)
            .count()
    }

    #[must_use]
    pub fn has_failures(&self) -> bool {
        self.failure_count() > 0
    }
}

#[derive(Debug, Clone)]
pub struct PreflightEnvironment {
    pub os: &'static str,
    pub arch: &'static str,
    pub path_entries: Vec<PathBuf>,
    pub kvm_path: PathBuf,
    pub vhost_vsock_path: PathBuf,
    pub cache_root: Result<PathBuf, String>,
    pub default_work_root: Result<PathBuf, String>,
}

impl PreflightEnvironment {
    #[must_use]
    pub fn detect() -> Self {
        let cache_root = crate::image_cache::default_cache_root()
            .map_err(|error| format!("failed to resolve image cache root: {error}"));
        let default_work_root = dirs::cache_dir()
            .map(|path| path.join("intar-agent"))
            .ok_or_else(|| "cache dir unavailable for default vm_defaults.work_dir".to_string());
        Self {
            os: env::consts::OS,
            arch: env::consts::ARCH,
            path_entries: env::var_os("PATH")
                .map(|path| env::split_paths(&path).collect())
                .unwrap_or_default(),
            kvm_path: PathBuf::from("/dev/kvm"),
            vhost_vsock_path: PathBuf::from("/dev/vhost-vsock"),
            cache_root,
            default_work_root,
        }
    }
}

#[must_use]
pub fn collect_preflight(cfg: &AgentConfig) -> PreflightReport {
    collect_preflight_with_environment(cfg, &PreflightEnvironment::detect())
}

#[must_use]
pub fn collect_preflight_with_environment(
    cfg: &AgentConfig,
    env: &PreflightEnvironment,
) -> PreflightReport {
    let mut checks = Vec::new();
    push_linux_check(&mut checks, env.os);
    push_arch_check(&mut checks, env.arch);
    push_char_device_check(&mut checks, "kvm device", &env.kvm_path);
    push_char_device_check(&mut checks, "vhost-vsock device", &env.vhost_vsock_path);
    push_command_check(
        &mut checks,
        "cloud-hypervisor binary",
        &cfg.cloud_hypervisor.binary,
        &env.path_entries,
    );
    push_command_check(&mut checks, "nft binary", "nft", &env.path_entries);
    push_command_check(&mut checks, "cp binary", "cp", &env.path_entries);
    push_dir_result_check(&mut checks, "image cache root", &env.cache_root);
    push_vm_work_dir_check(&mut checks, cfg, env);
    push_bridge_check(&mut checks, cfg);
    push_registry_check(&mut checks, cfg);

    PreflightReport { checks }
}

fn push_linux_check(checks: &mut Vec<PreflightCheck>, os: &str) {
    if os == "linux" {
        checks.push(pass("host os", "linux host"));
    } else {
        checks.push(fail(
            "host os",
            format!("agent direct-boot proof requires Linux; host is {os}"),
        ));
    }
}

fn push_arch_check(checks: &mut Vec<PreflightCheck>, arch: &str) {
    if arch == "x86_64" {
        checks.push(pass(
            "host architecture",
            "x86_64 host can run the current amd64 image set",
        ));
    } else {
        checks.push(fail(
            "host architecture",
            format!("current staging image set requires x86_64; host is {arch}"),
        ));
    }
}

fn push_command_check(
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

fn push_char_device_check(checks: &mut Vec<PreflightCheck>, name: &str, path: &Path) {
    match path.metadata() {
        Ok(metadata) if is_char_device(&metadata) => {
            match fs::OpenOptions::new().read(true).write(true).open(path) {
                Ok(_) => checks.push(pass(name, format!("found and opened {}", path.display()))),
                Err(error) => checks.push(fail(
                    name,
                    format!(
                        "'{}' exists but cannot be opened: {}",
                        path.display(),
                        error
                    ),
                )),
            }
        }
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

fn push_dir_result_check(
    checks: &mut Vec<PreflightCheck>,
    name: &str,
    path: &Result<PathBuf, String>,
) {
    match path {
        Ok(path) => push_dir_check(checks, name, path),
        Err(error) => checks.push(fail(name, error.clone())),
    }
}

fn push_vm_work_dir_check(
    checks: &mut Vec<PreflightCheck>,
    cfg: &AgentConfig,
    env: &PreflightEnvironment,
) {
    match cfg.vm_defaults.work_dir.as_ref() {
        Some(path) => push_dir_check(checks, "vm work_dir", path),
        None => push_dir_result_check(checks, "vm work_dir", &env.default_work_root),
    }
}

fn push_dir_check(checks: &mut Vec<PreflightCheck>, name: &str, path: &Path) {
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

fn push_bridge_check(checks: &mut Vec<PreflightCheck>, cfg: &AgentConfig) {
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

fn push_registry_check(checks: &mut Vec<PreflightCheck>, cfg: &AgentConfig) {
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

fn resolve_command(command: &str, path_entries: &[PathBuf]) -> Option<PathBuf> {
    let raw = Path::new(command);
    if raw.is_absolute() || command.contains(std::path::MAIN_SEPARATOR) {
        return is_executable_file(raw).then(|| raw.to_path_buf());
    }

    path_entries
        .iter()
        .map(|entry| entry.join(command))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    executable_permissions(&metadata)
}

#[cfg(unix)]
fn is_char_device(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::FileTypeExt;

    metadata.file_type().is_char_device()
}

#[cfg(not(unix))]
fn is_char_device(metadata: &std::fs::Metadata) -> bool {
    metadata.is_file()
}

#[cfg(unix)]
fn executable_permissions(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable_permissions(_metadata: &std::fs::Metadata) -> bool {
    true
}

fn pass(name: impl Into<String>, detail: impl Into<String>) -> PreflightCheck {
    PreflightCheck {
        name: name.into(),
        status: PreflightStatus::Pass,
        detail: detail.into(),
    }
}

fn fail(name: impl Into<String>, detail: impl Into<String>) -> PreflightCheck {
    PreflightCheck {
        name: name.into(),
        status: PreflightStatus::Fail,
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::fs;
    use std::path::PathBuf;

    use tempfile::TempDir;

    use super::{
        PreflightEnvironment, PreflightStatus, collect_preflight_with_environment, resolve_command,
    };
    use crate::config::AgentConfig;

    #[cfg(unix)]
    fn make_executable(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &std::path::Path) {}

    fn fake_tool(dir: &std::path::Path, name: &str) {
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        make_executable(&path);
    }

    #[test]
    fn resolves_commands_from_path_entries() {
        let temp = TempDir::new().unwrap();
        fake_tool(temp.path(), "cloud-hypervisor");
        assert_eq!(
            resolve_command("cloud-hypervisor", &[temp.path().to_path_buf()]),
            Some(temp.path().join("cloud-hypervisor"))
        );
        assert_eq!(
            resolve_command("missing", &[temp.path().to_path_buf()]),
            None
        );
    }

    #[test]
    fn reports_ready_direct_boot_agent_host() {
        let temp = TempDir::new().unwrap();
        let bin = temp.path().join("bin");
        let cache = temp.path().join("cache");
        let work = temp.path().join("work");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::create_dir_all(&work).unwrap();
        for tool in ["cloud-hypervisor", "nft", "cp"] {
            fake_tool(&bin, tool);
        }
        let mut cfg = AgentConfig::default();
        cfg.bridge.enabled = true;
        cfg.bridge.base_url = "https://intar.dev".to_string();
        cfg.bridge.host_id = "agent-1".to_string();
        cfg.bridge.bootstrap_token = "secret".to_string();
        cfg.image_registry.url = "https://intar.dev/agent/registry/images".to_string();
        cfg.vm_defaults.work_dir = Some(work);

        let env = PreflightEnvironment {
            os: "linux",
            arch: "x86_64",
            path_entries: vec![bin],
            kvm_path: PathBuf::from("/dev/null"),
            vhost_vsock_path: PathBuf::from("/dev/null"),
            cache_root: Ok(cache),
            default_work_root: Err("unused".to_string()),
        };

        let report = collect_preflight_with_environment(&cfg, &env);

        assert_eq!(report.failure_count(), 0);
        assert!(report.checks.iter().any(|check| {
            check.name == "kvm device" && check.detail.contains("found and opened")
        }));
        assert!(report.checks.iter().any(|check| {
            check.name == "vhost-vsock device" && check.detail.contains("found and opened")
        }));
    }

    #[test]
    fn rejects_regular_file_as_kvm_device() {
        let temp = TempDir::new().unwrap();
        let fake_kvm = temp.path().join("kvm");
        fs::write(&fake_kvm, "").unwrap();
        let env = PreflightEnvironment {
            os: "linux",
            arch: "x86_64",
            path_entries: Vec::new(),
            kvm_path: fake_kvm,
            vhost_vsock_path: PathBuf::from("/dev/null"),
            cache_root: Ok(temp.path().to_path_buf()),
            default_work_root: Err("unused".to_string()),
        };

        let report = collect_preflight_with_environment(&AgentConfig::default(), &env);

        assert!(report.checks.iter().any(|check| {
            check.name == "kvm device"
                && check.status == PreflightStatus::Fail
                && check.detail.contains("not a character device")
        }));
    }

    #[test]
    fn reports_missing_direct_boot_prerequisites() {
        let temp = TempDir::new().unwrap();
        let mut cfg = AgentConfig::default();
        cfg.image_registry.url = "https://intar.dev/agent/registry/images".to_string();
        cfg.vm_defaults.work_dir = Some(temp.path().join("missing-work"));
        let env = PreflightEnvironment {
            os: "macos",
            arch: "aarch64",
            path_entries: Vec::new(),
            kvm_path: temp.path().join("missing-kvm"),
            vhost_vsock_path: temp.path().join("missing-vsock"),
            cache_root: Err("cache dir unavailable".to_string()),
            default_work_root: Err("unused".to_string()),
        };

        let report = collect_preflight_with_environment(&cfg, &env);

        assert!(report.has_failures());
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.name == "host os" && check.status == PreflightStatus::Fail)
        );
        assert!(report.checks.iter().any(|check| {
            check.name == "bridge configuration" && check.status == PreflightStatus::Fail
        }));
    }
}
