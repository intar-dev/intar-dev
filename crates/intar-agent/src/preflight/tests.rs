#![allow(clippy::unwrap_used)]

use std::fs;
use std::path::PathBuf;

use tempfile::TempDir;

use super::{
    PreflightEnvironment, PreflightStatus, collect_preflight_with_environment,
    parse_systemd_major_version, resolve_command,
};
use crate::config::AgentConfig;
use intar_jailer_protocol::{
    CLOUD_HYPERVISOR_SHA256, CLOUD_HYPERVISOR_VERSION, JailerCapabilities, PROTOCOL_VERSION,
    RUN_GUEST_NETWORK_PREFIX,
};

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

fn ready_capabilities(source_root: PathBuf) -> JailerCapabilities {
    JailerCapabilities {
        protocol_version: PROTOCOL_VERSION,
        cloud_hypervisor_version: CLOUD_HYPERVISOR_VERSION.to_owned(),
        cloud_hypervisor_sha256: CLOUD_HYPERVISOR_SHA256.to_owned(),
        total_cpu_millis: 8_000,
        reserved_cpu_millis: 1_000,
        schedulable_cpu_millis: 7_000,
        committed_cpu_millis: 125,
        supports_jailer_v2: true,
        supports_jailer_v3: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_hard_cpu_quota: true,
        supports_boot_cpu_lease: true,
        boot_cpu_millis: intar_jailer_protocol::DEFAULT_BOOT_CPU_MILLIS,
        boot_cpu_lease_ms: intar_jailer_protocol::DEFAULT_BOOT_CPU_LEASE_MS,
        supports_landlock: true,
        supports_cgroup_v2: true,
        uid_gid_start: 200_000,
        uid_gid_end: 265_535,
        uid_gid_range_collision_free: true,
        config_trusted: true,
        source_roots_trusted: true,
        jailer_binary_trusted: true,
        runtime_hash_verified: true,
        runtime_statically_linked: true,
        systemd_version: Some("systemd 252 (252.30)".to_string()),
        supports_systemd_transient_units: true,
        seccomp_supported: true,
        landlock_abi: Some(3),
        privileged_self_test_passed: true,
        kvm_accounting_proven: true,
        allow_uid_gid_collisions: false,
        allowed_source_roots: vec![source_root],
        posix_acl_supported: true,
        guest_network_pool: "10.77.0.0/16".to_owned(),
        run_guest_network_prefix: RUN_GUEST_NETWORK_PREFIX,
        ssh_public_port_start: 22_000,
        ssh_public_port_end: 22_999,
    }
}

#[test]
fn resolves_commands_from_path_entries() {
    let temp = TempDir::new().unwrap();
    fake_tool(temp.path(), "nft");
    assert_eq!(
        resolve_command("nft", &[temp.path().to_path_buf()]),
        Some(temp.path().join("nft"))
    );
    assert_eq!(
        resolve_command("missing", &[temp.path().to_path_buf()]),
        None
    );
}

#[test]
fn reports_ready_jailed_agent_host() {
    let temp = TempDir::new().unwrap();
    let bin = temp.path().join("bin");
    let cache = temp.path().join("cache");
    let work = temp.path().join("work");
    fs::create_dir_all(&bin).unwrap();
    fs::create_dir_all(&cache).unwrap();
    fs::create_dir_all(&work).unwrap();
    let systemd_runtime = temp.path().join("run/systemd/system");
    fs::create_dir_all(&systemd_runtime).unwrap();
    fake_tool(&bin, "nft");
    fake_tool(&bin, "nsenter");
    let mut cfg = AgentConfig::default();
    cfg.bridge.enabled = true;
    cfg.bridge.base_url = "https://intar.dev".to_string();
    cfg.bridge.host_id = "agent-1".to_string();
    cfg.bridge.bootstrap_token = "secret".to_string();
    cfg.image_registry.url = "https://intar.dev/agent/registry/images".to_string();
    cfg.vm_defaults.work_dir = Some(work);
    let socket_path = temp.path().join("jailerd.sock");
    let system_bus_socket = temp.path().join("system-bus.sock");
    #[cfg(unix)]
    let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    #[cfg(unix)]
    let _system_bus = std::os::unix::net::UnixListener::bind(&system_bus_socket).unwrap();
    cfg.jailer.socket = socket_path;

    let env = PreflightEnvironment {
        os: "linux",
        arch: "x86_64",
        trusted_nsenter: Ok(bin.join("nsenter")),
        path_entries: vec![bin],
        kvm_path: PathBuf::from("/dev/null"),
        tun_path: PathBuf::from("/dev/null"),
        urandom_path: PathBuf::from("/dev/null"),
        kernel_release: "6.8.0-test".to_string(),
        cgroup_controllers: Ok("cpu io memory pids".to_string()),
        cgroup_membership: Ok("0::/system.slice/intar-agent.service\n".to_string()),
        seccomp_actions: Ok("kill_process errno log allow\n".to_string()),
        systemd_version: Ok("systemd 252 (252.30)".to_string()),
        systemd_runtime_path: systemd_runtime,
        system_bus_socket_path: system_bus_socket,
        ipv4_forwarding: Ok("1\n".to_string()),
        cache_root: Ok(cache),
        default_work_root: Err("unused".to_string()),
    };

    let report = collect_preflight_with_environment(
        &cfg,
        &env,
        &Ok(ready_capabilities(temp.path().to_path_buf())),
    );

    assert_eq!(report.failure_count(), 0);
    assert!(report.checks.iter().any(|check| {
        check.name == "kvm device" && check.detail.contains("character device exists")
    }));
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.name == "jailerd socket")
    );
}

#[test]
fn rejects_regular_file_as_kvm_device() {
    let temp = TempDir::new().unwrap();
    let fake_kvm = temp.path().join("kvm");
    fs::write(&fake_kvm, "").unwrap();
    let env = PreflightEnvironment {
        os: "linux",
        arch: "x86_64",
        trusted_nsenter: Ok(temp.path().join("nsenter")),
        path_entries: Vec::new(),
        kvm_path: fake_kvm,
        tun_path: PathBuf::from("/dev/null"),
        urandom_path: PathBuf::from("/dev/null"),
        kernel_release: "6.8.0".to_string(),
        cgroup_controllers: Ok("cpu".to_string()),
        cgroup_membership: Ok("0::/\n".to_string()),
        seccomp_actions: Ok("errno allow\n".to_string()),
        systemd_version: Ok("systemd 252".to_string()),
        systemd_runtime_path: temp.path().to_path_buf(),
        system_bus_socket_path: PathBuf::from("/dev/null"),
        ipv4_forwarding: Ok("1".to_string()),
        cache_root: Ok(temp.path().to_path_buf()),
        default_work_root: Err("unused".to_string()),
    };

    let report = collect_preflight_with_environment(
        &AgentConfig::default(),
        &env,
        &Ok(ready_capabilities(temp.path().to_path_buf())),
    );

    assert!(report.checks.iter().any(|check| {
        check.name == "kvm device"
            && check.status == PreflightStatus::Fail
            && check.detail.contains("not a character device")
    }));
}

#[test]
fn reports_missing_jailer_prerequisites() {
    let temp = TempDir::new().unwrap();
    let mut cfg = AgentConfig::default();
    cfg.image_registry.url = "https://intar.dev/agent/registry/images".to_string();
    cfg.vm_defaults.work_dir = Some(temp.path().join("missing-work"));
    let env = PreflightEnvironment {
        os: "macos",
        arch: "aarch64",
        trusted_nsenter: Err("trusted nsenter unavailable".to_string()),
        path_entries: Vec::new(),
        kvm_path: temp.path().join("missing-kvm"),
        tun_path: temp.path().join("missing-tun"),
        urandom_path: temp.path().join("missing-urandom"),
        kernel_release: "6.1.0".to_string(),
        cgroup_controllers: Err("cgroup v2 unavailable".to_string()),
        cgroup_membership: Err("cgroup membership unavailable".to_string()),
        seccomp_actions: Err("seccomp unavailable".to_string()),
        systemd_version: Err("systemd unavailable".to_string()),
        systemd_runtime_path: temp.path().join("missing-systemd"),
        system_bus_socket_path: temp.path().join("missing-system-bus"),
        ipv4_forwarding: Ok("0".to_string()),
        cache_root: Err("cache dir unavailable".to_string()),
        default_work_root: Err("unused".to_string()),
    };

    let report = collect_preflight_with_environment(
        &cfg,
        &env,
        &Err("jailerd rejected peer credentials".to_string()),
    );

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

#[test]
fn parses_systemd_version_output() {
    assert_eq!(
        parse_systemd_major_version("systemd 252 (252.30-1)"),
        Some(252)
    );
    assert_eq!(parse_systemd_major_version("systemd 256"), Some(256));
    assert_eq!(parse_systemd_major_version("252.30-1~deb12u2"), Some(252));
    assert_eq!(parse_systemd_major_version("not-systemd"), None);
}

#[test]
fn rejects_unattested_jailerd_security_and_identity_state() {
    let temp = TempDir::new().unwrap();
    let mut capabilities = ready_capabilities(temp.path().to_path_buf());
    capabilities.uid_gid_range_collision_free = false;
    capabilities.runtime_hash_verified = false;
    capabilities.runtime_statically_linked = false;
    capabilities.landlock_abi = Some(2);
    capabilities.kvm_accounting_proven = false;
    capabilities.supports_jailer_v2 = false;
    capabilities.supports_boot_cpu_lease = false;
    capabilities.supports_template_backed_launch = false;
    capabilities.fast_template_store = false;
    capabilities.supports_hard_cpu_quota = false;

    let env = PreflightEnvironment {
        os: "linux",
        arch: "x86_64",
        trusted_nsenter: Ok(temp.path().join("nsenter")),
        path_entries: Vec::new(),
        kvm_path: PathBuf::from("/dev/null"),
        tun_path: PathBuf::from("/dev/null"),
        urandom_path: PathBuf::from("/dev/null"),
        kernel_release: "6.8.0".to_string(),
        cgroup_controllers: Ok("cpu".to_string()),
        cgroup_membership: Ok("0::/\n".to_string()),
        seccomp_actions: Ok("errno allow\n".to_string()),
        systemd_version: Ok("systemd 252".to_string()),
        systemd_runtime_path: temp.path().to_path_buf(),
        system_bus_socket_path: PathBuf::from("/dev/null"),
        ipv4_forwarding: Ok("1".to_string()),
        cache_root: Ok(temp.path().to_path_buf()),
        default_work_root: Ok(temp.path().to_path_buf()),
    };

    let report =
        collect_preflight_with_environment(&AgentConfig::default(), &env, &Ok(capabilities));

    for name in [
        "VM identity range",
        "Cloud Hypervisor runtime hash",
        "Cloud Hypervisor static linkage",
        "Landlock ABI",
        "KVM helper accounting",
        "jailer v2 isolation capability",
        "boot CPU lease capability",
        "fast jail template store",
        "hard CPU quota capability",
    ] {
        assert!(
            report
                .checks
                .iter()
                .any(|check| { check.name == name && check.status == PreflightStatus::Fail }),
            "missing failure for {name}"
        );
    }
}

#[test]
fn rejects_legacy_jailerd_protocol_v1() {
    let temp = TempDir::new().unwrap();
    let mut capabilities = ready_capabilities(temp.path().to_path_buf());
    capabilities.protocol_version = 1;
    let env = minimally_ready_environment(&temp);

    let report =
        collect_preflight_with_environment(&AgentConfig::default(), &env, &Ok(capabilities));

    assert!(report.checks.iter().any(|check| {
        check.name == "jailerd protocol"
            && check.status == PreflightStatus::Fail
            && check.detail.contains("required version 3")
    }));
}

#[test]
fn accepts_explicit_identity_collision_override_as_warning() {
    let temp = TempDir::new().unwrap();
    let mut capabilities = ready_capabilities(temp.path().to_path_buf());
    capabilities.uid_gid_range_collision_free = false;
    capabilities.allow_uid_gid_collisions = true;
    let env = minimally_ready_environment(&temp);

    let report =
        collect_preflight_with_environment(&AgentConfig::default(), &env, &Ok(capabilities));

    assert!(report.checks.iter().any(|check| {
        check.name == "VM identity range" && check.status == PreflightStatus::Warn
    }));
    assert!(!report.checks.iter().any(|check| {
        check.name == "VM identity range" && check.status == PreflightStatus::Fail
    }));
}

#[test]
fn rejects_agent_paths_outside_jailerd_source_roots() {
    let temp = TempDir::new().unwrap();
    let capabilities = ready_capabilities(PathBuf::from("/var/cache/intar-agent"));
    let env = minimally_ready_environment(&temp);

    let report =
        collect_preflight_with_environment(&AgentConfig::default(), &env, &Ok(capabilities));

    assert!(report.checks.iter().any(|check| {
        check.name == "agent source paths" && check.status == PreflightStatus::Fail
    }));
}

#[test]
fn rejects_agent_and_jailerd_network_policy_mismatch() {
    let temp = TempDir::new().unwrap();
    let mut cfg = AgentConfig::default();
    cfg.vm_defaults.network.guest_cidr = "10.77.128.0/17".to_owned();
    cfg.ssh_access.enabled = true;
    cfg.ssh_access.public_port_start = 23_000;
    cfg.ssh_access.public_port_end = 23_999;
    let report = collect_preflight_with_environment(
        &cfg,
        &minimally_ready_environment(&temp),
        &Ok(ready_capabilities(temp.path().to_path_buf())),
    );
    for name in ["jailerd guest network policy", "jailerd SSH port policy"] {
        assert!(
            report
                .checks
                .iter()
                .any(|check| { check.name == name && check.status == PreflightStatus::Fail })
        );
    }
}

fn minimally_ready_environment(temp: &TempDir) -> PreflightEnvironment {
    PreflightEnvironment {
        os: "linux",
        arch: "x86_64",
        trusted_nsenter: Ok(temp.path().join("nsenter")),
        path_entries: Vec::new(),
        kvm_path: PathBuf::from("/dev/null"),
        tun_path: PathBuf::from("/dev/null"),
        urandom_path: PathBuf::from("/dev/null"),
        kernel_release: "6.8.0".to_string(),
        cgroup_controllers: Ok("cpu".to_string()),
        cgroup_membership: Ok("0::/\n".to_string()),
        seccomp_actions: Ok("errno allow\n".to_string()),
        systemd_version: Ok("systemd 252".to_string()),
        systemd_runtime_path: temp.path().to_path_buf(),
        system_bus_socket_path: PathBuf::from("/dev/null"),
        ipv4_forwarding: Ok("1".to_string()),
        cache_root: Ok(temp.path().join("cache")),
        default_work_root: Ok(temp.path().join("work")),
    }
}
