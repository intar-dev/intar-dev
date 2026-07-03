use std::path::{Path, PathBuf};
use std::{env, fs};

use intar_contracts::catalog::ImageArchitecture;

use crate::config::BuilderConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreflightStatus {
    Pass,
    Warn,
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
    pub host_arch: ImageArchitecture,
    pub path_entries: Vec<PathBuf>,
    pub kvm_path: PathBuf,
    pub vhost_vsock_path: PathBuf,
}

impl PreflightEnvironment {
    #[must_use]
    pub fn detect() -> Self {
        Self {
            host_arch: crate::bridge::host_architecture(),
            path_entries: env::var_os("PATH")
                .map(|path| env::split_paths(&path).collect())
                .unwrap_or_default(),
            kvm_path: PathBuf::from("/dev/kvm"),
            vhost_vsock_path: PathBuf::from("/dev/vhost-vsock"),
        }
    }
}

#[must_use]
pub fn collect_preflight(cfg: &BuilderConfig) -> PreflightReport {
    collect_preflight_with_environment(cfg, &PreflightEnvironment::detect())
}

#[must_use]
pub fn collect_preflight_with_environment(
    cfg: &BuilderConfig,
    env: &PreflightEnvironment,
) -> PreflightReport {
    let mut checks = Vec::new();
    push_arch_check(&mut checks, env.host_arch.clone());
    push_accelerator_check(&mut checks, &cfg.qemu.accelerator);
    push_char_device_check(&mut checks, "kvm device", &env.kvm_path);
    push_optional_char_device_check(&mut checks, "vhost-vsock device", &env.vhost_vsock_path);
    push_command_check(
        &mut checks,
        "qemu binary",
        &cfg.qemu.qemu_binary,
        &env.path_entries,
    );
    push_command_check(
        &mut checks,
        "mmdebstrap binary",
        &cfg.qemu.mmdebstrap_binary,
        &env.path_entries,
    );
    push_command_check(
        &mut checks,
        "mke2fs binary",
        &cfg.qemu.mke2fs_binary,
        &env.path_entries,
    );
    push_command_check(
        &mut checks,
        "e2fsck binary",
        &cfg.qemu.e2fsck_binary,
        &env.path_entries,
    );
    push_command_check(
        &mut checks,
        "resize2fs binary",
        &cfg.qemu.resize2fs_binary,
        &env.path_entries,
    );
    if let Some(kino_binary) = &cfg.builder.kino_binary {
        push_file_check(&mut checks, "kino binary override", kino_binary);
    } else if cfg.builder.kino_release_base_url.trim().is_empty() {
        checks.push(fail(
            "kino release source",
            "builder.kino_release_base_url is required when builder.kino_binary is not set",
        ));
    } else {
        checks.push(pass(
            "kino release source",
            format!(
                "will download pinned kino releases from {}",
                cfg.builder.kino_release_base_url
            ),
        ));
    }
    push_dir_check(&mut checks, "builder work_root", &cfg.builder.work_root);
    push_dir_check(&mut checks, "builder cache_root", &cfg.builder.cache_root);
    match cfg.builder.state_db.parent() {
        Some(parent) => push_dir_check(&mut checks, "builder state_db parent", parent),
        None => checks.push(fail(
            "builder state_db parent",
            format!(
                "'{}' has no parent directory",
                cfg.builder.state_db.display()
            ),
        )),
    }
    push_job_check(&mut checks, cfg);
    push_bridge_check(&mut checks, cfg);

    PreflightReport { checks }
}

fn push_arch_check(checks: &mut Vec<PreflightCheck>, arch: ImageArchitecture) {
    match arch {
        ImageArchitecture::X86_64 => checks.push(pass(
            "host architecture",
            "x86_64 host can build the current amd64 image set",
        )),
        ImageArchitecture::Aarch64 => checks.push(fail(
            "host architecture",
            "builder host must be x86_64 for the current amd64 image pipeline",
        )),
    }
}

fn push_accelerator_check(checks: &mut Vec<PreflightCheck>, accelerator: &str) {
    if accelerator == "kvm" {
        checks.push(pass("qemu accelerator", "accelerator is kvm"));
    } else {
        checks.push(fail(
            "qemu accelerator",
            format!(
                "accelerator must be kvm for release proof; configured '{}'",
                accelerator
            ),
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

fn push_file_check(checks: &mut Vec<PreflightCheck>, name: &str, path: &Path) {
    if is_executable_file(path) {
        checks.push(pass(name, format!("found {}", path.display())));
    } else {
        checks.push(fail(
            name,
            format!("'{}' is missing or is not executable", path.display()),
        ));
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

fn push_optional_char_device_check(checks: &mut Vec<PreflightCheck>, name: &str, path: &Path) {
    match path.metadata() {
        Ok(metadata) if is_char_device(&metadata) => {
            checks.push(pass(name, format!("found {}", path.display())));
        }
        Ok(_) => {
            checks.push(warn(
                name,
                format!(
                    "'{}' exists but is not a character device; builder will report vsock unsupported",
                    path.display()
                ),
            ));
        }
        Err(_) => {
            checks.push(warn(
                name,
                format!(
                    "'{}' is missing; builder will report vsock unsupported",
                    path.display()
                ),
            ));
        }
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
        Ok(_) => {
            checks.push(fail(
                name,
                format!("'{}' is not a directory", path.display()),
            ));
        }
        Err(error) => {
            checks.push(fail(
                name,
                format!("'{}' is not ready: {}", path.display(), error),
            ));
        }
    }
}

fn push_job_check(checks: &mut Vec<PreflightCheck>, cfg: &BuilderConfig) {
    if cfg.jobs.max_attempts == 0 {
        checks.push(fail(
            "job attempts",
            "jobs.max_attempts must be greater than zero",
        ));
    } else {
        checks.push(pass(
            "job attempts",
            format!("max_attempts = {}", cfg.jobs.max_attempts),
        ));
    }

    if cfg.jobs.max_concurrent_builds == 1 {
        checks.push(pass(
            "job concurrency",
            "max_concurrent_builds = 1 is supported",
        ));
    } else {
        checks.push(fail(
            "job concurrency",
            format!(
                "jobs.max_concurrent_builds must be 1 in this release; configured {}",
                cfg.jobs.max_concurrent_builds
            ),
        ));
    }
}

fn push_bridge_check(checks: &mut Vec<PreflightCheck>, cfg: &BuilderConfig) {
    if !cfg.bridge.enabled {
        checks.push(warn(
            "bridge configuration",
            "bridge.enabled = false; run-once can build locally but daemon mode will not converge jobs",
        ));
        return;
    }

    if cfg.bridge.base_url.trim().is_empty() {
        checks.push(fail("bridge base_url", "bridge.base_url is required"));
    } else {
        checks.push(pass(
            "bridge base_url",
            format!("using {}", cfg.bridge.base_url),
        ));
    }
    if cfg.bridge.host_id.trim().is_empty() {
        checks.push(fail("bridge host_id", "bridge.host_id is required"));
    } else {
        checks.push(pass("bridge host_id", cfg.bridge.host_id.clone()));
    }
    if cfg.bridge.bootstrap_token.trim().is_empty() {
        checks.push(fail(
            "bridge bootstrap_token",
            "bridge.bootstrap_token is required to mint short-lived builder JWTs",
        ));
    } else {
        checks.push(pass(
            "bridge bootstrap_token",
            "bootstrap token is configured",
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

fn warn(name: impl Into<String>, detail: impl Into<String>) -> PreflightCheck {
    PreflightCheck {
        name: name.into(),
        status: PreflightStatus::Warn,
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
    use crate::config::BuilderConfig;

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
    fn resolves_commands_from_explicit_path_or_path_entries() {
        let temp = TempDir::new().unwrap();
        fake_tool(temp.path(), "mmdebstrap");
        let command = resolve_command("mmdebstrap", &[temp.path().to_path_buf()]);
        assert_eq!(command, Some(temp.path().join("mmdebstrap")));
        let absolute = resolve_command(
            temp.path().join("mmdebstrap").to_str().unwrap(),
            &[temp.path().to_path_buf()],
        );
        assert_eq!(absolute, Some(temp.path().join("mmdebstrap")));
        assert_eq!(
            resolve_command("missing", &[temp.path().to_path_buf()]),
            None
        );
    }

    #[test]
    fn reports_ready_linux_kvm_builder_host() {
        let temp = TempDir::new().unwrap();
        let bin = temp.path().join("bin");
        let work = temp.path().join("work");
        let cache = temp.path().join("cache");
        let state = temp.path().join("state");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::create_dir_all(&state).unwrap();
        for tool in [
            "qemu-system-x86_64",
            "mmdebstrap",
            "mke2fs",
            "e2fsck",
            "resize2fs",
        ] {
            fake_tool(&bin, tool);
        }
        let mut cfg = BuilderConfig::default();
        cfg.bridge.base_url = "https://intar.dev".to_string();
        cfg.bridge.host_id = "builder-1".to_string();
        cfg.bridge.bootstrap_token = "secret".to_string();
        cfg.builder.work_root = work;
        cfg.builder.cache_root = cache;
        cfg.builder.state_db = state.join("builder.sqlite3");
        let env = PreflightEnvironment {
            host_arch: intar_contracts::catalog::ImageArchitecture::X86_64,
            path_entries: vec![bin],
            kvm_path: PathBuf::from("/dev/null"),
            vhost_vsock_path: PathBuf::from("/dev/null"),
        };

        let report = collect_preflight_with_environment(&cfg, &env);

        assert_eq!(report.failure_count(), 0);
        assert!(
            report
                .checks
                .iter()
                .all(|check| check.status != PreflightStatus::Fail)
        );
        assert!(report.checks.iter().any(|check| {
            check.name == "kvm device" && check.detail.contains("found and opened")
        }));
    }

    #[test]
    fn rejects_regular_file_as_kvm_device() {
        let temp = TempDir::new().unwrap();
        let fake_kvm = temp.path().join("kvm");
        fs::write(&fake_kvm, "").unwrap();
        let mut cfg = BuilderConfig::default();
        cfg.bridge.enabled = false;
        let env = PreflightEnvironment {
            host_arch: intar_contracts::catalog::ImageArchitecture::X86_64,
            path_entries: Vec::new(),
            kvm_path: fake_kvm,
            vhost_vsock_path: temp.path().join("missing-vsock"),
        };

        let report = collect_preflight_with_environment(&cfg, &env);

        assert!(report.checks.iter().any(|check| {
            check.name == "kvm device"
                && check.status == PreflightStatus::Fail
                && check.detail.contains("not a character device")
        }));
    }

    #[test]
    fn reports_missing_kvm_and_parallel_worker_misconfiguration() {
        let temp = TempDir::new().unwrap();
        let mut cfg = BuilderConfig::default();
        cfg.bridge.enabled = false;
        cfg.jobs.max_concurrent_builds = 2;
        cfg.qemu.accelerator = "tcg".to_string();
        cfg.builder.work_root = temp.path().join("missing-work");
        cfg.builder.cache_root = temp.path().join("missing-cache");
        cfg.builder.state_db = temp.path().join("missing-state").join("builder.sqlite3");
        let env = PreflightEnvironment {
            host_arch: intar_contracts::catalog::ImageArchitecture::Aarch64,
            path_entries: Vec::new(),
            kvm_path: temp.path().join("missing-kvm"),
            vhost_vsock_path: temp.path().join("missing-vsock"),
        };

        let report = collect_preflight_with_environment(&cfg, &env);

        assert!(report.has_failures());
        assert!(report.checks.iter().any(|check| {
            check.name == "host architecture" && check.status == PreflightStatus::Fail
        }));
        assert!(report.checks.iter().any(|check| {
            check.name == "qemu accelerator" && check.status == PreflightStatus::Fail
        }));
        assert!(report.checks.iter().any(|check| {
            check.name == "job concurrency" && check.status == PreflightStatus::Fail
        }));
        assert!(report.checks.iter().any(|check| {
            check.name == "bridge configuration" && check.status == PreflightStatus::Warn
        }));
    }
}
