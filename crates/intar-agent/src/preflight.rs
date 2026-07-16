use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use std::{env, fs};

use intar_jailer_protocol::{
    AsyncSeqpacketClient, CLOUD_HYPERVISOR_SHA256, CLOUD_HYPERVISOR_VERSION, JailerCapabilities,
    PROTOCOL_VERSION, RUN_GUEST_NETWORK_PREFIX, Request as JailerRequest,
    Response as JailerResponse,
};

use crate::config::AgentConfig;

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
    pub os: &'static str,
    pub arch: &'static str,
    pub path_entries: Vec<PathBuf>,
    pub trusted_nsenter: Result<PathBuf, String>,
    pub kvm_path: PathBuf,
    pub tun_path: PathBuf,
    pub urandom_path: PathBuf,
    pub kernel_release: String,
    pub cgroup_controllers: Result<String, String>,
    pub cgroup_membership: Result<String, String>,
    pub seccomp_actions: Result<String, String>,
    pub systemd_version: Result<String, String>,
    pub systemd_runtime_path: PathBuf,
    pub system_bus_socket_path: PathBuf,
    pub ipv4_forwarding: Result<String, String>,
    pub cache_root: Result<PathBuf, String>,
    pub default_work_root: Result<PathBuf, String>,
}

impl PreflightEnvironment {
    #[must_use]
    pub fn detect() -> Self {
        let path_entries = env::var_os("PATH")
            .map(|path| env::split_paths(&path).collect::<Vec<_>>())
            .unwrap_or_default();
        let cache_root = crate::image_cache::default_cache_root()
            .map_err(|error| format!("failed to resolve image cache root: {error}"));
        let default_work_root = dirs::cache_dir()
            .map(|path| path.join("intar-agent"))
            .ok_or_else(|| "cache dir unavailable for default vm_defaults.work_dir".to_string());
        Self {
            os: env::consts::OS,
            arch: env::consts::ARCH,
            systemd_version: read_systemd_version(&path_entries),
            trusted_nsenter: find_trusted_nsenter(),
            path_entries,
            kvm_path: PathBuf::from("/dev/kvm"),
            tun_path: PathBuf::from("/dev/net/tun"),
            urandom_path: PathBuf::from("/dev/urandom"),
            kernel_release: fs::read_to_string("/proc/sys/kernel/osrelease")
                .unwrap_or_default()
                .trim()
                .to_string(),
            cgroup_controllers: fs::read_to_string("/sys/fs/cgroup/cgroup.controllers")
                .map_err(|error| format!("failed to read cgroup v2 controllers: {error}")),
            cgroup_membership: fs::read_to_string("/proc/self/cgroup")
                .map_err(|error| format!("failed to read process cgroup membership: {error}")),
            seccomp_actions: fs::read_to_string("/proc/sys/kernel/seccomp/actions_avail")
                .map_err(|error| format!("failed to read seccomp actions: {error}")),
            systemd_runtime_path: PathBuf::from("/run/systemd/system"),
            system_bus_socket_path: PathBuf::from("/run/dbus/system_bus_socket"),
            ipv4_forwarding: fs::read_to_string("/proc/sys/net/ipv4/ip_forward")
                .map_err(|error| format!("failed to read IPv4 forwarding state: {error}")),
            cache_root,
            default_work_root,
        }
    }
}

pub async fn collect_preflight(cfg: &AgentConfig) -> PreflightReport {
    let environment = PreflightEnvironment::detect();
    let capabilities = query_jailerd_capabilities(cfg).await;
    collect_preflight_with_environment(cfg, &environment, &capabilities)
}

#[must_use]
pub fn collect_preflight_with_environment(
    cfg: &AgentConfig,
    env: &PreflightEnvironment,
    jailerd_capabilities: &Result<JailerCapabilities, String>,
) -> PreflightReport {
    let mut checks = Vec::new();
    push_linux_check(&mut checks, env.os);
    push_arch_check(&mut checks, env.arch);
    push_kernel_check(&mut checks, &env.kernel_release);
    push_char_device_presence_check(&mut checks, "kvm device", &env.kvm_path);
    push_char_device_presence_check(&mut checks, "tun device", &env.tun_path);
    push_char_device_presence_check(&mut checks, "urandom device", &env.urandom_path);
    push_cgroup_v2_check(&mut checks, &env.cgroup_controllers, &env.cgroup_membership);
    push_seccomp_check(&mut checks, &env.seccomp_actions);
    push_systemd_check(
        &mut checks,
        &env.systemd_version,
        &env.systemd_runtime_path,
        &env.system_bus_socket_path,
    );
    push_socket_check(&mut checks, "jailerd socket", &cfg.jailer.socket);
    push_command_check(&mut checks, "nft binary", "nft", &env.path_entries);
    push_trusted_helper_check(&mut checks, "nsenter binary", &env.trusted_nsenter);
    push_ipv4_forwarding_check(&mut checks, &env.ipv4_forwarding);
    push_dir_result_check(&mut checks, "image cache root", &env.cache_root);
    push_vm_work_dir_check(&mut checks, cfg, env);
    push_jailerd_capabilities_check(&mut checks, cfg, env, jailerd_capabilities);
    checks.push(warn(
        "privileged self-test",
        "doctor is read-only and does not create a unit, cgroup, jail, network namespace, or KVM workload; run `sudo /usr/lib/intar/intar-jailerd-self-test` separately",
    ));
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
            format!("jailed scenario hosts require Linux; host is {os}"),
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

fn push_kernel_check(checks: &mut Vec<PreflightCheck>, release: &str) {
    let version = release
        .split(['.', '-'])
        .take(2)
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>();
    match version.as_deref() {
        Ok([major, minor]) if (*major, *minor) >= (6, 2) => checks.push(pass(
            "host kernel",
            format!("kernel {release} satisfies the required Linux 6.2 baseline"),
        )),
        _ => checks.push(fail(
            "host kernel",
            format!("kernel {release:?} does not satisfy the required Linux 6.2 baseline"),
        )),
    }
}

fn push_cgroup_v2_check(
    checks: &mut Vec<PreflightCheck>,
    controllers: &Result<String, String>,
    membership: &Result<String, String>,
) {
    let controllers_ready = controllers.as_ref().is_ok_and(|value| {
        value
            .split_whitespace()
            .any(|controller| controller == "cpu")
    });
    let unified = membership.as_ref().is_ok_and(|value| {
        value
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .all(|line| line.starts_with("0::"))
            && value.lines().any(|line| line.trim().starts_with("0::"))
    });
    if controllers_ready && unified {
        checks.push(pass(
            "cgroup v2 cpu controller",
            "unified hierarchy exposes the cpu controller",
        ));
        return;
    }

    let detail = match (controllers, membership) {
        (Err(error), _) => error.clone(),
        (_, Err(error)) => error.clone(),
        (Ok(value), _) if !controllers_ready => {
            format!("unified hierarchy does not expose cpu: {value}")
        }
        (_, Ok(value)) => format!(
            "process is not attached exclusively to unified cgroup v2: {}",
            value.trim()
        ),
    };
    checks.push(fail("cgroup v2 cpu controller", detail));
}

fn push_seccomp_check(checks: &mut Vec<PreflightCheck>, actions: &Result<String, String>) {
    match actions {
        Ok(value)
            if value.split_whitespace().any(|action| action == "allow")
                && value.split_whitespace().any(|action| action == "errno") =>
        {
            checks.push(pass(
                "seccomp filter support",
                format!("kernel exposes seccomp filter actions: {}", value.trim()),
            ));
        }
        Ok(value) => checks.push(fail(
            "seccomp filter support",
            format!("kernel seccomp actions are incomplete: {}", value.trim()),
        )),
        Err(error) => checks.push(fail("seccomp filter support", error.clone())),
    }
}

fn push_systemd_check(
    checks: &mut Vec<PreflightCheck>,
    version: &Result<String, String>,
    runtime_path: &Path,
    system_bus_socket: &Path,
) {
    match version {
        Ok(value) if parse_systemd_major_version(value).is_some_and(|major| major >= 252) => {
            checks.push(pass(
                "systemd version",
                format!(
                    "{} satisfies the required systemd 252 baseline",
                    value.trim()
                ),
            ));
        }
        Ok(value) => checks.push(fail(
            "systemd version",
            format!("{value:?} does not report systemd >= 252"),
        )),
        Err(error) => checks.push(fail("systemd version", error.clone())),
    }
    push_dir_check(checks, "systemd system manager", runtime_path);
    push_socket_check(checks, "system D-Bus socket", system_bus_socket);
}

fn push_ipv4_forwarding_check(
    checks: &mut Vec<PreflightCheck>,
    forwarding: &Result<String, String>,
) {
    match forwarding {
        Ok(value) if value.trim() == "1" => checks.push(pass(
            "IPv4 forwarding",
            "net.ipv4.ip_forward is enabled for run-namespace transit",
        )),
        Ok(value) => checks.push(fail(
            "IPv4 forwarding",
            format!(
                "net.ipv4.ip_forward must be 1 for run-namespace transit; found {:?}",
                value.trim()
            ),
        )),
        Err(error) => checks.push(fail("IPv4 forwarding", error.clone())),
    }
}

fn push_jailerd_capabilities_check(
    checks: &mut Vec<PreflightCheck>,
    cfg: &AgentConfig,
    env: &PreflightEnvironment,
    result: &Result<JailerCapabilities, String>,
) {
    let capabilities = match result {
        Ok(capabilities) => {
            checks.push(pass(
                "jailerd handshake",
                "authenticated SOCK_SEQPACKET Capabilities request succeeded",
            ));
            capabilities
        }
        Err(error) => {
            checks.push(fail("jailerd handshake", error.clone()));
            return;
        }
    };

    push_bool_check(
        checks,
        "jailerd protocol",
        capabilities.protocol_version == PROTOCOL_VERSION,
        format!("protocol version {}", capabilities.protocol_version),
        format!(
            "protocol version {} does not match required version {PROTOCOL_VERSION}",
            capabilities.protocol_version
        ),
    );
    push_bool_check(
        checks,
        "jailerd guest network policy",
        capabilities.guest_network_pool == cfg.vm_defaults.network.guest_cidr
            && capabilities.run_guest_network_prefix == RUN_GUEST_NETWORK_PREFIX,
        format!(
            "agent and jailerd agree on pool {} with per-run /{} networks",
            capabilities.guest_network_pool, capabilities.run_guest_network_prefix
        ),
        format!(
            "agent pool {} does not match jailerd pool {} with required per-run /{} networks",
            cfg.vm_defaults.network.guest_cidr,
            capabilities.guest_network_pool,
            capabilities.run_guest_network_prefix
        ),
    );
    if cfg.ssh_access.enabled {
        push_bool_check(
            checks,
            "jailerd SSH port policy",
            capabilities.ssh_public_port_start == cfg.ssh_access.public_port_start
                && capabilities.ssh_public_port_end == cfg.ssh_access.public_port_end,
            format!(
                "agent and jailerd agree on SSH ports {}..={}",
                capabilities.ssh_public_port_start, capabilities.ssh_public_port_end
            ),
            format!(
                "agent SSH ports {}..={} do not match jailerd ports {}..={}",
                cfg.ssh_access.public_port_start,
                cfg.ssh_access.public_port_end,
                capabilities.ssh_public_port_start,
                capabilities.ssh_public_port_end
            ),
        );
    }
    push_bool_check(
        checks,
        "Cloud Hypervisor release",
        capabilities.cloud_hypervisor_version == CLOUD_HYPERVISOR_VERSION
            && capabilities.cloud_hypervisor_sha256 == CLOUD_HYPERVISOR_SHA256,
        format!(
            "{} has pinned SHA-256 {}",
            capabilities.cloud_hypervisor_version, capabilities.cloud_hypervisor_sha256
        ),
        format!(
            "jailerd reports {} / {}; expected {} / {}",
            capabilities.cloud_hypervisor_version,
            capabilities.cloud_hypervisor_sha256,
            CLOUD_HYPERVISOR_VERSION,
            CLOUD_HYPERVISOR_SHA256
        ),
    );
    push_bool_check(
        checks,
        "Cloud Hypervisor runtime hash",
        capabilities.runtime_hash_verified,
        "jailerd verified the installed runtime against the pinned SHA-256",
        "jailerd could not verify the installed runtime against the pinned SHA-256",
    );
    push_bool_check(
        checks,
        "Cloud Hypervisor static linkage",
        capabilities.runtime_statically_linked,
        "jailerd verified that the runtime has no ELF interpreter",
        "jailerd could not prove that the runtime is statically linked",
    );
    push_bool_check(
        checks,
        "jailerd config trust",
        capabilities.config_trusted,
        "jailerd reports a root-owned, non-writable configuration",
        "jailerd configuration ownership or mode is not trusted",
    );
    push_bool_check(
        checks,
        "intar-jailer binary trust",
        capabilities.jailer_binary_trusted,
        "jailerd reports a root-owned, non-writable one-shot jailer binary",
        "intar-jailer ownership, mode, path, or ancestors are not trusted",
    );
    push_bool_check(
        checks,
        "jailerd source roots",
        capabilities.source_roots_trusted
            && !capabilities.allowed_source_roots.is_empty()
            && capabilities
                .allowed_source_roots
                .iter()
                .all(|root| root.is_absolute()),
        format!(
            "jailerd reports trusted agent artifact source roots: {}",
            display_paths(&capabilities.allowed_source_roots)
        ),
        format!(
            "jailerd artifact source roots are missing or untrusted: {}",
            display_paths(&capabilities.allowed_source_roots)
        ),
    );
    push_agent_source_paths_check(checks, cfg, env, capabilities);
    push_bool_check(
        checks,
        "POSIX ACL support",
        capabilities.posix_acl_supported,
        "jailerd can grant narrow agent access to API, vsock, and log paths",
        "jailerd could not prove POSIX ACL support for narrow agent path access",
    );

    let identity_range_valid = capabilities.uid_gid_start >= 1_000
        && capabilities.uid_gid_start <= capabilities.uid_gid_end;
    let identity_detail = format!(
        "UID/GID range {}..={}",
        capabilities.uid_gid_start, capabilities.uid_gid_end
    );
    if !identity_range_valid {
        checks.push(fail(
            "VM identity range",
            format!("{identity_detail} is invalid"),
        ));
    } else if capabilities.uid_gid_range_collision_free {
        checks.push(pass(
            "VM identity range",
            format!("{identity_detail} is collision-free"),
        ));
    } else if capabilities.allow_uid_gid_collisions {
        checks.push(warn(
            "VM identity range",
            format!(
                "{identity_detail} collides with an existing identity; jailerd's explicit operator override is enabled"
            ),
        ));
    } else {
        checks.push(fail(
            "VM identity range",
            format!("{identity_detail} collides with an existing identity"),
        ));
    }

    let jailerd_systemd_ready = capabilities.supports_systemd_transient_units
        && capabilities
            .systemd_version
            .as_deref()
            .and_then(parse_systemd_major_version)
            .is_some_and(|version| version >= 252);
    push_bool_check(
        checks,
        "jailerd systemd backend",
        jailerd_systemd_ready,
        format!(
            "jailerd can create transient units with {}",
            capabilities.systemd_version.as_deref().unwrap_or("systemd")
        ),
        format!(
            "jailerd cannot prove systemd >= 252 transient-unit support (reported {:?})",
            capabilities.systemd_version
        ),
    );
    push_bool_check(
        checks,
        "jailerd seccomp support",
        capabilities.seccomp_supported,
        "jailerd reports kernel seccomp-filter support",
        "jailerd cannot prove kernel seccomp-filter support",
    );
    push_bool_check(
        checks,
        "Landlock ABI",
        capabilities.landlock_abi.is_some_and(|abi| abi >= 3),
        format!(
            "jailerd probed Landlock ABI {}",
            capabilities.landlock_abi.unwrap_or_default()
        ),
        format!(
            "jailerd did not prove Landlock ABI >= 3 (reported {:?})",
            capabilities.landlock_abi
        ),
    );
    push_bool_check(
        checks,
        "cgroup v2 capability",
        capabilities.supports_cgroup_v2,
        "jailerd reports unified cgroup v2 CPU support",
        "jailerd does not report unified cgroup v2 CPU support",
    );
    push_bool_check(
        checks,
        "KVM helper accounting",
        capabilities.kvm_accounting_proven,
        "the privileged self-test accounted for attributable KVM helpers",
        "KVM helper accounting has not been proven by the privileged self-test",
    );
    checks.push(if capabilities.privileged_self_test_passed {
        pass(
            "privileged self-test attestation",
            "jailerd reports a successful prior privileged self-test; doctor did not rerun it",
        )
    } else {
        warn(
            "privileged self-test attestation",
            "jailerd has no successful privileged self-test attestation",
        )
    });
    push_bool_check(
        checks,
        "jailer v2 isolation capability",
        capabilities.supports_jailer_v2,
        "jailerd advertises the required template-backed jailer-v2 contract",
        "jailerd does not advertise the required jailer-v2 contract",
    );
    push_bool_check(
        checks,
        "hard CPU quota capability",
        capabilities.supports_hard_cpu_quota,
        "jailerd advertises aggregate hard CPU quotas",
        "jailerd does not advertise aggregate hard CPU quotas",
    );
    checks.push(
        if capabilities.supports_jailer_v2
            && capabilities.supports_boot_cpu_lease
            && capabilities.boot_cpu_millis >= 1_000
            && capabilities.boot_cpu_lease_ms > 0
        {
            pass(
                "boot CPU lease capability",
                format!(
                    "jailerd advertises a capacity-accounted {}m / {}ms boot lease",
                    capabilities.boot_cpu_millis, capabilities.boot_cpu_lease_ms
                ),
            )
        } else {
            fail(
                "boot CPU lease capability",
                "jailerd does not attest the mandatory capacity-accounted boot CPU lease",
            )
        },
    );
    checks.push(
        if capabilities.supports_jailer_v2
            && capabilities.supports_template_backed_launch
            && capabilities.fast_template_store
        {
            pass(
                "fast jail template store",
                "jailerd attests content-addressed same-filesystem template launch",
            )
        } else {
            fail(
                "fast jail template store",
                "jailerd does not attest mandatory template-backed same-filesystem reflinks",
            )
        },
    );
    push_bool_check(
        checks,
        "Landlock enforcement capability",
        capabilities.supports_landlock,
        "jailerd advertises fail-closed Landlock enforcement",
        "jailerd does not advertise fail-closed Landlock enforcement",
    );
    push_capacity_check(checks, capabilities);
}

fn push_agent_source_paths_check(
    checks: &mut Vec<PreflightCheck>,
    cfg: &AgentConfig,
    env: &PreflightEnvironment,
    capabilities: &JailerCapabilities,
) {
    let work_root = cfg
        .vm_defaults
        .work_dir
        .as_ref()
        .map_or_else(|| env.default_work_root.as_ref(), Ok);
    let paths = [
        ("image cache", env.cache_root.as_ref()),
        ("VM work", work_root),
    ];
    let mut failures = Vec::new();
    let mut accepted = Vec::new();
    for (name, path) in paths {
        match path {
            Ok(path)
                if capabilities
                    .allowed_source_roots
                    .iter()
                    .any(|root| path_is_beneath(path, root)) =>
            {
                accepted.push(format!("{name} {}", path.display()));
            }
            Ok(path) => failures.push(format!(
                "{name} path {} is outside jailerd's allowed source roots",
                path.display()
            )),
            Err(error) => failures.push(format!("{name} path is unavailable: {error}")),
        }
    }
    if failures.is_empty() {
        checks.push(pass(
            "agent source paths",
            format!("{} are accepted by jailerd", accepted.join(" and ")),
        ));
    } else {
        checks.push(fail("agent source paths", failures.join("; ")));
    }
}

fn path_is_beneath(path: &Path, root: &Path) -> bool {
    use std::path::Component;

    path.is_absolute()
        && root.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        && !root
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        && path.starts_with(root)
}

fn display_paths(paths: &[PathBuf]) -> String {
    if paths.is_empty() {
        return "<none>".to_string();
    }
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

mod system_checks;
use system_checks::*;
#[cfg(test)]
mod tests;
