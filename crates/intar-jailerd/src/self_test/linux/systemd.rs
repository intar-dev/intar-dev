use super::*;

pub(super) fn cleanup_smoke_vms(
    core: &mut JailerdCore<SystemdHostBackend, FileSystemJailPreparer>,
    selectors: &[VmIdentityRequest],
    run_id: &ValidatedId,
) -> Result<()> {
    let mut failures = Vec::new();
    for (index, selector) in selectors.iter().enumerate() {
        match core.handle(Request::StopVm(selector.clone())) {
            Response::StopVm(_) => {}
            Response::Error(error) => failures.push(format!(
                "stop package-smoke VM {index} failed: {}: {}",
                error.code, error.message
            )),
            response => {
                failures.push(format!(
                    "unexpected stop response for VM {index}: {response:?}"
                ));
            }
        }

        // StopVm synchronously proves that the complete unit cgroup has
        // drained. systemd may garbage-collect the inactive transient unit
        // immediately afterwards, so an intervening InspectVm is racy and
        // cannot add a stronger proof. DestroyVm is the final authority: it
        // accepts an already-absent unit but still refuses a populated one.
        match core.handle(Request::DestroyVm(selector.clone())) {
            Response::DestroyVm(_) => {}
            Response::Error(error) => failures.push(format!(
                "destroy package-smoke VM {index} failed: {}: {}",
                error.code, error.message
            )),
            response => {
                failures.push(format!(
                    "unexpected destroy response for VM {index}: {response:?}"
                ));
            }
        }
    }
    match core.handle(Request::DestroyRunNetwork(DestroyRunNetworkRequest {
        run_id: run_id.clone(),
    })) {
        Response::DestroyRunNetwork(_) => {}
        Response::Error(error) => failures.push(format!(
            "destroy package-smoke network failed: {}: {}",
            error.code, error.message
        )),
        response => {
            failures.push(format!("unexpected destroy-network response: {response:?}"));
        }
    }
    let remaining_cpu_millis = core.capabilities().committed_cpu_millis;
    if remaining_cpu_millis != 0 {
        failures.push(format!(
            "package-smoke cleanup retained {remaining_cpu_millis} millicores of VM reservations"
        ));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        bail!("{}", failures.join("; "))
    }
}

pub(super) fn path_utf8(path: &Path) -> Result<String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .context("Cloud Hypervisor jail path is not valid UTF-8")
}

#[derive(Clone, Debug)]
pub(super) struct UnitState {
    pub(super) main_pid: u32,
    pub(super) control_group: String,
}

pub(super) fn start_worker_unit(
    unit_name: &str,
    executable: &Path,
    report: &Path,
    allowed_dir: &Path,
    denied_path: &Path,
    netns_path: &Path,
    boot_cpu_millis: u32,
) -> Result<()> {
    let connection = zbus::blocking::Connection::system()?;
    let manager = systemd_manager(&connection)?;
    let executable = executable.to_string_lossy().into_owned();
    let arguments = vec![
        executable.clone(),
        "self-test-worker".to_owned(),
        "--report".to_owned(),
        report.to_string_lossy().into_owned(),
        "--allowed-dir".to_owned(),
        allowed_dir.to_string_lossy().into_owned(),
        "--denied-path".to_owned(),
        denied_path.to_string_lossy().into_owned(),
    ];
    let exec_start = vec![(executable, arguments, false)];
    let device_allow = vec![
        ("/dev/kvm".to_owned(), "rw".to_owned()),
        ("/dev/urandom".to_owned(), "r".to_owned()),
        ("/dev/null".to_owned(), "rw".to_owned()),
    ];
    let properties = vec![
        (
            "Description",
            Value::new("Intar disposable jailer self-test"),
        ),
        ("Slice", Value::new("intar-vms.slice")),
        ("Type", Value::new("simple")),
        ("ExecStart", Value::new(exec_start)),
        ("CPUAccounting", Value::new(true)),
        (
            "CPUQuotaPerSecUSec",
            Value::new(u64::from(boot_cpu_millis) * 1_000),
        ),
        ("CPUQuotaPeriodUSec", Value::new(SELF_TEST_CPU_PERIOD_US)),
        ("KillMode", Value::new("control-group")),
        ("Restart", Value::new("no")),
        ("ExitType", Value::new("cgroup")),
        ("RestrictRealtime", Value::new(true)),
        ("LimitRTPRIO", Value::new(0_u64)),
        ("DevicePolicy", Value::new("closed")),
        ("DeviceAllow", Value::new(device_allow)),
        ("CapabilityBoundingSet", Value::new(0_u64)),
        ("AmbientCapabilities", Value::new(0_u64)),
        ("NoNewPrivileges", Value::new(true)),
        (
            "NetworkNamespacePath",
            Value::new(netns_path.to_string_lossy().into_owned()),
        ),
    ];
    let auxiliary: Vec<(&str, Vec<(&str, Value<'_>)>)> = Vec::new();
    let _: OwnedObjectPath = manager.call(
        "StartTransientUnit",
        &(unit_name, "fail", properties, auxiliary),
    )?;
    Ok(())
}

pub(super) fn update_worker_cpu_quota(unit_name: &str, cpu_millis: u32) -> Result<()> {
    let connection = zbus::blocking::Connection::system()?;
    let manager = systemd_manager(&connection)?;
    let properties = vec![
        (
            "CPUQuotaPerSecUSec",
            Value::new(u64::from(cpu_millis) * 1_000),
        ),
        ("CPUQuotaPeriodUSec", Value::new(SELF_TEST_CPU_PERIOD_US)),
    ];
    let _: () = manager
        .call("SetUnitProperties", &(unit_name, true, properties))
        .with_context(|| format!("set self-test CPU quota for {unit_name}"))?;
    Ok(())
}

pub(super) fn wait_for_worker_report(
    unit_name: &str,
    report_path: &Path,
    timeout: Duration,
) -> Result<UnitState> {
    let deadline = Instant::now() + timeout;
    loop {
        let state = inspect_unit(unit_name)?;
        if report_path.is_file() && state.main_pid != 0 && !state.control_group.is_empty() {
            return Ok(state);
        }
        if Instant::now() >= deadline {
            bail!("timed out waiting for self-test worker report")
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub(super) fn inspect_unit(unit_name: &str) -> Result<UnitState> {
    let connection = zbus::blocking::Connection::system()?;
    let manager = systemd_manager(&connection)?;
    let path: OwnedObjectPath = manager.call("GetUnit", &(unit_name,))?;
    let unit = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.systemd1",
        path,
        "org.freedesktop.systemd1.Unit",
    )?;
    let service = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.systemd1",
        unit.path(),
        "org.freedesktop.systemd1.Service",
    )?;
    let control_group: String = service.get_property("ControlGroup")?;
    let main_pid: u32 = service.get_property("MainPID")?;
    Ok(UnitState {
        main_pid,
        control_group,
    })
}

pub(super) fn stop_and_reset_unit(unit_name: &str) -> Result<()> {
    let connection = zbus::blocking::Connection::system()?;
    let manager = systemd_manager(&connection)?;
    let _: Result<OwnedObjectPath, _> = manager.call("StopUnit", &(unit_name, "replace"));
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut observed_stopped = false;
    loop {
        let path: Result<OwnedObjectPath, _> = manager.call("GetUnit", &(unit_name,));
        let Ok(path) = path else {
            return Ok(());
        };
        let unit = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.systemd1",
            path,
            "org.freedesktop.systemd1.Unit",
        )?;
        let active: String = unit.get_property("ActiveState")?;
        if matches!(active.as_str(), "inactive" | "failed") {
            let _: Result<(), _> = manager.call("ResetFailedUnit", &(unit_name,));
            observed_stopped = true;
        }
        ensure!(
            Instant::now() < deadline,
            if observed_stopped {
                "self-test unit stopped but was not removed"
            } else {
                "timed out stopping self-test unit"
            }
        );
        thread::sleep(Duration::from_millis(50));
    }
}

pub(super) fn systemd_manager<'a>(
    connection: &'a zbus::blocking::Connection,
) -> Result<zbus::blocking::Proxy<'a>> {
    Ok(zbus::blocking::Proxy::new(
        connection,
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
    )?)
}

pub(super) fn read_systemd_version() -> Result<String> {
    let connection = zbus::blocking::Connection::system()?;
    systemd_manager(&connection)?
        .get_property("Version")
        .context("read systemd version")
}

pub(super) fn cgroup_directory(control_group: &str) -> Result<PathBuf> {
    ensure!(
        control_group.starts_with('/'),
        "invalid systemd control group"
    );
    ensure!(
        !control_group.split('/').any(|part| part == ".."),
        "invalid systemd control group"
    );
    Ok(Path::new("/sys/fs/cgroup").join(control_group.trim_start_matches('/')))
}

pub(super) fn assert_cpu_quota(directory: &Path) -> Result<()> {
    assert_cpu_quota_millis(directory, SELF_TEST_CPU_MILLIS)
}

pub(super) fn assert_cpu_quota_millis(directory: &Path, cpu_millis: u32) -> Result<()> {
    let quota_micros = u64::from(cpu_millis)
        .checked_mul(SELF_TEST_CPU_PERIOD_US)
        .context("self-test CPU quota arithmetic overflow")?
        / 1_000;
    let cpu_max = std::fs::read_to_string(directory.join("cpu.max"))?;
    ensure!(
        cpu_max.trim() == format!("{quota_micros} {SELF_TEST_CPU_PERIOD_US}"),
        "self-test cpu.max mismatch: {}",
        cpu_max.trim()
    );
    let burst = std::fs::read_to_string(directory.join("cpu.max.burst"))?;
    ensure!(burst.trim() == "0", "self-test cpu.max.burst is not zero");
    ensure!(
        SELF_TEST_CPU_QUOTA_US == u64::from(SELF_TEST_CPU_MILLIS) * SELF_TEST_CPU_PERIOD_US / 1_000
    );
    Ok(())
}

pub(super) fn wait_for_throttling(directory: &Path, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let cpu_stat = std::fs::read_to_string(directory.join("cpu.stat"))?;
        let values = parse_cpu_stat(&cpu_stat);
        if values.get("nr_throttled").copied().unwrap_or_default() > 0 {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "CPU quota did not throttle busy worker"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

pub(super) fn parse_cpu_stat(contents: &str) -> BTreeMap<&str, u64> {
    contents
        .lines()
        .filter_map(|line| line.split_once(' '))
        .filter_map(|(name, value)| value.parse().ok().map(|value| (name, value)))
        .collect()
}

pub(super) fn ensure_unit_tasks_accounted(unit: &UnitState, cgroup: &Path) -> Result<()> {
    let processes = read_id_set(&cgroup.join("cgroup.procs"))?;
    ensure!(
        processes.contains(&unit.main_pid),
        "self-test main process is outside its unit cgroup"
    );
    for entry in std::fs::read_dir(format!("/proc/{}/task", unit.main_pid))? {
        let tid: u32 = entry?
            .file_name()
            .to_string_lossy()
            .parse()
            .context("parse self-test task ID")?;
        let task_cgroup = std::fs::read_to_string(format!("/proc/{tid}/cgroup"))?;
        ensure!(
            task_cgroup
                .lines()
                .any(|line| line == format!("0::{}", unit.control_group)),
            "self-test task {tid} escaped the VM cgroup"
        );
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub(super) struct TaskSnapshot {
    pub(super) ids: BTreeSet<u32>,
}

pub(super) fn snapshot_tasks() -> Result<TaskSnapshot> {
    let mut ids = BTreeSet::new();
    for process in std::fs::read_dir("/proc")? {
        let process = process?;
        let Ok(pid) = process.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(tasks) = std::fs::read_dir(process.path().join("task")) else {
            continue;
        };
        for task in tasks.flatten() {
            if let Ok(tid) = task.file_name().to_string_lossy().parse() {
                ids.insert(tid);
            }
        }
        ids.insert(pid);
    }
    Ok(TaskSnapshot { ids })
}

pub(super) fn prove_kvm_accounting(
    before: &TaskSnapshot,
    unit: &UnitState,
    cgroup: &Path,
) -> Result<bool> {
    let cgroup_threads = read_id_set(&cgroup.join("cgroup.threads"))?;
    ensure!(
        !cgroup_threads.is_empty(),
        "self-test unit has no accounted threads"
    );
    let after = snapshot_tasks()?;
    let newly_observed = after
        .ids
        .difference(&before.ids)
        .copied()
        .collect::<Vec<_>>();
    let mut saw_worker = false;
    for tid in newly_observed {
        let Ok(name) = std::fs::read_to_string(format!("/proc/{tid}/comm")) else {
            continue;
        };
        let name = name.trim();
        let attributable = name == "intar-kvm-test"
            || name.starts_with("kvm-")
            || name.starts_with("vhost-")
            || name.contains("kvm-pit");
        if !attributable {
            continue;
        }
        if name == "intar-kvm-test" {
            saw_worker = true;
        }
        if !cgroup_threads.contains(&tid) {
            return Ok(false);
        }
    }
    Ok(saw_worker && cgroup_threads.contains(&unit.main_pid))
}

pub(super) fn read_id_set(path: &Path) -> Result<BTreeSet<u32>> {
    Ok(std::fs::read_to_string(path)?
        .lines()
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()?)
}

pub(super) fn wait_for_cgroup_drain(directory: &Path, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let mut observed_drained = false;
    loop {
        if !directory.exists() {
            return Ok(());
        }
        let events = std::fs::read_to_string(directory.join("cgroup.events"))?;
        observed_drained |= events
            .lines()
            .any(|line| line.split_whitespace().eq(["populated", "0"]));
        ensure!(
            Instant::now() < deadline,
            if observed_drained {
                "self-test cgroup drained but was not removed"
            } else {
                "self-test cgroup did not drain"
            }
        );
        thread::sleep(Duration::from_millis(50));
    }
}
