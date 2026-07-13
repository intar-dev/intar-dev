#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::os::fd::OwnedFd;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use anyhow::ensure;
use anyhow::{Context as _, Result, bail};
use intar_jailer_protocol::{
    CLOUD_HYPERVISOR_SHA256, CLOUD_HYPERVISOR_VERSION, CpuQuota, DestroyRunNetworkRequest,
    EnsureRunNetworkRequest, JailPathMap, JailSpecV1, JailerCapabilities, JailerdConfig,
    OperationResult, PROTOCOL_VERSION, ProtocolError, Request, Response, RunNetworkResult,
    SandboxHealth, Sha256Digest, SourceArtifacts, ValidatedId, VmIdentityRequest, VmInspection,
    VmLaunchRequest, VmLaunchResult,
};
use rustix::fs::{Mode, OFlags, open};
#[cfg(target_os = "linux")]
use rustix::fs::{ResolveFlags, openat2};
use serde::{Deserialize, Serialize};
use serde_json::to_writer;
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

#[cfg(target_os = "linux")]
mod network;
#[cfg(target_os = "linux")]
use network::NetworkManager;
pub mod self_test;

#[cfg(any(target_os = "linux", test))]
const CAP_SYS_PTRACE_BIT: u32 = 19;
#[cfg(target_os = "linux")]
const VMM_START_TIMEOUT: Duration = Duration::from_secs(30);

/// A launch description which maps directly to a systemd transient service.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnitLaunchSpec {
    pub unit_name: String,
    pub description: String,
    pub jailer_binary: PathBuf,
    pub jail_spec_path: PathBuf,
    pub api_socket_path: PathBuf,
    pub cpu_quota: CpuQuota,
    pub uid: u32,
    pub gid: u32,
    pub device_allow: Vec<&'static str>,
}

const JAIL_DEVICE_ALLOW: &[&str] = &[
    "/dev/kvm rwm",
    "/dev/net/tun rwm",
    "/dev/urandom rm",
    "/dev/null rwm",
];

impl UnitLaunchSpec {
    /// Properties required on the transient unit. Backends must apply all of
    /// them atomically or fail the launch.
    pub fn required_properties(&self) -> BTreeMap<&'static str, String> {
        BTreeMap::from([
            ("Slice", "intar-vms.slice".to_owned()),
            (
                "CPUQuotaPerSecUSec",
                (u64::from(self.cpu_quota.cpu_millis) * 1_000).to_string(),
            ),
            (
                "CPUQuotaPeriodUSec",
                self.cpu_quota.period_micros.to_string(),
            ),
            ("KillMode", "control-group".to_owned()),
            ("Restart", "no".to_owned()),
            ("ExitType", "cgroup".to_owned()),
            ("RestrictRealtime", "yes".to_owned()),
            ("LimitRTPRIO", "0".to_owned()),
            ("DevicePolicy", "closed".to_owned()),
            ("NoNewPrivileges", "no".to_owned()),
        ])
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartedUnit {
    pub unit_name: String,
    pub pid: Option<u32>,
    pub cgroup_path: Option<PathBuf>,
    pub host_boot_id: Option<String>,
    pub pid_start_time_ticks: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendInspection {
    pub pid: Option<u32>,
    pub cgroup_path: Option<PathBuf>,
    pub host_boot_id: Option<String>,
    pub pid_start_time_ticks: Option<u64>,
    pub netns_inode: Option<u64>,
    pub jail_root_inode: Option<u64>,
    pub executable_sha256: Option<String>,
    pub health: SandboxHealth,
    pub cpu_stat: Option<intar_jailer_protocol::CpuStat>,
    pub seccomp_enabled: bool,
    pub landlock_enabled: bool,
    pub no_new_privs: bool,
    pub capabilities_empty: bool,
}

/// Privileged host operations. The production implementation must use the
/// systemd D-Bus API and netlink/nftables APIs; it must never interpolate a
/// request into a shell command.
pub trait HostBackend: Send {
    fn production_ready(&self) -> bool;
    fn start_unit(&mut self, spec: &UnitLaunchSpec) -> Result<StartedUnit>;
    fn inspect_unit(&mut self, unit_name: &str) -> Result<BackendInspection>;
    fn stop_unit(&mut self, unit_name: &str) -> Result<bool>;
    /// Remove an already-drained unit. Implementations must return `false`
    /// only when the unit no longer exists and must refuse active units.
    fn destroy_unit(&mut self, unit_name: &str) -> Result<bool>;
    fn ensure_run_network(&mut self, request: &EnsureRunNetworkRequest)
    -> Result<RunNetworkResult>;
    fn ensure_vm_network(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()>;
    fn recover_vm_network(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        self.ensure_vm_network(run, request, generation, uid, gid)
    }
    fn destroy_vm_network(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
    ) -> Result<bool>;
    fn destroy_run_network(&mut self, request: &DestroyRunNetworkRequest) -> Result<bool>;
}

/// Fail-closed production placeholder until the D-Bus/netlink backend is
/// linked. Capabilities accurately report that VM launches are unavailable.
#[derive(Default)]
pub struct UnavailableHostBackend;

impl HostBackend for UnavailableHostBackend {
    fn production_ready(&self) -> bool {
        false
    }

    fn start_unit(&mut self, _spec: &UnitLaunchSpec) -> Result<StartedUnit> {
        bail!("systemd transient-unit backend is not available in this build")
    }

    fn inspect_unit(&mut self, _unit_name: &str) -> Result<BackendInspection> {
        bail!("systemd transient-unit backend is not available in this build")
    }

    fn stop_unit(&mut self, _unit_name: &str) -> Result<bool> {
        bail!("systemd transient-unit backend is not available in this build")
    }

    fn destroy_unit(&mut self, _unit_name: &str) -> Result<bool> {
        bail!("systemd transient-unit backend is not available in this build")
    }

    fn ensure_run_network(
        &mut self,
        _request: &EnsureRunNetworkRequest,
    ) -> Result<RunNetworkResult> {
        bail!("netlink run-network backend is not available in this build")
    }

    fn destroy_run_network(&mut self, _request: &DestroyRunNetworkRequest) -> Result<bool> {
        bail!("netlink run-network backend is not available in this build")
    }

    fn ensure_vm_network(
        &mut self,
        _run: &EnsureRunNetworkRequest,
        _request: &VmLaunchRequest,
        _generation: &ValidatedId,
        _uid: u32,
        _gid: u32,
    ) -> Result<()> {
        bail!("VM network backend is not available in this build")
    }

    fn destroy_vm_network(
        &mut self,
        _run_id: &ValidatedId,
        _generation: &ValidatedId,
    ) -> Result<bool> {
        bail!("VM network backend is not available in this build")
    }
}

/// systemd transient-unit backend. Networking remains a separate fail-closed
/// boundary until the netlink/nftables implementation is available.
#[cfg(target_os = "linux")]
pub struct SystemdHostBackend {
    network: NetworkManager,
    cloud_hypervisor_sha256: Sha256Digest,
    landlock_attested: bool,
}

#[cfg(target_os = "linux")]
impl SystemdHostBackend {
    pub fn connect(config: &JailerdConfig) -> Result<Self> {
        let landlock_attested = self_test::load_verified(config)?.is_some_and(|attestation| {
            attestation.landlock_abi >= 3 && attestation.landlock_negative_access
        });
        Self::connect_with_landlock_attestation(config, landlock_attested)
    }

    pub(crate) fn connect_with_landlock_attestation(
        config: &JailerdConfig,
        landlock_attested: bool,
    ) -> Result<Self> {
        require_supervisor_process_inspection_capability()?;
        let _ = zbus::blocking::Connection::system().context("connect to system D-Bus")?;
        Ok(Self {
            network: NetworkManager::new(config)?,
            cloud_hypervisor_sha256: config.cloud_hypervisor_sha256.clone(),
            landlock_attested,
        })
    }

    fn manager<'a>(
        connection: &'a zbus::blocking::Connection,
    ) -> Result<zbus::blocking::Proxy<'a>> {
        zbus::blocking::Proxy::new(
            connection,
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
        )
        .context("create systemd manager proxy")
    }

    fn get_unit_path(
        manager: &zbus::blocking::Proxy<'_>,
        unit_name: &str,
    ) -> Result<Option<zbus::zvariant::OwnedObjectPath>> {
        let result: zbus::Result<zbus::zvariant::OwnedObjectPath> =
            manager.call("GetUnit", &(unit_name,));
        match result {
            Ok(path) => Ok(Some(path)),
            Err(zbus::Error::MethodError(name, _, _))
                if name.as_str() == "org.freedesktop.systemd1.NoSuchUnit" =>
            {
                Ok(None)
            }
            Err(error) => Err(error).with_context(|| format!("get systemd unit {unit_name}")),
        }
    }

    fn inspect_existing(&self, unit_name: &str) -> Result<BackendInspection> {
        let connection = zbus::blocking::Connection::system()?;
        let manager = Self::manager(&connection)?;
        let path = Self::get_unit_path(&manager, unit_name)?
            .with_context(|| format!("systemd unit {unit_name} no longer exists"))?;
        let unit = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.systemd1",
            path,
            "org.freedesktop.systemd1.Unit",
        )?;
        let active_state: String = unit.get_property("ActiveState")?;
        let health = match active_state.as_str() {
            "active" | "activating" | "reloading" => SandboxHealth::Healthy,
            "deactivating" => SandboxHealth::Stopping,
            "failed" | "inactive" => SandboxHealth::Exited,
            _ => SandboxHealth::Quarantined,
        };
        let service = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.systemd1",
            unit.path(),
            "org.freedesktop.systemd1.Service",
        )?;
        let control_group: String = service.get_property("ControlGroup")?;
        let cpu_stat = read_cpu_stat(&control_group).ok();
        let vmm_pid = if matches!(health, SandboxHealth::Healthy | SandboxHealth::Stopping) {
            find_verified_vmm_pid(&control_group, &self.cloud_hypervisor_sha256)?
        } else {
            None
        };
        let security = vmm_pid
            .map(inspect_process_security)
            .transpose()?
            .unwrap_or_default();
        Ok(BackendInspection {
            pid: vmm_pid,
            cgroup_path: (!control_group.is_empty()).then(|| PathBuf::from(&control_group)),
            host_boot_id: read_trimmed("/proc/sys/kernel/random/boot_id").ok(),
            pid_start_time_ticks: vmm_pid.and_then(read_pid_start_time_ticks),
            netns_inode: vmm_pid.and_then(process_network_namespace_inode),
            jail_root_inode: vmm_pid.and_then(process_root_inode),
            executable_sha256: vmm_pid.map(|_| self.cloud_hypervisor_sha256.as_str().to_owned()),
            health,
            cpu_stat,
            seccomp_enabled: security.seccomp_enabled,
            landlock_enabled: vmm_pid.is_some() && self.landlock_attested,
            no_new_privs: security.no_new_privs,
            capabilities_empty: security.capabilities_empty,
        })
    }
}

#[cfg(target_os = "linux")]
impl HostBackend for SystemdHostBackend {
    fn production_ready(&self) -> bool {
        true
    }

    fn start_unit(&mut self, spec: &UnitLaunchSpec) -> Result<StartedUnit> {
        use zbus::zvariant::{OwnedObjectPath, Value};

        let connection = zbus::blocking::Connection::system()?;
        let manager = Self::manager(&connection)?;
        let executable = spec.jailer_binary.to_string_lossy().into_owned();
        let spec_path = spec.jail_spec_path.to_string_lossy().into_owned();
        let exec_start = vec![(
            executable.clone(),
            vec![executable.clone(), "--spec".to_owned(), spec_path],
            false,
        )];
        let device_allow = spec
            .device_allow
            .iter()
            .map(|entry| {
                let (path, access) = entry.split_once(' ').unwrap_or((entry, "r"));
                (path.to_owned(), access.to_owned())
            })
            .collect::<Vec<_>>();
        let properties = vec![
            ("Description", Value::new(spec.description.clone())),
            ("Slice", Value::new("intar-vms.slice")),
            ("Type", Value::new("simple")),
            ("ExecStart", Value::new(exec_start)),
            ("CPUAccounting", Value::new(true)),
            (
                "CPUQuotaPerSecUSec",
                Value::new(u64::from(spec.cpu_quota.cpu_millis) * 1_000),
            ),
            (
                "CPUQuotaPeriodUSec",
                Value::new(spec.cpu_quota.period_micros),
            ),
            ("KillMode", Value::new("control-group")),
            ("Restart", Value::new("no")),
            ("ExitType", Value::new("cgroup")),
            ("RestrictRealtime", Value::new(true)),
            ("LimitRTPRIO", Value::new(0_u64)),
            ("DevicePolicy", Value::new("closed")),
            ("DeviceAllow", Value::new(device_allow)),
            ("NoNewPrivileges", Value::new(false)),
            ("UMask", Value::new(0o077_u32)),
            (
                "CapabilityBoundingSet",
                Value::new(minimum_jailer_capability_mask()),
            ),
            ("AmbientCapabilities", Value::new(0_u64)),
        ];
        let auxiliary: Vec<(&str, Vec<(&str, Value<'_>)>)> = Vec::new();
        let _: OwnedObjectPath = manager
            .call(
                "StartTransientUnit",
                &(spec.unit_name.as_str(), "fail", properties, auxiliary),
            )
            .with_context(|| format!("start transient unit {}", spec.unit_name))?;

        let deadline = Instant::now() + VMM_START_TIMEOUT;
        let inspection = loop {
            let last_observation = match self.inspect_existing(&spec.unit_name) {
                Ok(inspection) if inspection.pid.is_some() => {
                    match ping_cloud_hypervisor(&spec.api_socket_path) {
                        Ok(()) => break inspection,
                        Err(error) => format!(
                            "verified VMM process is present but its API ping failed: {error:#}"
                        ),
                    }
                }
                Ok(inspection) if inspection.health == SandboxHealth::Exited => {
                    bail!("Cloud Hypervisor exited during transient-unit activation")
                }
                Ok(inspection) => format!(
                    "unit health is {:?} and no verified VMM process is visible",
                    inspection.health
                ),
                Err(error) if error_has_io_kind(&error, std::io::ErrorKind::PermissionDenied) => {
                    return Err(error).context(
                        "inspect the cross-UID Cloud Hypervisor process; intar-jailerd requires CAP_SYS_PTRACE",
                    );
                }
                Err(error) => format!("unit inspection failed: {error:#}"),
            };
            if Instant::now() >= deadline {
                bail!(
                    "timed out after {}s waiting for verified Cloud Hypervisor API process; {last_observation}",
                    VMM_START_TIMEOUT.as_secs()
                )
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        let cgroup_path = inspection.cgroup_path.clone();
        if let Some(cgroup_path) = &cgroup_path
            && let Err(error) = assert_cpu_quota(cgroup_path, spec.cpu_quota)
        {
            return Err(error).context("verify transient unit CPU controller");
        }
        Ok(StartedUnit {
            unit_name: spec.unit_name.clone(),
            pid: inspection.pid,
            cgroup_path,
            host_boot_id: inspection.host_boot_id,
            pid_start_time_ticks: inspection.pid_start_time_ticks,
        })
    }

    fn inspect_unit(&mut self, unit_name: &str) -> Result<BackendInspection> {
        self.inspect_existing(unit_name)
    }

    fn stop_unit(&mut self, unit_name: &str) -> Result<bool> {
        let connection = zbus::blocking::Connection::system()?;
        let manager = Self::manager(&connection)?;
        let Some(path) = Self::get_unit_path(&manager, unit_name)? else {
            return Ok(false);
        };
        let service = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.systemd1",
            path,
            "org.freedesktop.systemd1.Service",
        )?;
        let control_group: String = service.get_property("ControlGroup")?;
        let _: zbus::zvariant::OwnedObjectPath = manager
            .call("StopUnit", &(unit_name, "replace"))
            .with_context(|| format!("stop transient unit {unit_name}"))?;
        if !wait_cgroup_drained(&control_group, Duration::from_secs(5))? {
            let _: () = manager
                .call("KillUnit", &(unit_name, "all", 9_i32))
                .with_context(|| format!("kill transient unit cgroup {unit_name}"))?;
            if !wait_cgroup_drained(&control_group, Duration::from_secs(10))? {
                bail!("transient unit cgroup did not drain after SIGKILL")
            }
        }
        Ok(true)
    }

    fn destroy_unit(&mut self, unit_name: &str) -> Result<bool> {
        let connection = zbus::blocking::Connection::system()?;
        let manager = Self::manager(&connection)?;
        let Some(path) = Self::get_unit_path(&manager, unit_name)? else {
            return Ok(false);
        };
        let unit = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.systemd1",
            path,
            "org.freedesktop.systemd1.Unit",
        )?;
        let active_state: String = unit.get_property("ActiveState")?;
        if !matches!(active_state.as_str(), "inactive" | "failed") {
            bail!("refusing to destroy populated transient unit {unit_name}")
        }
        drop(unit);
        let reset: zbus::Result<()> = manager.call("ResetFailedUnit", &(unit_name,));
        match reset {
            Ok(()) => {}
            Err(zbus::Error::MethodError(name, _, _))
                if name.as_str() == "org.freedesktop.systemd1.NoSuchUnit" =>
            {
                return Ok(true);
            }
            Err(error) => {
                return Err(error).with_context(|| format!("reset transient unit {unit_name}"));
            }
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match Self::get_unit_path(&manager, unit_name)? {
                None => return Ok(true),
                Some(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Some(_) => {
                    bail!(
                        "timed out waiting for systemd to unload transient unit {unit_name} after reset"
                    )
                }
            }
        }
    }

    fn ensure_run_network(
        &mut self,
        request: &EnsureRunNetworkRequest,
    ) -> Result<RunNetworkResult> {
        self.network.ensure_run(request)
    }

    fn ensure_vm_network(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        self.network.ensure_vm(run, request, generation, uid, gid)
    }

    fn recover_vm_network(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        self.network.recover_vm(run, request, generation, uid, gid)
    }

    fn destroy_vm_network(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
    ) -> Result<bool> {
        self.network.destroy_vm(run_id, generation)
    }

    fn destroy_run_network(&mut self, request: &DestroyRunNetworkRequest) -> Result<bool> {
        self.network.destroy_run(&request.run_id)
    }
}

#[cfg(target_os = "linux")]
fn minimum_jailer_capability_mask() -> u64 {
    // CAP_CHOWN, CAP_DAC_OVERRIDE, CAP_SETGID, CAP_SETUID, CAP_SETPCAP, CAP_SYS_CHROOT,
    // CAP_SYS_ADMIN, CAP_SYS_RESOURCE, and CAP_MKNOD. The VMM drops every set.
    [0_u32, 1, 6, 7, 8, 18, 21, 24, 27]
        .into_iter()
        .fold(0_u64, |mask, bit| mask | (1_u64 << bit))
}

#[cfg(target_os = "linux")]
fn wait_cgroup_drained(control_group: &str, timeout: Duration) -> Result<bool> {
    if control_group.is_empty() {
        return Ok(true);
    }
    let events = Path::new("/sys/fs/cgroup")
        .join(control_group.trim_start_matches('/'))
        .join("cgroup.events");
    let deadline = Instant::now() + timeout;
    loop {
        match std::fs::read_to_string(&events) {
            Ok(contents)
                if contents
                    .lines()
                    .any(|line| line.split_whitespace().eq(["populated", "0"])) =>
            {
                return Ok(true);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(error) => return Err(error).context("read cgroup drain state"),
            Ok(_) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(_) => return Ok(false),
        }
    }
}

#[cfg(target_os = "linux")]
fn ping_cloud_hypervisor(socket: &Path) -> Result<()> {
    use std::io::{Read as _, Write as _};

    let endpoint = cloud_hypervisor_client::UnixSocketEndpoint::new(socket.to_path_buf())
        .with_context(|| format!("anchor Cloud Hypervisor API {}", socket.display()))?;
    let mut stream = endpoint
        .connect()
        .with_context(|| format!("connect Cloud Hypervisor API {}", socket.display()))?;
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    stream.write_all(
        b"GET /api/v1/vmm.ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )?;
    let mut response = Vec::with_capacity(1_024);
    let mut buffer = [0_u8; 1_024];
    while response.len() < 8 * 1_024 {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => {
                response.extend_from_slice(&buffer[..length]);
                if response.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) && !response.is_empty() =>
            {
                break;
            }
            Err(error) => return Err(error).context("read Cloud Hypervisor API response"),
        }
    }
    let status = response
        .split(|byte| *byte == b'\n')
        .next()
        .context("Cloud Hypervisor API returned an empty response")?;
    if !status.starts_with(b"HTTP/1.1 200") && !status.starts_with(b"HTTP/1.0 200") {
        bail!("Cloud Hypervisor API ping did not return HTTP 200")
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_cpu_stat(control_group: &str) -> Result<intar_jailer_protocol::CpuStat> {
    let relative = control_group.trim_start_matches('/');
    let contents =
        std::fs::read_to_string(Path::new("/sys/fs/cgroup").join(relative).join("cpu.stat"))?;
    let values = contents
        .lines()
        .filter_map(|line| line.split_once(' '))
        .filter_map(|(name, value)| value.parse::<u64>().ok().map(|value| (name, value)))
        .collect::<BTreeMap<_, _>>();
    let get = |name: &str| values.get(name).copied().unwrap_or_default();
    Ok(intar_jailer_protocol::CpuStat {
        usage_usec: get("usage_usec"),
        user_usec: get("user_usec"),
        system_usec: get("system_usec"),
        nr_periods: get("nr_periods"),
        nr_throttled: get("nr_throttled"),
        throttled_usec: get("throttled_usec"),
    })
}

#[cfg(target_os = "linux")]
fn assert_cpu_quota(control_group: &Path, quota: CpuQuota) -> Result<()> {
    let relative = control_group.strip_prefix("/").unwrap_or(control_group);
    let directory = Path::new("/sys/fs/cgroup").join(relative);
    let cpu_max = std::fs::read_to_string(directory.join("cpu.max"))?;
    if cpu_max.trim() != quota.cpu_max() {
        bail!(
            "cpu.max mismatch: expected {}, got {}",
            quota.cpu_max(),
            cpu_max.trim()
        )
    }
    let burst = std::fs::read_to_string(directory.join("cpu.max.burst"))?;
    if burst.trim() != "0" {
        bail!("cpu.max.burst must be zero, got {}", burst.trim())
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_pid_start_time_ticks(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    fields.split_whitespace().nth(19)?.parse().ok()
}

#[cfg(target_os = "linux")]
fn process_network_namespace_inode(pid: u32) -> Option<u64> {
    use std::os::unix::fs::MetadataExt as _;

    std::fs::metadata(format!("/proc/{pid}/ns/net"))
        .ok()
        .map(|metadata| metadata.ino())
}

#[cfg(target_os = "linux")]
fn process_root_inode(pid: u32) -> Option<u64> {
    use std::os::unix::fs::MetadataExt as _;

    std::fs::metadata(format!("/proc/{pid}/root"))
        .ok()
        .map(|metadata| metadata.ino())
}

#[cfg(any(target_os = "linux", test))]
fn capability_set_contains(status: &str, field: &str, capability_bit: u32) -> bool {
    status
        .lines()
        .find_map(|line| line.strip_prefix(field))
        .map(str::trim)
        .and_then(|value| u64::from_str_radix(value, 16).ok())
        .is_some_and(|mask| mask & (1_u64 << capability_bit) != 0)
}

#[cfg(target_os = "linux")]
fn require_supervisor_process_inspection_capability() -> Result<()> {
    let status = std::fs::read_to_string("/proc/self/status")
        .context("read intar-jailerd process capabilities")?;
    for field in ["CapEff:", "CapBnd:"] {
        ensure!(
            capability_set_contains(&status, field, CAP_SYS_PTRACE_BIT),
            "intar-jailerd requires CAP_SYS_PTRACE in {field} to verify unique-UID VMM executables"
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn error_has_io_kind(error: &anyhow::Error, kind: std::io::ErrorKind) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == kind)
    })
}

#[cfg(target_os = "linux")]
fn find_verified_vmm_pid(control_group: &str, expected: &Sha256Digest) -> Result<Option<u32>> {
    if control_group.is_empty() {
        return Ok(None);
    }
    let cgroup = Path::new("/sys/fs/cgroup").join(control_group.trim_start_matches('/'));
    let processes =
        std::fs::read_to_string(cgroup.join("cgroup.procs")).context("read VM cgroup processes")?;
    let mut match_pid = None;
    for line in processes.lines() {
        let pid: u32 = line.parse().context("parse VM cgroup PID")?;
        let executable = PathBuf::from(format!("/proc/{pid}/exe"));
        let file = match File::open(&executable) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("open cgroup process executable for PID {pid}"));
            }
        };
        if !reader_digest_matches(file, expected)? {
            continue;
        }
        let membership = std::fs::read_to_string(format!("/proc/{pid}/cgroup"))?;
        let expected_membership = format!("0::{control_group}");
        if !membership.lines().any(|line| line == expected_membership) {
            bail!("verified VMM PID is outside its systemd cgroup")
        }
        if match_pid.replace(pid).is_some() {
            bail!("VM cgroup contains more than one verified Cloud Hypervisor process")
        }
    }
    Ok(match_pid)
}

#[cfg(target_os = "linux")]
fn reader_digest_matches(mut reader: File, expected: &Sha256Digest) -> Result<bool> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = reader.read(&mut buffer)?;
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
    Ok(encoded == expected.as_str())
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct ProcessSecurity {
    seccomp_enabled: bool,
    no_new_privs: bool,
    capabilities_empty: bool,
}

#[cfg(target_os = "linux")]
fn inspect_process_security(pid: u32) -> Result<ProcessSecurity> {
    let mut saw_task = false;
    let mut result = ProcessSecurity {
        seccomp_enabled: true,
        no_new_privs: true,
        capabilities_empty: true,
    };
    for entry in std::fs::read_dir(format!("/proc/{pid}/task"))? {
        let status = std::fs::read_to_string(entry?.path().join("status"))?;
        saw_task = true;
        let field = |name: &str| {
            status
                .lines()
                .find_map(|line| line.strip_prefix(name))
                .map(str::trim)
        };
        result.seccomp_enabled &= field("Seccomp:") == Some("2");
        result.no_new_privs &= field("NoNewPrivs:") == Some("1");
        for capability in ["CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"] {
            result.capabilities_empty &=
                field(capability).and_then(|value| u64::from_str_radix(value, 16).ok()) == Some(0);
        }
    }
    if !saw_task {
        bail!("VMM has no inspectable tasks")
    }
    Ok(result)
}

#[cfg(target_os = "linux")]
fn read_trimmed(path: &str) -> Result<String> {
    Ok(std::fs::read_to_string(path)?.trim().to_owned())
}

#[cfg(target_os = "linux")]
fn systemd_version() -> Option<String> {
    let connection = zbus::blocking::Connection::system().ok()?;
    let manager = SystemdHostBackend::manager(&connection).ok()?;
    manager.get_property("Version").ok()
}

#[cfg(target_os = "linux")]
fn systemd_major_version(value: &str) -> Option<u32> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| !part.is_empty())?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
fn identity_range_is_free(config: &JailerdConfig) -> bool {
    for path in ["/etc/passwd", "/etc/group"] {
        let Ok(contents) = std::fs::read_to_string(path) else {
            return false;
        };
        if contents.lines().any(|line| {
            line.split(':')
                .nth(2)
                .and_then(|value| value.parse::<u32>().ok())
                .is_some_and(|id| (config.uid_gid_start..=config.uid_gid_end).contains(&id))
        }) {
            return false;
        }
    }
    for path in ["/etc/subuid", "/etc/subgid"] {
        let contents = match std::fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        };
        if contents.lines().any(|line| {
            let mut fields = line.split(':');
            let _name = fields.next();
            let start = fields.next().and_then(|value| value.parse::<u32>().ok());
            let count = fields.next().and_then(|value| value.parse::<u32>().ok());
            match (start, count) {
                (Some(start), Some(count)) if count != 0 => {
                    let end = start.saturating_add(count - 1);
                    start <= config.uid_gid_end && end >= config.uid_gid_start
                }
                _ => true,
            }
        }) {
            return false;
        }
    }
    true
}

#[cfg(target_os = "linux")]
fn path_is_root_trusted(path: &Path, require_directory: bool) -> bool {
    use std::os::unix::fs::MetadataExt as _;

    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink()
        || (require_directory && !metadata.is_dir())
        || (!require_directory && !metadata.is_file())
        || metadata.uid() != 0
        || metadata.gid() != 0
        || metadata.mode() & 0o022 != 0
        || (!require_directory && metadata.nlink() != 1)
    {
        return false;
    }
    trusted_root_ancestors(path)
}

#[cfg(target_os = "linux")]
fn path_is_trusted_source_root(path: &Path, agent_uid: u32, agent_gid: u32) -> bool {
    use std::os::unix::fs::MetadataExt as _;

    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    let owner_ok = metadata.uid() == 0 || metadata.uid() == agent_uid;
    let group_ok = metadata.gid() == 0 || metadata.gid() == agent_gid;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || !owner_ok
        || !group_ok
        || metadata.mode() & 0o002 != 0
    {
        return false;
    }
    trusted_root_ancestors(path)
}

#[cfg(target_os = "linux")]
fn trusted_root_ancestors(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt as _;

    let mut current = path.parent();
    while let Some(ancestor) = current {
        let Ok(metadata) = std::fs::symlink_metadata(ancestor) else {
            return false;
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
        {
            return false;
        }
        current = ancestor.parent();
    }
    true
}

#[cfg(target_os = "linux")]
fn file_digest_matches(path: &Path, expected: &Sha256Digest) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let Ok(length) = file.read(&mut buffer) else {
            return false;
        };
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
    encoded == expected.as_str()
}

#[cfg(target_os = "linux")]
fn elf_has_no_interpreter(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    if bytes.len() < 64 || &bytes[..4] != b"\x7fELF" || bytes[4] != 2 || bytes[5] != 1 {
        return false;
    }
    let read_u16 = |offset: usize| {
        bytes
            .get(offset..offset + 2)
            .and_then(|value| value.try_into().ok())
            .map(u16::from_le_bytes)
    };
    let read_u32 = |offset: usize| {
        bytes
            .get(offset..offset + 4)
            .and_then(|value| value.try_into().ok())
            .map(u32::from_le_bytes)
    };
    let read_u64 = |offset: usize| {
        bytes
            .get(offset..offset + 8)
            .and_then(|value| value.try_into().ok())
            .map(u64::from_le_bytes)
    };
    let Some(program_offset) = read_u64(32).and_then(|value| usize::try_from(value).ok()) else {
        return false;
    };
    let Some(entry_size) = read_u16(54).map(usize::from) else {
        return false;
    };
    let Some(entry_count) = read_u16(56).map(usize::from) else {
        return false;
    };
    if entry_size < 4 {
        return false;
    }
    for index in 0..entry_count {
        let Some(offset) = index
            .checked_mul(entry_size)
            .and_then(|value| program_offset.checked_add(value))
        else {
            return false;
        };
        // PT_INTERP indicates a dynamic loader even when all other libraries
        // happen to be statically linked.
        if read_u32(offset) == Some(3) {
            return false;
        }
    }
    true
}

#[derive(Clone, Debug)]
pub struct PreparedJail {
    pub generation: ValidatedId,
    pub uid: u32,
    pub gid: u32,
    pub spec_path: PathBuf,
    pub jail_root_inode: Option<u64>,
    pub paths: JailPathMap,
}

pub trait JailPreparer: Send {
    fn prepare(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        netns_name: &str,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail>;
    fn destroy(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<bool>;
    fn quarantine(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<()>;
    fn persist(&mut self, _config: &JailerdConfig, _record: &VmRecord) -> Result<()> {
        Ok(())
    }
    fn recover(&mut self, _config: &JailerdConfig) -> Result<Vec<VmRecord>> {
        Ok(Vec::new())
    }
    fn export_recording(&mut self, _config: &JailerdConfig, _record: &VmRecord) -> Result<()> {
        Ok(())
    }
    fn reserve_identity(
        &mut self,
        _config: &JailerdConfig,
        _generation: &ValidatedId,
        _uid: u32,
        _gid: u32,
    ) -> Result<()> {
        Ok(())
    }
    fn release_identity_reservation(
        &mut self,
        _config: &JailerdConfig,
        _generation: &ValidatedId,
    ) -> Result<()> {
        Ok(())
    }
    fn recover_reserved_identities(&mut self, _config: &JailerdConfig) -> Result<BTreeSet<u32>> {
        Ok(BTreeSet::new())
    }
}

#[derive(Default)]
pub struct FileSystemJailPreparer;

impl JailPreparer for FileSystemJailPreparer {
    fn prepare(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        netns_name: &str,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail> {
        prepare_jail_files(config, request, netns_name, generation, uid, gid)
    }

    fn destroy(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<bool> {
        remove_generation_tree(config, generation)
    }

    fn quarantine(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<()> {
        quarantine_generation(config, generation)
    }

    fn persist(&mut self, config: &JailerdConfig, record: &VmRecord) -> Result<()> {
        let jail_root = trusted_jail_root_fd(config)?;
        let parent = open_optional_root_directory_at(&jail_root, c"cloud-hypervisor")?
            .context("jail generation parent is missing")?;
        let generation_name =
            CString::new(record.generation.as_str()).expect("validated generation contains no NUL");
        let directory = open_lifecycle_entry_at(
            &parent,
            &generation_name,
            OFlags::RDONLY | OFlags::DIRECTORY,
        )
        .context("open jail generation for metadata persistence")?;
        validate_root_directory(&directory, "jail generation")?;

        let destination = c"metadata-v1.json";
        if let Ok(existing) = open_lifecycle_entry_at(&directory, destination, OFlags::RDONLY) {
            validate_root_regular_file(&existing, "existing jail metadata")?;
        } else {
            match rustix::fs::statat(
                &directory,
                destination,
                rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
            ) {
                Err(error) if error == rustix::io::Errno::NOENT => {}
                Ok(_) => bail!("existing jail metadata is not a trusted regular file"),
                Err(error) => return Err(error).context("inspect existing jail metadata"),
            }
        }

        let temporary = CString::new(format!("metadata-v1.json.tmp-{}", Uuid::new_v4()))
            .expect("UUID temporary name has no NUL");
        let result = (|| -> Result<()> {
            let fd = rustix::fs::openat(
                &directory,
                &temporary,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::RUSR | Mode::WUSR,
            )
            .context("create fd-relative jail metadata")?;
            let mut file = File::from(fd);
            to_writer(&mut file, record).context("serialize jail metadata")?;
            file.write_all(b"\n")?;
            rustix::fs::fchmod(&file, Mode::RUSR | Mode::WUSR)?;
            file.sync_all()?;
            let temporary_stat = rustix::fs::fstat(&file)?;
            validate_root_regular_stat(&temporary_stat, "new jail metadata")?;
            rustix::fs::renameat(&directory, &temporary, &directory, destination)
                .context("publish jail metadata by dirfd")?;
            let published = open_lifecycle_entry_at(&directory, destination, OFlags::RDONLY)?;
            let published_stat = validate_root_regular_file(&published, "published jail metadata")?;
            if !same_lifecycle_object(&temporary_stat, &published_stat) {
                bail!("published jail metadata inode changed during rename")
            }
            rustix::fs::fsync(&directory)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = rustix::fs::unlinkat(&directory, &temporary, rustix::fs::AtFlags::empty());
        }
        result
    }

    fn recover(&mut self, config: &JailerdConfig) -> Result<Vec<VmRecord>> {
        let jail_root = trusted_jail_root_fd(config)?;
        let Some(root) = open_optional_root_directory_at(&jail_root, c"cloud-hypervisor")? else {
            return Ok(Vec::new());
        };
        let mut records = Vec::new();
        for name in lifecycle_directory_names(&root)? {
            let entry_stat =
                rustix::fs::statat(&root, &name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)?;
            if rustix::fs::FileType::from_raw_mode(entry_stat.st_mode)
                != rustix::fs::FileType::Directory
            {
                bail!("unexpected non-directory in jail generation root")
            }
            let generation_fd =
                open_lifecycle_entry_at(&root, &name, OFlags::RDONLY | OFlags::DIRECTORY)
                    .context("open persisted generation beneath pinned root")?;
            let opened_stat = validate_root_directory(&generation_fd, "persisted jail generation")?;
            if !same_lifecycle_object(&entry_stat, &opened_stat) {
                bail!("persisted jail generation changed while being opened")
            }
            let Ok(name_text) = name.to_str() else {
                let destination = CString::new(format!("invalid-{}", Uuid::new_v4()))
                    .expect("UUID quarantine name contains no NUL");
                quarantine_entry_at(&jail_root, &root, &name, &generation_fd, &destination)?;
                continue;
            };
            let Ok(generation) = ValidatedId::parse(name_text.to_owned()) else {
                let destination = CString::new(format!("invalid-{}", Uuid::new_v4()))
                    .expect("UUID quarantine name contains no NUL");
                quarantine_entry_at(&jail_root, &root, &name, &generation_fd, &destination)?;
                continue;
            };
            let recovered = (|| -> Result<VmRecord> {
                let bytes = read_root_metadata_at(&generation_fd, c"metadata-v1.json")?;
                let record: VmRecord =
                    serde_json::from_slice(&bytes).context("parse persisted jail metadata")?;
                if record.generation != generation {
                    bail!("persisted generation metadata does not match its directory")
                }
                let root_fd = open_lifecycle_entry_at(
                    &generation_fd,
                    c"root",
                    OFlags::RDONLY | OFlags::DIRECTORY,
                )
                .context("open persisted jail root beneath generation")?;
                let root_stat = validate_root_directory(&root_fd, "persisted jail root")?;
                if record.jail_root_inode != Some(root_stat.st_ino) {
                    bail!("persisted jail-root inode changed")
                }
                Ok(record)
            })();
            match recovered {
                Ok(record) => records.push(record),
                Err(_) => {
                    stop_orphan_generation(&generation)?;
                    if let Some((uid, gid)) = infer_generation_identity_at(&generation_fd, config) {
                        self.reserve_identity(config, &generation, uid, gid)?;
                    }
                    quarantine_entry_at(&jail_root, &root, &name, &generation_fd, &name)?;
                }
            }
        }
        Ok(records)
    }

    fn export_recording(&mut self, config: &JailerdConfig, record: &VmRecord) -> Result<()> {
        export_recording_disk(config, record)
    }

    fn reserve_identity(
        &mut self,
        config: &JailerdConfig,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        persist_identity_reservation(config, generation, uid, gid)
    }

    fn release_identity_reservation(
        &mut self,
        config: &JailerdConfig,
        generation: &ValidatedId,
    ) -> Result<()> {
        let Some(directory) = identity_reservation_directory_fd(config, false)? else {
            return Ok(());
        };
        let name = CString::new(format!("{}.json", generation.as_str()))
            .expect("validated reservation name contains no NUL");
        let reservation = match open_lifecycle_entry_at(&directory, &name, OFlags::RDONLY) {
            Ok(fd) => fd,
            Err(error) if error == rustix::io::Errno::NOENT => return Ok(()),
            Err(error) => return Err(error).context("open identity reservation for release"),
        };
        let opened = validate_root_regular_file(&reservation, "identity reservation")?;
        let current = rustix::fs::statat(&directory, &name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)?;
        if !same_lifecycle_object(&opened, &current) || current.st_nlink != 1 {
            bail!("identity reservation changed before release")
        }
        rustix::fs::unlinkat(&directory, &name, rustix::fs::AtFlags::empty())
            .context("release identity reservation by dirfd")?;
        rustix::fs::fsync(&directory)?;
        Ok(())
    }

    fn recover_reserved_identities(&mut self, config: &JailerdConfig) -> Result<BTreeSet<u32>> {
        recover_identity_reservations(config)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct IdentityReservationV1 {
    version: u16,
    generation: ValidatedId,
    uid: u32,
    gid: u32,
}

fn validate_root_regular_stat(stat: &rustix::fs::Stat, label: &str) -> Result<()> {
    if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
        || stat.st_uid != 0
        || stat.st_gid != 0
        || stat.st_nlink != 1
        || stat.st_mode & 0o177 != 0
    {
        bail!("{label} must be a root-owned private regular file with one link")
    }
    Ok(())
}

fn validate_root_regular_file(
    file: &impl std::os::fd::AsFd,
    label: &str,
) -> Result<rustix::fs::Stat> {
    let stat = rustix::fs::fstat(file)?;
    validate_root_regular_stat(&stat, label)?;
    Ok(stat)
}

fn read_root_metadata_at(parent: &impl std::os::fd::AsFd, name: &CStr) -> Result<Vec<u8>> {
    let fd = open_lifecycle_entry_at(parent, name, OFlags::RDONLY)
        .context("open root metadata beneath pinned directory")?;
    validate_root_regular_file(&fd, "persisted VM metadata")?;
    let file = File::from(fd);
    let mut bytes = Vec::new();
    file.take((intar_jailer_protocol::MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > intar_jailer_protocol::MAX_FRAME_BYTES {
        bail!("persisted root metadata exceeds frame limit")
    }
    Ok(bytes)
}

fn infer_generation_identity_at(
    directory: &impl std::os::fd::AsFd,
    config: &JailerdConfig,
) -> Option<(u32, u32)> {
    let fd = open_lifecycle_entry_at(directory, c"root/disks/root.raw", OFlags::RDONLY).ok()?;
    let stat = rustix::fs::fstat(&fd).ok()?;
    let uid = stat.st_uid;
    let gid = stat.st_gid;
    (rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::RegularFile
        && stat.st_nlink == 1
        && uid == gid
        && (config.uid_gid_start..=config.uid_gid_end).contains(&uid))
    .then_some((uid, gid))
}

#[cfg(target_os = "linux")]
fn stop_orphan_generation(generation: &ValidatedId) -> Result<()> {
    let unit_name = format!("intar-vm-{generation}.service");
    let connection = zbus::blocking::Connection::system()?;
    let manager = SystemdHostBackend::manager(&connection)?;
    let path: Result<zbus::zvariant::OwnedObjectPath> = manager
        .call("GetUnit", &(unit_name.as_str(),))
        .map_err(Into::into);
    let Ok(path) = path else {
        return Ok(());
    };
    let service = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.systemd1",
        path,
        "org.freedesktop.systemd1.Service",
    )?;
    let control_group: String = service.get_property("ControlGroup")?;
    let _: zbus::zvariant::OwnedObjectPath =
        manager.call("StopUnit", &(unit_name.as_str(), "replace"))?;
    if !wait_cgroup_drained(&control_group, Duration::from_secs(5))? {
        let _: () = manager.call("KillUnit", &(unit_name.as_str(), "all", 9_i32))?;
        if !wait_cgroup_drained(&control_group, Duration::from_secs(10))? {
            bail!("orphan transient unit did not drain")
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn stop_orphan_generation(_generation: &ValidatedId) -> Result<()> {
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmRecord {
    generation: ValidatedId,
    request: VmLaunchRequest,
    request_fingerprint: Sha256Digest,
    run_network: RunNetworkRecord,
    unit_name: String,
    uid: u32,
    gid: u32,
    quota: CpuQuota,
    vcpu_count: u16,
    paths: JailPathMap,
    cgroup_path: Option<PathBuf>,
    netns_name: String,
    host_boot_id: Option<String>,
    pid_start_time_ticks: Option<u64>,
    jail_root_inode: Option<u64>,
    cloud_hypervisor_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct RunNetworkRecord {
    request: EnsureRunNetworkRequest,
    result: RunNetworkResult,
}

pub struct JailerdCore<B, P> {
    config: JailerdConfig,
    backend: B,
    preparer: P,
    total_cpu_millis: u64,
    records: BTreeMap<ValidatedId, VmRecord>,
    allocated_identities: BTreeSet<u32>,
    run_networks: BTreeMap<ValidatedId, RunNetworkRecord>,
    readiness: HostReadiness,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HostReadiness {
    pub uid_gid_range_collision_free: bool,
    pub config_trusted: bool,
    pub source_roots_trusted: bool,
    pub jailer_binary_trusted: bool,
    pub runtime_hash_verified: bool,
    pub runtime_statically_linked: bool,
    pub systemd_version: Option<String>,
    pub supports_systemd_transient_units: bool,
    pub supports_cgroup_v2: bool,
    pub seccomp_supported: bool,
    pub landlock_abi: Option<u32>,
    pub privileged_self_test_passed: bool,
    pub kvm_accounting_proven: bool,
    pub posix_acl_supported: bool,
}

impl HostReadiness {
    #[cfg(target_os = "linux")]
    pub fn probe(config: &JailerdConfig, config_path: &Path) -> Self {
        let systemd_version = systemd_version();
        let self_test = self_test::load_verified(config).ok().flatten();
        Self {
            uid_gid_range_collision_free: identity_range_is_free(config),
            config_trusted: path_is_root_trusted(config_path, false),
            source_roots_trusted: config
                .allowed_source_roots
                .iter()
                .all(|path| path_is_trusted_source_root(path, config.agent_uid, config.agent_gid)),
            jailer_binary_trusted: path_is_root_trusted(&config.jailer_binary, false),
            runtime_hash_verified: path_is_root_trusted(&config.cloud_hypervisor_binary, false)
                && file_digest_matches(
                    &config.cloud_hypervisor_binary,
                    &config.cloud_hypervisor_sha256,
                ),
            runtime_statically_linked: path_is_root_trusted(&config.cloud_hypervisor_binary, false)
                && elf_has_no_interpreter(&config.cloud_hypervisor_binary),
            supports_systemd_transient_units: systemd_version
                .as_deref()
                .and_then(systemd_major_version)
                .is_some_and(|version| version >= 252),
            systemd_version,
            supports_cgroup_v2: std::fs::read_to_string("/sys/fs/cgroup/cgroup.controllers")
                .is_ok_and(|controllers| {
                    controllers.split_whitespace().any(|value| value == "cpu")
                }),
            seccomp_supported: Path::new("/proc/sys/kernel/seccomp/actions_avail").is_file(),
            landlock_abi: self_test.as_ref().map(|value| value.landlock_abi),
            privileged_self_test_passed: self_test.as_ref().is_some_and(|value| {
                value.quota_verified
                    && value.burst_verified
                    && value.network_verified
                    && value.landlock_negative_access
                    && value.cloud_hypervisor_lifecycle_verified
            }),
            kvm_accounting_proven: self_test
                .as_ref()
                .is_some_and(|value| value.kvm_accounting_proven),
            posix_acl_supported: ["/usr/bin/setfacl", "/usr/sbin/setfacl"]
                .iter()
                .any(|path| path_is_root_trusted(Path::new(path), false)),
        }
    }
}

impl<B: HostBackend, P: JailPreparer> JailerdCore<B, P> {
    pub fn new(
        config: JailerdConfig,
        backend: B,
        preparer: P,
        total_cpu_millis: u64,
    ) -> Result<Self> {
        Self::new_with_readiness(
            config,
            backend,
            preparer,
            total_cpu_millis,
            HostReadiness::default(),
        )
    }

    pub fn new_with_readiness(
        config: JailerdConfig,
        mut backend: B,
        mut preparer: P,
        total_cpu_millis: u64,
        mut readiness: HostReadiness,
    ) -> Result<Self> {
        config.validate().context("validate jailerd config")?;
        if total_cpu_millis == 0 {
            bail!("host CPU capacity must be positive")
        }
        let current_boot_id = current_host_boot_id();
        let mut records = BTreeMap::new();
        let mut allocated_identities = preparer.recover_reserved_identities(&config)?;
        let mut active_identities = BTreeSet::new();
        let mut run_networks = BTreeMap::<ValidatedId, RunNetworkRecord>::new();
        let mut recovery_clean = true;
        for record in preparer.recover(&config)? {
            if validate_recovered_record(&config, &record).is_err() {
                quarantine_recovered_record(&config, &mut backend, &mut preparer, &record)?;
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            if record.host_boot_id.as_deref() != current_boot_id.as_deref() {
                quarantine_recovered_record(&config, &mut backend, &mut preparer, &record)?;
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            let inspection = match backend.inspect_unit(&record.unit_name) {
                Ok(inspection) => inspection,
                Err(_) => {
                    quarantine_recovered_record(&config, &mut backend, &mut preparer, &record)?;
                    allocated_identities.insert(record.uid);
                    recovery_clean = false;
                    continue;
                }
            };
            if !matches!(
                inspection.health,
                SandboxHealth::Healthy | SandboxHealth::Exited
            ) || !backend_identity_matches(&record, &inspection)
                || (inspection.health == SandboxHealth::Healthy
                    && !live_api_ping(&record.paths.host_api_socket))
            {
                quarantine_recovered_record(&config, &mut backend, &mut preparer, &record)?;
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            match run_networks.get(&record.request.run_id) {
                Some(existing) if existing != &record.run_network => {
                    quarantine_recovered_record(&config, &mut backend, &mut preparer, &record)?;
                    allocated_identities.insert(record.uid);
                    recovery_clean = false;
                    continue;
                }
                Some(_) => {}
                None => {
                    let actual = match backend.ensure_run_network(&record.run_network.request) {
                        Ok(actual) => actual,
                        Err(_) => {
                            quarantine_recovered_record(
                                &config,
                                &mut backend,
                                &mut preparer,
                                &record,
                            )?;
                            allocated_identities.insert(record.uid);
                            recovery_clean = false;
                            continue;
                        }
                    };
                    if actual != record.run_network.result {
                        quarantine_recovered_record(&config, &mut backend, &mut preparer, &record)?;
                        allocated_identities.insert(record.uid);
                        recovery_clean = false;
                        continue;
                    }
                    run_networks.insert(record.request.run_id.clone(), record.run_network.clone());
                }
            }
            if backend
                .recover_vm_network(
                    &record.run_network.request,
                    &record.request,
                    &record.generation,
                    record.uid,
                    record.gid,
                )
                .is_err()
            {
                quarantine_recovered_record(&config, &mut backend, &mut preparer, &record)?;
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            if !active_identities.insert(record.uid) {
                quarantine_recovered_record(&config, &mut backend, &mut preparer, &record)?;
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            allocated_identities.insert(record.uid);
            records.insert(record.generation.clone(), record);
        }
        if !recovery_clean {
            readiness.privileged_self_test_passed = false;
            readiness.kvm_accounting_proven = false;
        }
        Ok(Self {
            config,
            backend,
            preparer,
            total_cpu_millis,
            records,
            allocated_identities,
            run_networks,
            readiness,
        })
    }

    pub fn handle(&mut self, request: Request) -> Response {
        if let Err(error) = validate_protocol_request(&request) {
            return Response::Error(ProtocolError::new("invalid_request", format!("{error:#}")));
        }
        let policy_validation = match &request {
            Request::EnsureRunNetwork(request) => self.config.validate_run_network_request(request),
            Request::LaunchVm(request) => self
                .config
                .validate_ssh_public_port(request.ssh_public_port),
            _ => Ok(()),
        };
        if let Err(error) = policy_validation {
            return Response::Error(ProtocolError::new("invalid_request", error.to_string()));
        }
        if matches!(request, Request::LaunchVm(_)) && !self.capabilities().supports_jailer_v1 {
            return Response::Error(ProtocolError::new(
                "host_not_ready",
                "host readiness attestation does not permit VM launches",
            ));
        }
        match self.try_handle(request) {
            Ok(response) => response,
            Err(error) => {
                let message = format!("{error:#}");
                Response::Error(ProtocolError::new(
                    classify_protocol_error(&message),
                    message,
                ))
            }
        }
    }

    fn try_handle(&mut self, request: Request) -> Result<Response> {
        match request {
            Request::Capabilities => Ok(Response::Capabilities(self.capabilities())),
            Request::EnsureRunNetwork(request) => {
                request.validate().context("validate run network request")?;
                let result = self.backend.ensure_run_network(&request)?;
                let record = RunNetworkRecord {
                    request: request.clone(),
                    result: result.clone(),
                };
                match self.run_networks.get(&request.run_id) {
                    Some(existing) if existing != &record => {
                        bail!("run network already exists with different topology")
                    }
                    Some(_) => {}
                    None => {
                        self.run_networks.insert(request.run_id.clone(), record);
                    }
                }
                Ok(Response::EnsureRunNetwork(result))
            }
            Request::LaunchVm(request) => Ok(Response::LaunchVm(self.launch_vm(*request)?)),
            Request::InspectVm(request) => Ok(Response::InspectVm(self.inspect_vm(request)?)),
            Request::StopVm(request) => Ok(Response::StopVm(OperationResult {
                changed: self.stop_vm(request)?,
            })),
            Request::DestroyVm(request) => Ok(Response::DestroyVm(OperationResult {
                changed: self.destroy_vm(request)?,
            })),
            Request::DestroyRunNetwork(request) => {
                if self
                    .records
                    .values()
                    .any(|record| record.request.run_id == request.run_id)
                {
                    bail!("run network still has VM generations")
                }
                let changed = self.backend.destroy_run_network(&request)?;
                self.run_networks.remove(&request.run_id);
                Ok(Response::DestroyRunNetwork(OperationResult { changed }))
            }
        }
    }

    pub fn capabilities(&self) -> JailerCapabilities {
        let committed_cpu_millis = self.committed_cpu_millis();
        let schedulable_cpu_millis = self
            .total_cpu_millis
            .saturating_sub(self.config.cpu_reserved_millis);
        let ready = self.backend.production_ready()
            && (self.readiness.uid_gid_range_collision_free
                || self.config.allow_uid_gid_collisions)
            && self.readiness.config_trusted
            && self.readiness.source_roots_trusted
            && self.readiness.jailer_binary_trusted
            && self.readiness.runtime_hash_verified
            && self.readiness.runtime_statically_linked
            && self.readiness.supports_systemd_transient_units
            && self.readiness.supports_cgroup_v2
            && self.readiness.seccomp_supported
            && self.readiness.posix_acl_supported
            && self.readiness.landlock_abi.is_some_and(|abi| abi >= 3)
            && self.readiness.privileged_self_test_passed
            && self.readiness.kvm_accounting_proven;
        JailerCapabilities {
            protocol_version: PROTOCOL_VERSION,
            cloud_hypervisor_version: CLOUD_HYPERVISOR_VERSION.to_owned(),
            cloud_hypervisor_sha256: CLOUD_HYPERVISOR_SHA256.to_owned(),
            total_cpu_millis: self.total_cpu_millis,
            reserved_cpu_millis: self.config.cpu_reserved_millis,
            schedulable_cpu_millis,
            committed_cpu_millis,
            supports_jailer_v1: ready,
            supports_hard_cpu_quota: ready,
            supports_landlock: ready,
            supports_cgroup_v2: self.readiness.supports_cgroup_v2,
            uid_gid_start: self.config.uid_gid_start,
            uid_gid_end: self.config.uid_gid_end,
            uid_gid_range_collision_free: self.readiness.uid_gid_range_collision_free,
            config_trusted: self.readiness.config_trusted,
            source_roots_trusted: self.readiness.source_roots_trusted,
            jailer_binary_trusted: self.readiness.jailer_binary_trusted,
            runtime_hash_verified: self.readiness.runtime_hash_verified,
            runtime_statically_linked: self.readiness.runtime_statically_linked,
            systemd_version: self.readiness.systemd_version.clone(),
            supports_systemd_transient_units: self.readiness.supports_systemd_transient_units,
            seccomp_supported: self.readiness.seccomp_supported,
            landlock_abi: self.readiness.landlock_abi,
            privileged_self_test_passed: self.readiness.privileged_self_test_passed,
            kvm_accounting_proven: self.readiness.kvm_accounting_proven,
            allow_uid_gid_collisions: self.config.allow_uid_gid_collisions,
            allowed_source_roots: self.config.allowed_source_roots.clone(),
            posix_acl_supported: self.readiness.posix_acl_supported,
            guest_network_pool: self.config.guest_network_pool.clone(),
            run_guest_network_prefix: intar_jailer_protocol::RUN_GUEST_NETWORK_PREFIX,
            ssh_public_port_start: self.config.ssh_public_port_start,
            ssh_public_port_end: self.config.ssh_public_port_end,
        }
    }

    fn launch_vm(&mut self, request: VmLaunchRequest) -> Result<VmLaunchResult> {
        let quota = request.validate().context("validate VM launch request")?;
        self.config
            .validate_ssh_public_port(request.ssh_public_port)
            .context("validate root-owned SSH public port policy")?;
        if !self.capabilities().supports_jailer_v1 {
            bail!("host readiness attestation does not permit VM launches")
        }
        let fingerprint = request_fingerprint(&request)?;
        if let Some(existing) = self.records.values().find(|record| {
            record.request.run_id == request.run_id && record.request.vm_id == request.vm_id
        }) {
            if existing.request_fingerprint != fingerprint {
                bail!("logical VM already exists with a different launch request")
            }
            return self.launch_result(existing.clone());
        }
        let run_network = self
            .run_networks
            .get(&request.run_id)
            .context("run network must be ensured before launching a VM")?
            .clone();
        let generation =
            ValidatedId::parse(Uuid::new_v4().to_string()).expect("UUID is a valid generation");
        if self.records.contains_key(&generation) {
            bail!("generation {generation} already exists")
        }
        let schedulable = self
            .total_cpu_millis
            .saturating_sub(self.config.cpu_reserved_millis);
        let after_launch = self
            .committed_cpu_millis()
            .checked_add(u64::from(request.cpu_millis))
            .context("CPU admission arithmetic overflow")?;
        if after_launch > schedulable {
            bail!(
                "local CPU capacity exhausted: committed={} requested={} schedulable={schedulable}",
                self.committed_cpu_millis(),
                request.cpu_millis
            )
        }

        let identity = self.allocate_identity()?;
        self.preparer
            .reserve_identity(&self.config, &generation, identity, identity)?;
        let prepared = match self.preparer.prepare(
            &self.config,
            &request,
            &run_network.result.namespace_name,
            &generation,
            identity,
            identity,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                return Err(error).context("prepare jail filesystem");
            }
        };
        if let Err(error) = self.backend.ensure_vm_network(
            &run_network.request,
            &request,
            &generation,
            identity,
            identity,
        ) {
            let _ = self
                .backend
                .destroy_vm_network(&request.run_id, &generation);
            let _ = self.preparer.quarantine(&self.config, &generation);
            return Err(error).context("prepare VM TAP and forwarding policy");
        }
        let unit_name = format!("intar-vm-{generation}.service");
        let unit_spec = UnitLaunchSpec {
            unit_name: unit_name.clone(),
            description: format!("Intar jailed VM {} / {}", request.run_id, request.vm_id),
            jailer_binary: self.config.jailer_binary.clone(),
            jail_spec_path: prepared.spec_path,
            api_socket_path: prepared.paths.host_api_socket.clone(),
            cpu_quota: quota,
            uid: identity,
            gid: identity,
            // The jailer creates these four device nodes after pivot_root, so
            // systemd's closed device policy must grant its distinct `m`
            // permission as well as the VMM's runtime access. Cloud
            // Hypervisor cannot create devices after the jailer clears every
            // capability set.
            device_allow: JAIL_DEVICE_ALLOW.to_vec(),
        };
        let mut record = VmRecord {
            generation: generation.clone(),
            request: request.clone(),
            request_fingerprint: fingerprint,
            run_network: run_network.clone(),
            unit_name: unit_name.clone(),
            uid: identity,
            gid: identity,
            quota,
            vcpu_count: request.vcpu_count,
            paths: prepared.paths.clone(),
            cgroup_path: None,
            netns_name: run_network.result.namespace_name.clone(),
            host_boot_id: current_host_boot_id(),
            pid_start_time_ticks: None,
            jail_root_inode: prepared.jail_root_inode,
            cloud_hypervisor_sha256: self.config.cloud_hypervisor_sha256.as_str().to_owned(),
        };
        if let Err(error) = self.preparer.persist(&self.config, &record) {
            let _ = self
                .backend
                .destroy_vm_network(&request.run_id, &generation);
            let _ = self.preparer.quarantine(&self.config, &generation);
            return Err(error).context("persist pre-launch VM intent");
        }
        let started = match self.backend.start_unit(&unit_spec) {
            Ok(started) => started,
            Err(error) => {
                return self.fail_launch(
                    &request.run_id,
                    &generation,
                    &unit_name,
                    error.context("start sandbox transient unit"),
                );
            }
        };
        if started.unit_name != unit_name {
            return self.fail_launch(
                &request.run_id,
                &generation,
                &unit_name,
                anyhow::anyhow!("backend returned mismatched transient unit name"),
            );
        }
        record.cgroup_path.clone_from(&started.cgroup_path);
        record.host_boot_id.clone_from(&started.host_boot_id);
        record.pid_start_time_ticks = started.pid_start_time_ticks;
        if let Err(error) = self.preparer.persist(&self.config, &record) {
            return self.fail_launch(
                &request.run_id,
                &generation,
                &unit_name,
                error.context("persist VM sandbox identity"),
            );
        }
        self.records.insert(generation.clone(), record);
        Ok(VmLaunchResult {
            generation,
            unit_name,
            pid: started.pid,
            cgroup_path: started.cgroup_path,
            uid: identity,
            gid: identity,
            netns_name: run_network.result.namespace_name,
            netns_inode: run_network.result.namespace_inode,
            host_boot_id: started.host_boot_id,
            pid_start_time_ticks: started.pid_start_time_ticks,
            jail_root_inode: prepared.jail_root_inode,
            cloud_hypervisor_sha256: self.config.cloud_hypervisor_sha256.as_str().to_owned(),
            paths: prepared.paths,
        })
    }

    fn fail_launch<T>(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
        unit_name: &str,
        failure: anyhow::Error,
    ) -> Result<T> {
        match self.rollback_failed_launch(run_id, generation, unit_name) {
            Ok(()) => Err(failure),
            Err(rollback_error) => Err(failure.context(format!(
                "failed-launch rollback was incomplete: {rollback_error:#}"
            ))),
        }
    }

    fn rollback_failed_launch(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
        unit_name: &str,
    ) -> Result<()> {
        let mut failures = Vec::new();
        let stop_proved_drain = match self.backend.stop_unit(unit_name) {
            Ok(_) => true,
            Err(error) => {
                failures.push(format!("stop transient unit {unit_name}: {error:#}"));
                false
            }
        };
        let destroy_proved_drain = match self.backend.destroy_unit(unit_name) {
            Ok(_) => true,
            Err(error) => {
                failures.push(format!("destroy transient unit {unit_name}: {error:#}"));
                false
            }
        };
        if stop_proved_drain || destroy_proved_drain {
            if let Err(error) = self.backend.destroy_vm_network(run_id, generation) {
                failures.push(format!(
                    "destroy VM network for generation {generation}: {error:#}"
                ));
            }
            if let Err(error) = self.preparer.quarantine(&self.config, generation) {
                failures.push(format!("quarantine generation {generation}: {error:#}"));
            }
        } else {
            failures.push(format!(
                "preserved VM network and generation {generation} because cgroup drain was not proven"
            ));
        }
        if failures.is_empty() {
            Ok(())
        } else {
            bail!(failures.join("; "))
        }
    }

    fn launch_result(&mut self, record: VmRecord) -> Result<VmLaunchResult> {
        let inspection = self.backend.inspect_unit(&record.unit_name)?;
        // This is a same-daemon retry of a launch whose `start_unit` handshake
        // already verified the API socket before the record was persisted and
        // inserted. Re-pinging here turns a transient API stall into destructive
        // quarantine and makes the idempotency response race VMM API readiness.
        // Recovery and InspectVm remain the liveness authorities and still
        // require a successful API ping for a healthy process.
        if !backend_identity_matches(&record, &inspection) {
            self.backend.stop_unit(&record.unit_name)?;
            self.backend.destroy_unit(&record.unit_name)?;
            let _ = self
                .backend
                .destroy_vm_network(&record.request.run_id, &record.generation);
            self.preparer.quarantine(&self.config, &record.generation)?;
            bail!("idempotent launch found mismatched live VM identity")
        }
        Ok(VmLaunchResult {
            generation: record.generation,
            unit_name: record.unit_name,
            pid: inspection.pid,
            cgroup_path: record.cgroup_path,
            uid: record.uid,
            gid: record.gid,
            netns_name: record.netns_name,
            netns_inode: record.run_network.result.namespace_inode,
            host_boot_id: record.host_boot_id,
            pid_start_time_ticks: record.pid_start_time_ticks,
            jail_root_inode: record.jail_root_inode,
            cloud_hypervisor_sha256: record.cloud_hypervisor_sha256,
            paths: record.paths,
        })
    }

    fn inspect_vm(&mut self, request: VmIdentityRequest) -> Result<VmInspection> {
        let generation = self.resolve_generation(&request)?;
        let record = self
            .records
            .get(&generation)
            .context("unknown jail generation")?
            .clone();
        let inspection = self.backend.inspect_unit(&record.unit_name)?;
        if !backend_identity_matches(&record, &inspection)
            || (inspection.health == SandboxHealth::Healthy
                && !live_api_ping(&record.paths.host_api_socket))
        {
            self.backend.stop_unit(&record.unit_name)?;
            self.backend.destroy_unit(&record.unit_name)?;
            let _ = self
                .backend
                .destroy_vm_network(&record.request.run_id, &record.generation);
            self.preparer.quarantine(&self.config, &record.generation)?;
            bail!("live VM identity does not match persisted sandbox metadata")
        }
        Ok(VmInspection {
            generation: record.generation,
            unit_name: record.unit_name,
            pid: inspection.pid,
            cgroup_path: inspection.cgroup_path,
            uid: record.uid,
            gid: record.gid,
            netns_name: record.netns_name,
            netns_inode: record.run_network.result.namespace_inode,
            host_boot_id: inspection.host_boot_id,
            pid_start_time_ticks: inspection.pid_start_time_ticks,
            jail_root_inode: record.jail_root_inode,
            cloud_hypervisor_sha256: inspection
                .executable_sha256
                .unwrap_or(record.cloud_hypervisor_sha256),
            cpu_quota: record.quota,
            vcpu_count: record.vcpu_count,
            health: inspection.health,
            cpu_stat: inspection.cpu_stat,
            seccomp_enabled: inspection.seccomp_enabled,
            landlock_enabled: inspection.landlock_enabled,
            no_new_privs: inspection.no_new_privs,
            capabilities_empty: inspection.capabilities_empty,
            paths: record.paths,
        })
    }

    fn stop_vm(&mut self, request: VmIdentityRequest) -> Result<bool> {
        let generation = self.resolve_generation(&request)?;
        let record = self
            .records
            .get(&generation)
            .context("unknown jail generation")?;
        let changed = self.backend.stop_unit(&record.unit_name)?;
        self.preparer.export_recording(&self.config, record)?;
        Ok(changed)
    }

    fn destroy_vm(&mut self, request: VmIdentityRequest) -> Result<bool> {
        let generation = self.resolve_generation(&request)?;
        let Some(record) = self.records.get(&generation).cloned() else {
            let unit_name = format!("intar-vm-{generation}.service");
            let backend_changed = self.backend.destroy_unit(&unit_name)?;
            let files_changed = self.preparer.destroy(&self.config, &generation)?;
            return Ok(backend_changed || files_changed);
        };
        self.preparer
            .reserve_identity(&self.config, &generation, record.uid, record.gid)?;
        // The inactive transient unit may already have been garbage-collected
        // while the agent archived VM artifacts. The backend is the final
        // authority here: it must refuse a live unit, remove a drained unit,
        // and return `false` when systemd has already removed it.
        let backend_changed = self.backend.destroy_unit(&record.unit_name)?;
        let network_changed = self
            .backend
            .destroy_vm_network(&record.request.run_id, &generation)?;
        let files_changed = self.preparer.destroy(&self.config, &generation)?;
        self.records.remove(&generation);
        self.preparer
            .release_identity_reservation(&self.config, &generation)?;
        self.allocated_identities.remove(&record.uid);
        debug_assert_eq!(record.uid, record.gid);
        Ok(backend_changed || network_changed || files_changed)
    }

    fn committed_cpu_millis(&self) -> u64 {
        self.records
            .values()
            .map(|record| u64::from(record.quota.cpu_millis))
            .sum()
    }

    fn allocate_identity(&mut self) -> Result<u32> {
        for candidate in self.config.uid_gid_start..=self.config.uid_gid_end {
            if self.allocated_identities.insert(candidate) {
                return Ok(candidate);
            }
        }
        bail!("VM UID/GID allocation range is exhausted")
    }

    fn resolve_generation(&self, request: &VmIdentityRequest) -> Result<ValidatedId> {
        request.validate().context("validate VM selector")?;
        if let Some(generation) = &request.generation {
            return Ok(generation.clone());
        }
        let run_id = request.run_id.as_ref().expect("validated logical run ID");
        let vm_id = request.vm_id.as_ref().expect("validated logical VM ID");
        self.records
            .values()
            .find(|record| record.request.run_id == *run_id && record.request.vm_id == *vm_id)
            .map(|record| record.generation.clone())
            .context("unknown jail generation")
    }
}

fn validate_protocol_request(request: &Request) -> Result<()> {
    match request {
        Request::EnsureRunNetwork(request) => request.validate().map_err(Into::into),
        Request::LaunchVm(request) => request.validate().map(|_| ()).map_err(Into::into),
        Request::InspectVm(request) | Request::StopVm(request) | Request::DestroyVm(request) => {
            request.validate().map_err(Into::into)
        }
        Request::Capabilities | Request::DestroyRunNetwork(_) => Ok(()),
    }
}

fn classify_protocol_error(message: &str) -> &'static str {
    if message.contains("local CPU capacity exhausted") {
        "cpu_capacity_exhausted"
    } else if message.contains("unknown jail generation") {
        "not_found"
    } else if message.contains("readiness attestation") {
        "host_not_ready"
    } else if message.contains("still has VM generations")
        || message.contains("refusing to destroy populated")
    {
        "resource_busy"
    } else if message.contains("already exists with a different")
        || message.contains("already allocated")
    {
        "conflict"
    } else if message.contains("allocation range is exhausted") {
        "identity_exhausted"
    } else {
        "host_operation_failed"
    }
}

pub fn host_cpu_capacity_millis() -> Result<u64> {
    let cpus = std::thread::available_parallelism().context("detect host CPU count")?;
    u64::try_from(cpus.get())
        .ok()
        .and_then(|value| value.checked_mul(1_000))
        .context("host CPU capacity overflow")
}

fn request_fingerprint(request: &VmLaunchRequest) -> Result<Sha256Digest> {
    let canonical = serde_json::to_vec(request).context("serialize VM launch fingerprint")?;
    Ok(Sha256Digest::for_bytes(&canonical))
}

fn backend_identity_matches(record: &VmRecord, inspection: &BackendInspection) -> bool {
    if inspection.cgroup_path != record.cgroup_path
        || inspection.host_boot_id != record.host_boot_id
    {
        return false;
    }
    if matches!(
        inspection.health,
        SandboxHealth::Exited | SandboxHealth::Stopping
    ) && inspection.pid.is_none()
    {
        return true;
    }
    inspection.pid.is_some()
        && inspection.pid_start_time_ticks == record.pid_start_time_ticks
        && inspection.netns_inode == Some(record.run_network.result.namespace_inode)
        && inspection.jail_root_inode == record.jail_root_inode
        && inspection.executable_sha256.as_deref() == Some(record.cloud_hypervisor_sha256.as_str())
}

/// Fail closed when persisted state cannot be reattached safely. The identity
/// reservation intentionally survives quarantine, so a generation whose
/// cleanup needs operator attention can never lend its UID/GID to another VM.
fn quarantine_recovered_record<B: HostBackend, P: JailPreparer>(
    config: &JailerdConfig,
    backend: &mut B,
    preparer: &mut P,
    record: &VmRecord,
) -> Result<()> {
    if record.uid == record.gid && (config.uid_gid_start..=config.uid_gid_end).contains(&record.uid)
    {
        preparer
            .reserve_identity(config, &record.generation, record.uid, record.gid)
            .context("preserve quarantined VM identity reservation")?;
    }
    let unit_name = format!("intar-vm-{}.service", record.generation);
    backend
        .stop_unit(&unit_name)
        .with_context(|| format!("drain mismatched transient unit {unit_name}"))?;
    backend
        .destroy_unit(&unit_name)
        .with_context(|| format!("remove mismatched transient unit {unit_name}"))?;

    // Retaining a network attachment is safer than aborting daemon startup
    // after the process tree has drained. The caller revokes readiness and the
    // persistent identity reservation prevents reuse until operator cleanup.
    let _ = backend.destroy_vm_network(&record.request.run_id, &record.generation);
    preparer
        .quarantine(config, &record.generation)
        .context("quarantine mismatched recovered jail")
}

#[cfg(target_os = "linux")]
fn live_api_ping(path: &Path) -> bool {
    ping_cloud_hypervisor(path).is_ok()
}

#[cfg(not(target_os = "linux"))]
fn live_api_ping(_path: &Path) -> bool {
    true
}

fn validate_recovered_record(config: &JailerdConfig, record: &VmRecord) -> Result<()> {
    let request_quota = record
        .request
        .validate()
        .context("validate persisted VM request")?;
    config
        .validate_run_network_request(&record.run_network.request)
        .context("validate persisted run network policy")?;
    config
        .validate_ssh_public_port(record.request.ssh_public_port)
        .context("validate persisted SSH public port policy")?;
    if record.request_fingerprint != request_fingerprint(&record.request)? {
        bail!("persisted VM request fingerprint changed")
    }
    if record.request.run_id != record.run_network.request.run_id
        || record.request.run_id != record.run_network.result.run_id
    {
        bail!("persisted VM and run-network identities differ")
    }
    if record.uid != record.gid
        || !(config.uid_gid_start..=config.uid_gid_end).contains(&record.uid)
    {
        bail!("persisted VM identity is outside the configured allocation range")
    }
    if record.unit_name != format!("intar-vm-{}.service", record.generation) {
        bail!("persisted transient unit name does not match its generation")
    }
    if record.cloud_hypervisor_sha256 != config.cloud_hypervisor_sha256.as_str() {
        bail!("persisted VM runtime hash differs from the configured runtime")
    }
    if request_quota != record.quota
        || record.vcpu_count != record.request.vcpu_count
        || CpuQuota::from_millis(record.quota.cpu_millis)? != record.quota
    {
        bail!("persisted CPU quota is not canonical")
    }
    let expected_root = generation_directory(config, &record.generation).join("root");
    let expected_paths = jail_paths(&expected_root, record.paths.host_initrd.is_some());
    if record.paths != expected_paths {
        bail!("persisted jail paths do not match the generation root")
    }
    if !record.netns_name.starts_with("intar-") {
        bail!("persisted network namespace name is invalid")
    }
    if record.netns_name != record.run_network.result.namespace_name
        || record.run_network.result.namespace_inode == 0
    {
        bail!("persisted network namespace identity is invalid")
    }
    if record.cgroup_path.as_ref().is_some_and(|path| {
        !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
    }) {
        bail!("persisted cgroup path is invalid")
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn current_host_boot_id() -> Option<String> {
    read_trimmed("/proc/sys/kernel/random/boot_id").ok()
}

#[cfg(not(target_os = "linux"))]
fn current_host_boot_id() -> Option<String> {
    None
}

fn prepare_jail_files(
    config: &JailerdConfig,
    request: &VmLaunchRequest,
    netns_name: &str,
    generation: &ValidatedId,
    uid: u32,
    gid: u32,
) -> Result<PreparedJail> {
    let generation_dir = generation_directory(config, generation);
    let root = generation_dir.join("root");
    let jail_root = trusted_jail_root_fd(config)?;
    let generation_parent = ensure_root_directory_at(&jail_root, c"cloud-hypervisor")?;
    let generation_name =
        CString::new(generation.as_str()).expect("validated generation name contains no NUL");
    rustix::fs::mkdirat(
        &generation_parent,
        &generation_name,
        Mode::RUSR | Mode::WUSR | Mode::XUSR,
    )
    .context("create exclusive fd-relative jail generation")?;
    let generation_fd = open_lifecycle_entry_at(
        &generation_parent,
        &generation_name,
        OFlags::RDONLY | OFlags::DIRECTORY,
    )?;
    validate_root_directory(&generation_fd, "new jail generation")?;
    rustix::fs::fchmod(&generation_fd, Mode::RUSR | Mode::WUSR | Mode::XUSR)?;
    for (relative, mode) in [
        ("root", 0o711),
        ("root/boot", 0o555),
        ("root/disks", 0o770),
        ("root/run", 0o770),
        ("root/logs", 0o770),
        ("root/dev", 0o755),
        ("root/dev/net", 0o755),
        ("root/proc", 0o555),
    ] {
        ensure_directory(&generation_dir.join(relative), mode)?;
    }

    let operation = (|| -> Result<PreparedJail> {
        copy_verified_path(
            &config.cloud_hypervisor_binary,
            &root.join("cloud-hypervisor"),
            Some(&config.cloud_hypervisor_sha256),
            0o555,
        )?;
        copy_verified_path(
            &config.jailer_binary,
            &root.join("intar-jailer"),
            None,
            0o555,
        )?;
        stage_artifacts(config, &request.artifacts, &root, uid, gid)?;
        for log in ["serial.log", "console.log", "cloud-hypervisor.stderr.log"] {
            create_exclusive_file(&root.join("logs").join(log), 0o600)?;
            set_owner(&root.join("logs").join(log), uid, gid)?;
        }
        set_owner(&root.join("disks"), 0, 0)?;
        set_mode(&root.join("disks"), 0o755)?;
        for directory in [root.join("run"), root.join("logs")] {
            set_owner(&directory, uid, gid)?;
            set_mode(&directory, 0o700)?;
        }
        apply_agent_acls(config, &generation_dir, &root)?;

        if netns_name.is_empty()
            || netns_name.len() > 64
            || !netns_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            bail!("invalid derived network namespace name")
        }
        let netns_path = config.netns_root.join(netns_name);
        let spec = JailSpecV1 {
            version: PROTOCOL_VERSION,
            generation: generation.clone(),
            uid,
            gid,
            jail_root: root.clone(),
            netns_path,
            nofile_limit: 2_048,
            file_size_limit: config.vmm_file_size_limit_bytes,
        };
        let spec_path = generation_dir.join("jail-spec-v1.json");
        let mut spec_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&spec_path)
            .context("create exclusive jail spec")?;
        to_writer(&mut spec_file, &spec).context("serialize jail spec")?;
        spec_file.write_all(b"\n").context("terminate jail spec")?;
        spec_file.sync_all().context("sync jail spec")?;
        let root_fd =
            open_lifecycle_entry_at(&generation_fd, c"root", OFlags::RDONLY | OFlags::DIRECTORY)?;
        let root_stat = validate_root_directory(&root_fd, "prepared jail root")?;

        Ok(PreparedJail {
            generation: generation.clone(),
            uid,
            gid,
            spec_path,
            jail_root_inode: Some(root_stat.st_ino),
            paths: jail_paths(&root, request.artifacts.initrd.is_some()),
        })
    })();
    match operation {
        Ok(prepared) => Ok(prepared),
        Err(error) => match remove_generation_tree(config, generation) {
            Ok(_) => Err(error),
            Err(cleanup_error) => {
                quarantine_generation(config, generation).with_context(|| {
                    format!(
                        "jail preparation failed ({error:#}); fd-relative cleanup also failed ({cleanup_error:#})"
                    )
                })?;
                Err(error).context(format!(
                    "jail cleanup failed and the generation was quarantined: {cleanup_error:#}"
                ))
            }
        },
    }
}

fn stage_artifacts(
    config: &JailerdConfig,
    artifacts: &SourceArtifacts,
    root: &Path,
    uid: u32,
    gid: u32,
) -> Result<()> {
    stage_source(config, &artifacts.kernel, &root.join("boot/kernel"), 0o444)?;
    if let Some(initrd) = &artifacts.initrd {
        stage_source(config, initrd, &root.join("boot/initrd"), 0o444)?;
    }
    stage_source(
        config,
        &artifacts.root_disk,
        &root.join("disks/root.raw"),
        0o600,
    )?;
    stage_source(
        config,
        &artifacts.runtime_disk,
        &root.join("disks/runtime.raw"),
        0o600,
    )?;
    stage_source(
        config,
        &artifacts.recording_disk,
        &root.join("disks/recordings.vfat"),
        0o600,
    )?;
    for path in [
        root.join("disks/root.raw"),
        root.join("disks/recordings.vfat"),
    ] {
        set_mode(&path, 0o600)?;
        set_owner(&path, uid, gid)?;
    }
    set_mode(&root.join("disks/runtime.raw"), 0o444)?;
    set_owner(&root.join("disks/runtime.raw"), 0, 0)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn export_recording_disk(config: &JailerdConfig, record: &VmRecord) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;

    let export = &record.request.artifacts.recording_disk;
    export
        .validate()
        .context("validate recording export descriptor")?;
    let root = config
        .allowed_source_roots
        .get(usize::from(export.source_root))
        .context("recording export source-root index is invalid")?;
    let parent_relative = export
        .relative_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = export
        .relative_path
        .file_name()
        .context("recording export has no file name")?;
    let root_fd = open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    let parent_fd = openat2(
        &root_fd,
        parent_relative,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_XDEV,
    )
    .context("open recording export directory beneath trusted root")?;
    let source_fd = open(
        &record.paths.host_recording_disk,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    let mut source = File::from(source_fd);
    let source_metadata = source.metadata()?;
    if !source_metadata.is_file()
        || source_metadata.nlink() != 1
        || source_metadata.uid() != record.uid
        || source_metadata.gid() != record.gid
        || source_metadata.mode() & 0o077 != 0
    {
        bail!("jailed recording disk ownership or mode changed")
    }
    let temporary = format!(".recording-export-{}", Uuid::new_v4());
    let operation = (|| -> Result<()> {
        let output_fd = rustix::fs::openat(
            &parent_fd,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::RUSR | Mode::WUSR,
        )?;
        let mut output = File::from(output_fd);
        std::io::copy(&mut source, &mut output).context("copy drained recording export")?;
        rustix::fs::fchmod(&output, Mode::RUSR | Mode::WUSR)?;
        rustix::fs::fchown(
            &output,
            Some(rustix::process::Uid::from_raw(config.agent_uid)),
            Some(rustix::process::Gid::from_raw(config.agent_gid)),
        )?;
        output.sync_all()?;
        let after = source.metadata()?;
        if source_metadata.len() != after.len()
            || source_metadata.mtime() != after.mtime()
            || source_metadata.mtime_nsec() != after.mtime_nsec()
        {
            bail!("recording disk changed after VM cgroup drain")
        }
        rustix::fs::renameat(&parent_fd, temporary.as_str(), &parent_fd, file_name)?;
        rustix::fs::fsync(&parent_fd)?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = rustix::fs::unlinkat(&parent_fd, temporary.as_str(), rustix::fs::AtFlags::empty());
    }
    operation
}

#[cfg(not(target_os = "linux"))]
fn export_recording_disk(_config: &JailerdConfig, _record: &VmRecord) -> Result<()> {
    bail!("recording export is supported only on Linux")
}

fn stage_source(
    config: &JailerdConfig,
    source: &intar_jailer_protocol::ArtifactSource,
    destination: &Path,
    mode: u32,
) -> Result<()> {
    let source_file = open_trusted_source(config, source.source_root, &source.relative_path)?;
    stage_source_file(
        source_file,
        destination,
        mode,
        source.sha256.as_ref(),
        &source.access,
    )
}

fn open_trusted_source(config: &JailerdConfig, source_root: u16, relative: &Path) -> Result<File> {
    use std::os::unix::fs::MetadataExt as _;

    let root = config
        .allowed_source_roots
        .get(usize::from(source_root))
        .context("artifact source-root index is outside the configured roots")?;
    if relative.is_absolute()
        || relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        bail!("artifact source path must be a traversal-free relative path")
    }
    let root_fd = open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open trusted source root {}", root.display()))?;
    let source_fd = open_source_beneath(&root_fd, relative).with_context(|| {
        format!(
            "open trusted artifact source {}/{}",
            root.display(),
            relative.display()
        )
    })?;
    let file = File::from(source_fd);
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || !(metadata.uid() == 0 || metadata.uid() == config.agent_uid)
        || !(metadata.gid() == 0 || metadata.gid() == config.agent_gid)
        || metadata.mode() & 0o002 != 0
    {
        bail!("artifact source is not a regular file")
    }
    Ok(file)
}

fn stage_source_file(
    mut source: File,
    destination: &Path,
    mode: u32,
    expected: Option<&Sha256Digest>,
    access: &intar_jailer_protocol::ArtifactAccess,
) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;

    let before = source.metadata().context("stat opened artifact source")?;
    let temporary = destination.with_file_name(format!(
        ".{}-staging-{}",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .context("artifact destination name is not UTF-8")?,
        Uuid::new_v4()
    ));

    let operation = (|| -> Result<()> {
        if matches!(access, intar_jailer_protocol::ArtifactAccess::ReadWrite) {
            reflink_open_file_or_copy(&mut source, &temporary)?;
            if let Some(expected) = expected {
                let mut staged = File::open(&temporary)?;
                verify_reader_digest(&mut staged, expected)?;
            }
        } else {
            copy_reader_verified(&mut source, &temporary, mode, expected)?;
        }
        let after = source.metadata().context("restat opened artifact source")?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || after.nlink() != 1
        {
            bail!("artifact source changed while it was being staged")
        }
        set_mode(&temporary, mode)?;
        std::fs::rename(&temporary, destination)
            .with_context(|| format!("publish staged file {}", destination.display()))?;
        File::open(
            destination
                .parent()
                .context("artifact destination parent")?,
        )?
        .sync_all()?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    operation
}

#[cfg(target_os = "linux")]
fn reflink_open_file_or_copy(source: &mut File, destination: &Path) -> Result<()> {
    use std::os::fd::AsRawFd as _;

    let source_path = PathBuf::from(format!("/proc/self/fd/{}", source.as_raw_fd()));
    reflink_copy::reflink_or_copy(&source_path, destination)
        .with_context(|| format!("reflink/copy staged disk {}", destination.display()))?;
    File::open(destination)?.sync_all()?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn reflink_open_file_or_copy(source: &mut File, destination: &Path) -> Result<()> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(destination)?;
    std::io::copy(source, &mut output)?;
    output.sync_all()?;
    Ok(())
}

fn copy_reader_verified(
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
fn open_source_beneath(
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
fn open_source_beneath(
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

fn copy_verified_path(
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

fn verify_reader_digest(reader: &mut File, expected: &Sha256Digest) -> Result<()> {
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

fn create_exclusive_file(path: &Path, mode: u32) -> Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    set_mode(path, mode)
}

fn jail_paths(root: &Path, has_initrd: bool) -> JailPathMap {
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

fn generation_directory(config: &JailerdConfig, generation: &ValidatedId) -> PathBuf {
    config
        .jail_root
        .join("cloud-hypervisor")
        .join(generation.as_str())
}

#[cfg(target_os = "linux")]
fn open_lifecycle_entry_at(
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
fn open_lifecycle_entry_at(
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

fn trusted_jail_root_fd(config: &JailerdConfig) -> Result<OwnedFd> {
    let fd = open(
        &config.jail_root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open jail lifecycle root {}", config.jail_root.display()))?;
    validate_root_directory(&fd, "jail lifecycle root")?;
    Ok(fd)
}

fn validate_root_directory(fd: &impl std::os::fd::AsFd, label: &str) -> Result<rustix::fs::Stat> {
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

fn open_optional_root_directory_at(
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

fn ensure_root_directory_at(parent: &impl std::os::fd::AsFd, name: &CStr) -> Result<OwnedFd> {
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

fn lifecycle_directory_names(fd: &impl std::os::fd::AsFd) -> Result<Vec<CString>> {
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

fn lifecycle_owner_allowed(config: &JailerdConfig, uid: u32, gid: u32) -> bool {
    let uid_allowed = uid == 0
        || uid == config.agent_uid
        || (config.uid_gid_start..=config.uid_gid_end).contains(&uid);
    let gid_allowed = gid == 0
        || gid == config.agent_gid
        || (config.uid_gid_start..=config.uid_gid_end).contains(&gid);
    uid_allowed && gid_allowed
}

fn same_lifecycle_object(left: &rustix::fs::Stat, right: &rustix::fs::Stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && rustix::fs::FileType::from_raw_mode(left.st_mode)
            == rustix::fs::FileType::from_raw_mode(right.st_mode)
}

#[cfg(target_os = "linux")]
fn open_lifecycle_object_at(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
) -> rustix::io::Result<OwnedFd> {
    open_lifecycle_entry_at(parent, name, OFlags::PATH)
}

#[cfg(not(target_os = "linux"))]
fn open_lifecycle_object_at(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
) -> rustix::io::Result<OwnedFd> {
    open_lifecycle_entry_at(parent, name, OFlags::RDONLY)
}

fn remove_directory_contents_fd_relative(
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

fn remove_generation_tree(config: &JailerdConfig, generation: &ValidatedId) -> Result<bool> {
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

fn quarantine_entry_at(
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

fn quarantine_generation(config: &JailerdConfig, generation: &ValidatedId) -> Result<()> {
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

fn identity_reservation_directory_fd(
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

fn persist_identity_reservation(
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

fn recover_identity_reservations(config: &JailerdConfig) -> Result<BTreeSet<u32>> {
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

fn ensure_directory(path: &Path, mode: u32) -> Result<()> {
    if !path.exists() {
        std::fs::create_dir(path)
            .with_context(|| format!("create directory {}", path.display()))?;
    }
    set_mode(path, mode)
}

fn set_mode(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .with_context(|| format!("set mode on {}", path.display()))
}

#[cfg(target_os = "linux")]
fn set_owner(path: &Path, uid: u32, gid: u32) -> Result<()> {
    rustix::fs::chown(
        path,
        Some(rustix::process::Uid::from_raw(uid)),
        Some(rustix::process::Gid::from_raw(gid)),
    )
    .with_context(|| format!("set owner on {}", path.display()))
}

#[cfg(target_os = "linux")]
fn apply_agent_acls(config: &JailerdConfig, generation_dir: &Path, root: &Path) -> Result<()> {
    let setfacl = ["/usr/bin/setfacl", "/usr/sbin/setfacl"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path_is_root_trusted(path, false))
        .context("trusted setfacl binary is required")?;
    let agent = config.agent_uid.to_string();
    for directory in [
        config.jail_root.as_path(),
        generation_dir.parent().context("generation parent")?,
        generation_dir,
        root,
    ] {
        run_setfacl(&setfacl, directory, &format!("u:{agent}:--x,m::--x"))?;
    }
    for directory in [root.join("run"), root.join("logs")] {
        run_setfacl(&setfacl, &directory, &format!("u:{agent}:rwx,m::rwx"))?;
        run_setfacl(&setfacl, &directory, &format!("d:u:{agent}:rwx,d:m::rwx"))?;
    }
    for file in [
        root.join("logs/serial.log"),
        root.join("logs/console.log"),
        root.join("logs/cloud-hypervisor.stderr.log"),
    ] {
        run_setfacl(&setfacl, &file, &format!("u:{agent}:rw-,m::rw-"))?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn run_setfacl(program: &Path, path: &Path, acl: &str) -> Result<()> {
    use std::process::{Command, Stdio};

    let output = Command::new(program)
        .args(["--modify", acl, "--", path.to_string_lossy().as_ref()])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("execute trusted ACL helper {}", program.display()))?;
    if !output.status.success() {
        bail!(
            "set ACL on {} failed: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn apply_agent_acls(_config: &JailerdConfig, _generation_dir: &Path, _root: &Path) -> Result<()> {
    bail!("POSIX ACL staging is supported only on Linux")
}

#[cfg(not(target_os = "linux"))]
fn set_owner(_path: &Path, _uid: u32, _gid: u32) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use intar_jailer_protocol::{ArtifactAccess, ArtifactSource, SourceArtifacts};

    #[derive(Default)]
    struct FakeBackend {
        units: BTreeMap<String, BackendInspection>,
        started_specs: Vec<UnitLaunchSpec>,
        stopped_units: Vec<String>,
        destroyed_units: Vec<String>,
        unit_operations: Vec<String>,
        destroyed_vm_networks: Vec<(ValidatedId, ValidatedId)>,
        fail_vm_network: bool,
        fail_start_after_create: bool,
        fail_stop_unit: bool,
        fail_destroy_unit: bool,
        fail_destroy_vm_network: bool,
        returned_unit_name: Option<String>,
    }

    impl HostBackend for FakeBackend {
        fn production_ready(&self) -> bool {
            true
        }
        fn start_unit(&mut self, spec: &UnitLaunchSpec) -> Result<StartedUnit> {
            self.started_specs.push(spec.clone());
            self.units.insert(
                spec.unit_name.clone(),
                BackendInspection {
                    pid: Some(42),
                    cgroup_path: Some(format!("/intar-vms.slice/{}", spec.unit_name).into()),
                    host_boot_id: Some("test-boot".to_owned()),
                    pid_start_time_ticks: Some(7),
                    netns_inode: Some(17),
                    jail_root_inode: None,
                    executable_sha256: Some(CLOUD_HYPERVISOR_SHA256.to_owned()),
                    health: SandboxHealth::Healthy,
                    cpu_stat: None,
                    seccomp_enabled: true,
                    landlock_enabled: true,
                    no_new_privs: true,
                    capabilities_empty: true,
                },
            );
            if self.fail_start_after_create {
                bail!("injected transient unit activation failure")
            }
            Ok(StartedUnit {
                unit_name: self
                    .returned_unit_name
                    .clone()
                    .unwrap_or_else(|| spec.unit_name.clone()),
                pid: Some(42),
                cgroup_path: Some(format!("/intar-vms.slice/{}", spec.unit_name).into()),
                host_boot_id: Some("test-boot".to_owned()),
                pid_start_time_ticks: Some(7),
            })
        }
        fn inspect_unit(&mut self, unit_name: &str) -> Result<BackendInspection> {
            self.units
                .get(unit_name)
                .cloned()
                .context("missing fake unit")
        }
        fn stop_unit(&mut self, unit_name: &str) -> Result<bool> {
            self.stopped_units.push(unit_name.to_owned());
            self.unit_operations.push(format!("stop:{unit_name}"));
            if self.fail_stop_unit {
                bail!("injected transient unit stop failure")
            }
            let Some(unit) = self.units.get_mut(unit_name) else {
                return Ok(false);
            };
            unit.health = SandboxHealth::Exited;
            Ok(true)
        }
        fn destroy_unit(&mut self, unit_name: &str) -> Result<bool> {
            self.destroyed_units.push(unit_name.to_owned());
            self.unit_operations.push(format!("destroy:{unit_name}"));
            if self.fail_destroy_unit {
                bail!("injected transient unit destroy failure")
            }
            if self.units.get(unit_name).is_some_and(|unit| {
                !matches!(
                    unit.health,
                    SandboxHealth::Exited | SandboxHealth::Quarantined
                )
            }) {
                bail!("refusing to destroy populated fake unit")
            }
            Ok(self.units.remove(unit_name).is_some())
        }
        fn ensure_run_network(
            &mut self,
            request: &EnsureRunNetworkRequest,
        ) -> Result<RunNetworkResult> {
            Ok(RunNetworkResult {
                run_id: request.run_id.clone(),
                namespace_name: "intar-ns-test".to_owned(),
                namespace_inode: 17,
                bridge_name: "ibrtest".to_owned(),
                host_veth_name: "ivh-test".to_owned(),
                namespace_veth_name: "ivn-test".to_owned(),
                host_transit_cidr: "198.18.0.1/30".to_owned(),
                namespace_transit_cidr: "198.18.0.2/30".to_owned(),
            })
        }
        fn ensure_vm_network(
            &mut self,
            _run: &EnsureRunNetworkRequest,
            _request: &VmLaunchRequest,
            _generation: &ValidatedId,
            _uid: u32,
            _gid: u32,
        ) -> Result<()> {
            if self.fail_vm_network {
                bail!("injected VM network setup failure")
            }
            Ok(())
        }
        fn destroy_vm_network(
            &mut self,
            run_id: &ValidatedId,
            generation: &ValidatedId,
        ) -> Result<bool> {
            self.destroyed_vm_networks
                .push((run_id.clone(), generation.clone()));
            if self.fail_destroy_vm_network {
                bail!("injected VM network destroy failure")
            }
            Ok(true)
        }
        fn destroy_run_network(&mut self, _request: &DestroyRunNetworkRequest) -> Result<bool> {
            Ok(true)
        }
    }

    #[derive(Default)]
    struct FakePreparer;

    impl JailPreparer for FakePreparer {
        fn prepare(
            &mut self,
            config: &JailerdConfig,
            request: &VmLaunchRequest,
            _netns_name: &str,
            generation: &ValidatedId,
            uid: u32,
            gid: u32,
        ) -> Result<PreparedJail> {
            let root = generation_directory(config, generation).join("root");
            Ok(PreparedJail {
                generation: generation.clone(),
                uid,
                gid,
                spec_path: root.join("../jail-spec-v1.json"),
                jail_root_inode: None,
                paths: jail_paths(&root, request.artifacts.initrd.is_some()),
            })
        }
        fn destroy(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<bool> {
            Ok(true)
        }
        fn quarantine(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct TrackingPreparer {
        quarantined: Vec<ValidatedId>,
        persist_calls: usize,
        fail_persist_call: Option<usize>,
        fail_quarantine: bool,
    }

    impl JailPreparer for TrackingPreparer {
        fn prepare(
            &mut self,
            config: &JailerdConfig,
            request: &VmLaunchRequest,
            _netns_name: &str,
            generation: &ValidatedId,
            uid: u32,
            gid: u32,
        ) -> Result<PreparedJail> {
            let root = generation_directory(config, generation).join("root");
            Ok(PreparedJail {
                generation: generation.clone(),
                uid,
                gid,
                spec_path: root.join("../jail-spec-v1.json"),
                jail_root_inode: None,
                paths: jail_paths(&root, request.artifacts.initrd.is_some()),
            })
        }

        fn destroy(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<bool> {
            Ok(true)
        }

        fn quarantine(&mut self, _config: &JailerdConfig, generation: &ValidatedId) -> Result<()> {
            self.quarantined.push(generation.clone());
            if self.fail_quarantine {
                bail!("injected jail quarantine failure")
            }
            Ok(())
        }

        fn persist(&mut self, _config: &JailerdConfig, _record: &VmRecord) -> Result<()> {
            self.persist_calls += 1;
            if self.fail_persist_call == Some(self.persist_calls) {
                bail!("injected jail metadata persistence failure")
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct RecoverPreparer {
        records: Vec<VmRecord>,
        quarantined: Vec<ValidatedId>,
        reserved: Vec<(ValidatedId, u32, u32)>,
    }

    impl JailPreparer for RecoverPreparer {
        fn prepare(
            &mut self,
            _config: &JailerdConfig,
            _request: &VmLaunchRequest,
            _netns_name: &str,
            _generation: &ValidatedId,
            _uid: u32,
            _gid: u32,
        ) -> Result<PreparedJail> {
            bail!("recovery test does not prepare new jails")
        }

        fn destroy(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<bool> {
            Ok(false)
        }

        fn quarantine(&mut self, _config: &JailerdConfig, generation: &ValidatedId) -> Result<()> {
            self.quarantined.push(generation.clone());
            Ok(())
        }

        fn recover(&mut self, _config: &JailerdConfig) -> Result<Vec<VmRecord>> {
            Ok(std::mem::take(&mut self.records))
        }

        fn reserve_identity(
            &mut self,
            _config: &JailerdConfig,
            generation: &ValidatedId,
            uid: u32,
            gid: u32,
        ) -> Result<()> {
            self.reserved.push((generation.clone(), uid, gid));
            Ok(())
        }
    }

    #[test]
    fn eight_eighth_cpu_vms_fill_exactly_one_schedulable_core() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakePreparer,
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        for index in 0..8 {
            let response = core.handle(Request::LaunchVm(Box::new(launch(index, 125))));
            assert!(matches!(response, Response::LaunchVm(_)), "{response:?}");
        }
        let response = core.handle(Request::LaunchVm(Box::new(launch(8, 125))));
        assert!(matches!(response, Response::Error(_)));
        assert_eq!(core.capabilities().committed_cpu_millis, 1_000);
    }

    #[test]
    fn launch_grants_mknod_only_for_the_jail_devices() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakePreparer,
            125,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        assert!(matches!(
            core.handle(Request::LaunchVm(Box::new(launch(0, 125)))),
            Response::LaunchVm(_)
        ));
        assert_eq!(core.backend.started_specs.len(), 1);
        assert_eq!(
            core.backend.started_specs[0].device_allow,
            [
                "/dev/kvm rwm",
                "/dev/net/tun rwm",
                "/dev/urandom rm",
                "/dev/null rwm",
            ]
        );
    }

    #[test]
    fn reservation_is_held_until_destroy_after_exit() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakePreparer,
            125,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match core.handle(Request::LaunchVm(Box::new(launch(1, 125)))) {
            Response::LaunchVm(value) => value,
            other => panic!("unexpected response {other:?}"),
        };
        assert_eq!(core.capabilities().committed_cpu_millis, 125);
        let identity = VmIdentityRequest::by_generation(launched.generation);
        assert!(matches!(
            core.handle(Request::StopVm(identity.clone())),
            Response::StopVm(_)
        ));
        assert_eq!(core.capabilities().committed_cpu_millis, 125);
        assert!(matches!(
            core.handle(Request::DestroyVm(identity)),
            Response::DestroyVm(_)
        ));
        assert_eq!(core.capabilities().committed_cpu_millis, 0);
    }

    #[test]
    fn destroy_continues_after_systemd_garbage_collects_a_drained_unit() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakePreparer,
            125,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match core.handle(Request::LaunchVm(Box::new(launch(1, 125)))) {
            Response::LaunchVm(value) => value,
            other => panic!("unexpected response {other:?}"),
        };
        let identity = VmIdentityRequest::by_generation(launched.generation.clone());
        assert!(matches!(
            core.handle(Request::StopVm(identity.clone())),
            Response::StopVm(_)
        ));
        assert!(core.backend.units.remove(&launched.unit_name).is_some());

        assert!(matches!(
            core.handle(Request::DestroyVm(identity)),
            Response::DestroyVm(_)
        ));
        assert_eq!(core.capabilities().committed_cpu_millis, 0);
        assert!(!core.records.contains_key(&launched.generation));
    }

    #[test]
    fn destroy_refuses_a_populated_unit() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakePreparer,
            125,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match core.handle(Request::LaunchVm(Box::new(launch(1, 125)))) {
            Response::LaunchVm(value) => value,
            other => panic!("unexpected response {other:?}"),
        };

        assert!(matches!(
            core.handle(Request::DestroyVm(VmIdentityRequest::by_generation(
                launched.generation.clone()
            ))),
            Response::Error(_)
        ));
        assert_eq!(core.capabilities().committed_cpu_millis, 125);
        assert!(core.records.contains_key(&launched.generation));
    }

    #[test]
    fn logical_vm_launch_is_idempotent_and_conflicts_on_changed_resources() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakePreparer,
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let request = launch(1, 125);
        let first = match core.handle(Request::LaunchVm(Box::new(request.clone()))) {
            Response::LaunchVm(value) => value,
            other => panic!("unexpected first launch response {other:?}"),
        };
        let second = match core.handle(Request::LaunchVm(Box::new(request.clone()))) {
            Response::LaunchVm(value) => value,
            other => panic!("unexpected idempotent launch response {other:?}"),
        };
        assert_eq!(first.generation, second.generation);
        assert_eq!(core.capabilities().committed_cpu_millis, 125);

        let mut changed = request;
        changed.cpu_millis = 126;
        let response = core.handle(Request::LaunchVm(Box::new(changed)));
        assert!(matches!(
            response,
            Response::Error(ProtocolError { ref code, .. }) if code == "conflict"
        ));
    }

    #[test]
    fn idempotent_launch_still_rejects_a_changed_live_process_identity() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            TrackingPreparer::default(),
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let request = launch(1, 125);
        let launched = match core.handle(Request::LaunchVm(Box::new(request.clone()))) {
            Response::LaunchVm(value) => value,
            other => panic!("unexpected first launch response {other:?}"),
        };
        core.backend
            .units
            .get_mut(&launched.unit_name)
            .expect("fake unit")
            .pid_start_time_ticks = Some(8);

        let response = core.handle(Request::LaunchVm(Box::new(request)));
        assert!(matches!(
            response,
            Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
        ));
        assert!(core.backend.stopped_units.contains(&launched.unit_name));
        assert!(core.backend.destroyed_units.contains(&launched.unit_name));
        assert!(core.preparer.quarantined.contains(&launched.generation));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn inspect_healthy_vm_still_requires_a_live_api_ping() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakePreparer,
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match core.handle(Request::LaunchVm(Box::new(launch(1, 125)))) {
            Response::LaunchVm(value) => value,
            other => panic!("unexpected launch response {other:?}"),
        };

        let response = core.handle(Request::InspectVm(VmIdentityRequest::by_generation(
            launched.generation,
        )));
        assert!(matches!(
            response,
            Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
        ));
        assert!(core.backend.stopped_units.contains(&launched.unit_name));
        assert!(core.backend.destroyed_units.contains(&launched.unit_name));
    }

    #[test]
    fn network_setup_failure_revokes_partial_network_and_quarantines_generation() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend {
                fail_vm_network: true,
                ..FakeBackend::default()
            },
            TrackingPreparer::default(),
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        assert!(matches!(
            core.handle(Request::LaunchVm(Box::new(launch(1, 125)))),
            Response::Error(_)
        ));
        assert!(core.records.is_empty());
        assert_eq!(core.preparer.quarantined.len(), 1);
        assert_eq!(core.backend.destroyed_vm_networks.len(), 1);
        assert_eq!(
            core.backend.destroyed_vm_networks[0],
            (
                ValidatedId::parse("run").expect("run ID"),
                core.preparer.quarantined[0].clone(),
            )
        );
    }

    #[test]
    fn partial_start_failure_stops_then_destroys_the_transient_unit() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend {
                fail_start_after_create: true,
                ..FakeBackend::default()
            },
            TrackingPreparer::default(),
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        let response = core.handle(Request::LaunchVm(Box::new(launch(1, 125))));
        assert!(matches!(response, Response::Error(_)));
        assert!(core.records.is_empty());
        let generation = core
            .preparer
            .quarantined
            .first()
            .expect("failed generation quarantined");
        let unit_name = format!("intar-vm-{generation}.service");
        assert_eq!(
            core.backend.unit_operations,
            [format!("stop:{unit_name}"), format!("destroy:{unit_name}")]
        );
        assert!(!core.backend.units.contains_key(&unit_name));
        assert_eq!(
            core.backend.destroyed_vm_networks,
            [(
                ValidatedId::parse("run").expect("run ID"),
                generation.clone()
            )]
        );
    }

    #[test]
    fn post_start_persistence_failure_rolls_back_the_transient_unit() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            TrackingPreparer {
                fail_persist_call: Some(2),
                ..TrackingPreparer::default()
            },
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        let response = core.handle(Request::LaunchVm(Box::new(launch(1, 125))));
        assert!(matches!(response, Response::Error(_)));
        assert!(core.records.is_empty());
        let generation = core
            .preparer
            .quarantined
            .first()
            .expect("failed generation quarantined");
        let unit_name = format!("intar-vm-{generation}.service");
        assert_eq!(
            core.backend.unit_operations,
            [format!("stop:{unit_name}"), format!("destroy:{unit_name}")]
        );
        assert!(!core.backend.units.contains_key(&unit_name));
        assert_eq!(core.preparer.persist_calls, 2);
    }

    #[test]
    fn failed_launch_reports_every_rollback_failure() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend {
                fail_start_after_create: true,
                fail_stop_unit: true,
                fail_destroy_unit: true,
                fail_destroy_vm_network: true,
                ..FakeBackend::default()
            },
            TrackingPreparer {
                fail_quarantine: true,
                ..TrackingPreparer::default()
            },
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        let Response::Error(error) = core.handle(Request::LaunchVm(Box::new(launch(1, 125))))
        else {
            panic!("failed launch unexpectedly succeeded")
        };
        for expected in [
            "injected transient unit activation failure",
            "injected transient unit stop failure",
            "injected transient unit destroy failure",
            "preserved VM network and generation",
        ] {
            assert!(
                error.message.contains(expected),
                "missing {expected:?} from {:?}",
                error.message
            );
        }
        assert_eq!(core.backend.stopped_units.len(), 1);
        assert_eq!(core.backend.destroyed_units.len(), 1);
        assert!(core.backend.destroyed_vm_networks.is_empty());
        assert!(core.preparer.quarantined.is_empty());
    }

    #[test]
    fn drained_failed_launch_reports_network_and_quarantine_failures() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend {
                fail_start_after_create: true,
                fail_destroy_vm_network: true,
                ..FakeBackend::default()
            },
            TrackingPreparer {
                fail_quarantine: true,
                ..TrackingPreparer::default()
            },
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        let Response::Error(error) = core.handle(Request::LaunchVm(Box::new(launch(1, 125))))
        else {
            panic!("failed launch unexpectedly succeeded")
        };
        for expected in [
            "injected transient unit activation failure",
            "injected VM network destroy failure",
            "injected jail quarantine failure",
        ] {
            assert!(error.message.contains(expected));
        }
        assert_eq!(core.backend.destroyed_vm_networks.len(), 1);
        assert_eq!(core.preparer.quarantined.len(), 1);
    }

    #[test]
    fn mismatched_started_unit_never_controls_the_returned_unit_name() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend {
                returned_unit_name: Some("ssh.service".to_owned()),
                ..FakeBackend::default()
            },
            TrackingPreparer::default(),
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        assert!(matches!(
            core.handle(Request::LaunchVm(Box::new(launch(1, 125)))),
            Response::Error(_)
        ));
        assert!(core.records.is_empty());
        let generation = core
            .preparer
            .quarantined
            .first()
            .expect("failed generation quarantined");
        assert_eq!(
            core.backend.stopped_units,
            vec![format!("intar-vm-{generation}.service")]
        );
        assert_eq!(
            core.backend.destroyed_units,
            vec![format!("intar-vm-{generation}.service")]
        );
        assert!(core.backend.units.is_empty());
        assert!(
            !core
                .backend
                .stopped_units
                .iter()
                .any(|unit| unit == "ssh.service")
        );
        assert_eq!(
            core.backend.destroyed_vm_networks,
            vec![(
                ValidatedId::parse("run").expect("run ID"),
                generation.clone(),
            )]
        );
    }

    #[test]
    fn recovery_reattaches_a_matching_drained_generation() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let record = recovered_record(&config);
        let mut backend = FakeBackend::default();
        backend
            .units
            .insert(record.unit_name.clone(), recovered_inspection(&record));
        let core = JailerdCore::new_with_readiness(
            config,
            backend,
            RecoverPreparer {
                records: vec![record.clone()],
                ..RecoverPreparer::default()
            },
            1_000,
            ready_readiness(),
        )
        .expect("recover core");
        assert!(core.records.contains_key(&record.generation));
        assert_eq!(core.capabilities().committed_cpu_millis, 125);
        assert!(core.preparer.quarantined.is_empty());
    }

    #[test]
    fn recovery_derives_unit_name_before_draining_tampered_metadata() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut record = recovered_record(&config);
        let expected_unit = format!("intar-vm-{}.service", record.generation);
        record.unit_name = "ssh.service".to_owned();
        let core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            RecoverPreparer {
                records: vec![record.clone()],
                ..RecoverPreparer::default()
            },
            1_000,
            ready_readiness(),
        )
        .expect("quarantine tampered record without aborting recovery");
        assert!(core.records.is_empty());
        assert_eq!(core.backend.stopped_units, vec![expected_unit.clone()]);
        assert_eq!(core.backend.destroyed_units, vec![expected_unit]);
        assert_eq!(core.preparer.quarantined, vec![record.generation.clone()]);
        assert_eq!(
            core.preparer.reserved,
            vec![(record.generation, record.uid, record.gid)]
        );
        assert!(!core.capabilities().supports_jailer_v1);
    }

    #[test]
    fn transient_unit_properties_encode_hard_quota_and_safety() {
        let quota = CpuQuota::from_millis(125).expect("quota");
        let spec = UnitLaunchSpec {
            unit_name: "intar-vm-test.service".to_owned(),
            description: "test".to_owned(),
            jailer_binary: "/intar-jailer".into(),
            jail_spec_path: "/spec".into(),
            api_socket_path: "/api.sock".into(),
            cpu_quota: quota,
            uid: 200_000,
            gid: 200_000,
            device_allow: vec!["/dev/kvm rw"],
        };
        let properties = spec.required_properties();
        assert_eq!(properties["CPUQuotaPerSecUSec"], "125000");
        assert_eq!(properties["CPUQuotaPeriodUSec"], "100000");
        assert_eq!(properties["KillMode"], "control-group");
        assert_eq!(properties["RestrictRealtime"], "yes");
    }

    #[test]
    fn process_capability_parser_requires_sys_ptrace_bit() {
        let status = concat!(
            "Name:\tintar-jailerd\n",
            "CapEff:\t0000000000080000\n",
            "CapBnd:\t000001ffffffffff\n",
        );
        assert!(capability_set_contains(
            status,
            "CapEff:",
            CAP_SYS_PTRACE_BIT
        ));
        assert!(capability_set_contains(
            status,
            "CapBnd:",
            CAP_SYS_PTRACE_BIT
        ));
        assert!(!capability_set_contains(
            "CapEff:\t0000000000000000\n",
            "CapEff:",
            CAP_SYS_PTRACE_BIT
        ));
        assert!(!capability_set_contains(
            "CapEff:\tnot-hex\n",
            "CapEff:",
            CAP_SYS_PTRACE_BIT
        ));
    }

    #[test]
    fn trusted_source_rejects_lexical_escape() {
        let directory = tempfile::tempdir().expect("temp directory");
        assert!(
            open_trusted_source(
                &JailerdConfig {
                    allowed_source_roots: vec![directory.path().to_path_buf()],
                    agent_uid: unsafe_test_uid(),
                    agent_gid: unsafe_test_gid(),
                    ..JailerdConfig::default()
                },
                0,
                Path::new("../outside.raw")
            )
            .is_err()
        );
    }

    #[test]
    fn fd_relative_cleanup_rejects_symlinks_without_touching_targets() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temp directory");
        let jail = directory.path().join("jail");
        std::fs::create_dir(&jail).expect("create jail fixture");
        let outside = directory.path().join("outside-secret");
        std::fs::write(&outside, b"do not delete").expect("write outside fixture");
        symlink(&outside, jail.join("escape")).expect("create symlink attack");
        let fd = open(
            &jail,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .expect("open jail fixture");
        let config = lifecycle_test_config(directory.path());
        assert!(
            remove_directory_contents_fd_relative(
                &config,
                &fd,
                config.agent_uid,
                config.agent_gid,
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"do not delete");
    }

    #[test]
    fn fd_relative_cleanup_rejects_hardlinked_files() {
        let directory = tempfile::tempdir().expect("temp directory");
        let jail = directory.path().join("jail");
        std::fs::create_dir(&jail).expect("create jail fixture");
        let outside = directory.path().join("outside");
        std::fs::write(&outside, b"shared inode").expect("write hardlink fixture");
        std::fs::hard_link(&outside, jail.join("linked")).expect("create hardlink attack");
        let fd = open(
            &jail,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .expect("open jail fixture");
        let config = lifecycle_test_config(directory.path());
        assert!(
            remove_directory_contents_fd_relative(
                &config,
                &fd,
                config.agent_uid,
                config.agent_gid,
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"shared inode");
        assert!(jail.join("linked").exists());
    }

    #[test]
    fn fd_relative_cleanup_stays_on_the_pinned_directory_after_name_swap() {
        let directory = tempfile::tempdir().expect("temp directory");
        let original = directory.path().join("generation");
        let moved = directory.path().join("moved-generation");
        std::fs::create_dir(&original).expect("create original generation");
        std::fs::write(original.join("old"), b"old").expect("write original entry");
        let fd = open(
            &original,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .expect("pin original generation");
        std::fs::rename(&original, &moved).expect("move pinned generation");
        std::fs::create_dir(&original).expect("create replacement generation");
        std::fs::write(original.join("replacement"), b"keep").expect("write replacement entry");
        let config = lifecycle_test_config(directory.path());
        remove_directory_contents_fd_relative(&config, &fd, config.agent_uid, config.agent_gid)
            .expect("clean pinned generation");
        assert!(!moved.join("old").exists());
        assert_eq!(
            std::fs::read(original.join("replacement")).unwrap(),
            b"keep"
        );
    }

    fn unsafe_test_uid() -> u32 {
        std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(".").expect("cwd metadata"))
    }

    fn unsafe_test_gid() -> u32 {
        std::os::unix::fs::MetadataExt::gid(&std::fs::metadata(".").expect("cwd metadata"))
    }

    fn lifecycle_test_config(root: &Path) -> JailerdConfig {
        let mut config = test_config();
        config.jail_root = root.to_path_buf();
        config.agent_uid = unsafe_test_uid();
        config.agent_gid = unsafe_test_gid();
        config
    }

    fn test_config() -> JailerdConfig {
        JailerdConfig {
            agent_uid: 501,
            agent_gid: 501,
            ..JailerdConfig::default()
        }
    }

    fn ready_readiness() -> HostReadiness {
        HostReadiness {
            uid_gid_range_collision_free: true,
            config_trusted: true,
            source_roots_trusted: true,
            jailer_binary_trusted: true,
            runtime_hash_verified: true,
            runtime_statically_linked: true,
            systemd_version: Some("252".to_owned()),
            supports_systemd_transient_units: true,
            supports_cgroup_v2: true,
            seccomp_supported: true,
            landlock_abi: Some(3),
            privileged_self_test_passed: true,
            kvm_accounting_proven: true,
            posix_acl_supported: true,
        }
    }

    fn ensure_test_network<P: JailPreparer>(core: &mut JailerdCore<FakeBackend, P>) {
        let response = core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run").expect("run ID"),
            guest_cidr: "10.77.0.0/28".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        }));
        assert!(matches!(response, Response::EnsureRunNetwork(_)));
    }

    fn launch(index: u32, cpu_millis: u32) -> VmLaunchRequest {
        VmLaunchRequest {
            run_id: ValidatedId::parse("run").expect("run ID"),
            vm_id: ValidatedId::parse(format!("vm-{index}")).expect("VM ID"),
            cpu_millis,
            vcpu_count: 1,
            memory_mib: 512,
            tap_name: format!("tap{index}"),
            mac_address: format!("02:00:00:00:00:{index:02x}"),
            guest_ip_cidr: format!("10.77.0.{}/28", index + 2),
            ssh_public_port: Some(22_000_u16 + u16::try_from(index).expect("small fixture")),
            vsock_cid: 3 + index,
            artifacts: SourceArtifacts {
                kernel: source("/trusted/kernel", ArtifactAccess::ReadOnly),
                initrd: None,
                root_disk: source("/trusted/root.raw", ArtifactAccess::ReadWrite),
                runtime_disk: source("/trusted/runtime.raw", ArtifactAccess::ReadOnly),
                recording_disk: source("/trusted/recordings.vfat", ArtifactAccess::ReadWrite),
            },
        }
    }

    fn recovered_record(config: &JailerdConfig) -> VmRecord {
        let request = launch(1, 125);
        let generation = ValidatedId::parse("recovered-generation").expect("generation");
        let root = generation_directory(config, &generation).join("root");
        let quota = CpuQuota::from_millis(request.cpu_millis).expect("quota");
        VmRecord {
            generation: generation.clone(),
            request_fingerprint: request_fingerprint(&request).expect("fingerprint"),
            run_network: RunNetworkRecord {
                request: EnsureRunNetworkRequest {
                    run_id: request.run_id.clone(),
                    guest_cidr: "10.77.0.0/28".to_owned(),
                    gateway: "10.77.0.1".to_owned(),
                },
                result: RunNetworkResult {
                    run_id: request.run_id.clone(),
                    namespace_name: "intar-ns-test".to_owned(),
                    namespace_inode: 17,
                    bridge_name: "ibrtest".to_owned(),
                    host_veth_name: "ivh-test".to_owned(),
                    namespace_veth_name: "ivn-test".to_owned(),
                    host_transit_cidr: "198.18.0.1/30".to_owned(),
                    namespace_transit_cidr: "198.18.0.2/30".to_owned(),
                },
            },
            unit_name: format!("intar-vm-{generation}.service"),
            uid: config.uid_gid_start,
            gid: config.uid_gid_start,
            quota,
            vcpu_count: request.vcpu_count,
            paths: jail_paths(&root, request.artifacts.initrd.is_some()),
            cgroup_path: Some(format!("/intar-vms.slice/intar-vm-{generation}.service").into()),
            netns_name: "intar-ns-test".to_owned(),
            host_boot_id: current_host_boot_id(),
            pid_start_time_ticks: None,
            jail_root_inode: None,
            cloud_hypervisor_sha256: CLOUD_HYPERVISOR_SHA256.to_owned(),
            request,
        }
    }

    fn recovered_inspection(record: &VmRecord) -> BackendInspection {
        BackendInspection {
            pid: None,
            cgroup_path: record.cgroup_path.clone(),
            host_boot_id: record.host_boot_id.clone(),
            pid_start_time_ticks: None,
            netns_inode: None,
            jail_root_inode: record.jail_root_inode,
            executable_sha256: None,
            health: SandboxHealth::Exited,
            cpu_stat: None,
            seccomp_enabled: false,
            landlock_enabled: false,
            no_new_privs: false,
            capabilities_empty: false,
        }
    }

    fn source(path: &str, access: ArtifactAccess) -> ArtifactSource {
        ArtifactSource {
            source_root: 0,
            relative_path: path.trim_start_matches("/trusted/").into(),
            sha256: (access == ArtifactAccess::ReadOnly)
                .then(|| Sha256Digest::parse("a".repeat(64)).expect("digest")),
            access,
        }
    }
}
