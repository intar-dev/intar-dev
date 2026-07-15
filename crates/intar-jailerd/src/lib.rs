#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
#[cfg(any(target_os = "linux", test))]
use std::ffi::OsString;
use std::ffi::{CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::os::fd::OwnedFd;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};
#[cfg(target_os = "linux")]
use intar_jailer_protocol::CpuStat;
use intar_jailer_protocol::{
    ArtifactAccess, ArtifactSource, CLOUD_HYPERVISOR_SHA256, CLOUD_HYPERVISOR_VERSION, CpuQuota,
    CpuQuotaAttestation, DestroyRunNetworkRequest, EnsureRunNetworkRequest, FinalizeVmBootRequest,
    FinalizeVmBootResult, JailPathMap, JailSpecV1, JailerCapabilities, JailerdConfig,
    LaunchVmV2Request, OperationResult, PREPARED_IMAGE_SOURCE_ROOT, PROTOCOL_VERSION,
    PrepareImageV2Request, PreparedImageV2Result, ProtocolError, Request, Response,
    RunNetworkResult, SandboxHealth, Sha256Digest, SourceArtifacts, ValidatedId, VmCpuPhase,
    VmCpuRuntimeState, VmIdentityRequest, VmInspection, VmLaunchRequest, VmLaunchResult,
};
use rustix::fs::{Mode, OFlags, open};
#[cfg(target_os = "linux")]
use rustix::fs::{ResolveFlags, openat2};
use serde::{Deserialize, Serialize};
use serde_json::to_writer;
use sha2::{Digest as _, Sha256};
use thiserror::Error;
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
#[cfg(target_os = "linux")]
const BOOT_CPU_GUARDIAN_START_TIMEOUT: Duration = Duration::from_secs(2);

/// A launch description which maps directly to a systemd transient service.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnitLaunchSpec {
    pub generation: ValidatedId,
    pub unit_name: String,
    pub description: String,
    pub jailer_binary: PathBuf,
    pub jail_spec_path: PathBuf,
    pub api_socket_path: PathBuf,
    pub cpu_quota: CpuQuota,
    pub steady_cpu_quota: CpuQuota,
    pub boot_cpu_lease_ms: Option<u64>,
    /// Exact identity of the template-backed Cloud Hypervisor clone. V2
    /// launches use this for the one launch-time process check; recovery and
    /// periodic inspection deliberately retain full digest verification.
    pub vmm_executable_identity: Option<RuntimeFileIdentity>,
    pub uid: u32,
    pub gid: u32,
    pub device_allow: Vec<&'static str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BootCpuGuardianRequest {
    generation: ValidatedId,
    unit_name: String,
    steady_quota: CpuQuota,
    deadline_uptime_millis: u64,
}

impl BootCpuGuardianRequest {
    pub fn new(
        generation: ValidatedId,
        unit_name: String,
        steady_quota: CpuQuota,
        deadline_uptime_millis: u64,
    ) -> Result<Self> {
        let expected_unit_name = vm_unit_name(&generation);
        if unit_name != expected_unit_name {
            bail!("boot CPU guardian unit mismatch: expected {expected_unit_name}, got {unit_name}")
        }
        if deadline_uptime_millis == 0 {
            bail!("boot CPU guardian deadline must be positive")
        }
        Ok(Self {
            generation,
            unit_name,
            steady_quota,
            deadline_uptime_millis,
        })
    }

    pub fn generation(&self) -> &ValidatedId {
        &self.generation
    }

    pub fn unit_name(&self) -> &str {
        &self.unit_name
    }

    pub fn steady_quota(&self) -> CpuQuota {
        self.steady_quota
    }

    pub fn deadline_uptime_millis(&self) -> u64 {
        self.deadline_uptime_millis
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct BootCpuGuardianUnitSpec {
    unit_name: String,
    executable: String,
    request: BootCpuGuardianRequest,
}

#[cfg(any(target_os = "linux", test))]
impl BootCpuGuardianUnitSpec {
    fn new(executable: PathBuf, request: BootCpuGuardianRequest) -> Result<Self> {
        if !executable.is_absolute() {
            bail!("boot CPU guardian executable must be absolute")
        }
        let executable = executable
            .to_str()
            .context("boot CPU guardian executable must be valid UTF-8")?
            .to_owned();
        Ok(Self {
            unit_name: boot_cpu_guardian_unit_name(request.generation()),
            executable,
            request,
        })
    }

    fn command_argv(&self) -> Vec<String> {
        vec![
            self.executable.clone(),
            "boot-cpu-lease-guardian".to_owned(),
            "--generation".to_owned(),
            self.request.generation().to_string(),
            "--unit-name".to_owned(),
            self.request.unit_name().to_owned(),
            "--steady-cpu-millis".to_owned(),
            self.request.steady_quota().cpu_millis.to_string(),
            "--deadline-uptime-millis".to_owned(),
            self.request.deadline_uptime_millis().to_string(),
        ]
    }

    #[cfg(test)]
    fn required_properties(&self) -> BTreeMap<&'static str, String> {
        BTreeMap::from([
            ("Type", "oneshot".to_owned()),
            ("RemainAfterExit", "yes".to_owned()),
            ("PartOf", self.request.unit_name().to_owned()),
            ("User", "root".to_owned()),
            ("Group", "root".to_owned()),
            ("NoNewPrivileges", "yes".to_owned()),
            ("ProtectSystem", "strict".to_owned()),
            ("ProtectControlGroups", "no".to_owned()),
            ("CapabilityBoundingSet", "0".to_owned()),
            ("AmbientCapabilities", "0".to_owned()),
            ("CollectMode", "inactive-or-failed".to_owned()),
        ])
    }
}

fn vm_unit_name(generation: &ValidatedId) -> String {
    format!("intar-vm-{generation}.service")
}

fn boot_cpu_guardian_unit_name(generation: &ValidatedId) -> String {
    format!("intar-vm-boot-lease-{generation}.service")
}

#[cfg(target_os = "linux")]
fn restrict_all_namespaces_dbus_value() -> zbus::zvariant::Value<'static> {
    // systemd exposes RestrictNamespaces as the uint64 namespace-type mask on
    // D-Bus. `yes` in a unit file maps to every bit set; a boolean variant
    // makes StartTransientUnit reject the entire auxiliary unit with
    // "Unexpected message contents".
    zbus::zvariant::Value::new(u64::MAX)
}

#[cfg(any(target_os = "linux", test))]
fn vm_cgroup_path(unit_name: &str) -> PathBuf {
    Path::new("/intar.slice/intar-vms.slice").join(unit_name)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeFileIdentity {
    pub device: u64,
    pub inode: u64,
    pub bytes: u64,
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
        let mut properties = BTreeMap::from([
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
        ]);
        if self.boot_cpu_lease_ms.is_some() {
            properties.insert("BindsTo", boot_cpu_guardian_unit_name(&self.generation));
        }
        properties
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
    /// Atomically update the unit quota and read back both `cpu.max` and
    /// `cpu.max.burst`. Success is a privileged live attestation.
    fn update_unit_cpu_quota(
        &mut self,
        unit_name: &str,
        cgroup_path: &Path,
        quota: CpuQuota,
    ) -> Result<()>;
    fn stop_unit(&mut self, unit_name: &str) -> Result<bool>;
    /// Remove an already-drained unit. Implementations must return `false`
    /// only when the unit no longer exists and must refuse active units.
    fn destroy_unit(&mut self, unit_name: &str) -> Result<bool>;
    fn ensure_run_network(&mut self, request: &EnsureRunNetworkRequest)
    -> Result<RunNetworkResult>;
    /// Reconstruct and re-render a previously tracked run even when its
    /// launch-time exact-hit marker is current.
    fn repair_run_network(&mut self, request: &EnsureRunNetworkRequest)
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
    /// Activate or revoke the reserved public SSH forwarding rule. The TAP
    /// remains attached in either state.
    fn set_vm_ssh_forwarding(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
        active: bool,
    ) -> Result<bool>;
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

    fn update_unit_cpu_quota(
        &mut self,
        _unit_name: &str,
        _cgroup_path: &Path,
        _quota: CpuQuota,
    ) -> Result<()> {
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

    fn repair_run_network(
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

    fn set_vm_ssh_forwarding(
        &mut self,
        _run_id: &ValidatedId,
        _generation: &ValidatedId,
        _active: bool,
    ) -> Result<bool> {
        bail!("VM network backend is not available in this build")
    }
}

/// systemd transient-unit backend. Networking remains a separate fail-closed
/// boundary until the netlink/nftables implementation is available.
#[cfg(target_os = "linux")]
#[derive(Clone)]
pub struct SystemdHostBackend {
    network: Arc<Mutex<NetworkManager>>,
    system_bus: zbus::blocking::Connection,
    cloud_hypervisor_sha256: Sha256Digest,
    guardian_binary: PathBuf,
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
        let guardian_binary =
            std::env::current_exe().context("resolve intar-jailerd executable")?;
        ensure!(
            guardian_binary.is_absolute() && path_is_root_trusted(&guardian_binary, false),
            "intar-jailerd executable is not a trusted root-owned guardian binary"
        );
        let system_bus = zbus::blocking::Connection::system().context("connect to system D-Bus")?;
        Ok(Self {
            network: Arc::new(Mutex::new(NetworkManager::new(config)?)),
            system_bus,
            cloud_hypervisor_sha256: config.cloud_hypervisor_sha256.clone(),
            guardian_binary,
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

    fn attest_boot_cpu_guardian_active(&self, unit_name: &str) -> Result<()> {
        let deadline = Instant::now() + BOOT_CPU_GUARDIAN_START_TIMEOUT;
        let mut last_observation = "guardian unit has not appeared".to_owned();
        loop {
            let manager = Self::manager(&self.system_bus)?;
            if let Some(path) = Self::get_unit_path(&manager, unit_name)? {
                let unit = zbus::blocking::Proxy::new(
                    &self.system_bus,
                    "org.freedesktop.systemd1",
                    path,
                    "org.freedesktop.systemd1.Unit",
                )?;
                let active_state: String = unit.get_property("ActiveState")?;
                match active_state.as_str() {
                    // A completed oneshot remains active only after its helper
                    // has successfully mutated and attested the VM cgroup.
                    "active" => return Ok(()),
                    "activating" | "reloading" => {
                        let service = zbus::blocking::Proxy::new(
                            &self.system_bus,
                            "org.freedesktop.systemd1",
                            unit.path(),
                            "org.freedesktop.systemd1.Service",
                        )?;
                        let main_pid: u32 = service.get_property("MainPID")?;
                        if main_pid != 0 {
                            return Ok(());
                        }
                        last_observation =
                            format!("guardian is {active_state} without a main process");
                    }
                    "inactive" => {
                        last_observation = "guardian is still inactive".to_owned();
                    }
                    "deactivating" | "failed" => {
                        bail!("boot CPU guardian {unit_name} became {active_state}")
                    }
                    state => bail!("boot CPU guardian {unit_name} entered {state}"),
                }
            }
            if Instant::now() >= deadline {
                bail!("timed out attesting boot CPU guardian {unit_name}: {last_observation}")
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn inspect_existing_with_launch_identity(
        &self,
        unit_name: &str,
        launch_identity: Option<RuntimeFileIdentity>,
    ) -> Result<BackendInspection> {
        let connection = &self.system_bus;
        let manager = Self::manager(connection)?;
        let path = Self::get_unit_path(&manager, unit_name)?
            .with_context(|| format!("systemd unit {unit_name} no longer exists"))?;
        let unit = zbus::blocking::Proxy::new(
            connection,
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
            connection,
            "org.freedesktop.systemd1",
            unit.path(),
            "org.freedesktop.systemd1.Service",
        )?;
        let control_group: String = service.get_property("ControlGroup")?;
        let cpu_stat = read_cpu_stat(&control_group).ok();
        let vmm_pid = if matches!(health, SandboxHealth::Healthy | SandboxHealth::Stopping) {
            match launch_identity {
                Some(identity) => find_vmm_pid_by_identity(&control_group, identity)?,
                None => find_verified_vmm_pid(&control_group, &self.cloud_hypervisor_sha256)?,
            }
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

    fn inspect_existing(&self, unit_name: &str) -> Result<BackendInspection> {
        // Recovery and periodic inspection intentionally retain the full
        // executable digest check. Only the freshly staged V2 launch can use
        // the inode identity proven immediately before StartTransientUnit.
        self.inspect_existing_with_launch_identity(unit_name, None)
    }
}

#[cfg(target_os = "linux")]
impl HostBackend for SystemdHostBackend {
    fn production_ready(&self) -> bool {
        true
    }

    fn start_unit(&mut self, spec: &UnitLaunchSpec) -> Result<StartedUnit> {
        use zbus::zvariant::{OwnedObjectPath, Value};

        ensure!(
            spec.unit_name == vm_unit_name(&spec.generation),
            "VM transient unit name is not bound to its generation"
        );
        // Anchor the hard lease to a monotonic clock before creating the
        // cgroup. Both the daemon-local watchdog and the systemd-owned
        // guardian use this interval without consulting wall time.
        let boot_deadline = spec
            .boot_cpu_lease_ms
            .map(|lease_ms| Instant::now() + Duration::from_millis(lease_ms));
        let guardian = spec
            .boot_cpu_lease_ms
            .map(|lease_ms| {
                let deadline_uptime_millis = proc_uptime_millis()?
                    .checked_add(lease_ms)
                    .context("boot CPU guardian deadline overflow")?;
                let request = BootCpuGuardianRequest::new(
                    spec.generation.clone(),
                    spec.unit_name.clone(),
                    spec.steady_cpu_quota,
                    deadline_uptime_millis,
                )?;
                BootCpuGuardianUnitSpec::new(self.guardian_binary.clone(), request)
            })
            .transpose()?;
        let connection = &self.system_bus;
        let manager = Self::manager(connection)?;
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
        let mut properties = vec![
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
        if let Some(guardian) = &guardian {
            // BindsTo starts the auxiliary unit in the same transaction and
            // tears the VM down if the sleeping guardian ever fails. Do not
            // add an ordering dependency: a oneshot remains activating until
            // the lease deadline and must not delay VM startup.
            properties.push(("BindsTo", Value::new(vec![guardian.unit_name.clone()])));
        }
        let auxiliary = guardian
            .as_ref()
            .map(|guardian| {
                let executable = guardian.executable.clone();
                let exec_start = vec![(executable.clone(), guardian.command_argv(), false)];
                let timeout_start_usec = spec
                    .boot_cpu_lease_ms
                    .unwrap_or_default()
                    .saturating_add(30_000)
                    .saturating_mul(1_000);
                vec![(
                    guardian.unit_name.as_str(),
                    vec![
                        (
                            "Description",
                            Value::new(format!(
                                "Intar boot CPU lease guardian for {}",
                                spec.generation
                            )),
                        ),
                        ("Slice", Value::new("system.slice")),
                        ("Type", Value::new("oneshot")),
                        ("ExecStart", Value::new(exec_start)),
                        ("RemainAfterExit", Value::new(true)),
                        (
                            "PartOf",
                            Value::new(vec![guardian.request.unit_name().to_owned()]),
                        ),
                        ("CollectMode", Value::new("inactive-or-failed")),
                        ("TimeoutStartUSec", Value::new(timeout_start_usec)),
                        ("KillMode", Value::new("process")),
                        ("Restart", Value::new("no")),
                        ("User", Value::new("root")),
                        ("Group", Value::new("root")),
                        ("UMask", Value::new(0o077_u32)),
                        ("NoNewPrivileges", Value::new(true)),
                        ("PrivateTmp", Value::new(true)),
                        ("ProtectHome", Value::new("yes")),
                        ("ProtectSystem", Value::new("strict")),
                        ("ProtectControlGroups", Value::new(false)),
                        ("ProtectKernelTunables", Value::new(true)),
                        ("ProtectKernelModules", Value::new(true)),
                        ("ProtectKernelLogs", Value::new(true)),
                        ("ProtectClock", Value::new(true)),
                        ("LockPersonality", Value::new(true)),
                        ("MemoryDenyWriteExecute", Value::new(true)),
                        ("RestrictNamespaces", restrict_all_namespaces_dbus_value()),
                        ("RestrictRealtime", Value::new(true)),
                        ("DevicePolicy", Value::new("closed")),
                        ("CapabilityBoundingSet", Value::new(0_u64)),
                        ("AmbientCapabilities", Value::new(0_u64)),
                    ],
                )]
            })
            .unwrap_or_default();
        let _: OwnedObjectPath = manager
            .call(
                "StartTransientUnit",
                &(spec.unit_name.as_str(), "fail", properties, auxiliary),
            )
            .with_context(|| format!("start transient unit {}", spec.unit_name))?;
        drop(manager);
        if let Some(guardian) = &guardian {
            self.attest_boot_cpu_guardian_active(&guardian.unit_name)?;
        }

        let deadline = Instant::now() + VMM_START_TIMEOUT;
        loop {
            let last_observation = match ping_cloud_hypervisor(&spec.api_socket_path) {
                Ok(()) => break,
                Err(error) => format!("Cloud Hypervisor API ping failed: {error:#}"),
            };
            if Instant::now() >= deadline {
                bail!(
                    "timed out after {}s waiting for Cloud Hypervisor API readiness; {last_observation}",
                    VMM_START_TIMEOUT.as_secs()
                )
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        // API readiness is the cheap polling signal. Perform the expensive
        // cgroup scan, executable identity check, and process security audit
        // exactly once after the happy-path socket responds.
        let inspection = self
            .inspect_existing_with_launch_identity(
                &spec.unit_name,
                spec.vmm_executable_identity,
            )
            .map_err(|error| {
            if error_has_io_kind(&error, std::io::ErrorKind::PermissionDenied) {
                error.context(
                    "inspect the cross-UID Cloud Hypervisor process; intar-jailerd requires CAP_SYS_PTRACE",
                )
            } else {
                error.context("inspect API-ready Cloud Hypervisor process")
            }
            })?;
        if inspection.health == SandboxHealth::Exited {
            bail!("Cloud Hypervisor exited during transient-unit activation")
        }
        if inspection.pid.is_none() {
            bail!("Cloud Hypervisor API responded without a verified VMM process")
        }
        let cgroup_path = inspection.cgroup_path.clone();
        if let Some(cgroup_path) = &cgroup_path
            && let Err(error) = assert_cpu_quota(cgroup_path, spec.cpu_quota)
        {
            return Err(error).context("verify transient unit CPU controller");
        }
        if let (Some(cgroup_path), Some(boot_deadline)) = (&cgroup_path, boot_deadline) {
            spawn_hard_cpu_seal(cgroup_path.clone(), spec.steady_cpu_quota, boot_deadline)?;
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

    fn update_unit_cpu_quota(
        &mut self,
        unit_name: &str,
        cgroup_path: &Path,
        quota: CpuQuota,
    ) -> Result<()> {
        use zbus::zvariant::Value;

        let connection = &self.system_bus;
        let manager = Self::manager(connection)?;
        let properties = vec![
            (
                "CPUQuotaPerSecUSec",
                Value::new(u64::from(quota.cpu_millis) * 1_000),
            ),
            ("CPUQuotaPeriodUSec", Value::new(quota.period_micros)),
        ];
        let _: () = manager
            .call("SetUnitProperties", &(unit_name, true, properties))
            .with_context(|| format!("seal transient unit CPU quota for {unit_name}"))?;
        assert_cpu_quota(cgroup_path, quota)
            .with_context(|| format!("read back sealed CPU quota for {unit_name}"))
    }

    fn stop_unit(&mut self, unit_name: &str) -> Result<bool> {
        let connection = &self.system_bus;
        let manager = Self::manager(connection)?;
        let Some(path) = Self::get_unit_path(&manager, unit_name)? else {
            return Ok(false);
        };
        let service = zbus::blocking::Proxy::new(
            connection,
            "org.freedesktop.systemd1",
            path,
            "org.freedesktop.systemd1.Service",
        )?;
        let control_group: zbus::Result<String> = service.get_property("ControlGroup");
        let Some(control_group) = settle_unit_operation(
            control_group,
            UnitCallSite::ObjectProperty,
            || Ok(Self::get_unit_path(&manager, unit_name)?.is_some()),
            &format!("read transient unit cgroup {unit_name}"),
        )?
        else {
            return Ok(false);
        };
        let stop: zbus::Result<zbus::zvariant::OwnedObjectPath> =
            manager.call("StopUnit", &(unit_name, "replace"));
        if settle_unit_operation(
            stop,
            UnitCallSite::Manager,
            || Ok(Self::get_unit_path(&manager, unit_name)?.is_some()),
            &format!("stop transient unit {unit_name}"),
        )?
        .is_none()
        {
            if !wait_cgroup_drained(&control_group, Duration::from_secs(5))? {
                bail!("transient unit disappeared before its cgroup drained")
            }
            return Ok(false);
        }
        if !wait_cgroup_drained(&control_group, Duration::from_secs(5))? {
            let kill: zbus::Result<()> = manager.call("KillUnit", &(unit_name, "all", 9_i32));
            let _ = settle_unit_operation(
                kill,
                UnitCallSite::Manager,
                || Ok(Self::get_unit_path(&manager, unit_name)?.is_some()),
                &format!("kill transient unit cgroup {unit_name}"),
            )?;
            if !wait_cgroup_drained(&control_group, Duration::from_secs(10))? {
                bail!("transient unit cgroup did not drain after SIGKILL")
            }
        }
        Ok(true)
    }

    fn destroy_unit(&mut self, unit_name: &str) -> Result<bool> {
        let connection = &self.system_bus;
        let manager = Self::manager(connection)?;
        let Some(path) = Self::get_unit_path(&manager, unit_name)? else {
            return Ok(false);
        };
        let unit = zbus::blocking::Proxy::new(
            connection,
            "org.freedesktop.systemd1",
            path,
            "org.freedesktop.systemd1.Unit",
        )?;
        let active_state: zbus::Result<String> = unit.get_property("ActiveState");
        let Some(active_state) = settle_unit_operation(
            active_state,
            UnitCallSite::ObjectProperty,
            || Ok(Self::get_unit_path(&manager, unit_name)?.is_some()),
            &format!("read transient unit state {unit_name}"),
        )?
        else {
            return Ok(false);
        };
        if !matches!(active_state.as_str(), "inactive" | "failed") {
            bail!("refusing to destroy populated transient unit {unit_name}")
        }
        drop(unit);
        let reset: zbus::Result<()> = manager.call("ResetFailedUnit", &(unit_name,));
        if settle_unit_operation(
            reset,
            UnitCallSite::Manager,
            || Ok(Self::get_unit_path(&manager, unit_name)?.is_some()),
            &format!("reset transient unit {unit_name}"),
        )?
        .is_none()
        {
            return Ok(true);
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
        self.network
            .lock()
            .map_err(|_| anyhow::anyhow!("jailerd network state lock poisoned"))?
            .ensure_run(request)
    }

    fn repair_run_network(
        &mut self,
        request: &EnsureRunNetworkRequest,
    ) -> Result<RunNetworkResult> {
        self.network
            .lock()
            .map_err(|_| anyhow::anyhow!("jailerd network state lock poisoned"))?
            .repair_run(request)
    }

    fn ensure_vm_network(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        self.network
            .lock()
            .map_err(|_| anyhow::anyhow!("jailerd network state lock poisoned"))?
            .ensure_vm(run, request, generation, uid, gid)
    }

    fn recover_vm_network(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        self.network
            .lock()
            .map_err(|_| anyhow::anyhow!("jailerd network state lock poisoned"))?
            .recover_vm(run, request, generation, uid, gid)
    }

    fn destroy_vm_network(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
    ) -> Result<bool> {
        self.network
            .lock()
            .map_err(|_| anyhow::anyhow!("jailerd network state lock poisoned"))?
            .destroy_vm(run_id, generation)
    }

    fn set_vm_ssh_forwarding(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
        active: bool,
    ) -> Result<bool> {
        self.network
            .lock()
            .map_err(|_| anyhow::anyhow!("jailerd network state lock poisoned"))?
            .set_vm_ssh_forwarding(run_id, generation, active)
    }

    fn destroy_run_network(&mut self, request: &DestroyRunNetworkRequest) -> Result<bool> {
        self.network
            .lock()
            .map_err(|_| anyhow::anyhow!("jailerd network state lock poisoned"))?
            .destroy_run(&request.run_id)
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnitCallSite {
    Manager,
    ObjectProperty,
}

#[cfg(any(target_os = "linux", test))]
fn is_unit_disappeared_name(site: UnitCallSite, name: &str) -> bool {
    match site {
        UnitCallSite::Manager => name == "org.freedesktop.systemd1.NoSuchUnit",
        UnitCallSite::ObjectProperty => matches!(
            name,
            "org.freedesktop.DBus.Error.UnknownObject" | "org.freedesktop.systemd1.NoSuchUnit"
        ),
    }
}

#[cfg(any(target_os = "linux", test))]
fn is_unit_disappeared_error(site: UnitCallSite, error: &zbus::Error) -> bool {
    match error {
        zbus::Error::MethodError(name, _, _) => is_unit_disappeared_name(site, name.as_str()),
        zbus::Error::FDO(error) => matches!(
            (site, error.as_ref()),
            (
                UnitCallSite::ObjectProperty,
                zbus::fdo::Error::UnknownObject(_)
            )
        ),
        _ => false,
    }
}

#[cfg(any(target_os = "linux", test))]
fn settle_unit_operation<T>(
    operation: zbus::Result<T>,
    site: UnitCallSite,
    unit_still_exists: impl FnOnce() -> Result<bool>,
    context: &str,
) -> Result<Option<T>> {
    match operation {
        Ok(value) => Ok(Some(value)),
        Err(error) if is_unit_disappeared_error(site, &error) => {
            if unit_still_exists().context("recheck transient unit after D-Bus failure")? {
                Err(error).with_context(|| context.to_owned())
            } else {
                Ok(None)
            }
        }
        Err(error) => Err(error).with_context(|| context.to_owned()),
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
fn read_cpu_stat(control_group: &str) -> Result<CpuStat> {
    read_cpu_stat_path(Path::new(control_group))
}

#[cfg(target_os = "linux")]
fn read_cpu_stat_path(control_group: &Path) -> Result<CpuStat> {
    let relative = control_group.strip_prefix("/").unwrap_or(control_group);
    let contents =
        std::fs::read_to_string(Path::new("/sys/fs/cgroup").join(relative).join("cpu.stat"))?;
    let values = contents
        .lines()
        .filter_map(|line| line.split_once(' '))
        .filter_map(|(name, value)| value.parse::<u64>().ok().map(|value| (name, value)))
        .collect::<BTreeMap<_, _>>();
    let get = |name: &str| values.get(name).copied().unwrap_or_default();
    Ok(CpuStat {
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
    assert_cpu_quota_at(Path::new("/sys/fs/cgroup"), control_group, quota)
}

#[cfg(any(target_os = "linux", test))]
fn assert_cpu_quota_at(cgroup_root: &Path, control_group: &Path, quota: CpuQuota) -> Result<()> {
    let relative = control_group.strip_prefix("/").unwrap_or(control_group);
    let directory = cgroup_root.join(relative);
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

#[cfg(any(target_os = "linux", test))]
fn clear_cpu_burst_and_attest_at(
    cgroup_root: &Path,
    control_group: &Path,
    quota: CpuQuota,
) -> Result<()> {
    let relative = control_group.strip_prefix("/").unwrap_or(control_group);
    std::fs::write(cgroup_root.join(relative).join("cpu.max.burst"), "0")?;
    assert_cpu_quota_at(cgroup_root, control_group, quota)
}

#[cfg(any(target_os = "linux", test))]
fn parse_proc_uptime_millis(contents: &str) -> Result<u64> {
    let uptime = contents
        .split_whitespace()
        .next()
        .context("/proc/uptime omitted the monotonic uptime value")?;
    let (seconds, fractional) = uptime.split_once('.').unwrap_or((uptime, ""));
    let seconds = seconds
        .parse::<u64>()
        .context("parse /proc/uptime seconds")?;
    if !fractional.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!("parse /proc/uptime fractional seconds")
    }
    let mut fractional_millis = 0_u64;
    let mut digits = 0_u8;
    for byte in fractional.bytes().take(3) {
        fractional_millis = fractional_millis
            .checked_mul(10)
            .and_then(|value| value.checked_add(u64::from(byte - b'0')))
            .context("/proc/uptime milliseconds overflow")?;
        digits += 1;
    }
    while digits < 3 {
        fractional_millis = fractional_millis
            .checked_mul(10)
            .context("/proc/uptime milliseconds overflow")?;
        digits += 1;
    }
    seconds
        .checked_mul(1_000)
        .and_then(|value| value.checked_add(fractional_millis))
        .context("/proc/uptime milliseconds overflow")
}

#[cfg(any(target_os = "linux", test))]
fn proc_uptime_millis_at(path: &Path) -> Result<u64> {
    let contents = std::fs::read_to_string(path)
        .with_context(|| format!("read monotonic uptime from {}", path.display()))?;
    parse_proc_uptime_millis(&contents)
}

#[cfg(target_os = "linux")]
fn proc_uptime_millis() -> Result<u64> {
    proc_uptime_millis_at(Path::new("/proc/uptime"))
}

#[cfg(any(target_os = "linux", test))]
fn wait_until_uptime_deadline_with<R, S>(
    deadline_uptime_millis: u64,
    mut read_uptime_millis: R,
    mut sleep: S,
) -> Result<()>
where
    R: FnMut() -> Result<u64>,
    S: FnMut(Duration),
{
    loop {
        let now = read_uptime_millis()?;
        let Some(remaining) = deadline_uptime_millis.checked_sub(now) else {
            return Ok(());
        };
        if remaining == 0 {
            return Ok(());
        }
        sleep(Duration::from_millis(remaining));
    }
}

#[cfg(target_os = "linux")]
fn wait_until_uptime_deadline(deadline_uptime_millis: u64) -> Result<()> {
    wait_until_uptime_deadline_with(
        deadline_uptime_millis,
        proc_uptime_millis,
        std::thread::sleep,
    )
}

/// Execute the crash-surviving systemd boot-CPU guardian worker.
///
/// The hidden CLI that calls this function is started only as a root-owned
/// auxiliary transient unit. Its arguments contain no arbitrary path or
/// systemd property: the VM unit name must be exactly derived from generation.
#[cfg(target_os = "linux")]
pub fn run_boot_cpu_guardian(request: BootCpuGuardianRequest) -> Result<()> {
    use zbus::zvariant::Value;

    wait_until_uptime_deadline(request.deadline_uptime_millis())?;
    let connection =
        zbus::blocking::Connection::system().context("connect guardian to system D-Bus")?;
    let manager = SystemdHostBackend::manager(&connection)?;
    let unit_path = SystemdHostBackend::get_unit_path(&manager, request.unit_name())?
        .with_context(|| format!("guarded VM unit {} no longer exists", request.unit_name()))?;
    let unit = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.systemd1",
        unit_path,
        "org.freedesktop.systemd1.Unit",
    )?;
    let active_state: String = unit.get_property("ActiveState")?;
    ensure!(
        matches!(active_state.as_str(), "active" | "activating" | "reloading"),
        "guarded VM unit {} is {active_state}",
        request.unit_name()
    );
    let service = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.systemd1",
        unit.path(),
        "org.freedesktop.systemd1.Service",
    )?;
    let control_group: String = service.get_property("ControlGroup")?;
    ensure!(!control_group.is_empty(), "guarded VM unit has no cgroup");
    let cgroup_path = PathBuf::from(&control_group);
    ensure!(
        cgroup_path == vm_cgroup_path(request.unit_name()),
        "guarded VM unit resolved to unexpected cgroup {}",
        cgroup_path.display()
    );
    let quota = request.steady_quota();
    let properties = vec![
        (
            "CPUQuotaPerSecUSec",
            Value::new(u64::from(quota.cpu_millis) * 1_000),
        ),
        ("CPUQuotaPeriodUSec", Value::new(quota.period_micros)),
    ];
    let _: () = manager
        .call(
            "SetUnitProperties",
            &(request.unit_name(), true, properties),
        )
        .with_context(|| format!("guardian seal CPU quota for {}", request.unit_name()))?;
    clear_cpu_burst_and_attest_at(Path::new("/sys/fs/cgroup"), &cgroup_path, quota)
        .with_context(|| format!("attest guardian CPU seal for {}", request.unit_name()))?;
    tracing::info!(
        generation = %request.generation(),
        unit = request.unit_name(),
        cpu_millis = quota.cpu_millis,
        deadline_uptime_millis = request.deadline_uptime_millis(),
        "boot CPU lease guardian sealed VM to steady quota"
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn spawn_hard_cpu_seal(
    control_group: PathBuf,
    steady_quota: CpuQuota,
    deadline: Instant,
) -> Result<()> {
    std::thread::Builder::new()
        .name("jailerd-hard-cpu-lease".to_owned())
        .spawn(move || {
            if let Err(error) = seal_cpu_controller_at_deadline(
                Path::new("/sys/fs/cgroup"),
                &control_group,
                steady_quota,
                deadline,
            ) {
                tracing::error!(
                    ?error,
                    cgroup = %control_group.display(),
                    "hard boot CPU lease controller failed"
                );
            }
        })
        .context("spawn independent hard boot CPU lease controller")?;
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn seal_cpu_controller_at_deadline(
    cgroup_root: &Path,
    control_group: &Path,
    steady_quota: CpuQuota,
    deadline: Instant,
) -> Result<()> {
    if let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        std::thread::sleep(remaining);
    }
    let relative = control_group.strip_prefix("/").unwrap_or(control_group);
    let directory = cgroup_root.join(relative);
    // Lower the hard quota first. cpu.max.burst is already zero from launch,
    // but rewrite and attest it so a mutated controller cannot retain credits.
    std::fs::write(directory.join("cpu.max"), steady_quota.cpu_max())?;
    clear_cpu_burst_and_attest_at(cgroup_root, control_group, steady_quota)
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
fn find_vmm_pid_by_identity(
    control_group: &str,
    expected: RuntimeFileIdentity,
) -> Result<Option<u32>> {
    use std::os::unix::fs::MetadataExt as _;

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
        let metadata = match std::fs::metadata(&executable) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("stat cgroup process executable for PID {pid}"));
            }
        };
        if metadata.dev() != expected.device
            || metadata.ino() != expected.inode
            || metadata.len() != expected.bytes
        {
            continue;
        }
        let membership = std::fs::read_to_string(format!("/proc/{pid}/cgroup"))?;
        let expected_membership = format!("0::{control_group}");
        if !membership.lines().any(|line| line == expected_membership) {
            bail!("inode-verified VMM PID is outside its systemd cgroup")
        }
        if match_pid.replace(pid).is_some() {
            bail!("VM cgroup contains more than one inode-verified Cloud Hypervisor process")
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
    pub vmm_executable_identity: Option<RuntimeFileIdentity>,
    pub paths: JailPathMap,
}

pub trait JailPreparer: Send {
    /// Whether this preparer can guarantee clone-only template staging on the
    /// configured jail filesystem.
    fn fast_template_store(&mut self, _config: &JailerdConfig) -> bool {
        false
    }
    /// Cheap live validation used when publishing capabilities. Production
    /// checks the pinned source/template inode identities so post-prewarm
    /// tampering immediately withdraws the fast-launch capability.
    fn fast_template_store_ready(&self, _config: &JailerdConfig) -> bool {
        true
    }
    fn prepare_image_v2(
        &mut self,
        _config: &JailerdConfig,
        _request: &PrepareImageV2Request,
    ) -> Result<PreparedImageV2Result> {
        bail!("template-backed image preparation is unavailable")
    }
    fn validate_prepared_launch(
        &mut self,
        _config: &JailerdConfig,
        _request: &LaunchVmV2Request,
    ) -> Result<()> {
        bail!("template-backed VM launch is unavailable")
    }
    fn prepare(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        run_network: &RunNetworkResult,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail>;
    fn prepare_v2(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        run_network: &RunNetworkResult,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail> {
        self.prepare(config, request, run_network, generation, uid, gid)
    }
    fn destroy(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<bool>;
    fn quarantine(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<()>;
    fn grant_agent_runtime_access(
        &mut self,
        _config: &JailerdConfig,
        _generation: &ValidatedId,
        _uid: u32,
        _gid: u32,
    ) -> Result<()>;
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

#[derive(Clone, Default)]
pub struct FileSystemJailPreparer {
    host_template: Option<HostTemplateMetadataV2>,
    fast_store_attestation: Option<FastTemplateStoreAttestation>,
}

impl JailPreparer for FileSystemJailPreparer {
    fn fast_template_store(&mut self, config: &JailerdConfig) -> bool {
        let prepared = probe_fast_template_store(config).and_then(|attestation| {
            prepare_or_validate_host_template(config).map(|metadata| (metadata, attestation))
        });
        match prepared {
            Ok((metadata, attestation)) => {
                self.host_template = Some(metadata);
                self.fast_store_attestation = Some(attestation);
                true
            }
            Err(error) => {
                tracing::error!(
                    error = %format!("{error:#}"),
                    "fast template-store readiness preparation failed"
                );
                self.host_template = None;
                self.fast_store_attestation = None;
                false
            }
        }
    }

    fn fast_template_store_ready(&self, config: &JailerdConfig) -> bool {
        self.host_template.as_ref().is_some_and(|metadata| {
            validate_host_template(config, metadata).is_ok()
                && self
                    .fast_store_attestation
                    .as_ref()
                    .is_some_and(|attestation| {
                        validate_fast_template_store_attestation(config, attestation).is_ok()
                    })
        })
    }

    fn prepare_image_v2(
        &mut self,
        config: &JailerdConfig,
        request: &PrepareImageV2Request,
    ) -> Result<PreparedImageV2Result> {
        prepare_image_template(config, request)
    }

    fn validate_prepared_launch(
        &mut self,
        config: &JailerdConfig,
        request: &LaunchVmV2Request,
    ) -> Result<()> {
        validate_prepared_launch_template(config, request)
    }

    fn prepare(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        run_network: &RunNetworkResult,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail> {
        prepare_jail_files(config, request, run_network, generation, uid, gid, None)
    }

    fn prepare_v2(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        run_network: &RunNetworkResult,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail> {
        let metadata = self
            .host_template
            .as_ref()
            .context("root-owned host runtime template is unavailable")?;
        validate_host_template(config, metadata)
            .context("validate pinned host runtime template before V2 launch")?;
        prepare_jail_files(
            config,
            request,
            run_network,
            generation,
            uid,
            gid,
            Some(metadata),
        )
    }

    fn destroy(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<bool> {
        remove_generation_tree(config, generation)
    }

    fn quarantine(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<()> {
        quarantine_generation(config, generation)
    }

    fn grant_agent_runtime_access(
        &mut self,
        config: &JailerdConfig,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        grant_agent_api_socket_access(config, generation, uid, gid)
    }

    fn persist(&mut self, config: &JailerdConfig, record: &VmRecord) -> Result<()> {
        if record.schema_version != VM_RECORD_METADATA_VERSION {
            bail!("refusing to persist non-v2 jail metadata")
        }
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

        let destination = c"metadata-v2.json";
        if lifecycle_entry_exists_at(&directory, c"metadata-v1.json")? {
            bail!("legacy jail metadata cannot be overwritten or adopted")
        }
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

        let temporary = CString::new(format!("metadata-v2.json.tmp-{}", Uuid::new_v4()))
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
                if lifecycle_entry_exists_at(&generation_fd, c"metadata-v1.json")? {
                    bail!("legacy v1 jail metadata is not recoverable")
                }
                let bytes = read_root_metadata_at(&generation_fd, c"metadata-v2.json")?;
                let record = decode_vm_record_v2(&bytes)?;
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

fn lifecycle_entry_exists_at(parent: &impl std::os::fd::AsFd, name: &CStr) -> Result<bool> {
    match rustix::fs::statat(parent, name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => Ok(true),
        Err(error) if error == rustix::io::Errno::NOENT => Ok(false),
        Err(error) => Err(error).context("inspect lifecycle metadata entry"),
    }
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

const VM_RECORD_METADATA_VERSION: u16 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmRecord {
    schema_version: u16,
    generation: ValidatedId,
    request: VmLaunchRequest,
    request_fingerprint: Sha256Digest,
    run_network: RunNetworkRecord,
    unit_name: String,
    uid: u32,
    gid: u32,
    #[serde(rename = "steady_quota")]
    quota: CpuQuota,
    effective_quota: CpuQuota,
    cpu_phase: VmCpuPhase,
    #[serde(deserialize_with = "deserialize_required_option")]
    boot_deadline_unix_ms: Option<u64>,
    /// Same-daemon hard deadline for live lease enforcement. This is runtime
    /// state only: the Unix deadline remains the durable/reporting identity,
    /// while recovery seals every reattached boot-phase record immediately.
    #[serde(skip)]
    boot_deadline_monotonic: Option<Instant>,
    #[serde(deserialize_with = "deserialize_required_option")]
    quota_attestation: Option<CpuQuotaAttestation>,
    ssh_forward_active: bool,
    vcpu_count: u16,
    paths: JailPathMap,
    cgroup_path: Option<PathBuf>,
    netns_name: String,
    host_boot_id: Option<String>,
    pid_start_time_ticks: Option<u64>,
    jail_root_inode: Option<u64>,
    cloud_hypervisor_sha256: String,
}

#[derive(Debug, Error)]
#[error(
    "boot CPU capacity pending: committed={committed} requested={requested} steady={steady} schedulable={schedulable}"
)]
struct BootCapacityPendingError {
    committed: u64,
    requested: u32,
    steady: u32,
    schedulable: u64,
}

impl VmRecord {
    fn effective_quota(&self) -> CpuQuota {
        self.effective_quota
    }

    fn cpu_runtime(&self) -> VmCpuRuntimeState {
        VmCpuRuntimeState {
            phase: self.cpu_phase,
            steady_quota: self.quota,
            effective_quota: self.effective_quota(),
            boot_deadline_unix_ms: self.boot_deadline_unix_ms,
            attestation: self.quota_attestation.clone(),
        }
    }
}

fn remaining_boot_cpu_lease_ms(deadline: Instant, now: Instant) -> Result<u64> {
    let remaining = deadline
        .checked_duration_since(now)
        .filter(|remaining| !remaining.is_zero())
        .context("boot CPU lease expired before transient unit start")?;
    let remaining_ms = u64::try_from(remaining.as_millis())
        .context("remaining boot CPU lease milliseconds overflow")?;
    ensure!(
        remaining_ms > 0,
        "boot CPU lease expired before transient unit start"
    );
    Ok(remaining_ms)
}

fn boot_cpu_lease_expired(
    monotonic_deadline: Option<Instant>,
    unix_deadline_ms: Option<u64>,
    monotonic_now: Instant,
    unix_now_ms: u64,
) -> bool {
    monotonic_deadline.map_or_else(
        || unix_deadline_ms.is_some_and(|deadline| deadline <= unix_now_ms),
        |deadline| deadline <= monotonic_now,
    )
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn decode_vm_record_v2(bytes: &[u8]) -> Result<VmRecord> {
    let record: VmRecord =
        serde_json::from_slice(bytes).context("parse persisted v2 jail metadata")?;
    if record.schema_version != VM_RECORD_METADATA_VERSION {
        bail!(
            "unsupported jail metadata schema version {}",
            record.schema_version
        )
    }
    Ok(record)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct RunNetworkRecord {
    request: EnsureRunNetworkRequest,
    result: RunNetworkResult,
}

#[derive(Clone, Debug)]
struct UnresolvedRecovery {
    run_id: ValidatedId,
    generation: ValidatedId,
    unit_name: String,
    uid: u32,
    gid: u32,
}

/// Capacity and identity reserved for a V2 launch whose filesystem, network,
/// and transient-unit work is executing outside the lifecycle-state lock.
/// Keeping the complete immutable input here fences the eventual commit and
/// prevents a concurrent retry from creating a second generation.
#[derive(Clone, Debug, Eq, PartialEq)]
struct LaunchReservation {
    generation: ValidatedId,
    request: VmLaunchRequest,
    request_fingerprint: Sha256Digest,
    run_network: RunNetworkRecord,
    uid: u32,
    gid: u32,
    quota: CpuQuota,
    effective_quota: CpuQuota,
    boot_deadline_unix_ms: u64,
    boot_deadline_monotonic: Instant,
}

pub struct JailerdCore<B, P> {
    config: JailerdConfig,
    backend: B,
    preparer: P,
    total_cpu_millis: u64,
    records: BTreeMap<ValidatedId, VmRecord>,
    /// Capacity charged before StartTransientUnit. It is transferred to
    /// `records` only after the unit identity is durably persisted, and is
    /// retained if cgroup drain cannot be proven.
    pending_cpu_reservations: BTreeMap<ValidatedId, CpuQuota>,
    /// V2 launches executing without the lifecycle lock. Entries are inserted
    /// atomically with their CPU charge and removed only by a generation-fenced
    /// success/failure commit.
    inflight_launches: BTreeMap<ValidatedId, LaunchReservation>,
    /// Failed launches and recovered generations whose complete containment
    /// still needs to be retried by the lease watchdog. These entries are
    /// deliberately independent from `records`: untrusted persisted metadata
    /// must never become an addressable live VM merely to make cleanup
    /// retryable.
    unresolved_recoveries: BTreeMap<ValidatedId, UnresolvedRecovery>,
    allocated_identities: BTreeSet<u32>,
    run_networks: BTreeMap<ValidatedId, RunNetworkRecord>,
    readiness: HostReadiness,
    fast_template_store: bool,
}

enum DetachedLaunchAdmission<B, P> {
    Existing(Box<DetachedExistingLaunchTask<B, P>>),
    Reserved(Box<DetachedLaunchTask<B, P>>),
}

struct DetachedExistingLaunchTask<B, P> {
    config: JailerdConfig,
    backend: B,
    preparer: P,
    record: VmRecord,
}

enum DetachedExistingLaunchOutcome {
    Success {
        record: VmRecord,
        inspection: BackendInspection,
    },
    InspectionFailed {
        record: VmRecord,
        error: anyhow::Error,
    },
    IdentityMismatch {
        record: VmRecord,
        error: anyhow::Error,
        containment: RecoveryContainmentOutcome,
    },
}

struct DetachedLaunchTask<B, P> {
    config: JailerdConfig,
    backend: B,
    preparer: P,
    reservation: LaunchReservation,
    prepared_request: LaunchVmV2Request,
}

struct DetachedLaunchSuccess {
    reservation: LaunchReservation,
    record: VmRecord,
    result: VmLaunchResult,
}

struct DetachedLaunchFailure {
    reservation: LaunchReservation,
    error: anyhow::Error,
    cgroup_drain_proven: bool,
    cleanup_failures: Vec<String>,
    identity_released: bool,
}

enum DetachedLaunchOutcome {
    Success(Box<DetachedLaunchSuccess>),
    Failure(Box<DetachedLaunchFailure>),
}

#[derive(Default)]
struct DetachedLaunchProgress {
    identity_reserved: bool,
    jail_prepare_attempted: bool,
    network_prepare_attempted: bool,
    unit_start_attempted: bool,
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
                    && value.boot_quota_transition_verified
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

impl<B: HostBackend, P: JailPreparer> DetachedLaunchTask<B, P> {
    fn execute(mut self) -> DetachedLaunchOutcome {
        let mut progress = DetachedLaunchProgress::default();
        let operation = (|| -> Result<(VmRecord, VmLaunchResult)> {
            self.preparer
                .validate_prepared_launch(&self.config, &self.prepared_request)
                .context("validate root-owned prepared image template")?;

            progress.identity_reserved = true;
            self.preparer
                .reserve_identity(
                    &self.config,
                    &self.reservation.generation,
                    self.reservation.uid,
                    self.reservation.gid,
                )
                .context("persist generation identity reservation")?;

            progress.jail_prepare_attempted = true;
            let prepared = self
                .preparer
                .prepare_v2(
                    &self.config,
                    &self.reservation.request,
                    &self.reservation.run_network.result,
                    &self.reservation.generation,
                    self.reservation.uid,
                    self.reservation.gid,
                )
                .context("prepare jail filesystem")?;

            progress.network_prepare_attempted = true;
            self.backend
                .ensure_vm_network(
                    &self.reservation.run_network.request,
                    &self.reservation.request,
                    &self.reservation.generation,
                    self.reservation.uid,
                    self.reservation.gid,
                )
                .context("prepare VM TAP and forwarding policy")?;

            let unit_name = vm_unit_name(&self.reservation.generation);
            let mut unit_spec = UnitLaunchSpec {
                generation: self.reservation.generation.clone(),
                unit_name: unit_name.clone(),
                description: format!(
                    "Intar jailed VM {} / {}",
                    self.reservation.request.run_id, self.reservation.request.vm_id
                ),
                jailer_binary: self.config.jailer_binary.clone(),
                jail_spec_path: prepared.spec_path.clone(),
                api_socket_path: prepared.paths.host_api_socket.clone(),
                cpu_quota: self.reservation.effective_quota,
                steady_cpu_quota: self.reservation.quota,
                boot_cpu_lease_ms: Some(self.config.boot_cpu_lease_ms),
                vmm_executable_identity: prepared.vmm_executable_identity,
                uid: self.reservation.uid,
                gid: self.reservation.gid,
                device_allow: JAIL_DEVICE_ALLOW.to_vec(),
            };
            let mut record = VmRecord {
                schema_version: VM_RECORD_METADATA_VERSION,
                generation: self.reservation.generation.clone(),
                request: self.reservation.request.clone(),
                request_fingerprint: self.reservation.request_fingerprint.clone(),
                run_network: self.reservation.run_network.clone(),
                unit_name: unit_name.clone(),
                uid: self.reservation.uid,
                gid: self.reservation.gid,
                quota: self.reservation.quota,
                effective_quota: self.reservation.effective_quota,
                cpu_phase: VmCpuPhase::BootBurst,
                boot_deadline_unix_ms: Some(self.reservation.boot_deadline_unix_ms),
                boot_deadline_monotonic: Some(self.reservation.boot_deadline_monotonic),
                quota_attestation: None,
                ssh_forward_active: false,
                vcpu_count: self.reservation.request.vcpu_count,
                paths: prepared.paths.clone(),
                cgroup_path: None,
                netns_name: self.reservation.run_network.result.namespace_name.clone(),
                host_boot_id: current_host_boot_id(),
                pid_start_time_ticks: None,
                jail_root_inode: prepared.jail_root_inode,
                cloud_hypervisor_sha256: self.config.cloud_hypervisor_sha256.as_str().to_owned(),
            };
            self.preparer
                .persist(&self.config, &record)
                .context("persist pre-launch VM intent")?;

            // Admission owns the lease start. Every operation before the unit
            // exists consumes part of the same 45-second budget rather than
            // granting a fresh lease when StartTransientUnit finally runs.
            unit_spec.boot_cpu_lease_ms = Some(remaining_boot_cpu_lease_ms(
                self.reservation.boot_deadline_monotonic,
                Instant::now(),
            )?);

            progress.unit_start_attempted = true;
            let started = self
                .backend
                .start_unit(&unit_spec)
                .context("start sandbox transient unit")?;
            ensure!(
                started.unit_name == unit_name,
                "backend returned mismatched transient unit name"
            );
            self.preparer
                .grant_agent_runtime_access(
                    &self.config,
                    &self.reservation.generation,
                    self.reservation.uid,
                    self.reservation.gid,
                )
                .context("grant agent access to Cloud Hypervisor API socket")?;

            record.cgroup_path.clone_from(&started.cgroup_path);
            record.host_boot_id.clone_from(&started.host_boot_id);
            record.pid_start_time_ticks = started.pid_start_time_ticks;
            record.quota_attestation = Some(
                quota_attestation(self.reservation.effective_quota)
                    .context("attest boot CPU quota")?,
            );
            self.preparer
                .persist(&self.config, &record)
                .context("persist VM sandbox identity")?;
            let cpu_runtime = record.cpu_runtime();
            let result = VmLaunchResult {
                generation: self.reservation.generation.clone(),
                unit_name,
                pid: started.pid,
                cgroup_path: started.cgroup_path,
                uid: self.reservation.uid,
                gid: self.reservation.gid,
                netns_name: self.reservation.run_network.result.namespace_name.clone(),
                netns_inode: self.reservation.run_network.result.namespace_inode,
                host_boot_id: started.host_boot_id,
                pid_start_time_ticks: started.pid_start_time_ticks,
                jail_root_inode: prepared.jail_root_inode,
                cloud_hypervisor_sha256: self.config.cloud_hypervisor_sha256.as_str().to_owned(),
                cpu_runtime,
                paths: prepared.paths,
            };
            Ok((record, result))
        })();

        match operation {
            Ok((record, result)) => {
                DetachedLaunchOutcome::Success(Box::new(DetachedLaunchSuccess {
                    reservation: self.reservation,
                    record,
                    result,
                }))
            }
            Err(error) => {
                let (cgroup_drain_proven, cleanup_failures, identity_released) =
                    cleanup_detached_launch(
                        &self.config,
                        &mut self.backend,
                        &mut self.preparer,
                        &self.reservation,
                        progress,
                    );
                DetachedLaunchOutcome::Failure(Box::new(DetachedLaunchFailure {
                    reservation: self.reservation,
                    error,
                    cgroup_drain_proven,
                    cleanup_failures,
                    identity_released,
                }))
            }
        }
    }
}

fn cleanup_detached_launch<B: HostBackend, P: JailPreparer>(
    config: &JailerdConfig,
    backend: &mut B,
    preparer: &mut P,
    reservation: &LaunchReservation,
    progress: DetachedLaunchProgress,
) -> (bool, Vec<String>, bool) {
    let mut failures = Vec::new();
    let unit_name = vm_unit_name(&reservation.generation);
    let cgroup_drain_proven = if progress.unit_start_attempted {
        let stopped = match backend.stop_unit(&unit_name) {
            Ok(_) => true,
            Err(error) => {
                failures.push(format!("stop transient unit {unit_name}: {error:#}"));
                false
            }
        };
        let destroyed = match backend.destroy_unit(&unit_name) {
            Ok(_) => true,
            Err(error) => {
                failures.push(format!("destroy transient unit {unit_name}: {error:#}"));
                false
            }
        };
        stopped || destroyed
    } else {
        true
    };

    if cgroup_drain_proven {
        if progress.network_prepare_attempted
            && let Err(error) =
                backend.destroy_vm_network(&reservation.request.run_id, &reservation.generation)
        {
            failures.push(format!(
                "destroy VM network for generation {}: {error:#}",
                reservation.generation
            ));
        }
        if progress.jail_prepare_attempted
            && let Err(error) = preparer.quarantine(config, &reservation.generation)
        {
            failures.push(format!(
                "quarantine generation {}: {error:#}",
                reservation.generation
            ));
        }
    } else {
        failures.push(format!(
            "preserved VM network and generation {} because cgroup drain was not proven",
            reservation.generation
        ));
    }

    let identity_released = if !progress.identity_reserved {
        true
    } else if progress.identity_reserved && !progress.jail_prepare_attempted && cgroup_drain_proven
    {
        match preparer.release_identity_reservation(config, &reservation.generation) {
            Ok(()) => true,
            Err(error) => {
                failures.push(format!(
                    "release unused identity reservation for {}: {error:#}",
                    reservation.generation
                ));
                false
            }
        }
    } else {
        false
    };
    (cgroup_drain_proven, failures, identity_released)
}

fn execute_existing_launch<B: HostBackend, P: JailPreparer>(
    config: &JailerdConfig,
    backend: &mut B,
    preparer: &mut P,
    record: VmRecord,
) -> DetachedExistingLaunchOutcome {
    let inspection = match backend.inspect_unit(&record.unit_name) {
        Ok(inspection) => inspection,
        Err(error) => {
            return DetachedExistingLaunchOutcome::InspectionFailed { record, error };
        }
    };
    if backend_identity_matches(&record, &inspection) {
        return DetachedExistingLaunchOutcome::Success { record, inspection };
    }

    let recovery = unresolved_recovery_for_record(&record);
    let mut containment = RecoveryContainmentOutcome::default();
    if let Err(error) =
        backend.set_vm_ssh_forwarding(&record.request.run_id, &record.generation, false)
    {
        containment.failures.push(format!(
            "close SSH ingress for mismatched generation {}: {error:#}",
            record.generation
        ));
    }
    let recovery_containment = attempt_recovered_containment(config, backend, preparer, &recovery);
    containment.cgroup_drain_proven = recovery_containment.cgroup_drain_proven;
    containment.failures.extend(recovery_containment.failures);
    DetachedExistingLaunchOutcome::IdentityMismatch {
        record,
        error: anyhow::anyhow!("idempotent launch found mismatched live VM identity"),
        containment,
    }
}

fn existing_launch_result(record: VmRecord, inspection: BackendInspection) -> VmLaunchResult {
    let cpu_runtime = record.cpu_runtime();
    VmLaunchResult {
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
        cpu_runtime,
        paths: record.paths,
    }
}

/// Fence the immutable identity captured before a detached idempotency check.
/// Finalization may legitimately change only the CPU lease, attestation, and
/// ingress fields while the lifecycle lock is dropped.
fn detached_existing_identity_matches(expected: &VmRecord, current: &VmRecord) -> bool {
    expected.schema_version == current.schema_version
        && expected.generation == current.generation
        && expected.request == current.request
        && expected.request_fingerprint == current.request_fingerprint
        && expected.run_network == current.run_network
        && expected.unit_name == current.unit_name
        && expected.uid == current.uid
        && expected.gid == current.gid
        && expected.quota == current.quota
        && expected.vcpu_count == current.vcpu_count
        && expected.paths == current.paths
        && expected.cgroup_path == current.cgroup_path
        && expected.netns_name == current.netns_name
        && expected.host_boot_id == current.host_boot_id
        && expected.pid_start_time_ticks == current.pid_start_time_ticks
        && expected.jail_root_inode == current.jail_root_inode
        && expected.cloud_hypervisor_sha256 == current.cloud_hypervisor_sha256
}

fn unresolved_recovery_for_record(record: &VmRecord) -> UnresolvedRecovery {
    UnresolvedRecovery {
        run_id: record.request.run_id.clone(),
        generation: record.generation.clone(),
        // Never trust a mutable or persisted unit name for containment.
        unit_name: vm_unit_name(&record.generation),
        uid: record.uid,
        gid: record.gid,
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
        let fast_template_store = preparer.fast_template_store(&config);
        let current_boot_id = current_host_boot_id();
        let mut records = BTreeMap::new();
        let mut allocated_identities = preparer.recover_reserved_identities(&config)?;
        let mut active_identities = BTreeSet::new();
        let mut run_networks = BTreeMap::<ValidatedId, RunNetworkRecord>::new();
        let mut pending_cpu_reservations = BTreeMap::new();
        let mut unresolved_recoveries = BTreeMap::new();
        let mut recovery_clean = true;
        for mut record in preparer.recover(&config)? {
            if validate_recovered_record(&config, &record).is_err() {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            if record.host_boot_id.as_deref() != current_boot_id.as_deref() {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            let inspection = match backend.inspect_unit(&record.unit_name) {
                Ok(inspection) => inspection,
                Err(_) => {
                    contain_or_retain_recovered_record(
                        &config,
                        &mut backend,
                        &mut preparer,
                        &record,
                        &mut pending_cpu_reservations,
                        &mut unresolved_recoveries,
                    );
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
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            match run_networks.get(&record.request.run_id) {
                Some(existing) if existing != &record.run_network => {
                    contain_or_retain_recovered_record(
                        &config,
                        &mut backend,
                        &mut preparer,
                        &record,
                        &mut pending_cpu_reservations,
                        &mut unresolved_recoveries,
                    );
                    allocated_identities.insert(record.uid);
                    recovery_clean = false;
                    continue;
                }
                Some(_) => {}
                None => {
                    let actual = match backend.ensure_run_network(&record.run_network.request) {
                        Ok(actual) => actual,
                        Err(_) => {
                            contain_or_retain_recovered_record(
                                &config,
                                &mut backend,
                                &mut preparer,
                                &record,
                                &mut pending_cpu_reservations,
                                &mut unresolved_recoveries,
                            );
                            allocated_identities.insert(record.uid);
                            recovery_clean = false;
                            continue;
                        }
                    };
                    if actual != record.run_network.result {
                        contain_or_retain_recovered_record(
                            &config,
                            &mut backend,
                            &mut preparer,
                            &record,
                            &mut pending_cpu_reservations,
                            &mut unresolved_recoveries,
                        );
                        allocated_identities.insert(record.uid);
                        recovery_clean = false;
                        continue;
                    }
                    run_networks.insert(record.request.run_id.clone(), record.run_network.clone());
                }
            }
            let Some(cgroup_path) = record.cgroup_path.as_deref() else {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            };
            // Daemon restart ends every boot lease conservatively. Ingress is
            // still absent at this point, and is restored only for a record
            // that had durably completed finalization before the restart.
            if backend
                .update_unit_cpu_quota(&record.unit_name, cgroup_path, record.quota)
                .is_err()
            {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            record.cpu_phase = VmCpuPhase::Steady;
            record.effective_quota = record.quota;
            record.boot_deadline_unix_ms = None;
            record.quota_attestation = Some(quota_attestation(record.quota)?);
            if preparer.persist(&config, &record).is_err() {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
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
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            if record.ssh_forward_active
                && backend
                    .set_vm_ssh_forwarding(&record.request.run_id, &record.generation, true)
                    .is_err()
            {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
                allocated_identities.insert(record.uid);
                recovery_clean = false;
                continue;
            }
            if !active_identities.insert(record.uid) {
                contain_or_retain_recovered_record(
                    &config,
                    &mut backend,
                    &mut preparer,
                    &record,
                    &mut pending_cpu_reservations,
                    &mut unresolved_recoveries,
                );
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
            pending_cpu_reservations,
            inflight_launches: BTreeMap::new(),
            unresolved_recoveries,
            allocated_identities,
            run_networks,
            readiness,
            fast_template_store,
        })
    }

    pub fn handle(&mut self, request: Request) -> Response {
        if let Err(error) = validate_protocol_request(&request) {
            return Response::Error(ProtocolError::new("invalid_request", format!("{error:#}")));
        }
        let policy_validation = match &request {
            Request::EnsureRunNetwork(request) | Request::RepairRunNetwork(request) => {
                self.config.validate_run_network_request(request)
            }
            Request::LaunchVmV2(request) => self
                .config
                .validate_ssh_public_port(request.launch.ssh_public_port),
            _ => Ok(()),
        };
        if let Err(error) = policy_validation {
            return Response::Error(ProtocolError::new("invalid_request", error.to_string()));
        }
        if matches!(request, Request::LaunchVmV2(_)) {
            let capabilities = self.capabilities();
            if !(capabilities.supports_jailer_v2
                && capabilities.supports_template_backed_launch
                && capabilities.fast_template_store)
            {
                return Response::Error(ProtocolError::new(
                    "host_not_ready",
                    "host readiness attestation does not permit template-backed VM launches",
                ));
            }
        }
        if matches!(request, Request::PrepareImageV2(_)) && !self.capabilities().supports_jailer_v2
        {
            return Response::Error(ProtocolError::new(
                "host_not_ready",
                "host readiness attestation does not permit template-backed image preparation",
            ));
        }
        match self.try_handle(request) {
            Ok(response) => response,
            Err(error) => {
                let message = format!("{error:#}");
                Response::Error(ProtocolError::new(
                    classify_protocol_error(&error, &message),
                    message,
                ))
            }
        }
    }

    fn try_handle(&mut self, request: Request) -> Result<Response> {
        match request {
            Request::Capabilities => Ok(Response::Capabilities(self.capabilities())),
            Request::PrepareImageV2(request) => Ok(Response::PrepareImageV2(
                self.preparer.prepare_image_v2(&self.config, &request)?,
            )),
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
            Request::RepairRunNetwork(request) => {
                request
                    .validate()
                    .context("validate run network repair request")?;
                let record = self
                    .run_networks
                    .get(&request.run_id)
                    .cloned()
                    .context("cannot repair an untracked run network")?;
                if record.request != request {
                    bail!("run network repair topology differs from durable state")
                }
                let result = self.backend.repair_run_network(&request)?;
                if result != record.result {
                    bail!("repaired run network identity differs from durable state")
                }
                Ok(Response::RepairRunNetwork(result))
            }
            Request::LaunchVmV2(request) => Ok(Response::LaunchVmV2(self.launch_vm_v2(*request)?)),
            Request::FinalizeVmBoot(request) => {
                Ok(Response::FinalizeVmBoot(self.finalize_vm_boot(request)?))
            }
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
        let fast_template_store =
            self.fast_template_store && self.preparer.fast_template_store_ready(&self.config);
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
            supports_jailer_v2: ready && fast_template_store,
            supports_template_backed_launch: ready && fast_template_store,
            fast_template_store,
            supports_hard_cpu_quota: ready,
            supports_boot_cpu_lease: ready,
            boot_cpu_millis: self.config.boot_cpu_millis,
            boot_cpu_lease_ms: self.config.boot_cpu_lease_ms,
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

    /// Snapshot the root-owned configuration needed for stateless image
    /// preparation. Production dispatch drops the core mutex before doing any
    /// source hashing or filesystem import so boot-lease enforcement cannot be
    /// delayed by a multi-GiB image.
    pub fn template_prepare_config(&self) -> Option<JailerdConfig> {
        self.capabilities()
            .supports_jailer_v2
            .then(|| self.config.clone())
    }

    fn begin_detached_launch_vm_v2(
        &mut self,
        request: LaunchVmV2Request,
    ) -> Result<DetachedLaunchAdmission<B, P>>
    where
        B: Clone,
        P: Clone,
    {
        let quota = request
            .validate()
            .context("validate template-backed VM launch request")?;
        self.config
            .validate_ssh_public_port(request.launch.ssh_public_port)
            .context("validate root-owned SSH public port policy")?;
        let effective_quota =
            CpuQuota::from_millis(request.launch.cpu_millis.max(self.config.boot_cpu_millis))
                .context("derive root-owned boot CPU quota")?;
        let fingerprint = request_fingerprint(&request.launch)?;

        if let Some(existing) = self.records.values().find(|record| {
            record.request.run_id == request.launch.run_id
                && record.request.vm_id == request.launch.vm_id
        }) {
            if existing.request_fingerprint != fingerprint {
                bail!("logical VM already exists with a different launch request")
            }
            return Ok(DetachedLaunchAdmission::Existing(Box::new(
                DetachedExistingLaunchTask {
                    config: self.config.clone(),
                    backend: self.backend.clone(),
                    preparer: self.preparer.clone(),
                    record: existing.clone(),
                },
            )));
        }
        if let Some(existing) = self.inflight_launches.values().find(|reservation| {
            reservation.request.run_id == request.launch.run_id
                && reservation.request.vm_id == request.launch.vm_id
        }) {
            if existing.request_fingerprint != fingerprint {
                bail!("logical VM launch already exists with a different launch request")
            }
            return Err(BootCapacityPendingError {
                committed: self.committed_cpu_millis(),
                requested: existing.effective_quota.cpu_millis,
                steady: existing.quota.cpu_millis,
                schedulable: self
                    .total_cpu_millis
                    .saturating_sub(self.config.cpu_reserved_millis),
            }
            .into());
        }

        let run_network = self
            .run_networks
            .get(&request.launch.run_id)
            .context("run network must be ensured before launching a VM")?
            .clone();
        let schedulable = self
            .total_cpu_millis
            .saturating_sub(self.config.cpu_reserved_millis);
        let committed = self.committed_cpu_millis();
        let after_launch = committed
            .checked_add(u64::from(effective_quota.cpu_millis))
            .context("CPU admission arithmetic overflow")?;
        if after_launch > schedulable {
            return Err(BootCapacityPendingError {
                committed,
                requested: effective_quota.cpu_millis,
                steady: request.launch.cpu_millis,
                schedulable,
            }
            .into());
        }

        let generation = loop {
            let candidate =
                ValidatedId::parse(Uuid::new_v4().to_string()).expect("UUID is a valid generation");
            if !self.records.contains_key(&candidate)
                && !self.inflight_launches.contains_key(&candidate)
                && !self.pending_cpu_reservations.contains_key(&candidate)
            {
                break candidate;
            }
        };
        let admitted_at_monotonic = Instant::now();
        let boot_deadline_monotonic = admitted_at_monotonic
            .checked_add(Duration::from_millis(self.config.boot_cpu_lease_ms))
            .context("monotonic boot CPU lease deadline overflow")?;
        let boot_deadline_unix_ms = unix_time_millis()?
            .checked_add(self.config.boot_cpu_lease_ms)
            .context("boot CPU lease deadline overflow")?;
        let identity = self.allocate_identity()?;
        let reservation = LaunchReservation {
            generation: generation.clone(),
            request: request.launch.clone(),
            request_fingerprint: fingerprint,
            run_network,
            uid: identity,
            gid: identity,
            quota,
            effective_quota,
            boot_deadline_unix_ms,
            boot_deadline_monotonic,
        };

        // The reservation and its charge enter the lifecycle state in the same
        // critical section. Every concurrent admission therefore observes the
        // boot quota even though the expensive work runs after this lock drops.
        self.pending_cpu_reservations
            .insert(generation.clone(), effective_quota);
        self.inflight_launches
            .insert(generation, reservation.clone());

        Ok(DetachedLaunchAdmission::Reserved(Box::new(
            DetachedLaunchTask {
                config: self.config.clone(),
                backend: self.backend.clone(),
                preparer: self.preparer.clone(),
                reservation,
                prepared_request: request,
            },
        )))
    }

    fn complete_detached_launch_vm_v2(
        &mut self,
        outcome: DetachedLaunchOutcome,
    ) -> Result<VmLaunchResult> {
        let reservation = match &outcome {
            DetachedLaunchOutcome::Success(success) => &success.reservation,
            DetachedLaunchOutcome::Failure(failure) => &failure.reservation,
        };
        if self.inflight_launches.get(&reservation.generation) != Some(reservation)
            || self.pending_cpu_reservations.get(&reservation.generation)
                != Some(&reservation.effective_quota)
        {
            self.readiness.privileged_self_test_passed = false;
            self.readiness.kvm_accounting_proven = false;
            bail!(
                "generation-fenced V2 launch commit rejected for {}",
                reservation.generation
            )
        }

        match outcome {
            DetachedLaunchOutcome::Success(success) => {
                ensure!(
                    success.record.generation == success.reservation.generation
                        && success.result.generation == success.reservation.generation,
                    "detached V2 launch returned a mismatched generation"
                );
                ensure!(
                    !self.records.values().any(|record| {
                        record.request.run_id == success.reservation.request.run_id
                            && record.request.vm_id == success.reservation.request.vm_id
                    }),
                    "logical VM was committed while its fenced launch was in flight"
                );
                let generation = success.reservation.generation.clone();
                self.records.insert(generation.clone(), success.record);
                self.pending_cpu_reservations.remove(&generation);
                self.inflight_launches.remove(&generation);
                self.unresolved_recoveries.remove(&generation);
                Ok(success.result)
            }
            DetachedLaunchOutcome::Failure(failure) => {
                let generation = failure.reservation.generation.clone();
                self.inflight_launches.remove(&generation);
                if failure.cgroup_drain_proven {
                    self.pending_cpu_reservations.remove(&generation);
                }
                if failure.identity_released {
                    self.allocated_identities.remove(&failure.reservation.uid);
                }
                if failure.cleanup_failures.is_empty() {
                    self.unresolved_recoveries.remove(&generation);
                    Err(failure.error)
                } else {
                    self.unresolved_recoveries.insert(
                        generation.clone(),
                        UnresolvedRecovery {
                            run_id: failure.reservation.request.run_id,
                            generation: generation.clone(),
                            unit_name: vm_unit_name(&generation),
                            uid: failure.reservation.uid,
                            gid: failure.reservation.gid,
                        },
                    );
                    self.readiness.privileged_self_test_passed = false;
                    self.readiness.kvm_accounting_proven = false;
                    Err(failure.error.context(format!(
                        "detached launch containment was incomplete: {}",
                        failure.cleanup_failures.join("; ")
                    )))
                }
            }
        }
    }

    fn complete_detached_existing_launch(
        &mut self,
        outcome: DetachedExistingLaunchOutcome,
    ) -> Result<VmLaunchResult> {
        match outcome {
            DetachedExistingLaunchOutcome::Success { record, inspection } => {
                let generation = record.generation.clone();
                let current = self
                    .records
                    .get(&generation)
                    .cloned()
                    .context("VM generation was removed during detached idempotency check")?;
                if !detached_existing_identity_matches(&record, &current) {
                    self.readiness.privileged_self_test_passed = false;
                    self.readiness.kvm_accounting_proven = false;
                    bail!("generation-fenced idempotent launch commit rejected for {generation}")
                }
                ensure!(
                    backend_identity_matches(&current, &inspection),
                    "detached idempotent launch returned a stale backend identity"
                );
                Ok(existing_launch_result(current, inspection))
            }
            DetachedExistingLaunchOutcome::InspectionFailed { record, error } => {
                match self.records.get(&record.generation) {
                    Some(current) if detached_existing_identity_matches(&record, current) => {
                        Err(error)
                    }
                    Some(_) => {
                        self.readiness.privileged_self_test_passed = false;
                        self.readiness.kvm_accounting_proven = false;
                        Err(error.context(format!(
                            "generation-fenced idempotent inspection commit rejected for {}",
                            record.generation
                        )))
                    }
                    None => Err(error.context(format!(
                        "VM generation {} was removed during detached idempotency inspection",
                        record.generation
                    ))),
                }
            }
            DetachedExistingLaunchOutcome::IdentityMismatch {
                record,
                error,
                mut containment,
            } => {
                let generation = record.generation.clone();
                self.readiness.privileged_self_test_passed = false;
                self.readiness.kvm_accounting_proven = false;

                let Some(current) = self.records.get(&generation).cloned() else {
                    // A concurrent destroy removes the authoritative record only
                    // after the backend has proven the unit drained.
                    return Err(error.context(format!(
                        "VM generation {generation} was concurrently removed after identity mismatch"
                    )));
                };
                // Repeat the ingress revocation while holding the lifecycle
                // lock. A concurrent finalizer may have installed DNAT after
                // the detached containment task's first revocation, but it
                // cannot race this final state transition.
                if let Err(error) =
                    self.backend
                        .set_vm_ssh_forwarding(&record.request.run_id, &generation, false)
                {
                    containment.failures.push(format!(
                        "commit SSH ingress revocation for mismatched generation {generation}: {error:#}"
                    ));
                }
                let fence_matches = detached_existing_identity_matches(&record, &current);
                let conservative_quota = CpuQuota::from_millis(
                    self.config.boot_cpu_millis.max(record.request.cpu_millis),
                )
                .context("derive conservative CPU charge for mismatched generation")?;
                let recovery = unresolved_recovery_for_record(&record);

                if fence_matches {
                    // The addressable record must disappear in the same locked
                    // transition that installs any conservative capacity hold.
                    self.records.remove(&generation);
                }
                if containment.cgroup_drain_proven {
                    self.pending_cpu_reservations.remove(&generation);
                } else {
                    self.pending_cpu_reservations
                        .insert(generation.clone(), conservative_quota);
                }
                if containment.failures.is_empty() {
                    self.unresolved_recoveries.remove(&generation);
                } else {
                    self.unresolved_recoveries
                        .insert(generation.clone(), recovery);
                }

                let mut context = if fence_matches {
                    String::new()
                } else {
                    format!(
                        "generation-fenced mismatch commit rejected for {generation}; authoritative record retained"
                    )
                };
                if !containment.failures.is_empty() {
                    if !context.is_empty() {
                        context.push_str("; ");
                    }
                    context.push_str("identity-mismatch containment was incomplete: ");
                    context.push_str(&containment.failures.join("; "));
                }
                if context.is_empty() {
                    Err(error)
                } else {
                    Err(error.context(context))
                }
            }
        }
    }

    fn launch_vm_v2(&mut self, request: LaunchVmV2Request) -> Result<VmLaunchResult> {
        let quota = request
            .validate()
            .context("validate template-backed VM launch request")?;
        self.preparer
            .validate_prepared_launch(&self.config, &request)
            .context("validate root-owned prepared image template")?;
        self.launch_vm_validated(request.launch, quota)
    }

    fn launch_vm_validated(
        &mut self,
        request: VmLaunchRequest,
        quota: CpuQuota,
    ) -> Result<VmLaunchResult> {
        let effective_quota =
            CpuQuota::from_millis(request.cpu_millis.max(self.config.boot_cpu_millis))
                .context("derive root-owned boot CPU quota")?;
        self.config
            .validate_ssh_public_port(request.ssh_public_port)
            .context("validate root-owned SSH public port policy")?;
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
            .checked_add(u64::from(effective_quota.cpu_millis))
            .context("CPU admission arithmetic overflow")?;
        if after_launch > schedulable {
            return Err(BootCapacityPendingError {
                committed: self.committed_cpu_millis(),
                requested: effective_quota.cpu_millis,
                steady: request.cpu_millis,
                schedulable,
            }
            .into());
        }

        let admitted_at_monotonic = Instant::now();
        let boot_deadline_monotonic = admitted_at_monotonic
            .checked_add(Duration::from_millis(self.config.boot_cpu_lease_ms))
            .context("monotonic boot CPU lease deadline overflow")?;
        let boot_deadline_unix_ms = Some(
            unix_time_millis()?
                .checked_add(self.config.boot_cpu_lease_ms)
                .context("boot CPU lease deadline overflow")?,
        );

        let identity = self.allocate_identity()?;
        self.preparer
            .reserve_identity(&self.config, &generation, identity, identity)?;
        let prepared = match self.preparer.prepare_v2(
            &self.config,
            &request,
            &run_network.result,
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
        let unit_name = vm_unit_name(&generation);
        let mut unit_spec = UnitLaunchSpec {
            generation: generation.clone(),
            unit_name: unit_name.clone(),
            description: format!("Intar jailed VM {} / {}", request.run_id, request.vm_id),
            jailer_binary: self.config.jailer_binary.clone(),
            jail_spec_path: prepared.spec_path.clone(),
            api_socket_path: prepared.paths.host_api_socket.clone(),
            cpu_quota: effective_quota,
            steady_cpu_quota: quota,
            boot_cpu_lease_ms: Some(self.config.boot_cpu_lease_ms),
            vmm_executable_identity: prepared.vmm_executable_identity,
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
            schema_version: VM_RECORD_METADATA_VERSION,
            generation: generation.clone(),
            request: request.clone(),
            request_fingerprint: fingerprint,
            run_network: run_network.clone(),
            unit_name: unit_name.clone(),
            uid: identity,
            gid: identity,
            quota,
            effective_quota,
            cpu_phase: VmCpuPhase::BootBurst,
            boot_deadline_unix_ms,
            boot_deadline_monotonic: Some(boot_deadline_monotonic),
            quota_attestation: None,
            ssh_forward_active: false,
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
        unit_spec.boot_cpu_lease_ms =
            match remaining_boot_cpu_lease_ms(boot_deadline_monotonic, Instant::now()) {
                Ok(remaining_ms) => Some(remaining_ms),
                Err(error) => {
                    let _ = self
                        .backend
                        .destroy_vm_network(&request.run_id, &generation);
                    let _ = self.preparer.quarantine(&self.config, &generation);
                    return Err(error).context("start VM within admitted boot CPU lease");
                }
            };
        // Charge the full boot allocation before the first operation that can
        // create a live cgroup. From this point every failure must either
        // prove cgroup drain or retain this conservative reservation.
        self.pending_cpu_reservations
            .insert(generation.clone(), effective_quota);
        self.unresolved_recoveries.insert(
            generation.clone(),
            UnresolvedRecovery {
                run_id: request.run_id.clone(),
                generation: generation.clone(),
                unit_name: unit_name.clone(),
                uid: identity,
                gid: identity,
            },
        );
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
        if let Err(error) =
            self.preparer
                .grant_agent_runtime_access(&self.config, &generation, identity, identity)
        {
            return self.fail_launch(
                &request.run_id,
                &generation,
                &unit_name,
                error.context("grant agent access to Cloud Hypervisor API socket"),
            );
        }
        record.cgroup_path.clone_from(&started.cgroup_path);
        record.host_boot_id.clone_from(&started.host_boot_id);
        record.pid_start_time_ticks = started.pid_start_time_ticks;
        record.quota_attestation = match quota_attestation(effective_quota) {
            Ok(attestation) => Some(attestation),
            Err(error) => {
                return self.fail_launch(
                    &request.run_id,
                    &generation,
                    &unit_name,
                    error.context("attest boot CPU quota"),
                );
            }
        };
        if let Err(error) = self.preparer.persist(&self.config, &record) {
            return self.fail_launch(
                &request.run_id,
                &generation,
                &unit_name,
                error.context("persist VM sandbox identity"),
            );
        }
        let cpu_runtime = record.cpu_runtime();
        self.records.insert(generation.clone(), record);
        self.pending_cpu_reservations.remove(&generation);
        self.unresolved_recoveries.remove(&generation);
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
            cpu_runtime,
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
        let mut cgroup_drain_proven = false;
        match self.rollback_failed_launch(run_id, generation, unit_name, &mut cgroup_drain_proven) {
            Ok(()) => {
                self.pending_cpu_reservations.remove(generation);
                self.unresolved_recoveries.remove(generation);
                Err(failure)
            }
            Err(rollback_error) => {
                if cgroup_drain_proven {
                    self.pending_cpu_reservations.remove(generation);
                }
                // An unproven drain is both an accounting and isolation
                // failure. Keep the boot charge and revoke launch readiness
                // until recovery can conclusively seal or remove the unit.
                self.readiness.privileged_self_test_passed = false;
                self.readiness.kvm_accounting_proven = false;
                Err(failure.context(format!(
                    "failed-launch rollback was incomplete; retained conservative boot CPU reservation: {rollback_error:#}"
                )))
            }
        }
    }

    fn rollback_failed_launch(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
        unit_name: &str,
        cgroup_drain_proven: &mut bool,
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
        *cgroup_drain_proven = stop_proved_drain || destroy_proved_drain;
        if *cgroup_drain_proven {
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
        // This is a same-daemon retry of a launch whose `start_unit` handshake
        // already verified the API socket before the record was persisted and
        // inserted. Re-pinging here turns a transient API stall into destructive
        // quarantine and makes the idempotency response race VMM API readiness.
        // Recovery and InspectVm remain the liveness authorities and still
        // require a successful API ping for a healthy process.
        let outcome =
            execute_existing_launch(&self.config, &mut self.backend, &mut self.preparer, record);
        self.complete_detached_existing_launch(outcome)
    }

    fn finalize_vm_boot(&mut self, request: FinalizeVmBootRequest) -> Result<FinalizeVmBootResult> {
        let generation = request.generation;
        let phase_changed = self.seal_vm_cpu(&generation)?;
        let mut record = self
            .records
            .get(&generation)
            .context("unknown jail generation")?
            .clone();
        let forwarding_changed =
            self.backend
                .set_vm_ssh_forwarding(&record.request.run_id, &record.generation, true)?;
        let forward_active = record.request.ssh_public_port.is_some();
        if record.ssh_forward_active != forward_active {
            record.ssh_forward_active = forward_active;
            if let Err(error) = self.preparer.persist(&self.config, &record) {
                let rollback = self.backend.set_vm_ssh_forwarding(
                    &record.request.run_id,
                    &record.generation,
                    false,
                );
                return match rollback {
                    Ok(_) => Err(error).context("persist activated SSH forwarding state"),
                    Err(rollback_error) => self.contain_failed_boot_seal(
                        &record,
                        error.context(format!(
                            "persist activated SSH forwarding state; ingress rollback also failed: {rollback_error:#}"
                        )),
                    ),
                };
            }
            self.records.insert(generation.clone(), record.clone());
        }
        Ok(FinalizeVmBootResult {
            generation,
            changed: phase_changed || forwarding_changed,
            ssh_forward_active: record.ssh_forward_active,
            cpu_runtime: record.cpu_runtime(),
        })
    }

    /// Seal every expired boot lease without publishing SSH ingress. The
    /// daemon watchdog calls this even when the agent is disconnected.
    pub fn enforce_boot_deadlines(&mut self) -> Result<usize> {
        let monotonic_now = Instant::now();
        let unix_now_ms = unix_time_millis()?;
        let mut failures = self.retry_unresolved_recoveries();
        let expired = self
            .records
            .values()
            .filter(|record| {
                record.cpu_phase == VmCpuPhase::BootBurst
                    && boot_cpu_lease_expired(
                        record.boot_deadline_monotonic,
                        record.boot_deadline_unix_ms,
                        monotonic_now,
                        unix_now_ms,
                    )
            })
            .map(|record| record.generation.clone())
            .collect::<Vec<_>>();
        let mut sealed = 0;
        for generation in expired {
            match self.seal_vm_cpu(&generation) {
                Ok(true) => sealed += 1,
                Ok(false) => {}
                Err(error) => failures.push(format!("{generation}: {error:#}")),
            }
        }
        if failures.is_empty() {
            Ok(sealed)
        } else {
            bail!(
                "boot CPU lease watchdog sealed {sealed} VM(s) but failed for: {}",
                failures.join("; ")
            )
        }
    }

    fn retry_unresolved_recoveries(&mut self) -> Vec<String> {
        let generations = self
            .unresolved_recoveries
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut failures = Vec::new();
        for generation in generations {
            let Some(recovery) = self.unresolved_recoveries.get(&generation).cloned() else {
                continue;
            };
            let outcome = attempt_recovered_containment(
                &self.config,
                &mut self.backend,
                &mut self.preparer,
                &recovery,
            );
            if outcome.cgroup_drain_proven {
                self.pending_cpu_reservations.remove(&generation);
            }
            if outcome.failures.is_empty() {
                self.unresolved_recoveries.remove(&generation);
            } else {
                failures.push(format!(
                    "{} recovery containment: {}",
                    generation,
                    outcome.failures.join("; ")
                ));
            }
        }
        failures
    }

    fn seal_vm_cpu(&mut self, generation: &ValidatedId) -> Result<bool> {
        let mut record = self
            .records
            .get(generation)
            .context("unknown jail generation")?
            .clone();
        let phase_changed = record.cpu_phase == VmCpuPhase::BootBurst;
        let cgroup_path = record
            .cgroup_path
            .as_deref()
            .context("VM cgroup identity is not persisted")?;
        if let Err(error) =
            self.backend
                .update_unit_cpu_quota(&record.unit_name, cgroup_path, record.quota)
        {
            return self.contain_failed_boot_seal(&record, error);
        }
        record.cpu_phase = VmCpuPhase::Steady;
        record.effective_quota = record.quota;
        record.boot_deadline_unix_ms = None;
        record.boot_deadline_monotonic = None;
        record.quota_attestation = Some(quota_attestation(record.quota)?);
        if let Err(error) = self.preparer.persist(&self.config, &record) {
            return self.contain_failed_boot_seal(
                &record,
                error.context("persist sealed CPU quota state"),
            );
        }
        self.records.insert(generation.clone(), record);
        Ok(phase_changed)
    }

    fn contain_failed_boot_seal<T>(
        &mut self,
        record: &VmRecord,
        failure: anyhow::Error,
    ) -> Result<T> {
        self.readiness.privileged_self_test_passed = false;
        self.readiness.kvm_accounting_proven = false;
        let mut cgroup_drain_proven = false;
        match self.rollback_failed_launch(
            &record.request.run_id,
            &record.generation,
            &record.unit_name,
            &mut cgroup_drain_proven,
        ) {
            Ok(()) => {
                self.records.remove(&record.generation);
                Err(failure).context("boot CPU seal failed; VM was stopped and quarantined")
            }
            Err(containment_error) => Err(failure).context(format!(
                "boot CPU seal failed; containment was incomplete: {containment_error:#}"
            )),
        }
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
        let cpu_runtime = record.cpu_runtime();
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
            cpu_runtime,
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
        let committed: u64 = self
            .records
            .values()
            .map(|record| u64::from(record.effective_quota().cpu_millis))
            .sum();
        committed.saturating_add(
            self.pending_cpu_reservations
                .values()
                .map(|quota| u64::from(quota.cpu_millis))
                .sum(),
        )
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

/// Execute a V2 launch without holding the lifecycle-state mutex across
/// template validation, generation staging, networking, systemd activation,
/// or VMM readiness polling. Admission and completion remain short,
/// generation-fenced critical sections, and the boot quota is charged for the
/// entire unlocked interval.
pub fn launch_vm_v2_response<B, P>(
    core: &Arc<Mutex<JailerdCore<B, P>>>,
    request: LaunchVmV2Request,
) -> Response
where
    B: HostBackend + Clone,
    P: JailPreparer + Clone,
{
    if let Err(error) = request.validate() {
        return Response::Error(ProtocolError::new("invalid_request", error.to_string()));
    }

    let admission = {
        let mut core = match core.lock() {
            Ok(core) => core,
            Err(_) => {
                return Response::Error(ProtocolError::new(
                    "host_operation_failed",
                    "jailerd lifecycle state lock poisoned",
                ));
            }
        };
        if let Err(error) = core
            .config
            .validate_ssh_public_port(request.launch.ssh_public_port)
        {
            return Response::Error(ProtocolError::new("invalid_request", error.to_string()));
        }
        let capabilities = core.capabilities();
        if !(capabilities.supports_jailer_v2
            && capabilities.supports_template_backed_launch
            && capabilities.fast_template_store)
        {
            return Response::Error(ProtocolError::new(
                "host_not_ready",
                "host readiness attestation does not permit template-backed VM launches",
            ));
        }
        match core.begin_detached_launch_vm_v2(request) {
            Ok(admission) => admission,
            Err(error) => return protocol_error_response(error),
        }
    };

    match admission {
        DetachedLaunchAdmission::Existing(task) => {
            let DetachedExistingLaunchTask {
                config,
                mut backend,
                mut preparer,
                record,
            } = *task;
            let outcome = execute_existing_launch(&config, &mut backend, &mut preparer, record);
            let result = match core.lock() {
                Ok(mut core) => core.complete_detached_existing_launch(outcome),
                Err(_) => {
                    return Response::Error(ProtocolError::new(
                        "host_operation_failed",
                        "jailerd lifecycle state lock poisoned during idempotent launch commit",
                    ));
                }
            };
            match result {
                Ok(result) => Response::LaunchVmV2(result),
                Err(error) => protocol_error_response(error),
            }
        }
        DetachedLaunchAdmission::Reserved(task) => {
            let outcome = task.execute();
            let result = match core.lock() {
                Ok(mut core) => core.complete_detached_launch_vm_v2(outcome),
                Err(_) => {
                    return Response::Error(ProtocolError::new(
                        "host_operation_failed",
                        "jailerd lifecycle state lock poisoned during launch commit",
                    ));
                }
            };
            match result {
                Ok(result) => Response::LaunchVmV2(result),
                Err(error) => protocol_error_response(error),
            }
        }
    }
}

fn protocol_error_response(error: anyhow::Error) -> Response {
    let message = format!("{error:#}");
    Response::Error(ProtocolError::new(
        classify_protocol_error(&error, &message),
        message,
    ))
}

/// Execute the long-running, stateless template import after production
/// dispatch has released `JailerdCore`'s lifecycle mutex.
pub fn prepare_image_v2_response(
    config: &JailerdConfig,
    request: PrepareImageV2Request,
) -> Response {
    if let Err(error) = request.validate() {
        return Response::Error(ProtocolError::new("invalid_request", error.to_string()));
    }
    if let Err(error) = probe_fast_template_store(config) {
        return Response::Error(ProtocolError::new(
            "host_not_ready",
            format!("fast image template store is unavailable: {error:#}"),
        ));
    }
    let host_template = match read_optional_host_template_metadata(config) {
        Ok(Some(metadata)) => metadata,
        Ok(None) => {
            return Response::Error(ProtocolError::new(
                "host_not_ready",
                "root-owned host runtime template is unavailable",
            ));
        }
        Err(error) => {
            return Response::Error(ProtocolError::new(
                "host_not_ready",
                format!("host runtime template metadata is unavailable: {error:#}"),
            ));
        }
    };
    if let Err(error) = validate_host_template(config, &host_template) {
        return Response::Error(ProtocolError::new(
            "host_not_ready",
            format!("host runtime template validation failed: {error:#}"),
        ));
    }
    match prepare_image_template(config, &request) {
        Ok(result) => Response::PrepareImageV2(result),
        Err(error) => Response::Error(ProtocolError::new(
            "image_prepare_failed",
            format!("{error:#}"),
        )),
    }
}

fn validate_protocol_request(request: &Request) -> Result<()> {
    match request {
        Request::PrepareImageV2(request) => request.validate().map_err(Into::into),
        Request::EnsureRunNetwork(request) | Request::RepairRunNetwork(request) => {
            request.validate().map_err(Into::into)
        }
        Request::LaunchVmV2(request) => request.validate().map(|_| ()).map_err(Into::into),
        Request::FinalizeVmBoot(_) => Ok(()),
        Request::InspectVm(request) | Request::StopVm(request) | Request::DestroyVm(request) => {
            request.validate().map_err(Into::into)
        }
        Request::Capabilities | Request::DestroyRunNetwork(_) => Ok(()),
    }
}

fn classify_protocol_error(error: &anyhow::Error, message: &str) -> &'static str {
    if error.downcast_ref::<BootCapacityPendingError>().is_some() {
        "boot_capacity_pending"
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

fn unix_time_millis() -> Result<u64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_millis();
    u64::try_from(millis).context("Unix timestamp does not fit in u64 milliseconds")
}

fn quota_attestation(quota: CpuQuota) -> Result<CpuQuotaAttestation> {
    Ok(CpuQuotaAttestation {
        quota,
        cpu_max: quota.cpu_max(),
        cpu_max_burst: 0,
        verified_at_unix_ms: unix_time_millis()?,
    })
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

#[derive(Debug, Default)]
struct RecoveryContainmentOutcome {
    cgroup_drain_proven: bool,
    failures: Vec<String>,
}

/// Attempt every containment boundary even when an earlier one fails. A
/// successful stop or destroy is sufficient proof that the cgroup no longer
/// consumes CPU; network and jail cleanup are attempted only after that proof.
fn attempt_recovered_containment<B: HostBackend, P: JailPreparer>(
    config: &JailerdConfig,
    backend: &mut B,
    preparer: &mut P,
    recovery: &UnresolvedRecovery,
) -> RecoveryContainmentOutcome {
    let mut outcome = RecoveryContainmentOutcome::default();
    if recovery.uid == recovery.gid
        && (config.uid_gid_start..=config.uid_gid_end).contains(&recovery.uid)
        && let Err(error) =
            preparer.reserve_identity(config, &recovery.generation, recovery.uid, recovery.gid)
    {
        outcome.failures.push(format!(
            "preserve quarantined VM identity reservation: {error:#}"
        ));
    }
    match backend.stop_unit(&recovery.unit_name) {
        Ok(_) => outcome.cgroup_drain_proven = true,
        Err(error) => outcome.failures.push(format!(
            "drain mismatched transient unit {}: {error:#}",
            recovery.unit_name
        )),
    }
    match backend.destroy_unit(&recovery.unit_name) {
        Ok(_) => outcome.cgroup_drain_proven = true,
        Err(error) => outcome.failures.push(format!(
            "remove mismatched transient unit {}: {error:#}",
            recovery.unit_name
        )),
    }
    if outcome.cgroup_drain_proven {
        if let Err(error) = backend.destroy_vm_network(&recovery.run_id, &recovery.generation) {
            outcome.failures.push(format!(
                "destroy recovered VM network for {}: {error:#}",
                recovery.generation
            ));
        }
        if let Err(error) = preparer.quarantine(config, &recovery.generation) {
            outcome.failures.push(format!(
                "quarantine mismatched recovered jail {}: {error:#}",
                recovery.generation
            ));
        }
    } else {
        outcome.failures.push(format!(
            "preserved VM network and jail {} because cgroup drain was not proven",
            recovery.generation
        ));
    }
    outcome
}

/// Fail closed when persisted state cannot be reattached safely. Constructor
/// recovery must not abort and leave a boot-quota process tree without a live
/// watchdog. Instead, charge the full effective boot allocation and retain a
/// cleanup item until a later attempt proves cgroup drain.
fn contain_or_retain_recovered_record<B: HostBackend, P: JailPreparer>(
    config: &JailerdConfig,
    backend: &mut B,
    preparer: &mut P,
    record: &VmRecord,
    pending_cpu_reservations: &mut BTreeMap<ValidatedId, CpuQuota>,
    unresolved_recoveries: &mut BTreeMap<ValidatedId, UnresolvedRecovery>,
) {
    let requested_effective = config.boot_cpu_millis.max(record.request.cpu_millis);
    let conservative_quota = CpuQuota::from_millis(requested_effective).unwrap_or_else(|_| {
        CpuQuota::from_millis(config.boot_cpu_millis).expect("validated quota")
    });
    let recovery = UnresolvedRecovery {
        run_id: record.request.run_id.clone(),
        generation: record.generation.clone(),
        // Never trust a persisted unit name when selecting a root-owned unit.
        unit_name: format!("intar-vm-{}.service", record.generation),
        uid: record.uid,
        gid: record.gid,
    };
    pending_cpu_reservations.insert(record.generation.clone(), conservative_quota);
    unresolved_recoveries.insert(record.generation.clone(), recovery.clone());
    let outcome = attempt_recovered_containment(config, backend, preparer, &recovery);
    if outcome.cgroup_drain_proven {
        pending_cpu_reservations.remove(&record.generation);
    }
    if outcome.failures.is_empty() {
        unresolved_recoveries.remove(&record.generation);
    }
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
    if record.schema_version != VM_RECORD_METADATA_VERSION {
        bail!("persisted VM metadata schema is not v2")
    }
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
    let expected_effective = match record.cpu_phase {
        VmCpuPhase::BootBurst => {
            if record.boot_deadline_unix_ms.is_none() || record.ssh_forward_active {
                bail!("persisted boot CPU lease state is incomplete or externally reachable")
            }
            CpuQuota::from_millis(record.request.cpu_millis.max(config.boot_cpu_millis))?
        }
        VmCpuPhase::Steady => {
            if record.boot_deadline_unix_ms.is_some() {
                bail!("persisted steady CPU state retains a boot lease deadline")
            }
            record.quota
        }
    };
    if record.effective_quota != expected_effective {
        bail!("persisted effective CPU quota does not match its phase")
    }
    if let Some(attestation) = &record.quota_attestation
        && (attestation.quota != record.effective_quota()
            || attestation.cpu_max != attestation.quota.cpu_max()
            || attestation.cpu_max_burst != 0
            || attestation.verified_at_unix_ms == 0)
    {
        bail!("persisted CPU quota attestation is invalid")
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

const IMAGE_TEMPLATE_METADATA_VERSION: u16 = 2;
const HOST_TEMPLATE_METADATA_VERSION: u16 = 2;
const HOST_TEMPLATE_POINTER: &str = "host-v2-current.json";
const HOST_TEMPLATE_DIRECTORY: &str = "host-v2";
const BLANK_RECORDING_BYTES: u64 = 256 * 1024 * 1024;
const BLANK_RECORDING_LABEL: [u8; 11] = *b"INTARREC   ";
const BLANK_RECORDING_DISPLAY_LABEL: &[u8] = b"INTARREC";
const BLANK_RECORDING_VOLUME_ID: u32 = 0x494e_5441;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ImageTemplateArtifactV2 {
    sha256: Sha256Digest,
    bytes: u64,
    device: u64,
    inode: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ImageTemplateMetadataV2 {
    schema_version: u16,
    image_sha256: Sha256Digest,
    virtual_size_bytes: u64,
    root_disk: ImageTemplateArtifactV2,
    kernel: ImageTemplateArtifactV2,
    initrd: Option<ImageTemplateArtifactV2>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct SourceFileIdentityV2 {
    device: u64,
    inode: u64,
    bytes: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct HostTemplateArtifactV2 {
    sha256: Sha256Digest,
    identity: SourceFileIdentityV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct HostTemplateMetadataV2 {
    schema_version: u16,
    bundle_sha256: Sha256Digest,
    cloud_hypervisor_source: SourceFileIdentityV2,
    jailer_source: SourceFileIdentityV2,
    cloud_hypervisor: HostTemplateArtifactV2,
    jailer: HostTemplateArtifactV2,
    blank_recording: HostTemplateArtifactV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct HostTemplateBundleMetadataV2 {
    schema_version: u16,
    bundle_sha256: Sha256Digest,
    cloud_hypervisor: HostTemplateArtifactV2,
    jailer: HostTemplateArtifactV2,
    blank_recording: HostTemplateArtifactV2,
}

impl From<&HostTemplateMetadataV2> for HostTemplateBundleMetadataV2 {
    fn from(metadata: &HostTemplateMetadataV2) -> Self {
        Self {
            schema_version: metadata.schema_version,
            bundle_sha256: metadata.bundle_sha256.clone(),
            cloud_hypervisor: metadata.cloud_hypervisor.clone(),
            jailer: metadata.jailer.clone(),
            blank_recording: metadata.blank_recording.clone(),
        }
    }
}

fn source_file_identity(metadata: &std::fs::Metadata) -> SourceFileIdentityV2 {
    use std::os::unix::fs::MetadataExt as _;

    SourceFileIdentityV2 {
        device: metadata.dev(),
        inode: metadata.ino(),
        bytes: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
    }
}

fn validate_host_template_artifact_metadata(
    metadata: &std::fs::Metadata,
    expected: &HostTemplateArtifactV2,
    label: &str,
) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;

    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.gid() != 0
        || metadata.nlink() != 1
        || metadata.mode() & 0o222 != 0
    {
        bail!("{label} ownership, link count, mode, or file type changed")
    }
    let file_identity = source_file_identity(metadata);
    if file_identity != expected.identity {
        bail!("{label} pinned inode identity or timestamps changed")
    }
    Ok(())
}

fn runtime_file_identity(metadata: &std::fs::Metadata) -> RuntimeFileIdentity {
    use std::os::unix::fs::MetadataExt as _;

    RuntimeFileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        bytes: metadata.len(),
    }
}

fn digest_reader(reader: &mut File) -> Result<Sha256Digest> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = reader.read(&mut buffer).context("read template artifact")?;
        if length == 0 {
            break;
        }
        hasher.update(&buffer[..length]);
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(Sha256Digest::parse(encoded).expect("SHA-256 encoder is canonical"))
}

fn host_template_bundle_sha256(
    cloud_hypervisor: &Sha256Digest,
    jailer: &Sha256Digest,
    blank_recording: &Sha256Digest,
) -> Sha256Digest {
    let mut hasher = Sha256::new();
    hasher.update(b"intar-host-template-v2\0");
    for digest in [cloud_hypervisor, jailer, blank_recording] {
        hasher.update(digest.as_str().as_bytes());
        hasher.update(b"\0");
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    Sha256Digest::parse(encoded).expect("SHA-256 encoder is canonical")
}

fn template_artifact_source(
    image_sha256: &Sha256Digest,
    file_name: &str,
    sha256: &Sha256Digest,
    access: ArtifactAccess,
) -> ArtifactSource {
    ArtifactSource {
        source_root: PREPARED_IMAGE_SOURCE_ROOT,
        relative_path: PathBuf::from(image_sha256.as_str()).join(file_name),
        sha256: Some(sha256.clone()),
        access,
    }
}

fn prepared_image_result(metadata: &ImageTemplateMetadataV2) -> PreparedImageV2Result {
    PreparedImageV2Result {
        image_sha256: metadata.image_sha256.clone(),
        virtual_size_bytes: metadata.virtual_size_bytes,
        root_disk: template_artifact_source(
            &metadata.image_sha256,
            "root.raw",
            &metadata.root_disk.sha256,
            ArtifactAccess::ReadWrite,
        ),
        kernel: template_artifact_source(
            &metadata.image_sha256,
            "kernel",
            &metadata.kernel.sha256,
            ArtifactAccess::ReadOnly,
        ),
        initrd: metadata.initrd.as_ref().map(|artifact| {
            template_artifact_source(
                &metadata.image_sha256,
                "initrd",
                &artifact.sha256,
                ArtifactAccess::ReadOnly,
            )
        }),
        fast_template_store: true,
    }
}

fn request_template_identity_matches(
    request: &PrepareImageV2Request,
    metadata: &ImageTemplateMetadataV2,
) -> bool {
    metadata.schema_version == IMAGE_TEMPLATE_METADATA_VERSION
        && metadata.image_sha256 == request.image_sha256
        && metadata.virtual_size_bytes == request.virtual_size_bytes
        && request.root_disk.sha256.as_ref() == Some(&metadata.root_disk.sha256)
        && request.kernel.sha256.as_ref() == Some(&metadata.kernel.sha256)
        && request
            .initrd
            .as_ref()
            .and_then(|source| source.sha256.as_ref())
            == metadata.initrd.as_ref().map(|artifact| &artifact.sha256)
}

fn validate_template_artifact_stat(
    stat: &rustix::fs::Stat,
    expected: &ImageTemplateArtifactV2,
    label: &str,
) -> Result<()> {
    if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
        || stat.st_uid != 0
        || stat.st_gid != 0
        || stat.st_nlink != 1
        || stat.st_mode & 0o222 != 0
        || stat_device_u64(stat) != Some(expected.device)
        || stat.st_ino != expected.inode
        || stat.st_size < 0
        || stat.st_size as u64 != expected.bytes
    {
        bail!("{label} identity, ownership, link count, mode, or size changed")
    }
    Ok(())
}

fn stat_device_u64(stat: &rustix::fs::Stat) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        Some(stat.st_dev)
    }
    #[cfg(not(target_os = "linux"))]
    {
        u64::try_from(stat.st_dev).ok()
    }
}

fn open_trusted_runtime_source(path: &Path) -> Result<File> {
    use std::os::unix::fs::MetadataExt as _;

    let fd = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open trusted runtime source {}", path.display()))?;
    let file = File::from(fd);
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.gid() != 0
        || metadata.nlink() != 1
        || metadata.mode() & 0o022 != 0
    {
        bail!("trusted runtime source must be root-owned, non-writable, regular, and single-linked")
    }
    Ok(file)
}

fn validate_runtime_source_identity(path: &Path, expected: &SourceFileIdentityV2) -> Result<()> {
    let file = open_trusted_runtime_source(path)?;
    if &source_file_identity(&file.metadata()?) != expected {
        bail!("trusted runtime source inode identity changed after template preparation")
    }
    Ok(())
}

fn copy_runtime_template_source(
    path: &Path,
    destination: &Path,
    expected: Option<&Sha256Digest>,
) -> Result<(SourceFileIdentityV2, HostTemplateArtifactV2)> {
    let mut source = open_trusted_runtime_source(path)?;
    let before = source_file_identity(&source.metadata()?);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(destination)
        .with_context(|| format!("create runtime template {}", destination.display()))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = source
            .read(&mut buffer)
            .context("read trusted runtime source")?;
        if length == 0 {
            break;
        }
        output.write_all(&buffer[..length])?;
        hasher.update(&buffer[..length]);
        bytes = bytes
            .checked_add(length as u64)
            .context("runtime template size overflow")?;
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    let actual = Sha256Digest::parse(encoded).expect("SHA-256 encoder is canonical");
    if expected.is_some_and(|expected| expected != &actual) {
        bail!("trusted runtime source digest does not match its root-owned pin")
    }
    rustix::fs::fchmod(&output, Mode::RUSR)?;
    rustix::fs::fchown(
        &output,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    if source_file_identity(&source.metadata()?) != before {
        bail!("trusted runtime source changed while its template was prepared")
    }
    let artifact = HostTemplateArtifactV2 {
        sha256: actual,
        identity: source_file_identity(&output.metadata()?),
    };
    validate_host_template_artifact_metadata(
        &output.metadata()?,
        &artifact,
        "new runtime template",
    )?;
    if artifact.identity.bytes != bytes {
        bail!("new runtime template size changed")
    }
    Ok((before, artifact))
}

fn create_blank_recording_template(destination: &Path) -> Result<HostTemplateArtifactV2> {
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(destination)
        .with_context(|| format!("create blank recording template {}", destination.display()))?;
    let digest = format_blank_recording(&mut output)?;
    rustix::fs::fchmod(&output, Mode::RUSR)?;
    rustix::fs::fchown(
        &output,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    let artifact = HostTemplateArtifactV2 {
        sha256: digest,
        identity: source_file_identity(&output.metadata()?),
    };
    validate_host_template_artifact_metadata(
        &output.metadata()?,
        &artifact,
        "new blank recording template",
    )?;
    if artifact.identity.bytes != BLANK_RECORDING_BYTES {
        bail!("blank recording template size changed")
    }
    Ok(artifact)
}

fn format_blank_recording(output: &mut File) -> Result<Sha256Digest> {
    output.set_len(BLANK_RECORDING_BYTES)?;
    fatfs::format_volume(
        &mut *output,
        fatfs::FormatVolumeOptions::new()
            .volume_id(BLANK_RECORDING_VOLUME_ID)
            .volume_label(BLANK_RECORDING_LABEL),
    )
    .context("format root-owned blank recording template")?;
    output.seek(SeekFrom::Start(0))?;
    digest_reader(output)
}

fn read_optional_host_template_metadata(
    config: &JailerdConfig,
) -> Result<Option<HostTemplateMetadataV2>> {
    let jail_root = trusted_jail_root_fd(config)?;
    let Some(templates) = open_optional_root_directory_at(&jail_root, c"templates")? else {
        return Ok(None);
    };
    let pointer = CString::new(HOST_TEMPLATE_POINTER).expect("fixed pointer name has no NUL");
    match open_lifecycle_entry_at(&templates, &pointer, OFlags::RDONLY) {
        Ok(fd) => {
            validate_root_regular_file(&fd, "host template pointer")?;
            let mut bytes = Vec::new();
            File::from(fd)
                .take((intar_jailer_protocol::MAX_FRAME_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() > intar_jailer_protocol::MAX_FRAME_BYTES {
                bail!("host template pointer exceeds frame limit")
            }
            Ok(Some(
                serde_json::from_slice(&bytes).context("decode host template pointer")?,
            ))
        }
        Err(error) if error == rustix::io::Errno::NOENT => Ok(None),
        Err(error) => Err(error).context("open host template pointer"),
    }
}

fn read_host_template_bundle(
    config: &JailerdConfig,
    bundle_sha256: &Sha256Digest,
) -> Result<(OwnedFd, HostTemplateBundleMetadataV2)> {
    let jail_root = trusted_jail_root_fd(config)?;
    let templates = open_optional_root_directory_at(&jail_root, c"templates")?
        .context("host template root is missing")?;
    let host = open_optional_root_directory_at(&templates, c"host-v2")?
        .context("host template bundle root is missing")?;
    let bundle_name =
        CString::new(bundle_sha256.as_str()).expect("SHA-256 bundle name contains no NUL");
    let bundle = open_lifecycle_entry_at(&host, &bundle_name, OFlags::RDONLY | OFlags::DIRECTORY)
        .context("open content-addressed host template bundle")?;
    validate_root_directory(&bundle, "host template bundle")?;
    let persisted: HostTemplateBundleMetadataV2 =
        serde_json::from_slice(&read_root_metadata_at(&bundle, c"metadata-v2.json")?)
            .context("decode host template bundle metadata")?;
    Ok((bundle, persisted))
}

fn open_host_template_bundle(
    config: &JailerdConfig,
    metadata: &HostTemplateMetadataV2,
) -> Result<OwnedFd> {
    let (bundle, persisted) = read_host_template_bundle(config, &metadata.bundle_sha256)?;
    if persisted != HostTemplateBundleMetadataV2::from(metadata) {
        bail!("host template bundle metadata differs from its pinned pointer")
    }
    Ok(bundle)
}

fn validate_host_template_bundle(
    config: &JailerdConfig,
    metadata: &HostTemplateMetadataV2,
) -> Result<()> {
    if metadata.schema_version != HOST_TEMPLATE_METADATA_VERSION
        || metadata.blank_recording.identity.bytes != BLANK_RECORDING_BYTES
        || metadata.bundle_sha256
            != host_template_bundle_sha256(
                &metadata.cloud_hypervisor.sha256,
                &metadata.jailer.sha256,
                &metadata.blank_recording.sha256,
            )
    {
        bail!("host template metadata identity is invalid")
    }
    let bundle = open_host_template_bundle(config, metadata)?;
    for (name, artifact, label) in [
        (
            c"cloud-hypervisor" as &CStr,
            &metadata.cloud_hypervisor,
            "Cloud Hypervisor template",
        ),
        (
            c"intar-jailer" as &CStr,
            &metadata.jailer,
            "jailer template",
        ),
        (
            c"recordings.vfat" as &CStr,
            &metadata.blank_recording,
            "blank recording template",
        ),
    ] {
        let fd = open_lifecycle_entry_at(&bundle, name, OFlags::RDONLY)
            .with_context(|| format!("open {label}"))?;
        let file = File::from(fd);
        validate_host_template_artifact_metadata(&file.metadata()?, artifact, label)?;
        if name == c"recordings.vfat" {
            let filesystem = fatfs::FileSystem::new(file, fatfs::FsOptions::new())
                .context("open blank recording template filesystem")?;
            if filesystem.volume_id() != BLANK_RECORDING_VOLUME_ID
                || filesystem.volume_label_as_bytes() != BLANK_RECORDING_DISPLAY_LABEL
                || filesystem.read_volume_label_from_root_dir_as_bytes()?
                    != Some(BLANK_RECORDING_LABEL)
            {
                bail!("blank recording template VFAT identity is invalid")
            }
        }
    }
    Ok(())
}

fn validate_host_template(config: &JailerdConfig, expected: &HostTemplateMetadataV2) -> Result<()> {
    let pointer = read_optional_host_template_metadata(config)?
        .context("root-owned host template pointer is missing")?;
    if &pointer != expected {
        bail!("root-owned host template pointer changed after readiness")
    }
    validate_host_template_bundle(config, &pointer)?;
    if pointer.cloud_hypervisor.sha256 != config.cloud_hypervisor_sha256 {
        bail!("host runtime template differs from the configured Cloud Hypervisor pin")
    }
    validate_runtime_source_identity(
        &config.cloud_hypervisor_binary,
        &pointer.cloud_hypervisor_source,
    )?;
    validate_runtime_source_identity(&config.jailer_binary, &pointer.jailer_source)?;
    Ok(())
}

fn source_was_atomically_replaced(
    current: &SourceFileIdentityV2,
    previous: &SourceFileIdentityV2,
    label: &str,
) -> Result<bool> {
    if current == previous {
        return Ok(false);
    }
    if current.device == previous.device && current.inode == previous.inode {
        bail!("{label} changed in place; refusing to rotate its pinned host template")
    }
    Ok(true)
}

fn host_runtime_sources_were_replaced(
    config: &JailerdConfig,
    previous: &HostTemplateMetadataV2,
) -> Result<bool> {
    let cloud = open_trusted_runtime_source(&config.cloud_hypervisor_binary)?;
    let jailer = open_trusted_runtime_source(&config.jailer_binary)?;
    let cloud_replaced = source_was_atomically_replaced(
        &source_file_identity(&cloud.metadata()?),
        &previous.cloud_hypervisor_source,
        "Cloud Hypervisor source",
    )?;
    let jailer_replaced = source_was_atomically_replaced(
        &source_file_identity(&jailer.metadata()?),
        &previous.jailer_source,
        "jailer source",
    )?;
    Ok(cloud_replaced || jailer_replaced)
}

fn write_root_owned_json<T: Serialize>(
    parent: &impl std::os::fd::AsFd,
    name: &CStr,
    value: &T,
    label: &str,
) -> Result<()> {
    let fd = rustix::fs::openat(
        parent,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR,
    )?;
    let mut file = File::from(fd);
    to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    rustix::fs::fchmod(&file, Mode::RUSR)?;
    rustix::fs::fchown(
        &file,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    file.sync_all()?;
    validate_root_regular_file(&file, label)?;
    Ok(())
}

fn prepare_or_validate_host_template(config: &JailerdConfig) -> Result<HostTemplateMetadataV2> {
    let previous = match read_optional_host_template_metadata(config)? {
        Some(metadata) => match validate_host_template(config, &metadata) {
            Ok(()) => return Ok(metadata),
            Err(validation_error) => {
                // A normal package upgrade atomically replaces root-owned
                // binaries. Rotate only when the old pointer and bundle are
                // themselves intact and at least one trusted source has a new
                // inode. Same-inode mutation and malformed/tampered template
                // state remain fail-closed.
                validate_host_template_bundle(config, &metadata)
                    .context("existing host template is not safe to rotate")?;
                if !host_runtime_sources_were_replaced(config, &metadata)? {
                    return Err(validation_error)
                        .context("host template validation failed without a package replacement");
                }
                Some(metadata)
            }
        },
        None => None,
    };

    let jail_root = trusted_jail_root_fd(config)?;
    let templates = ensure_root_directory_at(&jail_root, c"templates")?;
    let host = ensure_root_directory_at(&templates, c"host-v2")?;
    let temporary_name = format!(".prepare-{}", Uuid::new_v4());
    rustix::fs::mkdirat(
        &host,
        temporary_name.as_str(),
        Mode::RUSR | Mode::WUSR | Mode::XUSR,
    )
    .context("create temporary host template bundle")?;
    let temporary = config
        .jail_root
        .join("templates")
        .join(HOST_TEMPLATE_DIRECTORY)
        .join(&temporary_name);
    let pointer_temporary_name = format!(".{HOST_TEMPLATE_POINTER}-{}", Uuid::new_v4());
    let operation = (|| -> Result<HostTemplateMetadataV2> {
        let (cloud_hypervisor_source, cloud_hypervisor) = copy_runtime_template_source(
            &config.cloud_hypervisor_binary,
            &temporary.join("cloud-hypervisor"),
            Some(&config.cloud_hypervisor_sha256),
        )?;
        let (jailer_source, jailer) = copy_runtime_template_source(
            &config.jailer_binary,
            &temporary.join("intar-jailer"),
            None,
        )?;
        let blank_recording = create_blank_recording_template(&temporary.join("recordings.vfat"))?;
        let mut metadata = HostTemplateMetadataV2 {
            schema_version: HOST_TEMPLATE_METADATA_VERSION,
            bundle_sha256: host_template_bundle_sha256(
                &cloud_hypervisor.sha256,
                &jailer.sha256,
                &blank_recording.sha256,
            ),
            cloud_hypervisor_source,
            jailer_source,
            cloud_hypervisor,
            jailer,
            blank_recording,
        };
        let temporary_fd = open_lifecycle_entry_at(
            &host,
            temporary_name.as_str(),
            OFlags::RDONLY | OFlags::DIRECTORY,
        )?;
        validate_root_directory(&temporary_fd, "temporary host template bundle")?;
        write_root_owned_json(
            &temporary_fd,
            c"metadata-v2.json",
            &HostTemplateBundleMetadataV2::from(&metadata),
            "new host template bundle metadata",
        )?;
        let bundle_name = CString::new(metadata.bundle_sha256.as_str())?;
        match rustix::fs::renameat(&host, temporary_name.as_str(), &host, &bundle_name) {
            Ok(()) => {}
            Err(rustix::io::Errno::EXIST | rustix::io::Errno::NOTEMPTY) => {
                std::fs::remove_dir_all(&temporary)?;
                let (_, existing) = read_host_template_bundle(config, &metadata.bundle_sha256)
                    .context("open existing content-addressed host template")?;
                if existing.schema_version != HOST_TEMPLATE_METADATA_VERSION
                    || existing.bundle_sha256 != metadata.bundle_sha256
                    || existing.cloud_hypervisor.sha256 != metadata.cloud_hypervisor.sha256
                    || existing.jailer.sha256 != metadata.jailer.sha256
                    || existing.blank_recording.sha256 != metadata.blank_recording.sha256
                {
                    bail!("existing content-addressed host template has mismatched digests")
                }
                // The same content may be reached after an atomic package
                // reinstall. Reuse the already durable template inodes while
                // pinning the replacement source identities in the new
                // pointer.
                metadata.cloud_hypervisor = existing.cloud_hypervisor;
                metadata.jailer = existing.jailer;
                metadata.blank_recording = existing.blank_recording;
                validate_host_template_bundle(config, &metadata)
                    .context("validate existing content-addressed host template")?;
            }
            Err(error) => return Err(error).context("publish content-addressed host template"),
        }
        // Make the complete content-addressed bundle durable before any
        // reader can observe a pointer to it.
        #[cfg(target_os = "linux")]
        rustix::fs::syncfs(&host).context("sync content-addressed host template bundle")?;
        #[cfg(not(target_os = "linux"))]
        File::open(
            config
                .jail_root
                .join("templates")
                .join(HOST_TEMPLATE_DIRECTORY),
        )?
        .sync_all()?;

        let pointer_name = CString::new(HOST_TEMPLATE_POINTER)?;
        let pointer_temporary = CString::new(pointer_temporary_name.as_str())?;
        write_root_owned_json(
            &templates,
            &pointer_temporary,
            &metadata,
            "new host template pointer",
        )
        .context("write next host template pointer")?;
        let current = read_optional_host_template_metadata(config)?;
        if current.as_ref() != previous.as_ref() {
            bail!("host template pointer changed during atomic rotation")
        }
        rustix::fs::renameat(&templates, &pointer_temporary, &templates, &pointer_name)
            .context("atomically publish host template pointer")?;
        rustix::fs::fsync(&templates).context("sync host template pointer directory")?;
        #[cfg(target_os = "linux")]
        rustix::fs::syncfs(&templates).context("sync host template store")?;
        #[cfg(not(target_os = "linux"))]
        File::open(config.jail_root.join("templates"))?.sync_all()?;
        Ok(metadata)
    })();
    if operation.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
        let _ = rustix::fs::unlinkat(
            &templates,
            pointer_temporary_name.as_str(),
            rustix::fs::AtFlags::empty(),
        );
    }
    let metadata = operation?;
    validate_host_template(config, &metadata)?;
    Ok(metadata)
}

fn open_host_template_artifact(
    config: &JailerdConfig,
    metadata: &HostTemplateMetadataV2,
    name: &CStr,
) -> Result<File> {
    let expected = match name.to_bytes() {
        b"cloud-hypervisor" => &metadata.cloud_hypervisor,
        b"intar-jailer" => &metadata.jailer,
        b"recordings.vfat" => &metadata.blank_recording,
        _ => bail!("host template artifact name is not allowed"),
    };
    let bundle = open_host_template_bundle(config, metadata)?;
    let fd = open_lifecycle_entry_at(&bundle, name, OFlags::RDONLY)?;
    let file = File::from(fd);
    validate_host_template_artifact_metadata(
        &file.metadata()?,
        expected,
        "host template artifact",
    )?;
    Ok(file)
}

fn open_template_metadata(
    image_directory: &impl std::os::fd::AsFd,
) -> Result<ImageTemplateMetadataV2> {
    let bytes = read_root_metadata_at(image_directory, c"metadata-v2.json")?;
    serde_json::from_slice(&bytes).context("decode prepared image metadata")
}

fn validate_existing_image_template(
    config: &JailerdConfig,
    request: &PrepareImageV2Request,
) -> Result<ImageTemplateMetadataV2> {
    let jail_root = trusted_jail_root_fd(config)?;
    let templates = open_optional_root_directory_at(&jail_root, c"templates")?
        .context("prepared image template root is missing")?;
    let image_name = CString::new(request.image_sha256.as_str()).expect("SHA-256 contains no NUL");
    let image_directory =
        open_lifecycle_entry_at(&templates, &image_name, OFlags::RDONLY | OFlags::DIRECTORY)
            .context("open prepared image template")?;
    validate_root_directory(&image_directory, "prepared image template")?;
    let metadata = open_template_metadata(&image_directory)?;
    if !request_template_identity_matches(request, &metadata) {
        bail!("prepared image identity or hash metadata does not match the request")
    }
    for (name, expected, label) in [
        (
            c"root.raw" as &CStr,
            &metadata.root_disk,
            "template root disk",
        ),
        (c"kernel" as &CStr, &metadata.kernel, "template kernel"),
    ] {
        let file = open_lifecycle_entry_at(&image_directory, name, OFlags::RDONLY)
            .with_context(|| format!("open {label}"))?;
        let stat = rustix::fs::fstat(&file)?;
        validate_template_artifact_stat(&stat, expected, label)?;
    }
    match &metadata.initrd {
        Some(expected) => {
            let file = open_lifecycle_entry_at(&image_directory, c"initrd", OFlags::RDONLY)
                .context("open template initrd")?;
            validate_template_artifact_stat(
                &rustix::fs::fstat(&file)?,
                expected,
                "template initrd",
            )?;
        }
        None => {
            if open_lifecycle_entry_at(&image_directory, c"initrd", OFlags::RDONLY).is_ok() {
                bail!("prepared image unexpectedly contains an initrd")
            }
        }
    }
    if metadata.root_disk.bytes != request.virtual_size_bytes {
        bail!("prepared root disk size does not match the advertised virtual size")
    }
    Ok(metadata)
}

fn validate_prepared_launch_template(
    config: &JailerdConfig,
    request: &LaunchVmV2Request,
) -> Result<()> {
    // Reuse the root-owned metadata and inode validation path. Access is not
    // consulted here: LaunchVmV2Request::validate has already enforced the
    // distinct launch-time access modes for root, kernel, and initrd.
    let identity = PrepareImageV2Request {
        image_sha256: request.image_sha256.clone(),
        virtual_size_bytes: request.virtual_size_bytes,
        root_disk: request.launch.artifacts.root_disk.clone(),
        kernel: request.launch.artifacts.kernel.clone(),
        initrd: request.launch.artifacts.initrd.clone(),
    };
    let metadata = validate_existing_image_template(config, &identity)?;
    let expected = prepared_image_result(&metadata);
    if request.launch.artifacts.root_disk != expected.root_disk
        || request.launch.artifacts.kernel != expected.kernel
        || request.launch.artifacts.initrd != expected.initrd
    {
        bail!("prepared launch descriptors do not match root-owned template metadata")
    }
    Ok(())
}

fn copy_template_source(
    config: &JailerdConfig,
    source: &ArtifactSource,
    destination: &Path,
    expected_bytes: Option<u64>,
) -> Result<ImageTemplateArtifactV2> {
    use std::os::unix::fs::MetadataExt as _;

    let expected = source
        .sha256
        .as_ref()
        .context("prepared image source digest is missing")?;
    let mut input = open_trusted_source(config, source.source_root, &source.relative_path)?;
    let before = input.metadata().context("stat prepared image source")?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(destination)
        .with_context(|| format!("create image template artifact {}", destination.display()))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = input
            .read(&mut buffer)
            .context("read prepared image source")?;
        if length == 0 {
            break;
        }
        bytes = bytes
            .checked_add(length as u64)
            .context("prepared image size overflow")?;
        hasher.update(&buffer[..length]);
        if buffer[..length].iter().all(|byte| *byte == 0) {
            output.seek(SeekFrom::Current(length as i64))?;
        } else {
            output.write_all(&buffer[..length])?;
        }
    }
    output.set_len(bytes)?;
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    let actual = Sha256Digest::parse(encoded).expect("SHA-256 encoder is canonical");
    if &actual != expected {
        bail!(
            "source SHA-256 mismatch: expected {}, got {}",
            expected.as_str(),
            actual.as_str()
        )
    }
    if expected_bytes.is_some_and(|expected| expected != bytes) {
        bail!("prepared image source size does not match advertised virtual size")
    }
    rustix::fs::fchmod(&output, Mode::RUSR)?;
    rustix::fs::fchown(
        &output,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    let after = input.metadata().context("restat prepared image source")?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
        || after.nlink() != 1
    {
        bail!("prepared image source changed while it was imported")
    }
    let stat = rustix::fs::fstat(&output)?;
    let artifact = ImageTemplateArtifactV2 {
        sha256: actual,
        bytes,
        device: stat.st_dev as u64,
        inode: stat.st_ino,
    };
    validate_template_artifact_stat(&stat, &artifact, "new image template artifact")?;
    Ok(artifact)
}

fn prepare_image_template(
    config: &JailerdConfig,
    request: &PrepareImageV2Request,
) -> Result<PreparedImageV2Result> {
    request
        .validate()
        .context("validate prepared image request")?;
    if validate_existing_image_template(config, request).is_ok() {
        let metadata = validate_existing_image_template(config, request)?;
        return Ok(prepared_image_result(&metadata));
    }

    let jail_root = trusted_jail_root_fd(config)?;
    let templates = ensure_root_directory_at(&jail_root, c"templates")?;
    let image_name = CString::new(request.image_sha256.as_str()).expect("SHA-256 contains no NUL");
    let lock_name = CString::new(format!(".lock-{}", request.image_sha256.as_str()))
        .expect("SHA-256 lock name contains no NUL");
    let lock_fd = rustix::fs::openat(
        &templates,
        &lock_name,
        OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )
    .context("open prepared image single-flight lock")?;
    rustix::fs::fchmod(&lock_fd, Mode::RUSR | Mode::WUSR)?;
    rustix::fs::fchown(
        &lock_fd,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    validate_root_regular_file(&lock_fd, "prepared image single-flight lock")?;
    rustix::fs::flock(&lock_fd, rustix::fs::FlockOperation::LockExclusive)
        .context("lock prepared image single-flight")?;
    // Another client may have completed the same import while this request
    // waited on the per-image filesystem lock.
    if let Ok(metadata) = validate_existing_image_template(config, request) {
        return Ok(prepared_image_result(&metadata));
    }
    match rustix::fs::statat(
        &templates,
        &image_name,
        rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
    ) {
        Ok(_) => {
            // Existing root-owned state is never overwritten based on an
            // unprivileged request. Surface the validation failure instead.
            let metadata = validate_existing_image_template(config, request)?;
            return Ok(prepared_image_result(&metadata));
        }
        Err(error) if error == rustix::io::Errno::NOENT => {}
        Err(error) => return Err(error).context("inspect prepared image template"),
    }

    let temporary_name = format!(".prepare-{}", Uuid::new_v4());
    let temporary = config.jail_root.join("templates").join(&temporary_name);
    rustix::fs::mkdirat(
        &templates,
        temporary_name.as_str(),
        Mode::RUSR | Mode::WUSR | Mode::XUSR,
    )
    .context("create temporary image template")?;
    let operation = (|| -> Result<ImageTemplateMetadataV2> {
        let root_disk = copy_template_source(
            config,
            &request.root_disk,
            &temporary.join("root.raw"),
            Some(request.virtual_size_bytes),
        )?;
        let kernel =
            copy_template_source(config, &request.kernel, &temporary.join("kernel"), None)?;
        let initrd = request
            .initrd
            .as_ref()
            .map(|source| copy_template_source(config, source, &temporary.join("initrd"), None))
            .transpose()?;
        let metadata = ImageTemplateMetadataV2 {
            schema_version: IMAGE_TEMPLATE_METADATA_VERSION,
            image_sha256: request.image_sha256.clone(),
            virtual_size_bytes: request.virtual_size_bytes,
            root_disk,
            kernel,
            initrd,
        };
        let mut metadata_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o400)
            .open(temporary.join("metadata-v2.json"))?;
        to_writer(&mut metadata_file, &metadata)?;
        metadata_file.write_all(b"\n")?;
        rustix::fs::fchmod(&metadata_file, Mode::RUSR)?;
        rustix::fs::fchown(
            &metadata_file,
            Some(rustix::process::Uid::ROOT),
            Some(rustix::process::Gid::ROOT),
        )?;
        rustix::fs::renameat(&templates, temporary_name.as_str(), &templates, &image_name)
            .context("publish prepared image template")?;
        // Preparation is intentionally outside launch. One filesystem-wide
        // durability barrier replaces per-artifact syncs on this cold path.
        #[cfg(target_os = "linux")]
        rustix::fs::syncfs(&templates).context("sync prepared image template store")?;
        #[cfg(not(target_os = "linux"))]
        File::open(config.jail_root.join("templates"))?.sync_all()?;
        Ok(metadata)
    })();
    if operation.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    let metadata = operation?;
    let validated = validate_existing_image_template(config, request)?;
    if validated != metadata {
        bail!("published image template metadata changed during validation")
    }
    Ok(prepared_image_result(&validated))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TrustedDirectoryIdentity {
    device: u64,
    inode: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FastTemplateStoreAttestation {
    template_store: TrustedDirectoryIdentity,
    generation_store: TrustedDirectoryIdentity,
    allowed_source_roots: Vec<TrustedDirectoryIdentity>,
}

#[cfg(any(target_os = "linux", test))]
impl FastTemplateStoreAttestation {
    fn covers_allowed_source_roots(&self, config: &JailerdConfig) -> bool {
        self.allowed_source_roots.len() == config.allowed_source_roots.len()
    }
}

#[cfg(target_os = "linux")]
fn trusted_directory_identity(
    directory: &impl std::os::fd::AsFd,
) -> Result<TrustedDirectoryIdentity> {
    let stat = rustix::fs::fstat(directory)?;
    Ok(TrustedDirectoryIdentity {
        device: stat.st_dev as u64,
        inode: stat.st_ino as u64,
    })
}

#[cfg(target_os = "linux")]
fn open_trusted_source_root_fd(config: &JailerdConfig, path: &Path) -> Result<OwnedFd> {
    ensure!(
        path_is_trusted_source_root(path, config.agent_uid, config.agent_gid),
        "configured artifact source root is not trusted: {}",
        path.display()
    );
    let directory = open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open configured artifact source root {}", path.display()))?;
    let stat = rustix::fs::fstat(&directory)?;
    ensure!(
        rustix::fs::FileType::from_raw_mode(stat.st_mode) == rustix::fs::FileType::Directory
            && (stat.st_uid == 0 || stat.st_uid == config.agent_uid)
            && (stat.st_gid == 0 || stat.st_gid == config.agent_gid)
            && stat.st_mode & 0o002 == 0,
        "configured artifact source root identity changed: {}",
        path.display()
    );
    Ok(directory)
}

/// Prove the exact route used by v2 launch staging. The anonymous source inode
/// is root-owned and never receives a directory entry, while the clone lives
/// under a pinned, root-owned generation-store fd and is removed fd-relatively.
/// This makes the readiness probe safe even when the source directory belongs
/// to the unprivileged agent.
#[cfg(target_os = "linux")]
fn probe_exact_reflink_route(
    source_directory: &impl std::os::fd::AsFd,
    generation_store: &impl std::os::fd::AsFd,
    label: &str,
) -> Result<()> {
    use std::os::fd::AsRawFd as _;

    let source_fd = rustix::fs::openat(
        source_directory,
        c".",
        OFlags::RDWR | OFlags::TMPFILE | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )
    .with_context(|| format!("create anonymous root-owned {label} reflink probe"))?;
    let mut source = File::from(source_fd);
    source.write_all(b"intar-v2-exact-reflink-probe")?;
    rustix::fs::fchmod(&source, Mode::RUSR)?;
    rustix::fs::fchown(
        &source,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::ROOT),
    )?;
    let source_stat = rustix::fs::fstat(&source)?;
    ensure!(
        rustix::fs::FileType::from_raw_mode(source_stat.st_mode)
            == rustix::fs::FileType::RegularFile
            && source_stat.st_uid == 0
            && source_stat.st_gid == 0
            && source_stat.st_nlink == 0
            && source_stat.st_mode & 0o777 == 0o400,
        "anonymous {label} reflink probe did not retain root-only identity"
    );

    let clone_name = format!(".reflink-route-probe-{}", Uuid::new_v4());
    let source_path = PathBuf::from(format!("/proc/self/fd/{}", source.as_raw_fd()));
    let destination_path = PathBuf::from(format!(
        "/proc/self/fd/{}/{}",
        generation_store.as_fd().as_raw_fd(),
        clone_name
    ));
    let operation = (|| -> Result<()> {
        // Exact clone only. An EXDEV/EOPNOTSUPP result withdraws the entire v2
        // capability; this path must never fall back to byte copying.
        reflink_copy::reflink(&source_path, &destination_path).with_context(|| {
            format!("{label} cannot exact-reflink into the jail generation store")
        })?;
        let destination =
            open_lifecycle_entry_at(generation_store, clone_name.as_str(), OFlags::RDONLY)
                .with_context(|| format!("open cloned {label} reflink probe"))?;
        let destination_stat = rustix::fs::fstat(&destination)?;
        ensure!(
            rustix::fs::FileType::from_raw_mode(destination_stat.st_mode)
                == rustix::fs::FileType::RegularFile
                && destination_stat.st_uid == 0
                && destination_stat.st_gid == 0
                && destination_stat.st_nlink == 1
                && destination_stat.st_mode & 0o777 == 0o400
                && source_stat.st_dev == destination_stat.st_dev
                && source_stat.st_ino != destination_stat.st_ino
                && source_stat.st_size == destination_stat.st_size,
            "{label} reflink probe violated clone identity invariants"
        );
        Ok(())
    })();
    if operation.is_ok() {
        rustix::fs::unlinkat(
            generation_store,
            clone_name.as_str(),
            rustix::fs::AtFlags::empty(),
        )
        .with_context(|| format!("remove cloned {label} reflink probe"))?;
    } else {
        let _ = rustix::fs::unlinkat(
            generation_store,
            clone_name.as_str(),
            rustix::fs::AtFlags::empty(),
        );
    }
    operation
}

#[cfg(target_os = "linux")]
fn probe_fast_template_store(config: &JailerdConfig) -> Result<FastTemplateStoreAttestation> {
    let jail_root = trusted_jail_root_fd(config)?;
    let templates = ensure_root_directory_at(&jail_root, c"templates")?;
    let generation_store = ensure_root_directory_at(&jail_root, c"cloud-hypervisor")?;

    probe_exact_reflink_route(&templates, &generation_store, "root-owned template store")?;
    let mut allowed_source_roots = Vec::with_capacity(config.allowed_source_roots.len());
    for (index, path) in config.allowed_source_roots.iter().enumerate() {
        let source = open_trusted_source_root_fd(config, path)?;
        probe_exact_reflink_route(
            &source,
            &generation_store,
            &format!("allowed source root {index} ({})", path.display()),
        )?;
        allowed_source_roots.push(trusted_directory_identity(&source)?);
    }

    Ok(FastTemplateStoreAttestation {
        template_store: trusted_directory_identity(&templates)?,
        generation_store: trusted_directory_identity(&generation_store)?,
        allowed_source_roots,
    })
}

#[cfg(not(target_os = "linux"))]
fn probe_fast_template_store(_config: &JailerdConfig) -> Result<FastTemplateStoreAttestation> {
    bail!("exact v2 reflink readiness attestation is supported only on Linux")
}

#[cfg(target_os = "linux")]
fn validate_fast_template_store_attestation(
    config: &JailerdConfig,
    attestation: &FastTemplateStoreAttestation,
) -> Result<()> {
    ensure!(
        attestation.covers_allowed_source_roots(config),
        "configured source-root set changed after exact-reflink readiness"
    );
    let jail_root = trusted_jail_root_fd(config)?;
    let templates =
        open_lifecycle_entry_at(&jail_root, c"templates", OFlags::RDONLY | OFlags::DIRECTORY)
            .context("open attested template store")?;
    validate_root_directory(&templates, "attested template store")?;
    let generation_store = open_lifecycle_entry_at(
        &jail_root,
        c"cloud-hypervisor",
        OFlags::RDONLY | OFlags::DIRECTORY,
    )
    .context("open attested generation store")?;
    validate_root_directory(&generation_store, "attested generation store")?;
    ensure!(
        trusted_directory_identity(&templates)? == attestation.template_store
            && trusted_directory_identity(&generation_store)? == attestation.generation_store,
        "jail template or generation filesystem identity changed after exact-reflink readiness"
    );
    for ((index, path), expected) in config
        .allowed_source_roots
        .iter()
        .enumerate()
        .zip(&attestation.allowed_source_roots)
    {
        let source = open_trusted_source_root_fd(config, path)?;
        ensure!(
            trusted_directory_identity(&source)? == *expected,
            "allowed source root {index} ({}) changed after exact-reflink readiness",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn validate_fast_template_store_attestation(
    _config: &JailerdConfig,
    _attestation: &FastTemplateStoreAttestation,
) -> Result<()> {
    bail!("exact v2 reflink readiness attestation is supported only on Linux")
}

fn prepare_jail_files(
    config: &JailerdConfig,
    request: &VmLaunchRequest,
    run_network: &RunNetworkResult,
    generation: &ValidatedId,
    uid: u32,
    gid: u32,
    host_template: Option<&HostTemplateMetadataV2>,
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
        let vmm_executable_identity = match host_template {
            Some(metadata) => {
                stage_prepared_template_source_file(
                    open_host_template_artifact(config, metadata, c"cloud-hypervisor")?,
                    &root.join("cloud-hypervisor"),
                    0o555,
                )?;
                stage_prepared_template_source_file(
                    open_host_template_artifact(config, metadata, c"intar-jailer")?,
                    &root.join("intar-jailer"),
                    0o555,
                )?;
                stage_artifacts_v2(
                    config,
                    &request.artifacts,
                    request.root_disk_size_bytes,
                    &root,
                    uid,
                    gid,
                    metadata,
                )?;
                Some(runtime_file_identity(&std::fs::metadata(
                    root.join("cloud-hypervisor"),
                )?))
            }
            None => {
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
                None
            }
        };
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
        apply_agent_acls(config, generation, uid, gid)?;

        if run_network.namespace_name.is_empty()
            || run_network.namespace_name.len() > 64
            || !run_network
                .namespace_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            bail!("invalid derived network namespace name")
        }
        let netns_path = config.netns_root.join(&run_network.namespace_name);
        let spec = JailSpecV1 {
            version: PROTOCOL_VERSION,
            generation: generation.clone(),
            uid,
            gid,
            jail_root: root.clone(),
            netns_path,
            netns_inode: run_network.namespace_inode,
            nofile_limit: 2_048,
            file_size_limit: config.vmm_file_size_limit_bytes,
        };
        spec.validate().context("validate root-owned jail spec")?;
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
            vmm_executable_identity,
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

fn stage_artifacts_v2(
    config: &JailerdConfig,
    artifacts: &SourceArtifacts,
    root_disk_size_bytes: u64,
    root: &Path,
    uid: u32,
    gid: u32,
    host_template: &HostTemplateMetadataV2,
) -> Result<()> {
    validate_template_launch_sources(artifacts)?;
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
    let root_disk_path = root.join("disks/root.raw");
    let template_size = std::fs::metadata(&root_disk_path)?.len();
    ensure!(
        root_disk_size_bytes >= template_size,
        "generation root disk cannot be smaller than its prepared template"
    );
    if root_disk_size_bytes > template_size {
        OpenOptions::new()
            .write(true)
            .open(&root_disk_path)
            .context("open cloned generation root disk for expansion")?
            .set_len(root_disk_size_bytes)
            .context("expand cloned generation root disk")?;
    }
    // Runtime state remains per-VM and read-only, but the recording disk is a
    // preformatted root-owned blank. Its agent descriptor is retained solely
    // as the trusted export destination after the cgroup drains.
    artifacts
        .runtime_disk
        .validate()
        .context("validate per-run runtime disk descriptor")?;
    ensure!(
        artifacts.runtime_disk.source_root != PREPARED_IMAGE_SOURCE_ROOT
            && artifacts.runtime_disk.access == ArtifactAccess::ReadOnly,
        "v2 runtime disk must be an agent-owned read-only source"
    );
    let runtime_source = open_trusted_source(
        config,
        artifacts.runtime_disk.source_root,
        &artifacts.runtime_disk.relative_path,
    )?;
    // Runtime configuration is unique per VM but immutable after publication.
    // Clone its extents exactly instead of copying and syncing 16 MiB on every
    // launch; a cross-filesystem host is not fast-launch eligible and fails.
    stage_prepared_template_source_file(runtime_source, &root.join("disks/runtime.raw"), 0o444)?;
    stage_prepared_template_source_file(
        open_host_template_artifact(config, host_template, c"recordings.vfat")?,
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

fn stage_artifacts(
    config: &JailerdConfig,
    artifacts: &SourceArtifacts,
    root: &Path,
    uid: u32,
    gid: u32,
) -> Result<()> {
    validate_template_launch_sources(artifacts)?;
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
    if source.source_root == PREPARED_IMAGE_SOURCE_ROOT {
        let source_file = open_prepared_template_source(config, source)?;
        return stage_prepared_template_source_file(source_file, destination, mode);
    }
    let source_file = open_trusted_source(config, source.source_root, &source.relative_path)?;
    stage_source_file(
        source_file,
        destination,
        mode,
        source.sha256.as_ref(),
        &source.access,
    )
}

fn template_source_image(source: &ArtifactSource) -> Option<&str> {
    if source.source_root != PREPARED_IMAGE_SOURCE_ROOT {
        return None;
    }
    let mut components = source.relative_path.components();
    let image = match components.next()? {
        std::path::Component::Normal(value) => value.to_str()?,
        _ => return None,
    };
    let _file = match components.next()? {
        std::path::Component::Normal(value) => value,
        _ => return None,
    };
    components.next().is_none().then_some(image)
}

fn validate_template_launch_sources(artifacts: &SourceArtifacts) -> Result<()> {
    let root_template = template_source_image(&artifacts.root_disk);
    let kernel_template = template_source_image(&artifacts.kernel);
    let initrd_template = artifacts.initrd.as_ref().and_then(template_source_image);
    let has_any_template = root_template.is_some()
        || kernel_template.is_some()
        || initrd_template.is_some()
        || artifacts.runtime_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
        || artifacts.recording_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT;
    if !has_any_template {
        return Ok(());
    }
    let image = root_template.context("template-backed launch requires a prepared root disk")?;
    if kernel_template != Some(image)
        || artifacts
            .initrd
            .as_ref()
            .is_some_and(|_| initrd_template != Some(image))
        || artifacts.runtime_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
        || artifacts.recording_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
    {
        bail!(
            "template-backed launch must use one prepared boot bundle and agent-owned runtime disks"
        )
    }
    Ok(())
}

fn open_prepared_template_source(config: &JailerdConfig, source: &ArtifactSource) -> Result<File> {
    source
        .validate()
        .context("validate prepared template source")?;
    let mut components = source.relative_path.components();
    let image_component = match components.next() {
        Some(std::path::Component::Normal(value)) => value,
        _ => bail!("prepared template source is missing its image identity"),
    };
    let file_component = match components.next() {
        Some(std::path::Component::Normal(value)) => value,
        _ => bail!("prepared template source is missing its artifact name"),
    };
    if components.next().is_some() {
        bail!("prepared template source path has unexpected components")
    }
    let image_sha256 = Sha256Digest::parse(
        image_component
            .to_str()
            .context("prepared template image identity is not UTF-8")?
            .to_owned(),
    )?;
    let file_name = file_component
        .to_str()
        .context("prepared template artifact name is not UTF-8")?;
    let jail_root = trusted_jail_root_fd(config)?;
    let templates = open_optional_root_directory_at(&jail_root, c"templates")?
        .context("prepared image template root is missing")?;
    let image_name = CString::new(image_sha256.as_str()).expect("SHA-256 contains no NUL");
    let image_directory =
        open_lifecycle_entry_at(&templates, &image_name, OFlags::RDONLY | OFlags::DIRECTORY)
            .context("open root-owned image template")?;
    validate_root_directory(&image_directory, "root-owned image template")?;
    let metadata = open_template_metadata(&image_directory)?;
    if metadata.schema_version != IMAGE_TEMPLATE_METADATA_VERSION
        || metadata.image_sha256 != image_sha256
    {
        bail!("prepared image template metadata identity mismatch")
    }
    let (expected, expected_access) = match file_name {
        "root.raw" => (&metadata.root_disk, ArtifactAccess::ReadWrite),
        "kernel" => (&metadata.kernel, ArtifactAccess::ReadOnly),
        "initrd" => (
            metadata
                .initrd
                .as_ref()
                .context("prepared image does not contain an initrd")?,
            ArtifactAccess::ReadOnly,
        ),
        _ => bail!("prepared template artifact name is not allowed"),
    };
    if source.access != expected_access || source.sha256.as_ref() != Some(&expected.sha256) {
        bail!("prepared template source access or digest does not match root-owned metadata")
    }
    let file_name = CString::new(file_name).expect("fixed artifact names contain no NUL");
    let fd = open_lifecycle_entry_at(&image_directory, &file_name, OFlags::RDONLY)
        .context("open root-owned template artifact")?;
    validate_template_artifact_stat(
        &rustix::fs::fstat(&fd)?,
        expected,
        "root-owned template artifact",
    )?;
    Ok(File::from(fd))
}

fn stage_prepared_template_source_file(source: File, destination: &Path, mode: u32) -> Result<()> {
    use std::os::fd::AsRawFd as _;
    use std::os::unix::fs::MetadataExt as _;

    let before = source
        .metadata()
        .context("stat root-owned template source")?;
    let temporary = destination.with_file_name(format!(
        ".{}-reflink-{}",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .context("template destination name is not UTF-8")?,
        Uuid::new_v4()
    ));
    let source_path = PathBuf::from(format!("/proc/self/fd/{}", source.as_raw_fd()));
    let operation = (|| -> Result<()> {
        // Exact reflink only: the template capability must never degrade into
        // a multi-GiB copy on the VM launch path.
        reflink_copy::reflink(&source_path, &temporary)
            .with_context(|| format!("clone prepared template to {}", destination.display()))?;
        set_mode(&temporary, mode)?;
        let after = source
            .metadata()
            .context("restat root-owned template source")?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || after.nlink() != 1
        {
            bail!("root-owned template source changed while it was cloned")
        }
        let cloned = std::fs::metadata(&temporary)?;
        if !cloned.is_file()
            || cloned.nlink() != 1
            || cloned.dev() != before.dev()
            || cloned.ino() == before.ino()
            || cloned.len() != before.len()
        {
            bail!("prepared template clone did not preserve filesystem identity invariants")
        }
        std::fs::rename(&temporary, destination)
            .with_context(|| format!("publish cloned template {}", destination.display()))?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    operation
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
            reflink_open_file_exact(&mut source, &temporary)?;
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
fn reflink_open_file_exact(source: &mut File, destination: &Path) -> Result<()> {
    use std::os::fd::AsRawFd as _;

    let source_path = PathBuf::from(format!("/proc/self/fd/{}", source.as_raw_fd()));
    reflink_copy::reflink(&source_path, destination)
        .with_context(|| format!("exact-reflink staged disk {}", destination.display()))?;
    File::open(destination)?.sync_all()?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn reflink_open_file_exact(_source: &mut File, _destination: &Path) -> Result<()> {
    bail!("exact-reflink disk staging is supported only on Linux")
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
fn trusted_setfacl_binary() -> Result<PathBuf> {
    let setfacl = ["/usr/bin/setfacl", "/usr/sbin/setfacl"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path_is_root_trusted(path, false))
        .context("trusted setfacl binary is required")?;
    Ok(setfacl)
}

#[cfg(target_os = "linux")]
struct PinnedAclTarget {
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
    fn directory(
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

    fn regular_file(
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

    fn new(
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

    fn proc_fd_path(&self) -> PathBuf {
        use std::os::fd::AsRawFd as _;

        PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            self.fd.as_raw_fd()
        ))
    }

    fn attest_after(&self) -> Result<()> {
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
struct SetfaclEdit {
    acl: String,
    paths: Vec<PathBuf>,
}

#[cfg(any(target_os = "linux", test))]
fn agent_acl_edits(
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
fn is_pinned_proc_fd_path(path: &Path) -> bool {
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
fn setfacl_batch_arguments(edits: &[SetfaclEdit]) -> Result<Vec<OsString>> {
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
fn run_setfacl_batch(program: &Path, edits: &[SetfaclEdit]) -> Result<()> {
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
fn apply_agent_acls(
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
fn grant_agent_api_socket_access(
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
fn validate_runtime_socket(stat: &rustix::fs::Stat, uid: u32, gid: u32) -> Result<()> {
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
fn run_setfacl(program: &Path, path: &Path, acl: &str) -> Result<()> {
    run_setfacl_many(program, &[path], acl)
}

#[cfg(target_os = "linux")]
fn run_setfacl_many(program: &Path, paths: &[&Path], acl: &str) -> Result<()> {
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
fn apply_agent_acls(
    _config: &JailerdConfig,
    _generation: &ValidatedId,
    _vm_uid: u32,
    _vm_gid: u32,
) -> Result<()> {
    bail!("POSIX ACL staging is supported only on Linux")
}

#[cfg(not(target_os = "linux"))]
fn grant_agent_api_socket_access(
    _config: &JailerdConfig,
    _generation: &ValidatedId,
    _uid: u32,
    _gid: u32,
) -> Result<()> {
    bail!("runtime socket ACLs are supported only on Linux")
}

#[cfg(not(target_os = "linux"))]
fn set_owner(_path: &Path, _uid: u32, _gid: u32) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use intar_jailer_protocol::{ArtifactAccess, ArtifactSource, SourceArtifacts};
    use std::sync::Condvar;

    #[test]
    fn staging_acls_are_one_fd_pinned_interleaved_helper_batch() {
        let proc_path = |fd: u32| PathBuf::from(format!("/proc/4242/fd/{fd}"));
        let edits = agent_acl_edits(
            (10..14).map(proc_path).collect(),
            proc_path(20),
            proc_path(21),
            (30..33).map(proc_path).collect(),
            1_001,
            20_001,
        );
        assert_eq!(edits.len(), 5, "each distinct ACL must remain explicit");

        let arguments = setfacl_batch_arguments(&edits).expect("encode ACL helper batch");
        let expected = [
            "--modify",
            "u:1001:--x,m::--x",
            "/proc/4242/fd/10",
            "/proc/4242/fd/11",
            "/proc/4242/fd/12",
            "/proc/4242/fd/13",
            "--modify",
            "u:1001:rwx,m::rwx",
            "/proc/4242/fd/20",
            "/proc/4242/fd/21",
            "--modify",
            "d:u:1001:rwx,d:u:20001:rwx,d:m::rwx",
            "/proc/4242/fd/20",
            "--modify",
            "d:u:1001:rwx,d:m::rwx",
            "/proc/4242/fd/21",
            "--modify",
            "u:1001:rw-,m::rw-",
            "/proc/4242/fd/30",
            "/proc/4242/fd/31",
            "/proc/4242/fd/32",
        ]
        .map(OsString::from)
        .to_vec();
        assert_eq!(arguments, expected);
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| argument.as_os_str() == "--modify")
                .count(),
            5
        );
    }

    #[test]
    fn staging_acl_batch_rejects_unpinned_paths() {
        let error = setfacl_batch_arguments(&[SetfaclEdit {
            acl: "u:1001:--x,m::--x".to_owned(),
            paths: vec![PathBuf::from("/srv/intar/jails")],
        }])
        .expect_err("path-based ACL batch must fail closed");
        assert!(error.to_string().contains("fd-pinned procfs"));
    }

    #[test]
    fn blank_recording_template_is_deterministic_256_mib_intarrec_vfat() {
        let mut first = tempfile::tempfile().expect("first recording template");
        let first_digest = format_blank_recording(&mut first).expect("format first template");
        assert_eq!(
            first.metadata().expect("first metadata").len(),
            BLANK_RECORDING_BYTES
        );
        first
            .seek(SeekFrom::Start(0))
            .expect("rewind first template");
        let filesystem = fatfs::FileSystem::new(first, fatfs::FsOptions::new())
            .expect("open formatted recording template");
        assert_eq!(filesystem.volume_id(), BLANK_RECORDING_VOLUME_ID);
        assert_eq!(
            filesystem.volume_label_as_bytes(),
            BLANK_RECORDING_DISPLAY_LABEL
        );
        assert_eq!(
            filesystem
                .read_volume_label_from_root_dir_as_bytes()
                .expect("read root volume label"),
            Some(BLANK_RECORDING_LABEL)
        );

        let mut second = tempfile::tempfile().expect("second recording template");
        let second_digest = format_blank_recording(&mut second).expect("format second template");
        assert_eq!(first_digest, second_digest);
    }

    #[test]
    fn pinned_template_identity_detects_in_place_change() {
        let mut file = tempfile::tempfile().expect("template file");
        file.write_all(b"runtime").expect("write template");
        let before = source_file_identity(&file.metadata().expect("before metadata"));
        file.set_len(before.bytes + 1).expect("tamper template");
        let after = source_file_identity(&file.metadata().expect("after metadata"));
        assert_ne!(before, after);
    }

    #[test]
    fn pinned_template_rejects_hardlink_aliases() {
        let directory = tempfile::tempdir().expect("template directory");
        let source = directory.path().join("runtime");
        std::fs::write(&source, b"runtime").expect("write runtime");
        let before = std::fs::metadata(&source).expect("source metadata");
        let artifact = HostTemplateArtifactV2 {
            sha256: Sha256Digest::parse("a".repeat(64)).expect("digest"),
            identity: source_file_identity(&before),
        };
        std::fs::hard_link(&source, directory.path().join("runtime-alias"))
            .expect("create hardlink alias");
        let error = validate_host_template_artifact_metadata(
            &std::fs::metadata(&source).expect("aliased metadata"),
            &artifact,
            "test runtime",
        )
        .expect_err("hardlinked template must fail validation");
        assert!(error.to_string().contains("link count"));
    }

    #[test]
    fn restart_rotation_accepts_atomic_package_replacement_but_rejects_in_place_mutation() {
        let mut old = tempfile::tempfile().expect("old package inode");
        old.write_all(b"runtime-v1").expect("write old runtime");
        let old_identity = source_file_identity(&old.metadata().expect("old metadata"));

        let mut replacement = tempfile::tempfile().expect("replacement package inode");
        replacement
            .write_all(b"runtime-v2")
            .expect("write replacement runtime");
        let replacement_identity =
            source_file_identity(&replacement.metadata().expect("replacement metadata"));
        assert!(
            source_was_atomically_replaced(&replacement_identity, &old_identity, "test runtime")
                .expect("atomic replacement is eligible for rotation")
        );

        old.set_len(old_identity.bytes + 1)
            .expect("mutate old inode in place");
        let mutated_identity = source_file_identity(&old.metadata().expect("mutated metadata"));
        assert!(
            source_was_atomically_replaced(&mutated_identity, &old_identity, "test runtime")
                .expect_err("same-inode mutation must fail closed")
                .to_string()
                .contains("changed in place")
        );
    }

    #[test]
    fn host_template_bundle_identity_binds_every_artifact_digest() {
        let cloud = Sha256Digest::parse("a".repeat(64)).expect("cloud digest");
        let jailer = Sha256Digest::parse("b".repeat(64)).expect("jailer digest");
        let recording = Sha256Digest::parse("c".repeat(64)).expect("recording digest");
        let changed = Sha256Digest::parse("d".repeat(64)).expect("changed digest");
        let expected = host_template_bundle_sha256(&cloud, &jailer, &recording);
        assert_ne!(
            expected,
            host_template_bundle_sha256(&changed, &jailer, &recording)
        );
        assert_ne!(
            expected,
            host_template_bundle_sha256(&cloud, &changed, &recording)
        );
        assert_ne!(
            expected,
            host_template_bundle_sha256(&cloud, &jailer, &changed)
        );
    }

    #[test]
    fn exact_template_clone_never_falls_back_to_copy() {
        let source_directory = tempfile::tempdir().expect("source directory");
        let destination_directory = tempfile::tempdir().expect("destination directory");
        let destination = destination_directory.path().join("clone");
        let source = File::open(source_directory.path()).expect("open source directory");
        assert!(stage_prepared_template_source_file(source, &destination, 0o400).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn exact_reflink_attestation_requires_every_configured_source_root() {
        let mut config = test_config();
        config.allowed_source_roots = vec![PathBuf::from("/source-a"), PathBuf::from("/source-b")];
        let identity = TrustedDirectoryIdentity {
            device: 7,
            inode: 11,
        };
        let mut attestation = FastTemplateStoreAttestation {
            template_store: identity,
            generation_store: identity,
            allowed_source_roots: vec![identity],
        };
        assert!(!attestation.covers_allowed_source_roots(&config));
        attestation.allowed_source_roots.push(identity);
        assert!(attestation.covers_allowed_source_roots(&config));
        attestation.allowed_source_roots.push(identity);
        assert!(!attestation.covers_allowed_source_roots(&config));
    }

    #[derive(Default)]
    struct FakeBackend {
        units: BTreeMap<String, BackendInspection>,
        unit_quotas: BTreeMap<String, CpuQuota>,
        started_specs: Vec<UnitLaunchSpec>,
        inspect_unit_calls: usize,
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
        quota_updates: Vec<(String, CpuQuota)>,
        run_network_repairs: Vec<ValidatedId>,
        active_ssh_forwards: BTreeSet<(ValidatedId, ValidatedId)>,
        ssh_forward_updates: Vec<(ValidatedId, ValidatedId, bool)>,
        boundary_operations: Vec<String>,
        fail_quota_update: bool,
        fail_quota_update_units: BTreeSet<String>,
        fail_ssh_forward_update: bool,
        fail_ssh_forward_disable: bool,
    }

    impl HostBackend for FakeBackend {
        fn production_ready(&self) -> bool {
            true
        }
        fn start_unit(&mut self, spec: &UnitLaunchSpec) -> Result<StartedUnit> {
            self.started_specs.push(spec.clone());
            self.unit_quotas
                .insert(spec.unit_name.clone(), spec.cpu_quota);
            self.units.insert(
                spec.unit_name.clone(),
                BackendInspection {
                    pid: Some(42),
                    cgroup_path: Some(
                        format!("/intar.slice/intar-vms.slice/{}", spec.unit_name).into(),
                    ),
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
                cgroup_path: Some(
                    format!("/intar.slice/intar-vms.slice/{}", spec.unit_name).into(),
                ),
                host_boot_id: Some("test-boot".to_owned()),
                pid_start_time_ticks: Some(7),
            })
        }
        fn inspect_unit(&mut self, unit_name: &str) -> Result<BackendInspection> {
            self.inspect_unit_calls += 1;
            self.units
                .get(unit_name)
                .cloned()
                .context("missing fake unit")
        }
        fn update_unit_cpu_quota(
            &mut self,
            unit_name: &str,
            cgroup_path: &Path,
            quota: CpuQuota,
        ) -> Result<()> {
            if self.fail_quota_update || self.fail_quota_update_units.contains(unit_name) {
                bail!("injected CPU quota readback failure")
            }
            let unit = self.units.get(unit_name).context("missing fake unit")?;
            if unit.cgroup_path.as_deref() != Some(cgroup_path) {
                bail!("fake cgroup identity mismatch")
            }
            self.quota_updates.push((unit_name.to_owned(), quota));
            self.unit_quotas.insert(unit_name.to_owned(), quota);
            self.boundary_operations
                .push(format!("quota:{}", quota.cpu_millis));
            Ok(())
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
            let changed = self.units.remove(unit_name).is_some();
            if changed {
                self.unit_quotas.remove(unit_name);
            }
            Ok(changed)
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
        fn repair_run_network(
            &mut self,
            request: &EnsureRunNetworkRequest,
        ) -> Result<RunNetworkResult> {
            self.run_network_repairs.push(request.run_id.clone());
            self.ensure_run_network(request)
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
            self.active_ssh_forwards
                .remove(&(run_id.clone(), generation.clone()));
            Ok(true)
        }
        fn set_vm_ssh_forwarding(
            &mut self,
            run_id: &ValidatedId,
            generation: &ValidatedId,
            active: bool,
        ) -> Result<bool> {
            if self.fail_ssh_forward_update {
                bail!("injected SSH forwarding update failure")
            }
            if !active && self.fail_ssh_forward_disable {
                bail!("injected SSH forwarding rollback failure")
            }
            let key = (run_id.clone(), generation.clone());
            let changed = if active {
                self.active_ssh_forwards.insert(key.clone())
            } else {
                self.active_ssh_forwards.remove(&key)
            };
            self.ssh_forward_updates
                .push((run_id.clone(), generation.clone(), active));
            self.boundary_operations.push(format!("ssh:{active}"));
            Ok(changed)
        }
        fn destroy_run_network(&mut self, _request: &DestroyRunNetworkRequest) -> Result<bool> {
            Ok(true)
        }
    }

    #[derive(Default)]
    struct LaunchGateState {
        entered: bool,
        blocked: bool,
    }

    #[derive(Clone)]
    struct BlockingSharedBackend {
        state: Arc<Mutex<FakeBackend>>,
        gate: Arc<(Mutex<LaunchGateState>, Condvar)>,
    }

    impl Default for BlockingSharedBackend {
        fn default() -> Self {
            Self {
                state: Arc::new(Mutex::new(FakeBackend::default())),
                gate: Arc::new((Mutex::new(LaunchGateState::default()), Condvar::new())),
            }
        }
    }

    impl BlockingSharedBackend {
        fn block_next_launch(&self) {
            let (lock, _) = &*self.gate;
            let mut gate = lock.lock().expect("launch gate");
            gate.entered = false;
            gate.blocked = true;
        }

        fn wait_until_launch_enters(&self) {
            let (lock, ready) = &*self.gate;
            let mut gate = lock.lock().expect("launch gate");
            while !gate.entered {
                gate = ready.wait(gate).expect("wait for blocked launch");
            }
        }

        fn release_launch(&self) {
            let (lock, ready) = &*self.gate;
            let mut gate = lock.lock().expect("launch gate");
            gate.blocked = false;
            ready.notify_all();
        }
    }

    impl HostBackend for BlockingSharedBackend {
        fn production_ready(&self) -> bool {
            true
        }

        fn start_unit(&mut self, spec: &UnitLaunchSpec) -> Result<StartedUnit> {
            let (lock, ready) = &*self.gate;
            let mut gate = lock.lock().expect("launch gate");
            gate.entered = true;
            ready.notify_all();
            while gate.blocked {
                gate = ready.wait(gate).expect("release blocked launch");
            }
            drop(gate);
            self.state.lock().expect("backend state").start_unit(spec)
        }

        fn inspect_unit(&mut self, unit_name: &str) -> Result<BackendInspection> {
            self.state
                .lock()
                .expect("backend state")
                .inspect_unit(unit_name)
        }

        fn update_unit_cpu_quota(
            &mut self,
            unit_name: &str,
            cgroup_path: &Path,
            quota: CpuQuota,
        ) -> Result<()> {
            self.state
                .lock()
                .expect("backend state")
                .update_unit_cpu_quota(unit_name, cgroup_path, quota)
        }

        fn stop_unit(&mut self, unit_name: &str) -> Result<bool> {
            self.state
                .lock()
                .expect("backend state")
                .stop_unit(unit_name)
        }

        fn destroy_unit(&mut self, unit_name: &str) -> Result<bool> {
            self.state
                .lock()
                .expect("backend state")
                .destroy_unit(unit_name)
        }

        fn ensure_run_network(
            &mut self,
            request: &EnsureRunNetworkRequest,
        ) -> Result<RunNetworkResult> {
            self.state
                .lock()
                .expect("backend state")
                .ensure_run_network(request)
        }

        fn repair_run_network(
            &mut self,
            request: &EnsureRunNetworkRequest,
        ) -> Result<RunNetworkResult> {
            self.state
                .lock()
                .expect("backend state")
                .repair_run_network(request)
        }

        fn ensure_vm_network(
            &mut self,
            run: &EnsureRunNetworkRequest,
            request: &VmLaunchRequest,
            generation: &ValidatedId,
            uid: u32,
            gid: u32,
        ) -> Result<()> {
            self.state
                .lock()
                .expect("backend state")
                .ensure_vm_network(run, request, generation, uid, gid)
        }

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

        fn set_vm_ssh_forwarding(
            &mut self,
            run_id: &ValidatedId,
            generation: &ValidatedId,
            active: bool,
        ) -> Result<bool> {
            self.state
                .lock()
                .expect("backend state")
                .set_vm_ssh_forwarding(run_id, generation, active)
        }

        fn destroy_vm_network(
            &mut self,
            run_id: &ValidatedId,
            generation: &ValidatedId,
        ) -> Result<bool> {
            self.state
                .lock()
                .expect("backend state")
                .destroy_vm_network(run_id, generation)
        }

        fn destroy_run_network(&mut self, request: &DestroyRunNetworkRequest) -> Result<bool> {
            self.state
                .lock()
                .expect("backend state")
                .destroy_run_network(request)
        }
    }

    #[derive(Default)]
    struct FakePreparer;

    impl JailPreparer for FakePreparer {
        fn prepare(
            &mut self,
            config: &JailerdConfig,
            request: &VmLaunchRequest,
            _run_network: &RunNetworkResult,
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
                vmm_executable_identity: None,
                paths: jail_paths(&root, request.artifacts.initrd.is_some()),
            })
        }
        fn destroy(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<bool> {
            Ok(true)
        }
        fn quarantine(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<()> {
            Ok(())
        }
        fn grant_agent_runtime_access(
            &mut self,
            _config: &JailerdConfig,
            _generation: &ValidatedId,
            _uid: u32,
            _gid: u32,
        ) -> Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct RevokedFastTemplatePreparer;

    impl JailPreparer for RevokedFastTemplatePreparer {
        fn fast_template_store(&mut self, _config: &JailerdConfig) -> bool {
            true
        }

        fn fast_template_store_ready(&self, _config: &JailerdConfig) -> bool {
            false
        }

        fn prepare(
            &mut self,
            _config: &JailerdConfig,
            _request: &VmLaunchRequest,
            _run_network: &RunNetworkResult,
            _generation: &ValidatedId,
            _uid: u32,
            _gid: u32,
        ) -> Result<PreparedJail> {
            bail!("revoked template host cannot prepare a jail")
        }

        fn destroy(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<bool> {
            Ok(false)
        }

        fn quarantine(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<()> {
            Ok(())
        }

        fn grant_agent_runtime_access(
            &mut self,
            _config: &JailerdConfig,
            _generation: &ValidatedId,
            _uid: u32,
            _gid: u32,
        ) -> Result<()> {
            bail!("revoked template host cannot grant runtime access")
        }
    }

    #[derive(Clone, Copy, Default)]
    struct FakeTemplatePreparer;

    fn fake_prepared_image(request: &PrepareImageV2Request) -> PreparedImageV2Result {
        PreparedImageV2Result {
            image_sha256: request.image_sha256.clone(),
            virtual_size_bytes: request.virtual_size_bytes,
            root_disk: template_artifact_source(
                &request.image_sha256,
                "root.raw",
                request.root_disk.sha256.as_ref().expect("root digest"),
                ArtifactAccess::ReadWrite,
            ),
            kernel: template_artifact_source(
                &request.image_sha256,
                "kernel",
                request.kernel.sha256.as_ref().expect("kernel digest"),
                ArtifactAccess::ReadOnly,
            ),
            initrd: request.initrd.as_ref().map(|source| {
                template_artifact_source(
                    &request.image_sha256,
                    "initrd",
                    source.sha256.as_ref().expect("initrd digest"),
                    ArtifactAccess::ReadOnly,
                )
            }),
            fast_template_store: true,
        }
    }

    impl JailPreparer for FakeTemplatePreparer {
        fn fast_template_store(&mut self, _config: &JailerdConfig) -> bool {
            true
        }

        fn prepare_image_v2(
            &mut self,
            _config: &JailerdConfig,
            request: &PrepareImageV2Request,
        ) -> Result<PreparedImageV2Result> {
            Ok(fake_prepared_image(request))
        }

        fn validate_prepared_launch(
            &mut self,
            _config: &JailerdConfig,
            request: &LaunchVmV2Request,
        ) -> Result<()> {
            request.validate().map(|_| ()).map_err(Into::into)
        }

        fn prepare(
            &mut self,
            config: &JailerdConfig,
            request: &VmLaunchRequest,
            _run_network: &RunNetworkResult,
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
                vmm_executable_identity: None,
                paths: jail_paths(&root, request.artifacts.initrd.is_some()),
            })
        }

        fn destroy(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<bool> {
            Ok(true)
        }

        fn quarantine(&mut self, _config: &JailerdConfig, _generation: &ValidatedId) -> Result<()> {
            Ok(())
        }

        fn grant_agent_runtime_access(
            &mut self,
            _config: &JailerdConfig,
            _generation: &ValidatedId,
            _uid: u32,
            _gid: u32,
        ) -> Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct TrackingPreparer {
        quarantined: Vec<ValidatedId>,
        persist_calls: usize,
        runtime_access_calls: usize,
        fail_persist_call: Option<usize>,
        fail_runtime_access: bool,
        fail_quarantine: bool,
    }

    impl JailPreparer for TrackingPreparer {
        fn fast_template_store(&mut self, _config: &JailerdConfig) -> bool {
            true
        }

        fn prepare_image_v2(
            &mut self,
            _config: &JailerdConfig,
            request: &PrepareImageV2Request,
        ) -> Result<PreparedImageV2Result> {
            Ok(fake_prepared_image(request))
        }

        fn validate_prepared_launch(
            &mut self,
            _config: &JailerdConfig,
            request: &LaunchVmV2Request,
        ) -> Result<()> {
            request.validate().map(|_| ()).map_err(Into::into)
        }

        fn prepare(
            &mut self,
            config: &JailerdConfig,
            request: &VmLaunchRequest,
            _run_network: &RunNetworkResult,
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
                vmm_executable_identity: None,
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

        fn grant_agent_runtime_access(
            &mut self,
            _config: &JailerdConfig,
            _generation: &ValidatedId,
            _uid: u32,
            _gid: u32,
        ) -> Result<()> {
            self.runtime_access_calls += 1;
            if self.fail_runtime_access {
                bail!("injected runtime socket ACL failure")
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
            _run_network: &RunNetworkResult,
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

        fn grant_agent_runtime_access(
            &mut self,
            _config: &JailerdConfig,
            _generation: &ValidatedId,
            _uid: u32,
            _gid: u32,
        ) -> Result<()> {
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
    fn capabilities_and_prepare_image_v2_require_fast_template_store() {
        let config = test_config();
        let digest = Sha256Digest::parse("a".repeat(64)).expect("digest");
        let cached_source = |path: &str| ArtifactSource {
            source_root: 0,
            relative_path: PathBuf::from(path),
            sha256: Some(digest.clone()),
            access: ArtifactAccess::ReadOnly,
        };
        let request = PrepareImageV2Request {
            image_sha256: digest.clone(),
            virtual_size_bytes: 4 * 1024 * 1024 * 1024,
            root_disk: cached_source("images/root.raw"),
            kernel: cached_source("artifacts/kernel"),
            initrd: Some(cached_source("artifacts/initrd")),
        };

        let mut unavailable = JailerdCore::new_with_readiness(
            config.clone(),
            FakeBackend::default(),
            FakePreparer,
            4_000,
            ready_readiness(),
        )
        .expect("core");
        assert!(!unavailable.capabilities().supports_jailer_v2);
        assert!(matches!(
            unavailable.handle(Request::PrepareImageV2(Box::new(request.clone()))),
            Response::Error(ProtocolError { ref code, .. }) if code == "host_not_ready"
        ));

        let mut available = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakeTemplatePreparer,
            4_000,
            ready_readiness(),
        )
        .expect("core");
        let capabilities = available.capabilities();
        assert_eq!(capabilities.protocol_version, 2);
        assert!(capabilities.supports_jailer_v2);
        assert!(capabilities.supports_template_backed_launch);
        assert!(capabilities.fast_template_store);
        let prepared = match available.handle(Request::PrepareImageV2(Box::new(request))) {
            Response::PrepareImageV2(prepared) => prepared,
            other => panic!("unexpected prepare response: {other:?}"),
        };
        assert_eq!(prepared.root_disk.source_root, PREPARED_IMAGE_SOURCE_ROOT);
        assert_eq!(prepared.root_disk.access, ArtifactAccess::ReadWrite);
        assert!(prepared.fast_template_store);
    }

    #[test]
    fn live_template_validation_withdraws_fast_host_capabilities() {
        let core = JailerdCore::new_with_readiness(
            test_config(),
            FakeBackend::default(),
            RevokedFastTemplatePreparer,
            4_000,
            ready_readiness(),
        )
        .expect("core");
        let capabilities = core.capabilities();
        assert!(!capabilities.fast_template_store);
        assert!(!capabilities.supports_jailer_v2);
        assert!(!capabilities.supports_template_backed_launch);
    }

    #[test]
    fn launch_vm_v2_requires_and_uses_one_prepared_template_bundle() {
        let config = test_config();
        let digest = Sha256Digest::parse("d".repeat(64)).expect("digest");
        let cached_source = |path: &str| ArtifactSource {
            source_root: 0,
            relative_path: PathBuf::from(path),
            sha256: Some(digest.clone()),
            access: ArtifactAccess::ReadOnly,
        };
        let prepare = PrepareImageV2Request {
            image_sha256: digest.clone(),
            virtual_size_bytes: 4 * 1024 * 1024 * 1024,
            root_disk: cached_source("images/root.raw"),
            kernel: cached_source("artifacts/kernel"),
            initrd: Some(cached_source("artifacts/initrd")),
        };
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakeTemplatePreparer,
            4_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let prepared = match core.handle(Request::PrepareImageV2(Box::new(prepare))) {
            Response::PrepareImageV2(prepared) => prepared,
            other => panic!("unexpected prepare response: {other:?}"),
        };
        let mut prepared_launch = launch(0, 125);
        prepared_launch.artifacts.root_disk = prepared.root_disk.clone();
        prepared_launch.artifacts.kernel = prepared.kernel.clone();
        prepared_launch.artifacts.initrd = prepared.initrd.clone();

        let v2 = LaunchVmV2Request {
            image_sha256: prepared.image_sha256,
            virtual_size_bytes: prepared.virtual_size_bytes,
            launch: prepared_launch,
        };
        let mut unavailable = JailerdCore::new_with_readiness(
            test_config(),
            FakeBackend::default(),
            FakePreparer,
            4_000,
            ready_readiness(),
        )
        .expect("core without fast template store");
        assert!(matches!(
            unavailable.handle(Request::LaunchVmV2(Box::new(v2.clone()))),
            Response::Error(ProtocolError { ref code, .. }) if code == "host_not_ready"
        ));
        assert!(matches!(
            core.handle(Request::LaunchVmV2(Box::new(v2))),
            Response::LaunchVmV2(_)
        ));
    }

    #[test]
    fn detached_v2_launch_releases_core_lock_and_reserves_capacity() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let backend = BlockingSharedBackend::default();
        let core = Arc::new(Mutex::new(
            JailerdCore::new_with_readiness(
                config,
                backend.clone(),
                FakeTemplatePreparer,
                3_000,
                ready_readiness(),
            )
            .expect("core"),
        ));
        {
            let mut core = core.lock().expect("core lock");
            let response = core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
                run_id: ValidatedId::parse("run").expect("run ID"),
                guest_cidr: "10.77.0.0/28".to_owned(),
                gateway: "10.77.0.1".to_owned(),
            }));
            assert!(matches!(response, Response::EnsureRunNetwork(_)));
        }

        let first = match launch_vm_v2_response(&core, launch_v2(0, 1_000)) {
            Response::LaunchVmV2(result) => result,
            other => panic!("unexpected first launch response: {other:?}"),
        };
        assert!(matches!(
            core.lock()
                .expect("core lock")
                .handle(Request::FinalizeVmBoot(FinalizeVmBootRequest {
                    generation: first.generation.clone(),
                })),
            Response::FinalizeVmBoot(_)
        ));

        backend.block_next_launch();
        let launch_core = Arc::clone(&core);
        let launch_thread =
            std::thread::spawn(move || launch_vm_v2_response(&launch_core, launch_v2(1, 1_000)));
        backend.wait_until_launch_enters();

        {
            let mut live = core
                .try_lock()
                .expect("long VMM activation must not hold the core lock");
            assert_eq!(live.inflight_launches.len(), 1);
            assert_eq!(live.pending_cpu_reservations.len(), 1);
            assert_eq!(live.capabilities().committed_cpu_millis, 3_000);
            assert!(matches!(
                live.handle(Request::FinalizeVmBoot(FinalizeVmBootRequest {
                    generation: first.generation,
                })),
                Response::FinalizeVmBoot(_)
            ));
        }

        let duplicate = launch_vm_v2_response(&core, launch_v2(1, 1_000));
        assert!(matches!(
            duplicate,
            Response::Error(ProtocolError { ref code, .. }) if code == "boot_capacity_pending"
        ));
        assert_eq!(
            core.lock().expect("core lock").inflight_launches.len(),
            1,
            "an idempotent retry must not reserve a second generation"
        );

        let rejected = launch_vm_v2_response(&core, launch_v2(2, 1_000));
        assert!(matches!(
            rejected,
            Response::Error(ProtocolError { ref code, .. }) if code == "boot_capacity_pending"
        ));

        backend.release_launch();
        assert!(matches!(
            launch_thread.join().expect("launch thread"),
            Response::LaunchVmV2(_)
        ));
        let live = core.lock().expect("core lock");
        assert!(live.inflight_launches.is_empty());
        assert!(live.pending_cpu_reservations.is_empty());
        assert_eq!(live.records.len(), 2);
        assert_eq!(live.capabilities().committed_cpu_millis, 3_000);
    }

    #[test]
    fn detached_v2_launch_failure_releases_proven_capacity() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let backend = BlockingSharedBackend::default();
        backend.state.lock().expect("backend state").fail_vm_network = true;
        let core = Arc::new(Mutex::new(
            JailerdCore::new_with_readiness(
                config,
                backend,
                FakeTemplatePreparer,
                2_000,
                ready_readiness(),
            )
            .expect("core"),
        ));
        {
            let mut core = core.lock().expect("core lock");
            assert!(matches!(
                core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
                    run_id: ValidatedId::parse("run").expect("run ID"),
                    guest_cidr: "10.77.0.0/28".to_owned(),
                    gateway: "10.77.0.1".to_owned(),
                })),
                Response::EnsureRunNetwork(_)
            ));
        }

        assert!(matches!(
            launch_vm_v2_response(&core, launch_v2(0, 1_000)),
            Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
        ));
        let live = core.lock().expect("core lock");
        assert!(live.inflight_launches.is_empty());
        assert!(live.pending_cpu_reservations.is_empty());
        assert!(live.records.is_empty());
        assert_eq!(live.capabilities().committed_cpu_millis, 0);
    }

    #[test]
    fn detached_v2_launch_retains_capacity_until_failed_unit_is_contained() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let backend = BlockingSharedBackend::default();
        {
            let mut state = backend.state.lock().expect("backend state");
            state.fail_start_after_create = true;
            state.fail_stop_unit = true;
            state.fail_destroy_unit = true;
        }
        let core = Arc::new(Mutex::new(
            JailerdCore::new_with_readiness(
                config,
                backend,
                FakeTemplatePreparer,
                2_000,
                ready_readiness(),
            )
            .expect("core"),
        ));
        {
            let mut core = core.lock().expect("core lock");
            assert!(matches!(
                core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
                    run_id: ValidatedId::parse("run").expect("run ID"),
                    guest_cidr: "10.77.0.0/28".to_owned(),
                    gateway: "10.77.0.1".to_owned(),
                })),
                Response::EnsureRunNetwork(_)
            ));
        }

        assert!(matches!(
            launch_vm_v2_response(&core, launch_v2(0, 1_000)),
            Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
        ));
        let live = core.lock().expect("core lock");
        assert!(live.inflight_launches.is_empty());
        assert_eq!(live.pending_cpu_reservations.len(), 1);
        assert_eq!(live.unresolved_recoveries.len(), 1);
        assert_eq!(live.capabilities().committed_cpu_millis, 2_000);
        assert!(!live.capabilities().supports_jailer_v2);
    }

    #[test]
    fn detached_existing_identity_mismatch_releases_only_proven_capacity() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let backend = BlockingSharedBackend::default();
        let core = Arc::new(Mutex::new(
            JailerdCore::new_with_readiness(
                config,
                backend.clone(),
                FakeTemplatePreparer,
                2_000,
                ready_readiness(),
            )
            .expect("core"),
        ));
        {
            let mut core = core.lock().expect("core lock");
            assert!(matches!(
                core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
                    run_id: ValidatedId::parse("run").expect("run ID"),
                    guest_cidr: "10.77.0.0/28".to_owned(),
                    gateway: "10.77.0.1".to_owned(),
                })),
                Response::EnsureRunNetwork(_)
            ));
        }

        let request = launch_v2(0, 1_000);
        let launched = match launch_vm_v2_response(&core, request.clone()) {
            Response::LaunchVmV2(result) => result,
            other => panic!("unexpected launch response: {other:?}"),
        };
        {
            let mut state = backend.state.lock().expect("backend state");
            state
                .units
                .get_mut(&launched.unit_name)
                .expect("launched unit")
                .pid_start_time_ticks = Some(99);
        }

        assert!(matches!(
            launch_vm_v2_response(&core, request),
            Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
        ));
        let live = core.lock().expect("core lock");
        assert!(live.records.is_empty());
        assert!(live.pending_cpu_reservations.is_empty());
        assert!(live.unresolved_recoveries.is_empty());
        assert_eq!(live.capabilities().committed_cpu_millis, 0);
        assert!(!live.capabilities().supports_jailer_v2);
        drop(live);

        let state = backend.state.lock().expect("backend state");
        assert!(!state.units.contains_key(&launched.unit_name));
        assert_eq!(state.destroyed_vm_networks.len(), 1);
    }

    #[test]
    fn detached_existing_identity_mismatch_retains_boot_capacity_until_drain() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let backend = BlockingSharedBackend::default();
        let core = Arc::new(Mutex::new(
            JailerdCore::new_with_readiness(
                config,
                backend.clone(),
                FakeTemplatePreparer,
                2_000,
                ready_readiness(),
            )
            .expect("core"),
        ));
        {
            let mut core = core.lock().expect("core lock");
            assert!(matches!(
                core.handle(Request::EnsureRunNetwork(EnsureRunNetworkRequest {
                    run_id: ValidatedId::parse("run").expect("run ID"),
                    guest_cidr: "10.77.0.0/28".to_owned(),
                    gateway: "10.77.0.1".to_owned(),
                })),
                Response::EnsureRunNetwork(_)
            ));
        }

        let request = launch_v2(0, 1_000);
        let launched = match launch_vm_v2_response(&core, request.clone()) {
            Response::LaunchVmV2(result) => result,
            other => panic!("unexpected launch response: {other:?}"),
        };
        {
            let mut state = backend.state.lock().expect("backend state");
            state
                .units
                .get_mut(&launched.unit_name)
                .expect("launched unit")
                .pid_start_time_ticks = Some(99);
            state.active_ssh_forwards.insert((
                ValidatedId::parse("run").expect("run ID"),
                launched.generation.clone(),
            ));
            state.fail_stop_unit = true;
            state.fail_destroy_unit = true;
        }

        assert!(matches!(
            launch_vm_v2_response(&core, request),
            Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
        ));
        let live = core.lock().expect("core lock");
        assert!(live.records.is_empty());
        assert!(live.inflight_launches.is_empty());
        assert_eq!(live.pending_cpu_reservations.len(), 1);
        assert_eq!(live.unresolved_recoveries.len(), 1);
        assert_eq!(live.capabilities().committed_cpu_millis, 2_000);
        assert!(!live.capabilities().supports_jailer_v2);
        drop(live);

        let state = backend.state.lock().expect("backend state");
        assert!(state.units.contains_key(&launched.unit_name));
        assert!(state.active_ssh_forwards.is_empty());
        assert!(state.destroyed_vm_networks.is_empty());
    }

    #[test]
    fn eight_eighth_cpu_vms_fill_exactly_one_schedulable_core() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakeTemplatePreparer,
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        for index in 0..8 {
            let response = launch_prepared_v2(&mut core, index, 125);
            assert!(matches!(response, Response::LaunchVmV2(_)), "{response:?}");
        }
        let response = launch_prepared_v2(&mut core, 8, 125);
        assert!(matches!(
            response,
            Response::Error(ProtocolError { ref code, .. }) if code == "boot_capacity_pending"
        ));
        assert_eq!(core.capabilities().committed_cpu_millis, 1_000);
    }

    #[test]
    fn launch_uses_root_owned_boot_quota_and_keeps_ssh_closed() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        config.boot_cpu_lease_ms = 45_000;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakeTemplatePreparer,
            4_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        let launched = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected launch response {other:?}"),
        };
        assert_eq!(core.backend.started_specs[0].cpu_quota.cpu_millis, 2_000);
        let remaining_lease_ms = core.backend.started_specs[0]
            .boot_cpu_lease_ms
            .expect("boot lease");
        assert!((1..=45_000).contains(&remaining_lease_ms));
        assert_eq!(
            core.backend.started_specs[0].generation,
            launched.generation
        );
        assert_eq!(
            core.backend.started_specs[0].required_properties()["BindsTo"],
            boot_cpu_guardian_unit_name(&launched.generation)
        );
        assert_eq!(launched.cpu_runtime.phase, VmCpuPhase::BootBurst);
        assert_eq!(launched.cpu_runtime.steady_quota.cpu_millis, 1_000);
        assert_eq!(launched.cpu_runtime.effective_quota.cpu_millis, 2_000);
        assert!(launched.cpu_runtime.boot_deadline_unix_ms.is_some());
        assert_eq!(
            launched
                .cpu_runtime
                .attestation
                .as_ref()
                .expect("boot quota attestation")
                .cpu_max_burst,
            0
        );
        assert_eq!(core.capabilities().committed_cpu_millis, 2_000);
        assert!(core.backend.active_ssh_forwards.is_empty());
        assert!(core.backend.ssh_forward_updates.is_empty());
    }

    #[test]
    fn finalize_seals_quota_before_ingress_and_is_idempotent() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            TrackingPreparer::default(),
            4_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected launch response {other:?}"),
        };
        let request = FinalizeVmBootRequest {
            generation: launched.generation.clone(),
        };

        let first = match core.handle(Request::FinalizeVmBoot(request.clone())) {
            Response::FinalizeVmBoot(value) => value,
            other => panic!("unexpected finalize response {other:?}"),
        };
        assert!(first.changed);
        assert!(first.ssh_forward_active);
        assert_eq!(first.cpu_runtime.phase, VmCpuPhase::Steady);
        assert_eq!(first.cpu_runtime.effective_quota.cpu_millis, 1_000);
        assert_eq!(first.cpu_runtime.boot_deadline_unix_ms, None);
        assert_eq!(core.backend.boundary_operations, ["quota:1000", "ssh:true"]);
        assert_eq!(core.capabilities().committed_cpu_millis, 1_000);

        let second = match core.handle(Request::FinalizeVmBoot(request)) {
            Response::FinalizeVmBoot(value) => value,
            other => panic!("unexpected idempotent finalize response {other:?}"),
        };
        assert!(!second.changed);
        assert_eq!(second.cpu_runtime.phase, VmCpuPhase::Steady);
        assert_eq!(
            core.backend.boundary_operations,
            ["quota:1000", "ssh:true", "quota:1000", "ssh:true"]
        );
    }

    #[test]
    fn finalize_persistence_and_ingress_rollback_failure_contains_vm() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let preparer = TrackingPreparer {
            // Launch intent, launch identity, CPU seal, then ingress state.
            fail_persist_call: Some(4),
            ..TrackingPreparer::default()
        };
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            preparer,
            4_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected launch response {other:?}"),
        };
        core.backend.fail_ssh_forward_disable = true;

        let response = core.handle(Request::FinalizeVmBoot(FinalizeVmBootRequest {
            generation: launched.generation.clone(),
        }));
        assert!(matches!(response, Response::Error(_)));
        assert!(!core.records.contains_key(&launched.generation));
        assert!(core.backend.active_ssh_forwards.is_empty());
        assert!(core.backend.stopped_units.contains(&launched.unit_name));
        assert!(core.backend.destroyed_units.contains(&launched.unit_name));
        assert!(core.preparer.quarantined.contains(&launched.generation));
        assert!(!core.records.contains_key(&launched.generation));
        assert_eq!(core.capabilities().committed_cpu_millis, 0);
        assert!(!core.capabilities().supports_jailer_v2);
    }

    #[test]
    fn boot_pool_exhaustion_is_a_typed_pending_result() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakeTemplatePreparer,
            2_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        assert!(matches!(
            core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))),
            Response::LaunchVmV2(_)
        ));
        assert!(matches!(
            core.handle(Request::LaunchVmV2(Box::new(launch_v2(1, 1_000)))),
            Response::Error(ProtocolError { ref code, .. }) if code == "boot_capacity_pending"
        ));
        assert_eq!(core.capabilities().committed_cpu_millis, 2_000);
    }

    #[test]
    fn failed_quota_readback_contains_vm_without_exposing_ssh() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            TrackingPreparer::default(),
            4_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected launch response {other:?}"),
        };
        core.backend.fail_quota_update = true;

        let response = core.handle(Request::FinalizeVmBoot(FinalizeVmBootRequest {
            generation: launched.generation.clone(),
        }));
        assert!(matches!(response, Response::Error(_)));
        assert!(!core.records.contains_key(&launched.generation));
        assert!(core.backend.active_ssh_forwards.is_empty());
        assert!(core.backend.ssh_forward_updates.is_empty());
        assert!(core.backend.stopped_units.contains(&launched.unit_name));
        assert!(core.backend.destroyed_units.contains(&launched.unit_name));
        assert!(core.preparer.quarantined.contains(&launched.generation));
        assert!(!core.capabilities().supports_boot_cpu_lease);
    }

    #[test]
    fn admitted_boot_lease_ignores_wall_clock_steps() {
        let admitted_at = Instant::now();
        let monotonic_deadline = admitted_at + Duration::from_secs(45);
        let unix_deadline_ms = 1_045_000;

        // A forward wall-clock step cannot shorten a live lease while its
        // same-daemon monotonic identity is available.
        assert!(!boot_cpu_lease_expired(
            Some(monotonic_deadline),
            Some(unix_deadline_ms),
            admitted_at + Duration::from_secs(44),
            unix_deadline_ms + 60_000,
        ));
        assert_eq!(
            remaining_boot_cpu_lease_ms(monotonic_deadline, admitted_at + Duration::from_secs(44),)
                .expect("one second remains"),
            1_000,
        );

        // A backward wall-clock step likewise cannot extend the quota after
        // the monotonic admission deadline has elapsed.
        assert!(boot_cpu_lease_expired(
            Some(monotonic_deadline),
            Some(unix_deadline_ms),
            monotonic_deadline,
            unix_deadline_ms - 60_000,
        ));
        assert!(remaining_boot_cpu_lease_ms(monotonic_deadline, monotonic_deadline).is_err());
    }

    #[test]
    fn watchdog_seals_expired_lease_without_activating_ingress() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            TrackingPreparer::default(),
            4_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected launch response {other:?}"),
        };
        let record = core.records.get_mut(&launched.generation).expect("record");
        record.boot_deadline_unix_ms = Some(0);
        record.boot_deadline_monotonic = Some(Instant::now());

        assert_eq!(core.enforce_boot_deadlines().expect("watchdog"), 1);
        let record = core.records.get(&launched.generation).expect("record");
        assert_eq!(record.cpu_phase, VmCpuPhase::Steady);
        assert!(!record.ssh_forward_active);
        assert_eq!(record.effective_quota().cpu_millis, 1_000);
        assert!(core.backend.active_ssh_forwards.is_empty());
        assert!(core.backend.ssh_forward_updates.is_empty());
    }

    #[test]
    fn watchdog_continues_after_one_expired_lease_fails() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            TrackingPreparer::default(),
            4_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let first = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(0, 1_000)))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected launch response {other:?}"),
        };
        let second = match core.handle(Request::LaunchVmV2(Box::new(launch_v2(1, 1_000)))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected launch response {other:?}"),
        };
        for generation in [&first.generation, &second.generation] {
            let record = core.records.get_mut(generation).expect("record");
            record.boot_deadline_unix_ms = Some(0);
            record.boot_deadline_monotonic = Some(Instant::now());
        }
        core.backend
            .fail_quota_update_units
            .insert(first.unit_name.clone());

        let error = core
            .enforce_boot_deadlines()
            .expect_err("one injected seal should be reported");
        assert!(format!("{error:#}").contains(first.generation.as_str()));
        assert!(!core.records.contains_key(&first.generation));
        assert_eq!(
            core.records
                .get(&second.generation)
                .expect("second record")
                .cpu_phase,
            VmCpuPhase::Steady
        );
    }

    #[test]
    fn launch_grants_mknod_only_for_the_jail_devices() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakeTemplatePreparer,
            125,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        assert!(matches!(
            launch_prepared_v2(&mut core, 0, 125),
            Response::LaunchVmV2(_)
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
            FakeTemplatePreparer,
            125,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match launch_prepared_v2(&mut core, 1, 125) {
            Response::LaunchVmV2(value) => value,
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
            FakeTemplatePreparer,
            125,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match launch_prepared_v2(&mut core, 1, 125) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected response {other:?}"),
        };
        let identity = VmIdentityRequest::by_generation(launched.generation.clone());
        assert!(matches!(
            core.handle(Request::StopVm(identity.clone())),
            Response::StopVm(_)
        ));
        assert!(core.backend.units.remove(&launched.unit_name).is_some());
        assert!(matches!(
            core.handle(Request::StopVm(identity.clone())),
            Response::StopVm(OperationResult { changed: false })
        ));
        assert_eq!(core.capabilities().committed_cpu_millis, 125);

        assert!(matches!(
            core.handle(Request::DestroyVm(identity)),
            Response::DestroyVm(_)
        ));
        assert_eq!(core.capabilities().committed_cpu_millis, 0);
        assert!(!core.records.contains_key(&launched.generation));
        assert_eq!(core.backend.destroyed_vm_networks.len(), 1);
    }

    #[test]
    fn destroy_refuses_a_populated_unit() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            FakeTemplatePreparer,
            125,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match launch_prepared_v2(&mut core, 1, 125) {
            Response::LaunchVmV2(value) => value,
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
            FakeTemplatePreparer,
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let request = prepare_launch_v2(&mut core, 1, 125);
        let first = match core.handle(Request::LaunchVmV2(Box::new(request.clone()))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected first launch response {other:?}"),
        };
        let second = match core.handle(Request::LaunchVmV2(Box::new(request.clone()))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected idempotent launch response {other:?}"),
        };
        assert_eq!(first.generation, second.generation);
        assert_eq!(core.capabilities().committed_cpu_millis, 125);

        let mut changed = request;
        changed.launch.cpu_millis = 126;
        let response = core.handle(Request::LaunchVmV2(Box::new(changed)));
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
        let request = prepare_launch_v2(&mut core, 1, 125);
        let launched = match core.handle(Request::LaunchVmV2(Box::new(request.clone()))) {
            Response::LaunchVmV2(value) => value,
            other => panic!("unexpected first launch response {other:?}"),
        };
        core.backend
            .units
            .get_mut(&launched.unit_name)
            .expect("fake unit")
            .pid_start_time_ticks = Some(8);

        let response = core.handle(Request::LaunchVmV2(Box::new(request)));
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
            FakeTemplatePreparer,
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);
        let launched = match launch_prepared_v2(&mut core, 1, 125) {
            Response::LaunchVmV2(value) => value,
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
            launch_prepared_v2(&mut core, 1, 125),
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

        let response = launch_prepared_v2(&mut core, 1, 125);
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

        let response = launch_prepared_v2(&mut core, 1, 125);
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
        assert_eq!(core.preparer.runtime_access_calls, 1);
    }

    #[test]
    fn runtime_socket_acl_failure_rolls_back_the_transient_unit() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut core = JailerdCore::new_with_readiness(
            config,
            FakeBackend::default(),
            TrackingPreparer {
                fail_runtime_access: true,
                ..TrackingPreparer::default()
            },
            1_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        let Response::Error(error) = launch_prepared_v2(&mut core, 1, 125) else {
            panic!("runtime socket ACL failure unexpectedly succeeded")
        };
        assert!(
            error
                .message
                .contains("injected runtime socket ACL failure")
        );
        assert!(core.records.is_empty());
        assert_eq!(core.preparer.runtime_access_calls, 1);
        assert_eq!(core.preparer.persist_calls, 1);
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
    }

    #[test]
    fn failed_launch_reports_every_rollback_failure() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
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
            2_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        let Response::Error(error) =
            core.handle(Request::LaunchVmV2(Box::new(launch_v2(1, 1_000))))
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
        assert_eq!(core.capabilities().committed_cpu_millis, 2_000);
        assert_eq!(core.pending_cpu_reservations.len(), 1);
        assert_eq!(core.unresolved_recoveries.len(), 1);

        core.backend.fail_stop_unit = false;
        core.backend.fail_destroy_unit = false;
        core.backend.fail_destroy_vm_network = false;
        core.preparer.fail_quarantine = false;
        assert_eq!(core.enforce_boot_deadlines().expect("retry cleanup"), 0);
        assert_eq!(core.capabilities().committed_cpu_millis, 0);
        assert!(core.pending_cpu_reservations.is_empty());
        assert!(core.unresolved_recoveries.is_empty());
    }

    #[test]
    fn drained_failed_launch_reports_network_and_quarantine_failures() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
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
            2_000,
            ready_readiness(),
        )
        .expect("core");
        ensure_test_network(&mut core);

        let Response::Error(error) =
            core.handle(Request::LaunchVmV2(Box::new(launch_v2(1, 1_000))))
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
        assert_eq!(core.capabilities().committed_cpu_millis, 0);
        assert_eq!(core.unresolved_recoveries.len(), 1);
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
            launch_prepared_v2(&mut core, 1, 125),
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
    fn durable_v2_metadata_requires_explicit_cpu_and_ingress_state() {
        let config = test_config();
        let record = recovered_record(&config);
        let encoded = serde_json::to_value(&record).expect("serialize v2 metadata");
        for required in [
            "schema_version",
            "steady_quota",
            "effective_quota",
            "cpu_phase",
            "boot_deadline_unix_ms",
            "quota_attestation",
            "ssh_forward_active",
        ] {
            let mut incomplete = encoded.clone();
            incomplete
                .as_object_mut()
                .expect("metadata object")
                .remove(required);
            let bytes = serde_json::to_vec(&incomplete).expect("encode incomplete metadata");
            assert!(
                decode_vm_record_v2(&bytes).is_err(),
                "missing required v2 field {required:?} was accepted"
            );
        }
    }

    #[test]
    fn legacy_metadata_shape_cannot_be_decoded_as_v2() {
        let config = test_config();
        let mut legacy = serde_json::to_value(recovered_record(&config))
            .expect("serialize legacy metadata shape");
        let object = legacy.as_object_mut().expect("metadata object");
        let legacy_quota = object
            .remove("steady_quota")
            .expect("serialized steady quota");
        object.insert("quota".to_owned(), legacy_quota);
        for field in [
            "schema_version",
            "effective_quota",
            "cpu_phase",
            "boot_deadline_unix_ms",
            "quota_attestation",
            "ssh_forward_active",
        ] {
            object.remove(field);
        }
        let bytes = serde_json::to_vec(&legacy).expect("encode legacy metadata shape");
        assert!(decode_vm_record_v2(&bytes).is_err());
    }

    #[test]
    fn recovery_contains_non_v2_metadata_without_restoring_ingress() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        let mut record = recovered_record(&config);
        record.schema_version = 1;
        let forwarding_key = (record.request.run_id.clone(), record.generation.clone());
        let mut backend = FakeBackend::default();
        backend
            .units
            .insert(record.unit_name.clone(), recovered_inspection(&record));
        backend.active_ssh_forwards.insert(forwarding_key);

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
        .expect("contain legacy recovery");

        assert!(core.records.is_empty());
        assert!(core.backend.active_ssh_forwards.is_empty());
        assert!(core.backend.ssh_forward_updates.is_empty());
        assert_eq!(core.backend.stopped_units, vec![record.unit_name.clone()]);
        assert_eq!(core.backend.destroyed_units, vec![record.unit_name]);
        assert_eq!(core.preparer.quarantined, vec![record.generation]);
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
    }

    #[test]
    fn recovery_starts_watchdog_and_accounts_boot_quota_when_containment_fails() {
        let mut config = test_config();
        config.cpu_reserved_millis = 0;
        config.boot_cpu_millis = 2_000;
        let mut record = recovered_record(&config);
        record.cpu_phase = VmCpuPhase::BootBurst;
        record.effective_quota = CpuQuota::from_millis(2_000).expect("boot quota");
        record.boot_deadline_unix_ms = Some(u64::MAX);
        record.quota_attestation = None;
        record.ssh_forward_active = false;
        let mut backend = FakeBackend {
            fail_quota_update: true,
            fail_stop_unit: true,
            fail_destroy_unit: true,
            ..FakeBackend::default()
        };
        backend
            .units
            .insert(record.unit_name.clone(), recovered_inspection(&record));
        let mut core = JailerdCore::new_with_readiness(
            config,
            backend,
            RecoverPreparer {
                records: vec![record.clone()],
                ..RecoverPreparer::default()
            },
            4_000,
            ready_readiness(),
        )
        .expect("recovery must retain a live watchdog");

        assert!(core.records.is_empty());
        assert_eq!(core.capabilities().committed_cpu_millis, 2_000);
        assert_eq!(core.pending_cpu_reservations.len(), 1);
        assert!(core.unresolved_recoveries.contains_key(&record.generation));

        core.backend.fail_quota_update = false;
        core.backend.fail_stop_unit = false;
        core.backend.fail_destroy_unit = false;
        assert_eq!(core.enforce_boot_deadlines().expect("retry containment"), 0);
        assert_eq!(core.capabilities().committed_cpu_millis, 0);
        assert!(core.pending_cpu_reservations.is_empty());
        assert!(core.unresolved_recoveries.is_empty());
        assert!(!core.backend.units.contains_key(&record.unit_name));
        assert!(core.preparer.quarantined.contains(&record.generation));
    }

    #[test]
    fn transient_unit_properties_encode_hard_quota_and_safety() {
        let quota = CpuQuota::from_millis(125).expect("quota");
        let generation = ValidatedId::parse("test").expect("generation");
        let spec = UnitLaunchSpec {
            generation,
            unit_name: "intar-vm-test.service".to_owned(),
            description: "test".to_owned(),
            jailer_binary: "/intar-jailer".into(),
            jail_spec_path: "/spec".into(),
            api_socket_path: "/api.sock".into(),
            cpu_quota: quota,
            steady_cpu_quota: quota,
            boot_cpu_lease_ms: Some(45_000),
            vmm_executable_identity: None,
            uid: 200_000,
            gid: 200_000,
            device_allow: vec!["/dev/kvm rw"],
        };
        let properties = spec.required_properties();
        assert_eq!(properties["CPUQuotaPerSecUSec"], "125000");
        assert_eq!(properties["CPUQuotaPeriodUSec"], "100000");
        assert_eq!(properties["KillMode"], "control-group");
        assert_eq!(properties["RestrictRealtime"], "yes");
        assert_eq!(properties["BindsTo"], "intar-vm-boot-lease-test.service");
    }

    #[test]
    fn boot_cpu_guardian_unit_is_generation_bound_typed_and_hardened() {
        let generation = ValidatedId::parse("generation-1").expect("generation");
        let quota = CpuQuota::from_millis(1_000).expect("steady quota");
        let request = BootCpuGuardianRequest::new(
            generation.clone(),
            vm_unit_name(&generation),
            quota,
            123_456,
        )
        .expect("guardian request");
        let unit =
            BootCpuGuardianUnitSpec::new(PathBuf::from("/usr/lib/intar/intar-jailerd"), request)
                .expect("guardian unit");
        assert_eq!(unit.unit_name, "intar-vm-boot-lease-generation-1.service");
        assert_eq!(
            vm_cgroup_path(unit.request.unit_name()),
            PathBuf::from("/intar.slice/intar-vms.slice/intar-vm-generation-1.service")
        );
        assert_eq!(
            unit.command_argv(),
            vec![
                "/usr/lib/intar/intar-jailerd",
                "boot-cpu-lease-guardian",
                "--generation",
                "generation-1",
                "--unit-name",
                "intar-vm-generation-1.service",
                "--steady-cpu-millis",
                "1000",
                "--deadline-uptime-millis",
                "123456",
            ]
        );
        let properties = unit.required_properties();
        assert_eq!(properties["Type"], "oneshot");
        assert_eq!(properties["RemainAfterExit"], "yes");
        assert_eq!(properties["PartOf"], "intar-vm-generation-1.service");
        assert_eq!(properties["User"], "root");
        assert_eq!(properties["NoNewPrivileges"], "yes");
        assert_eq!(properties["ProtectSystem"], "strict");
        assert_eq!(properties["ProtectControlGroups"], "no");
        assert_eq!(properties["CapabilityBoundingSet"], "0");

        let mismatch = BootCpuGuardianRequest::new(
            generation,
            "intar-vm-other.service".to_owned(),
            quota,
            123_456,
        )
        .expect_err("cross-generation guardian must fail");
        assert!(mismatch.to_string().contains("unit mismatch"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn boot_cpu_guardian_encodes_namespace_lockdown_as_systemd_uint64_mask() {
        let value = restrict_all_namespaces_dbus_value();
        assert_eq!(value.value_signature(), "t");
    }

    #[test]
    fn hard_cpu_lease_uses_a_monotonic_deadline_and_attests_steady_quota() {
        let root = tempfile::tempdir().expect("temporary cgroup root");
        let cgroup = Path::new("/intar.slice/intar-vms.slice/intar-vm-test.service");
        let directory = root
            .path()
            .join(cgroup.strip_prefix("/").expect("relative"));
        std::fs::create_dir_all(&directory).expect("fake cgroup");
        std::fs::write(directory.join("cpu.max"), "200000 100000").expect("write boot quota");
        std::fs::write(directory.join("cpu.max.burst"), "0").expect("write boot burst");
        let steady = CpuQuota::from_millis(1_000).expect("steady quota");
        let started = Instant::now();
        let deadline = started + Duration::from_millis(10);

        seal_cpu_controller_at_deadline(root.path(), cgroup, steady, deadline)
            .expect("seal fake controller");

        assert!(started.elapsed() >= Duration::from_millis(10));
        assert_cpu_quota_at(root.path(), cgroup, steady).expect("attest fake controller");
    }

    #[test]
    fn guardian_uses_absolute_uptime_deadline_and_attests_fake_cgroup() {
        assert_eq!(
            parse_proc_uptime_millis("123.45 678.90\n").expect("parse uptime"),
            123_450
        );
        assert_eq!(
            parse_proc_uptime_millis("7 9\n").expect("parse whole uptime"),
            7_000
        );
        let proc = tempfile::tempdir().expect("fake proc root");
        let uptime_path = proc.path().join("uptime");
        std::fs::write(&uptime_path, "42.007 99.0\n").expect("write fake uptime");
        assert_eq!(
            proc_uptime_millis_at(&uptime_path).expect("read fake uptime"),
            42_007
        );

        let root = tempfile::tempdir().expect("temporary cgroup root");
        let cgroup = Path::new("/intar.slice/intar-vms.slice/intar-vm-generation-1.service");
        let directory = root
            .path()
            .join(cgroup.strip_prefix("/").expect("relative cgroup"));
        std::fs::create_dir_all(&directory).expect("fake cgroup");
        std::fs::write(directory.join("cpu.max"), "200000 100000").expect("write boot quota");
        std::fs::write(directory.join("cpu.max.burst"), "50000").expect("write stale burst");

        let uptime = std::cell::Cell::new(10_000_u64);
        let sleeps = std::cell::Cell::new(0_u32);
        wait_until_uptime_deadline_with(
            10_045,
            || Ok(uptime.get()),
            |duration| {
                sleeps.set(sleeps.get() + 1);
                let requested = u64::try_from(duration.as_millis()).expect("duration");
                uptime.set(uptime.get() + (requested / 2).max(1));
            },
        )
        .expect("wait for absolute deadline");
        assert!(uptime.get() >= 10_045);
        assert!(
            sleeps.get() > 1,
            "deadline must be re-read after early wakeups"
        );

        let steady = CpuQuota::from_millis(1_000).expect("steady quota");
        // Fake the successful SetUnitProperties mutation, then exercise the
        // guardian's burst reset and exact readback attestation.
        std::fs::write(directory.join("cpu.max"), steady.cpu_max()).expect("write steady quota");
        clear_cpu_burst_and_attest_at(root.path(), cgroup, steady)
            .expect("attest fake guardian seal");
        assert_eq!(
            std::fs::read_to_string(directory.join("cpu.max.burst")).expect("read burst"),
            "0"
        );
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
    fn unit_operation_accepts_only_a_confirmed_mid_operation_disappearance() {
        assert!(is_unit_disappeared_name(
            UnitCallSite::Manager,
            "org.freedesktop.systemd1.NoSuchUnit"
        ));
        assert!(is_unit_disappeared_name(
            UnitCallSite::ObjectProperty,
            "org.freedesktop.DBus.Error.UnknownObject"
        ));
        assert!(is_unit_disappeared_name(
            UnitCallSite::ObjectProperty,
            "org.freedesktop.systemd1.NoSuchUnit"
        ));
        for name in [
            "org.freedesktop.DBus.Error.UnknownInterface",
            "org.freedesktop.DBus.Error.UnknownProperty",
            "org.freedesktop.DBus.Error.AccessDenied",
            "org.freedesktop.DBus.Error.NoReply",
            "org.freedesktop.systemd1.LoadFailed",
        ] {
            assert!(!is_unit_disappeared_name(UnitCallSite::Manager, name));
            assert!(!is_unit_disappeared_name(
                UnitCallSite::ObjectProperty,
                name
            ));
        }

        assert_eq!(
            settle_unit_operation(
                Ok(7_u8),
                UnitCallSite::Manager,
                || panic!("successful call must not recheck"),
                "stop"
            )
            .expect("successful operation"),
            Some(7)
        );
        let disappeared = || {
            zbus::Error::FDO(Box::new(zbus::fdo::Error::UnknownObject(
                "injected disappearance".to_owned(),
            )))
        };
        assert_eq!(
            settle_unit_operation(
                Err(disappeared()),
                UnitCallSite::ObjectProperty,
                || Ok(false),
                "stop",
            )
            .expect("confirmed disappearance"),
            None::<u8>
        );

        let existing = settle_unit_operation::<u8>(
            Err(disappeared()),
            UnitCallSite::ObjectProperty,
            || Ok(true),
            "stop transient unit",
        )
        .expect_err("a live unit must preserve the original error");
        assert!(format!("{existing:#}").contains("injected disappearance"));

        let unknown = settle_unit_operation::<u8>(
            Err(disappeared()),
            UnitCallSite::ObjectProperty,
            || bail!("injected recheck failure"),
            "stop transient unit",
        )
        .expect_err("an inconclusive recheck must fail closed");
        assert!(format!("{unknown:#}").contains("injected recheck failure"));

        let unrelated = settle_unit_operation::<u8>(
            Err(zbus::Error::Failure("injected D-Bus error".to_owned())),
            UnitCallSite::Manager,
            || panic!("unrelated errors must not be reclassified"),
            "stop transient unit",
        )
        .expect_err("an unrelated D-Bus failure must fail closed");
        assert!(format!("{unrelated:#}").contains("injected D-Bus error"));
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
            // Existing lifecycle tests isolate steady-capacity behavior. Boot
            // lease tests override this with the production 2000m default.
            boot_cpu_millis: 125,
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

    #[test]
    fn typed_run_network_repair_requires_and_preserves_durable_identity() {
        let mut core = JailerdCore::new_with_readiness(
            test_config(),
            FakeBackend::default(),
            FakePreparer,
            4_000,
            ready_readiness(),
        )
        .expect("core");
        let request = EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run").expect("run ID"),
            guest_cidr: "10.77.0.0/28".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        };

        assert!(matches!(
            core.handle(Request::RepairRunNetwork(request.clone())),
            Response::Error(ProtocolError { ref code, .. }) if code == "host_operation_failed"
        ));
        assert!(core.backend.run_network_repairs.is_empty());

        let ensured = core.handle(Request::EnsureRunNetwork(request.clone()));
        let Response::EnsureRunNetwork(expected) = ensured else {
            panic!("unexpected ensure response: {ensured:?}");
        };
        assert_eq!(
            core.handle(Request::RepairRunNetwork(request.clone())),
            Response::RepairRunNetwork(expected)
        );
        assert_eq!(
            core.backend.run_network_repairs,
            vec![request.run_id.clone()]
        );

        let mut drifted = request;
        drifted.gateway = "10.77.0.2".to_owned();
        assert!(matches!(
            core.handle(Request::RepairRunNetwork(drifted)),
            Response::Error(ProtocolError { ref code, .. }) if code == "invalid_request"
        ));
        assert_eq!(core.backend.run_network_repairs.len(), 1);
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
            root_disk_size_bytes: 4 * 1024 * 1024 * 1024,
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

    fn launch_v2(index: u32, cpu_millis: u32) -> LaunchVmV2Request {
        let image_sha256 = Sha256Digest::parse("d".repeat(64)).expect("image digest");
        let artifact_sha256 = Sha256Digest::parse("e".repeat(64)).expect("artifact digest");
        let mut launch = launch(index, cpu_millis);
        launch.artifacts.root_disk = template_artifact_source(
            &image_sha256,
            "root.raw",
            &artifact_sha256,
            ArtifactAccess::ReadWrite,
        );
        launch.artifacts.kernel = template_artifact_source(
            &image_sha256,
            "kernel",
            &artifact_sha256,
            ArtifactAccess::ReadOnly,
        );
        LaunchVmV2Request {
            image_sha256,
            virtual_size_bytes: 4 * 1024 * 1024 * 1024,
            launch,
        }
    }

    fn prepare_launch_v2<P: JailPreparer>(
        core: &mut JailerdCore<FakeBackend, P>,
        index: u32,
        cpu_millis: u32,
    ) -> LaunchVmV2Request {
        let image_sha256 = Sha256Digest::parse("d".repeat(64)).expect("image digest");
        let prepare = PrepareImageV2Request {
            image_sha256,
            virtual_size_bytes: 4 * 1024 * 1024 * 1024,
            root_disk: source("/trusted/root.raw", ArtifactAccess::ReadOnly),
            kernel: source("/trusted/kernel", ArtifactAccess::ReadOnly),
            initrd: None,
        };
        let prepared = match core.handle(Request::PrepareImageV2(Box::new(prepare))) {
            Response::PrepareImageV2(prepared) => prepared,
            other => panic!("unexpected prepared-image response: {other:?}"),
        };
        let mut launch = launch(index, cpu_millis);
        launch.root_disk_size_bytes = prepared.virtual_size_bytes;
        launch.artifacts.root_disk = prepared.root_disk;
        launch.artifacts.kernel = prepared.kernel;
        launch.artifacts.initrd = prepared.initrd;
        LaunchVmV2Request {
            image_sha256: prepared.image_sha256,
            virtual_size_bytes: prepared.virtual_size_bytes,
            launch,
        }
    }

    fn launch_prepared_v2<P: JailPreparer>(
        core: &mut JailerdCore<FakeBackend, P>,
        index: u32,
        cpu_millis: u32,
    ) -> Response {
        let request = prepare_launch_v2(core, index, cpu_millis);
        core.handle(Request::LaunchVmV2(Box::new(request)))
    }

    fn recovered_record(config: &JailerdConfig) -> VmRecord {
        let request = launch(1, 125);
        let generation = ValidatedId::parse("recovered-generation").expect("generation");
        let root = generation_directory(config, &generation).join("root");
        let quota = CpuQuota::from_millis(request.cpu_millis).expect("quota");
        VmRecord {
            schema_version: VM_RECORD_METADATA_VERSION,
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
            effective_quota: quota,
            cpu_phase: VmCpuPhase::Steady,
            boot_deadline_unix_ms: None,
            boot_deadline_monotonic: None,
            quota_attestation: None,
            ssh_forward_active: true,
            vcpu_count: request.vcpu_count,
            paths: jail_paths(&root, request.artifacts.initrd.is_some()),
            cgroup_path: Some(
                format!("/intar.slice/intar-vms.slice/intar-vm-{generation}.service").into(),
            ),
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
