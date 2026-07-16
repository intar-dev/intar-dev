#[cfg(any(target_os = "linux", test))]
use super::*;

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum UnitCallSite {
    Manager,
    ObjectProperty,
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn is_unit_disappeared_name(site: UnitCallSite, name: &str) -> bool {
    match site {
        UnitCallSite::Manager => name == "org.freedesktop.systemd1.NoSuchUnit",
        UnitCallSite::ObjectProperty => matches!(
            name,
            "org.freedesktop.DBus.Error.UnknownObject" | "org.freedesktop.systemd1.NoSuchUnit"
        ),
    }
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn is_unit_disappeared_error(site: UnitCallSite, error: &zbus::Error) -> bool {
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
pub(super) fn settle_unit_operation<T>(
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
pub(super) fn minimum_jailer_capability_mask() -> u64 {
    // CAP_CHOWN, CAP_DAC_OVERRIDE, CAP_SETGID, CAP_SETUID, CAP_SETPCAP, CAP_SYS_CHROOT,
    // CAP_SYS_ADMIN, CAP_SYS_RESOURCE, and CAP_MKNOD. The VMM drops every set.
    [0_u32, 1, 6, 7, 8, 18, 21, 24, 27]
        .into_iter()
        .fold(0_u64, |mask, bit| mask | (1_u64 << bit))
}

#[cfg(target_os = "linux")]
pub(super) fn wait_cgroup_drained(control_group: &str, timeout: Duration) -> Result<bool> {
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
pub(super) fn ping_cloud_hypervisor(socket: &Path) -> Result<()> {
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
pub(super) fn read_cpu_stat(control_group: &str) -> Result<CpuStat> {
    read_cpu_stat_path(Path::new(control_group))
}

#[cfg(target_os = "linux")]
pub(super) fn read_cpu_stat_path(control_group: &Path) -> Result<CpuStat> {
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
pub(super) fn assert_cpu_quota(control_group: &Path, quota: CpuQuota) -> Result<()> {
    assert_cpu_quota_at(Path::new("/sys/fs/cgroup"), control_group, quota)
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn assert_cpu_quota_at(
    cgroup_root: &Path,
    control_group: &Path,
    quota: CpuQuota,
) -> Result<()> {
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
pub(super) fn clear_cpu_burst_and_attest_at(
    cgroup_root: &Path,
    control_group: &Path,
    quota: CpuQuota,
) -> Result<()> {
    let relative = control_group.strip_prefix("/").unwrap_or(control_group);
    std::fs::write(cgroup_root.join(relative).join("cpu.max.burst"), "0")?;
    assert_cpu_quota_at(cgroup_root, control_group, quota)
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn parse_proc_uptime_millis(contents: &str) -> Result<u64> {
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
pub(super) fn proc_uptime_millis_at(path: &Path) -> Result<u64> {
    let contents = std::fs::read_to_string(path)
        .with_context(|| format!("read monotonic uptime from {}", path.display()))?;
    parse_proc_uptime_millis(&contents)
}

#[cfg(target_os = "linux")]
pub(super) fn proc_uptime_millis() -> Result<u64> {
    proc_uptime_millis_at(Path::new("/proc/uptime"))
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn wait_until_uptime_deadline_with<R, S>(
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
pub(super) fn wait_until_uptime_deadline(deadline_uptime_millis: u64) -> Result<()> {
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
pub(super) fn spawn_hard_cpu_seal(
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
pub(super) fn seal_cpu_controller_at_deadline(
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
pub(super) fn read_pid_start_time_ticks(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    fields.split_whitespace().nth(19)?.parse().ok()
}

#[cfg(target_os = "linux")]
pub(super) fn process_network_namespace_inode(pid: u32) -> Option<u64> {
    use std::os::unix::fs::MetadataExt as _;

    std::fs::metadata(format!("/proc/{pid}/ns/net"))
        .ok()
        .map(|metadata| metadata.ino())
}

#[cfg(target_os = "linux")]
pub(super) fn process_root_inode(pid: u32) -> Option<u64> {
    use std::os::unix::fs::MetadataExt as _;

    std::fs::metadata(format!("/proc/{pid}/root"))
        .ok()
        .map(|metadata| metadata.ino())
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn capability_set_contains(status: &str, field: &str, capability_bit: u32) -> bool {
    status
        .lines()
        .find_map(|line| line.strip_prefix(field))
        .map(str::trim)
        .and_then(|value| u64::from_str_radix(value, 16).ok())
        .is_some_and(|mask| mask & (1_u64 << capability_bit) != 0)
}

#[cfg(target_os = "linux")]
pub(super) fn require_supervisor_process_inspection_capability() -> Result<()> {
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
pub(super) fn error_has_io_kind(error: &anyhow::Error, kind: std::io::ErrorKind) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == kind)
    })
}

#[cfg(target_os = "linux")]
pub(super) fn find_verified_vmm_pid(
    control_group: &str,
    expected: &Sha256Digest,
) -> Result<Option<u32>> {
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
pub(super) fn find_vmm_pid_by_identity(
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
pub(super) fn reader_digest_matches(mut reader: File, expected: &Sha256Digest) -> Result<bool> {
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
pub(super) struct ProcessSecurity {
    seccomp_enabled: bool,
    no_new_privs: bool,
    capabilities_empty: bool,
}

#[cfg(target_os = "linux")]
pub(super) fn inspect_process_security(pid: u32) -> Result<ProcessSecurity> {
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
pub(super) fn read_trimmed(path: &str) -> Result<String> {
    Ok(std::fs::read_to_string(path)?.trim().to_owned())
}

#[cfg(target_os = "linux")]
pub(super) fn systemd_version() -> Option<String> {
    let connection = zbus::blocking::Connection::system().ok()?;
    let manager = SystemdHostBackend::manager(&connection).ok()?;
    manager.get_property("Version").ok()
}

#[cfg(target_os = "linux")]
pub(super) fn systemd_major_version(value: &str) -> Option<u32> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| !part.is_empty())?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
pub(super) fn identity_range_is_free(config: &JailerdConfig) -> bool {
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
pub(super) fn path_is_root_trusted(path: &Path, require_directory: bool) -> bool {
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
pub(super) fn path_is_trusted_source_root(path: &Path, agent_uid: u32, agent_gid: u32) -> bool {
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
pub(super) fn trusted_root_ancestors(path: &Path) -> bool {
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
pub(super) fn file_digest_matches(path: &Path, expected: &Sha256Digest) -> bool {
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
pub(super) fn elf_has_no_interpreter(path: &Path) -> bool {
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
