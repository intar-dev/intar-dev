use std::path::{Path, PathBuf};
use std::{
    env, fs,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use crate::config::BuilderConfig;
use intar_contracts::catalog::ImageArchitecture;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreflightStatus {
    Pass,
    Warn,
    Fail,
}

const QSD_HELP_TIMEOUT: Duration = Duration::from_secs(5);
const QSD_HELP_MAX_BYTES: usize = 64 * 1024;

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
    push_qemu_version_check(&mut checks, &cfg.qemu.qemu_binary, &env.path_entries);
    push_command_check(
        &mut checks,
        "qemu-storage-daemon binary",
        cfg.qemu.qemu_storage_daemon_binary.as_str(),
        &env.path_entries,
    );
    push_qsd_nbd_export_check(
        &mut checks,
        cfg.qemu.qemu_storage_daemon_binary.as_str(),
        &env.path_entries,
    );
    push_command_check(
        &mut checks,
        "qemu-img binary",
        cfg.qemu.layered.qemu_img_binary.to_string_lossy().as_ref(),
        &env.path_entries,
    );
    push_command_check(
        &mut checks,
        "buildctl binary",
        cfg.qemu.layered.buildctl_binary.to_string_lossy().as_ref(),
        &env.path_entries,
    );
    let buildkit_socket = layered_oci_cache_root(cfg).join("buildkitd.sock");
    push_socket_check(&mut checks, "buildkitd socket", &buildkit_socket);
    push_command_check(
        &mut checks,
        "umoci binary",
        cfg.qemu.layered.umoci_binary.to_string_lossy().as_ref(),
        &env.path_entries,
    );
    push_command_check(&mut checks, "zstd binary", "zstd", &env.path_entries);
    push_pinned_image_check(&mut checks, &cfg.qemu.layered.debian_image);
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
    if cfg.qemu.raw_view_read_timeout_seconds == 0 {
        checks.push(fail(
            "raw view read timeout",
            "qemu.raw_view_read_timeout_seconds must be greater than zero",
        ));
    } else {
        checks.push(pass(
            "raw view read timeout",
            format!(
                "qemu.raw_view_read_timeout_seconds = {}",
                cfg.qemu.raw_view_read_timeout_seconds
            ),
        ));
    }
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

fn push_qsd_nbd_export_check(
    checks: &mut Vec<PreflightCheck>,
    command: &str,
    path_entries: &[PathBuf],
) {
    let Some(path) = resolve_command(command, path_entries) else {
        checks.push(fail(
            "qemu-storage-daemon NBD export",
            "cannot read QEMU storage daemon help because the configured binary is unavailable",
        ));
        return;
    };
    let mut child = match Command::new(&path)
        .arg("--help")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            checks.push(fail(
                "qemu-storage-daemon NBD export",
                format!("failed to run '{} --help': {error}", path.display()),
            ));
            return;
        }
    };
    let deadline = Instant::now() + QSD_HELP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                checks.push(fail(
                    "qemu-storage-daemon NBD export",
                    format!(
                        "'{} --help' did not finish within five seconds",
                        path.display()
                    ),
                ));
                return;
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                checks.push(fail(
                    "qemu-storage-daemon NBD export",
                    format!(
                        "failed while waiting for '{} --help': {error}",
                        path.display()
                    ),
                ));
                return;
            }
        }
    }
    let output = match child.wait_with_output() {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            checks.push(fail(
                "qemu-storage-daemon NBD export",
                format!("'{} --help' exited with {}", path.display(), output.status),
            ));
            return;
        }
        Err(error) => {
            checks.push(fail(
                "qemu-storage-daemon NBD export",
                format!("failed to collect '{} --help': {error}", path.display()),
            ));
            return;
        }
    };
    let output_len = output.stdout.len().saturating_add(output.stderr.len());
    if output_len > QSD_HELP_MAX_BYTES {
        checks.push(fail(
            "qemu-storage-daemon NBD export",
            "QEMU storage daemon help exceeds the 64 KiB preflight limit",
        ));
        return;
    }
    let mut bytes = output.stdout;
    bytes.extend(output.stderr);
    let output = match String::from_utf8(bytes) {
        Ok(output) => output,
        Err(_) => {
            checks.push(fail(
                "qemu-storage-daemon NBD export",
                "QEMU storage daemon help is not UTF-8",
            ));
            return;
        }
    };
    if output.contains("--nbd-server") && output.contains("--export [type=]nbd") {
        checks.push(pass(
            "qemu-storage-daemon NBD export",
            "configured daemon supports Unix-socket NBD export",
        ));
    } else {
        checks.push(fail(
            "qemu-storage-daemon NBD export",
            "configured daemon does not advertise --nbd-server and --export [type=]nbd",
        ));
    }
}

fn push_qemu_version_check(
    checks: &mut Vec<PreflightCheck>,
    command: &str,
    path_entries: &[PathBuf],
) {
    let Some(path) = resolve_command(command, path_entries) else {
        checks.push(fail(
            "qemu version",
            "cannot read the QEMU version because the configured binary is unavailable",
        ));
        return;
    };
    let output = match Command::new(&path).arg("--version").output() {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            checks.push(fail(
                "qemu version",
                format!(
                    "'{} --version' exited with {}",
                    path.display(),
                    output.status
                ),
            ));
            return;
        }
        Err(error) => {
            checks.push(fail(
                "qemu version",
                format!("failed to run '{} --version': {error}", path.display()),
            ));
            return;
        }
    };
    let output = match String::from_utf8(output.stdout) {
        Ok(output) => output,
        Err(_) => {
            checks.push(fail("qemu version", "QEMU version output is not UTF-8"));
            return;
        }
    };
    match parse_qemu_major_version(&output) {
        Some(major @ 10..) => checks.push(pass(
            "qemu version",
            format!("QEMU major version {major} supports structured exec channels"),
        )),
        Some(major) => checks.push(fail(
            "qemu version",
            format!("QEMU major version {major} is below required version 10"),
        )),
        None => checks.push(fail(
            "qemu version",
            "QEMU version output does not contain a parseable major version",
        )),
    }
}

fn parse_qemu_major_version(output: &str) -> Option<u32> {
    let mut words = output.split_whitespace();
    while let Some(word) = words.next() {
        if word == "version" {
            return words.next()?.split('.').next()?.parse().ok();
        }
    }
    None
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

fn layered_oci_cache_root(cfg: &BuilderConfig) -> PathBuf {
    cfg.qemu
        .layered
        .oci_cache_root
        .clone()
        .unwrap_or_else(|| cfg.builder.cache_root.join("oci"))
}

fn push_socket_check(checks: &mut Vec<PreflightCheck>, name: &str, path: &Path) {
    match path.metadata() {
        Ok(metadata) if is_socket(&metadata) => {
            checks.push(pass(name, format!("found {}", path.display())));
        }
        Ok(_) => checks.push(fail(
            name,
            format!("'{}' exists but is not a Unix socket", path.display()),
        )),
        Err(_) => checks.push(fail(
            name,
            format!(
                "'{}' is missing; start the configured BuildKit daemon",
                path.display()
            ),
        )),
    }
}

fn push_pinned_image_check(checks: &mut Vec<PreflightCheck>, image: &str) {
    if is_pinned_oci_image(image) {
        checks.push(pass(
            "layered Debian image",
            "uses an immutable SHA-256 digest",
        ));
    } else {
        checks.push(fail(
            "layered Debian image",
            "qemu.layered.debian_image must use @sha256: followed by 64 lowercase hex characters",
        ));
    }
}

fn is_pinned_oci_image(image: &str) -> bool {
    let Some((repository, digest)) = image.rsplit_once("@sha256:") else {
        return false;
    };
    !repository.is_empty()
        && digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
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

    if (1..=2).contains(&cfg.jobs.max_concurrent_builds) {
        checks.push(pass(
            "job concurrency",
            format!(
                "max_concurrent_builds = {} is supported",
                cfg.jobs.max_concurrent_builds
            ),
        ));
    } else {
        checks.push(fail(
            "job concurrency",
            format!(
                "jobs.max_concurrent_builds must be 1 or 2; configured {}",
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

#[cfg(unix)]
fn is_socket(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::FileTypeExt;

    metadata.file_type().is_socket()
}

#[cfg(not(unix))]
fn is_socket(_metadata: &std::fs::Metadata) -> bool {
    false
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
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;
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

    #[cfg(unix)]
    fn fake_qemu(dir: &std::path::Path, version_output: &str) {
        let path = dir.join("qemu-system-x86_64");
        fs::write(
            &path,
            format!("#!/bin/sh\nprintf '%s\\n' '{version_output}'\n"),
        )
        .unwrap();
        make_executable(&path);
    }

    #[cfg(unix)]
    fn fake_qemu_storage_daemon(dir: &std::path::Path, help_output: &str) {
        let path = dir.join("qemu-storage-daemon");
        fs::write(
            &path,
            format!("#!/bin/sh\nprintf '%s\\n' '{help_output}'\n"),
        )
        .unwrap();
        make_executable(&path);
    }

    #[test]
    fn parses_qemu_major_version() {
        assert_eq!(
            super::parse_qemu_major_version("QEMU emulator version 10.0.11 (Debian)"),
            Some(10)
        );
        assert_eq!(
            super::parse_qemu_major_version("QEMU emulator version 11.1"),
            Some(11)
        );
        assert_eq!(super::parse_qemu_major_version("QEMU emulator"), None);
    }

    #[test]
    fn resolves_commands_from_explicit_path_or_path_entries() {
        let temp = TempDir::new().unwrap();
        fake_tool(temp.path(), "qemu-img");
        let command = resolve_command("qemu-img", &[temp.path().to_path_buf()]);
        assert_eq!(command, Some(temp.path().join("qemu-img")));
        let absolute = resolve_command(
            temp.path().join("qemu-img").to_str().unwrap(),
            &[temp.path().to_path_buf()],
        );
        assert_eq!(absolute, Some(temp.path().join("qemu-img")));
        assert_eq!(
            resolve_command("missing", &[temp.path().to_path_buf()]),
            None
        );
    }

    #[cfg(unix)]
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
        let oci_cache = cache.join("oci");
        fs::create_dir_all(&oci_cache).unwrap();
        let _buildkit_socket = UnixListener::bind(oci_cache.join("buildkitd.sock")).unwrap();
        fake_qemu(&bin, "QEMU emulator version 10.0.11");
        fake_qemu_storage_daemon(
            &bin,
            "--nbd-server addr.type=unix,addr.path=raw-view.sock --export [type=]nbd,id=raw,node-name=root",
        );
        for tool in [
            "qemu-img",
            "buildctl",
            "umoci",
            "zstd",
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
            path_entries: vec![bin.clone()],
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
        cfg.jobs.max_concurrent_builds = 3;
        cfg.qemu.raw_view_read_timeout_seconds = 0;
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
            check.name == "raw view read timeout" && check.status == PreflightStatus::Fail
        }));
        assert!(report.checks.iter().any(|check| {
            check.name == "bridge configuration" && check.status == PreflightStatus::Warn
        }));
    }

    #[cfg(unix)]
    #[test]
    fn oci_builder_requires_tools_socket_and_pinned_debian_image() {
        let temp = TempDir::new().unwrap();
        let bin = temp.path().join("bin");
        let work = temp.path().join("work");
        let cache = temp.path().join("cache");
        let state = temp.path().join("state");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::create_dir_all(&state).unwrap();
        let oci_cache = cache.join("oci");
        fs::create_dir_all(&oci_cache).unwrap();
        let buildkit_socket = UnixListener::bind(oci_cache.join("buildkitd.sock")).unwrap();
        fake_qemu(&bin, "QEMU emulator version 10.0.11");
        fake_qemu_storage_daemon(
            &bin,
            "--nbd-server addr.type=unix,addr.path=raw-view.sock --export [type=]nbd,id=raw,node-name=root",
        );
        for tool in [
            "qemu-img",
            "buildctl",
            "umoci",
            "zstd",
            "mke2fs",
            "e2fsck",
            "resize2fs",
        ] {
            fake_tool(&bin, tool);
        }
        let mut cfg = BuilderConfig::default();
        cfg.bridge.enabled = false;
        cfg.builder.work_root = work;
        cfg.builder.cache_root = cache;
        cfg.builder.state_db = state.join("builder.sqlite3");
        let env = PreflightEnvironment {
            host_arch: intar_contracts::catalog::ImageArchitecture::X86_64,
            path_entries: vec![bin.clone()],
            kvm_path: PathBuf::from("/dev/null"),
            vhost_vsock_path: PathBuf::from("/dev/null"),
        };

        let report = collect_preflight_with_environment(&cfg, &env);

        assert_eq!(report.failure_count(), 0);
        assert!(report.checks.iter().any(|check| {
            check.name == "layered Debian image" && check.status == PreflightStatus::Pass
        }));
        assert!(report.checks.iter().any(|check| {
            check.name == "buildkitd socket" && check.status == PreflightStatus::Pass
        }));
        assert!(report.checks.iter().any(|check| {
            check.name == "qemu version" && check.status == PreflightStatus::Pass
        }));
        assert!(report.checks.iter().any(|check| {
            check.name == "qemu-storage-daemon binary" && check.status == PreflightStatus::Pass
        }));
        assert!(report.checks.iter().any(|check| {
            check.name == "qemu-storage-daemon NBD export" && check.status == PreflightStatus::Pass
        }));

        fake_qemu_storage_daemon(&bin, "--export [type=]vhost-user-blk,id=raw,node-name=root");
        let report = collect_preflight_with_environment(&cfg, &env);
        assert!(report.checks.iter().any(|check| {
            check.name == "qemu-storage-daemon NBD export" && check.status == PreflightStatus::Fail
        }));

        fs::remove_file(bin.join("qemu-storage-daemon")).unwrap();
        let report = collect_preflight_with_environment(&cfg, &env);
        assert!(report.checks.iter().any(|check| {
            check.name == "qemu-storage-daemon binary" && check.status == PreflightStatus::Fail
        }));
        fake_qemu_storage_daemon(
            &bin,
            "--nbd-server addr.type=unix,addr.path=raw-view.sock --export [type=]nbd,id=raw,node-name=root",
        );

        drop(buildkit_socket);
        fs::remove_file(oci_cache.join("buildkitd.sock")).unwrap();
        let report = collect_preflight_with_environment(&cfg, &env);
        assert!(report.checks.iter().any(|check| {
            check.name == "buildkitd socket" && check.status == PreflightStatus::Fail
        }));

        cfg.qemu.layered.debian_image = "debian:trixie-slim".to_string();
        let report = collect_preflight_with_environment(&cfg, &env);
        assert!(report.checks.iter().any(|check| {
            check.name == "layered Debian image" && check.status == PreflightStatus::Fail
        }));

        cfg.qemu.layered.debian_image =
            format!("docker.io/library/debian@sha256:{}", "A".repeat(64));
        let report = collect_preflight_with_environment(&cfg, &env);
        assert!(report.checks.iter().any(|check| {
            check.name == "layered Debian image" && check.status == PreflightStatus::Fail
        }));

        fake_qemu(&bin, "QEMU emulator version 7.2");
        let report = collect_preflight_with_environment(&cfg, &env);
        assert!(report.checks.iter().any(|check| {
            check.name == "qemu version" && check.status == PreflightStatus::Fail
        }));

        fake_qemu(&bin, "QEMU emulator version unknown");
        let report = collect_preflight_with_environment(&cfg, &env);
        assert!(report.checks.iter().any(|check| {
            check.name == "qemu version" && check.status == PreflightStatus::Fail
        }));
    }
}
