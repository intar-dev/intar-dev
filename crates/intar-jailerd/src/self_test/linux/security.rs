use super::*;

pub(super) fn assert_smoke_vsock_socket(
    config: &JailerdConfig,
    launch: &VmLaunchResult,
) -> Result<()> {
    let jail_root = open(
        &config.jail_root,
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .context("pin trusted jail root for vsock validation")?;
    let generation_root = PathBuf::from("cloud-hypervisor")
        .join(launch.generation.as_str())
        .join("root");
    let root = openat2(
        &jail_root,
        &generation_root,
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_XDEV,
    )
    .context("pin package-smoke jail root for vsock validation")?;
    let root_stat = rustix::fs::fstat(&root)?;
    ensure!(
        launch
            .jail_root_inode
            .is_some_and(|inode| inode == root_stat.st_ino),
        "package-smoke jail root inode changed"
    );
    let run = openat2(
        &root,
        "run",
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_XDEV,
    )
    .context("pin package-smoke runtime directory")?;
    let run_stat = rustix::fs::fstat(&run)?;
    ensure!(
        rustix::fs::FileType::from_raw_mode(run_stat.st_mode) == rustix::fs::FileType::Directory
            && run_stat.st_uid == launch.uid
            && run_stat.st_gid == launch.gid
            && run_stat.st_nlink >= 1
            && run_stat.st_mode & 0o700 == 0o700
            && run_stat.st_mode & 0o007 == 0,
        "package-smoke runtime directory has unsafe metadata"
    );
    let socket = openat2(
        &run,
        "kino.vsock",
        OFlags::PATH | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_XDEV,
    )
    .context("pin package-smoke Cloud Hypervisor vsock")?;
    let socket_stat = rustix::fs::fstat(&socket)?;
    ensure!(
        rustix::fs::FileType::from_raw_mode(socket_stat.st_mode) == rustix::fs::FileType::Socket
            && socket_stat.st_uid == launch.uid
            && socket_stat.st_gid == launch.gid
            && socket_stat.st_nlink == 1
            && socket_stat.st_mode & 0o007 == 0,
        "package-smoke Cloud Hypervisor vsock has unsafe metadata"
    );
    Ok(())
}

pub(super) async fn start_smoke_vm(
    client: &CloudHypervisorClient,
    config: &VmConfig,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + SATURATION_VM_TRANSITION_TIMEOUT;
    let ping = loop {
        match client.ping().await {
            Ok(ping) => break ping,
            Err(error) if tokio::time::Instant::now() < deadline => {
                let _ = error;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error).context("wait for jailed VMM API"),
        }
    };
    let reported_version = ping
        .build_version
        .as_deref()
        .or(ping.version.as_deref())
        .unwrap_or_default();
    ensure!(
        reported_version.contains("53.0"),
        "jailed runtime reported unexpected version {reported_version:?}"
    );
    client.vm_create(config).await.context("create smoke VM")?;
    client.vm_boot().await.context("boot smoke VM")?;
    let deadline = tokio::time::Instant::now() + SATURATION_VM_TRANSITION_TIMEOUT;
    loop {
        match client.vm_info().await {
            Ok(info) if matches!(info.state, VmState::Running) => return Ok(()),
            Ok(_) | Err(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Ok(info) => bail!("smoke VM did not reach running state: {:?}", info.state),
            Err(error) => return Err(error).context("inspect booted smoke VM"),
        }
    }
}

pub(super) async fn shutdown_smoke_vm(client: &CloudHypervisorClient) -> Result<()> {
    tokio::time::timeout(SATURATION_VM_TRANSITION_TIMEOUT, client.vm_shutdown())
        .await
        .context("time out requesting jailed API shutdown")?
        .context("request jailed API shutdown")?;

    // In pinned v53, vm_shutdown() takes ownership of the running VM,
    // shuts it down synchronously, and drops it while retaining vm_config.
    // vm_info() therefore reports Created, not Shutdown, after the API
    // response. This exact state proves that the VMM can boot the retained
    // configuration again; vm_delete() below then removes that config.
    let shutdown_info = tokio::time::timeout(CLOUD_HYPERVISOR_API_CALL_TIMEOUT, client.vm_info())
        .await
        .context("time out inspecting jailed API shutdown")?
        .context("inspect jailed API shutdown")?;
    validate_v53_post_shutdown_state(&shutdown_info)?;

    tokio::time::timeout(CLOUD_HYPERVISOR_API_CALL_TIMEOUT, client.vm_delete())
        .await
        .context("time out deleting shutdown smoke VM")?
        .context("delete shutdown smoke VM")?;
    let deleted_info = tokio::time::timeout(CLOUD_HYPERVISOR_API_CALL_TIMEOUT, client.vm_info())
        .await
        .context("time out confirming smoke VM deletion")?;
    validate_v53_post_delete_info(deleted_info)
}

pub(super) fn validate_v53_post_shutdown_state(info: &VmInfo) -> Result<()> {
    ensure!(
        matches!(info.state, VmState::Created),
        "pinned v53 did not retain only a reusable VM configuration after shutdown: {:?}",
        info.state
    );
    Ok(())
}

pub(super) fn validate_v53_post_delete_info(
    result: std::result::Result<VmInfo, CloudHypervisorError>,
) -> Result<()> {
    match result {
        Err(CloudHypervisorError::HttpStatus { status, body }) => {
            ensure!(
                status == 404,
                "pinned v53 returned HTTP {status} instead of 404 after VM delete"
            );
            let chain: Vec<String> =
                serde_json::from_str(&body).context("parse pinned v53 post-delete error chain")?;
            ensure!(
                chain
                    == [
                        "Error from API",
                        "The VM info is not available",
                        "VM is not created",
                    ],
                "pinned v53 returned an unexpected post-delete error chain: {chain:?}"
            );
            Ok(())
        }
        Err(error) => Err(anyhow::Error::new(error)
            .context("vm.info did not return pinned v53's post-delete 404")),
        Ok(info) => bail!(
            "pinned v53 still reported a VM after delete: {:?}",
            info.state
        ),
    }
}

pub(super) fn expect_inspection(response: Response, operation: &str) -> Result<VmInspection> {
    match response {
        Response::InspectVm(inspection) => Ok(inspection),
        Response::Error(error) => {
            bail!("{operation} failed: {}: {}", error.code, error.message)
        }
        response => bail!("{operation} returned unexpected response: {response:?}"),
    }
}

pub(super) fn assert_smoke_inspection(inspection: &VmInspection) -> Result<()> {
    ensure!(
        matches!(inspection.health, SandboxHealth::Healthy),
        "booted smoke VM unit is not healthy"
    );
    ensure!(inspection.seccomp_enabled, "VMM seccomp mode 2 is absent");
    ensure!(
        inspection.landlock_enabled,
        "VMM launch is not bound to the verified Landlock attestation"
    );
    ensure!(inspection.no_new_privs, "VMM NoNewPrivs is absent");
    ensure!(
        inspection.capabilities_empty,
        "VMM retains one or more capability sets"
    );
    ensure!(inspection.cpu_quota.cpu_millis == SELF_TEST_CPU_MILLIS);
    ensure!(inspection.vcpu_count == 1);
    let pid = inspection.pid.context("VMM inspection has no process ID")?;
    assert_api_only_vmm_argv(pid)?;
    assert_process_identity(pid, inspection.uid, inspection.gid)?;
    assert_process_namespaces(pid, &inspection.netns_name)?;
    assert_process_root_and_mounts(pid, inspection)?;
    assert_jail_devices(inspection)?;
    let control_group = inspection
        .cgroup_path
        .as_ref()
        .context("VMM inspection has no cgroup path")?
        .to_string_lossy()
        .into_owned();
    let unit = UnitState {
        main_pid: pid,
        control_group,
    };
    let cgroup = cgroup_directory(&unit.control_group)?;
    assert_cpu_quota(&cgroup)?;
    assert_cgroup_process_security(&cgroup, inspection.uid, inspection.gid)?;
    ensure_unit_tasks_accounted(&unit, &cgroup)?;
    ensure_process_descendants_accounted(&unit, &cgroup)?;
    Ok(())
}

pub(super) fn assert_api_only_vmm_argv(pid: u32) -> Result<()> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline"))?;
    validate_api_only_vmm_argv(&bytes)
}

pub(super) fn validate_api_only_vmm_argv(bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.last() == Some(&0),
        "Cloud Hypervisor argv is not NUL terminated"
    );
    let argv = bytes[..bytes.len() - 1]
        .split(|byte| *byte == 0)
        .map(std::str::from_utf8)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(
        argv == EXPECTED_API_ONLY_VMM_ARGV,
        "Cloud Hypervisor is not running with the exact API-only argv: {argv:?}"
    );
    Ok(())
}

pub(super) fn assert_saturation_vm_isolation(
    inspections: &[VmInspection],
    tasks_before: &TaskSnapshot,
) -> Result<()> {
    ensure!(
        inspections.len() == SELF_TEST_SATURATION_VM_COUNT,
        "saturation package proof requires exactly eight running VMs"
    );
    let generations = inspections
        .iter()
        .map(|inspection| inspection.generation.as_str())
        .collect::<BTreeSet<_>>();
    let unit_names = inspections
        .iter()
        .map(|inspection| inspection.unit_name.as_str())
        .collect::<BTreeSet<_>>();
    let uids = inspections
        .iter()
        .map(|inspection| inspection.uid)
        .collect::<BTreeSet<_>>();
    let gids = inspections
        .iter()
        .map(|inspection| inspection.gid)
        .collect::<BTreeSet<_>>();
    ensure!(
        generations.len() == SELF_TEST_SATURATION_VM_COUNT,
        "saturation package proof reused a generation"
    );
    ensure!(
        unit_names.len() == SELF_TEST_SATURATION_VM_COUNT,
        "saturation package proof reused a systemd unit"
    );
    ensure!(
        uids.len() == SELF_TEST_SATURATION_VM_COUNT
            && gids.len() == SELF_TEST_SATURATION_VM_COUNT
            && inspections
                .iter()
                .all(|inspection| inspection.uid == inspection.gid),
        "saturation package proof reused or mismatched a VM identity"
    );
    let run_netns = inspections
        .first()
        .context("saturation package proof has no VMs")?
        .netns_name
        .as_str();
    ensure!(
        inspections
            .iter()
            .all(|inspection| inspection.netns_name == run_netns),
        "same-run saturation VMs did not share their run network namespace"
    );

    for namespace in ["mnt", "pid", "uts", "ipc", "cgroup"] {
        let inodes = inspections
            .iter()
            .map(|inspection| {
                let pid = inspection.pid.context("VMM inspection has no process ID")?;
                Ok(std::fs::metadata(format!("/proc/{pid}/ns/{namespace}"))?.ino())
            })
            .collect::<Result<BTreeSet<_>>>()?;
        ensure!(
            inodes.len() == SELF_TEST_SATURATION_VM_COUNT,
            "saturation package proof shared the {namespace} namespace"
        );
    }
    let network_inodes = inspections
        .iter()
        .map(|inspection| {
            let pid = inspection.pid.context("VMM inspection has no process ID")?;
            Ok(std::fs::metadata(format!("/proc/{pid}/ns/net"))?.ino())
        })
        .collect::<Result<BTreeSet<_>>>()?;
    ensure!(
        network_inodes.len() == 1,
        "same-run saturation VMs do not share one network namespace"
    );

    let mut units = Vec::with_capacity(inspections.len());
    let mut cgroups = Vec::with_capacity(inspections.len());
    for inspection in inspections {
        let pid = inspection.pid.context("VMM inspection has no process ID")?;
        let control_group = inspection
            .cgroup_path
            .as_ref()
            .context("VMM inspection has no cgroup path")?
            .to_string_lossy()
            .into_owned();
        let unit = UnitState {
            main_pid: pid,
            control_group,
        };
        let cgroup = cgroup_directory(&unit.control_group)?;
        assert_cpu_quota(&cgroup)?;
        units.push(unit);
        cgroups.push(cgroup);
    }
    for first in 0..cgroups.len() {
        for second in (first + 1)..cgroups.len() {
            ensure!(
                cgroups[first] != cgroups[second]
                    && !cgroups[first].starts_with(&cgroups[second])
                    && !cgroups[second].starts_with(&cgroups[first]),
                "saturation package proof did not create independent leaf cgroups"
            );
        }
    }
    ensure!(
        prove_cloud_hypervisor_accounting(tasks_before, &units, &cgroups)?,
        "could not prove all eight jailed Cloud Hypervisor KVM task trees are independently accounted"
    );

    // Exclude VMM/guest setup from the measured window. The package guest
    // has a respawned BusyBox loop, so all eight aggregate process trees
    // remain continuously busy during one shared 30-second window.
    thread::sleep(Duration::from_secs(2));
    let before = cgroups
        .iter()
        .map(|cgroup| read_busy_guest_cpu_sample(cgroup))
        .collect::<Result<Vec<_>>>()?;
    let started = Instant::now();
    thread::sleep(Duration::from_secs(30));
    let elapsed = started.elapsed();
    let after = cgroups
        .iter()
        .map(|cgroup| read_busy_guest_cpu_sample(cgroup))
        .collect::<Result<Vec<_>>>()?;
    let mut aggregate_usage_usec = 0_u64;
    for (index, ((before, after), (inspection, (unit, cgroup)))) in before
        .iter()
        .zip(&after)
        .zip(inspections.iter().zip(units.iter().zip(&cgroups)))
        .enumerate()
    {
        validate_busy_guest_cpu_sample(*before, *after, elapsed)
            .with_context(|| format!("VM {index} independent CPU quota proof failed"))?;
        aggregate_usage_usec = aggregate_usage_usec
            .checked_add(
                after
                    .usage_usec
                    .checked_sub(before.usage_usec)
                    .context("cpu.stat usage counter moved backwards")?,
            )
            .context("aggregate saturation CPU usage overflow")?;
        assert_cgroup_process_security(cgroup, inspection.uid, inspection.gid)?;
        ensure_unit_tasks_accounted(unit, cgroup)?;
        ensure_process_descendants_accounted(unit, cgroup)?;
    }
    let elapsed_usec = u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX);
    let aggregate_maximum = elapsed_usec
        .checked_mul(
            14_u64
                .checked_mul(u64::try_from(SELF_TEST_SATURATION_VM_COUNT)?)
                .context("aggregate saturation percentage overflow")?,
        )
        .and_then(|value| value.checked_div(100))
        .context("aggregate saturation CPU ceiling overflow")?;
    ensure!(
        aggregate_usage_usec <= aggregate_maximum,
        "eight busy VMs exceeded the aggregate quota tolerance: usage={aggregate_usage_usec}us elapsed={elapsed_usec}us maximum={aggregate_maximum}us"
    );
    ensure!(
        prove_cloud_hypervisor_accounting(tasks_before, &units, &cgroups)?,
        "late Cloud Hypervisor/KVM helper escaped one of the eight VM cgroups during the busy sample"
    );
    Ok(())
}

pub(super) fn assert_jail_devices(inspection: &VmInspection) -> Result<()> {
    let root = &inspection.paths.host_jail_root;
    let expected = [
        ("dev/kvm", 10, 232, 0o600),
        ("dev/net/tun", 10, 200, 0o600),
        ("dev/urandom", 1, 9, 0o400),
        ("dev/null", 1, 3, 0o600),
    ];
    for (relative, expected_major, expected_minor, expected_mode) in expected {
        let metadata = std::fs::symlink_metadata(root.join(relative))?;
        ensure!(
            metadata.file_type().is_char_device()
                && rustix::fs::major(metadata.rdev()) == expected_major
                && rustix::fs::minor(metadata.rdev()) == expected_minor
                && metadata.mode() & 0o777 == expected_mode
                && metadata.uid() == inspection.uid
                && metadata.gid() == inspection.gid
                && metadata.nlink() == 1,
            "jailed device {relative} failed verification"
        );
    }
    ensure!(
        !root.join("dev/vhost-vsock").exists(),
        "package smoke exposed /dev/vhost-vsock"
    );
    let top_level = std::fs::read_dir(root.join("dev"))?
        .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
        .collect::<Result<BTreeSet<_>>>()?;
    ensure!(
        top_level
            == BTreeSet::from([
                "kvm".to_owned(),
                "net".to_owned(),
                "null".to_owned(),
                "urandom".to_owned(),
            ]),
        "jail contains a non-allowlisted top-level device entry"
    );
    let net_entries = std::fs::read_dir(root.join("dev/net"))?
        .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
        .collect::<Result<BTreeSet<_>>>()?;
    ensure!(
        net_entries == BTreeSet::from(["tun".to_owned()]),
        "jail contains a non-allowlisted /dev/net entry"
    );
    Ok(())
}

pub(super) fn assert_cgroup_process_security(
    cgroup: &Path,
    expected_uid: u32,
    expected_gid: u32,
) -> Result<()> {
    let processes = read_id_set(&cgroup.join("cgroup.procs"))?;
    ensure!(!processes.is_empty(), "VM cgroup has no processes");
    for pid in processes {
        assert_process_identity(pid, expected_uid, expected_gid)?;
        for entry in std::fs::read_dir(format!("/proc/{pid}/task"))? {
            let status = std::fs::read_to_string(entry?.path().join("status"))?;
            let field = |name: &str| {
                status
                    .lines()
                    .find_map(|line| line.strip_prefix(name))
                    .map(str::trim)
            };
            ensure!(
                field("NoNewPrivs:") == Some("1"),
                "VM cgroup task lacks NoNewPrivs"
            );
            for capability in ["CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"] {
                ensure!(
                    field(capability).and_then(|value| u64::from_str_radix(value, 16).ok())
                        == Some(0),
                    "VM cgroup task retains {capability}"
                );
            }
        }
    }
    Ok(())
}

pub(super) fn assert_process_root_and_mounts(pid: u32, inspection: &VmInspection) -> Result<()> {
    let process_root = std::fs::metadata(format!("/proc/{pid}/root"))?;
    let expected_root = std::fs::metadata(&inspection.paths.host_jail_root)?;
    ensure!(
        process_root.dev() == expected_root.dev() && process_root.ino() == expected_root.ino(),
        "Cloud Hypervisor process root does not match its persisted jail root"
    );
    ensure!(
        inspection.jail_root_inode == Some(expected_root.ino()),
        "persisted jail-root inode does not match the live jail"
    );

    let mountinfo = std::fs::read_to_string(format!("/proc/{pid}/mountinfo"))?;
    let mut saw_read_only_proc = false;
    for line in mountinfo.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        ensure!(fields.len() >= 10, "malformed VMM mountinfo entry");
        let mount_point = fields[4];
        let options = fields[5];
        let separator = fields
            .iter()
            .position(|field| *field == "-")
            .context("malformed VMM mountinfo separator")?;
        let filesystem = fields
            .get(separator + 1)
            .context("malformed VMM mountinfo filesystem")?;
        ensure!(
            !matches!(*filesystem, "cgroup" | "cgroup2" | "sysfs" | "devtmpfs"),
            "jailed VMM exposes forbidden {filesystem} filesystem at {mount_point}"
        );
        ensure!(
            !matches!(mount_point, "/sys" | "/dev" | "/run"),
            "jailed VMM exposes forbidden mount at {mount_point}"
        );
        if mount_point == "/proc" && *filesystem == "proc" {
            saw_read_only_proc = options.split(',').any(|option| option == "ro");
        }
    }
    ensure!(
        saw_read_only_proc,
        "jailed VMM does not expose a fresh read-only procfs"
    );
    Ok(())
}

pub(super) fn assert_process_identity(
    pid: u32,
    expected_uid: u32,
    expected_gid: u32,
) -> Result<()> {
    ensure!(
        expected_uid != 0 && expected_gid != 0,
        "VMM identity is root"
    );
    for entry in std::fs::read_dir(format!("/proc/{pid}/task"))? {
        let status = std::fs::read_to_string(entry?.path().join("status"))?;
        let field = |name: &str| {
            status
                .lines()
                .find_map(|line| line.strip_prefix(name))
                .map(str::trim)
        };
        let uids = field("Uid:")
            .context("VMM task status has no Uid field")?
            .split_whitespace()
            .map(str::parse)
            .collect::<std::result::Result<Vec<u32>, _>>()?;
        let gids = field("Gid:")
            .context("VMM task status has no Gid field")?
            .split_whitespace()
            .map(str::parse)
            .collect::<std::result::Result<Vec<u32>, _>>()?;
        ensure!(
            uids.len() == 4 && uids.iter().all(|value| *value == expected_uid),
            "VMM task retained an unexpected UID"
        );
        ensure!(
            gids.len() == 4 && gids.iter().all(|value| *value == expected_gid),
            "VMM task retained an unexpected GID"
        );
        ensure!(
            field("Groups:").is_some_and(str::is_empty),
            "VMM task retained supplementary groups"
        );
    }
    Ok(())
}

pub(super) fn assert_process_namespaces(pid: u32, netns_name: &str) -> Result<()> {
    for namespace in ["mnt", "pid", "uts", "ipc", "cgroup", "net"] {
        let host = std::fs::metadata(format!("/proc/self/ns/{namespace}"))?;
        let guest = std::fs::metadata(format!("/proc/{pid}/ns/{namespace}"))?;
        ensure!(
            host.ino() != guest.ino(),
            "jailed Cloud Hypervisor retained the host {namespace} namespace"
        );
    }
    let named_netns = std::fs::metadata(initial_mount_namespace_entry(
        Path::new("/run/netns"),
        netns_name,
    )?)?;
    let vmm_netns = std::fs::metadata(format!("/proc/{pid}/ns/net"))?;
    ensure!(
        named_netns.ino() == vmm_netns.ino(),
        "jailed Cloud Hypervisor did not join its prepared run network namespace"
    );
    Ok(())
}

pub(super) fn wait_for_guest_ready(serial_log: &Path, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if std::fs::read(serial_log).is_ok_and(|bytes| {
            bytes
                .windows(b"INTAR_PACKAGE_SMOKE_READY".len())
                .any(|window| window == b"INTAR_PACKAGE_SMOKE_READY")
        }) {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "busy package-smoke guest did not emit its boot marker"
        );
        thread::sleep(Duration::from_millis(100));
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct BusyGuestCpuSample {
    usage_usec: u64,
    nr_throttled: u64,
}

pub(super) fn read_busy_guest_cpu_sample(cgroup: &Path) -> Result<BusyGuestCpuSample> {
    let contents = std::fs::read_to_string(cgroup.join("cpu.stat"))?;
    let values = parse_cpu_stat(&contents);
    Ok(BusyGuestCpuSample {
        usage_usec: values.get("usage_usec").copied().unwrap_or_default(),
        nr_throttled: values.get("nr_throttled").copied().unwrap_or_default(),
    })
}

pub(super) fn validate_busy_guest_cpu_sample(
    before: BusyGuestCpuSample,
    after: BusyGuestCpuSample,
    elapsed: Duration,
) -> Result<()> {
    ensure!(
        elapsed >= Duration::from_secs(30) && elapsed <= Duration::from_secs(60),
        "busy-guest sample must run for 30 to 60 seconds"
    );
    let usage_delta = after
        .usage_usec
        .checked_sub(before.usage_usec)
        .context("cpu.stat usage counter moved backwards")?;
    let elapsed_usec = u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX);
    let maximum_usage = elapsed_usec
        .checked_mul(14)
        .and_then(|value| value.checked_div(100))
        .context("busy-guest usage ceiling overflow")?;
    ensure!(
        after.nr_throttled > before.nr_throttled,
        "busy guest did not increase cpu.stat nr_throttled"
    );
    ensure!(
        usage_delta <= maximum_usage,
        "busy guest exceeded the 14% ceiling: usage_delta={usage_delta}us elapsed={}us maximum={maximum_usage}us",
        elapsed_usec
    );
    Ok(())
}

pub(super) fn prove_cloud_hypervisor_accounting(
    before: &TaskSnapshot,
    units: &[UnitState],
    cgroups: &[PathBuf],
) -> Result<bool> {
    ensure!(
        units.len() == SELF_TEST_SATURATION_VM_COUNT && cgroups.len() == units.len(),
        "Cloud Hypervisor accounting proof requires eight units and cgroups"
    );
    let mut thread_sets = Vec::with_capacity(cgroups.len());
    let mut all_threads = BTreeSet::new();
    for (index, (unit, cgroup)) in units.iter().zip(cgroups).enumerate() {
        let cgroup_threads = read_id_set(&cgroup.join("cgroup.threads"))?;
        ensure!(
            cgroup_threads.contains(&unit.main_pid),
            "Cloud Hypervisor VM {index} main process is outside its cgroup"
        );
        let mut saw_vcpu = false;
        for entry in std::fs::read_dir(format!("/proc/{}/task", unit.main_pid))? {
            let entry = entry?;
            let tid: u32 = entry.file_name().to_string_lossy().parse()?;
            ensure!(
                cgroup_threads.contains(&tid),
                "Cloud Hypervisor VM {index} task {tid} is outside its cgroup"
            );
            let name = std::fs::read_to_string(entry.path().join("comm"))?;
            saw_vcpu |= name.trim().contains("vcpu");
        }
        ensure!(saw_vcpu, "Cloud Hypervisor VM {index} has no vCPU task");
        ensure_process_descendants_accounted(unit, cgroup)?;
        ensure!(
            cgroup_threads.iter().all(|tid| all_threads.insert(*tid)),
            "saturation VM cgroups contain an overlapping thread"
        );
        thread_sets.push(cgroup_threads);
    }

    let after = snapshot_tasks()?;
    for tid in after.ids.difference(&before.ids) {
        let Ok(name) = std::fs::read_to_string(format!("/proc/{tid}/comm")) else {
            continue;
        };
        let name = name.trim();
        if !is_attributable_kvm_helper(name) {
            continue;
        }
        let owners = thread_sets
            .iter()
            .filter(|threads| threads.contains(tid))
            .count();
        if owners != 1 {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn is_attributable_kvm_helper(name: &str) -> bool {
    name.starts_with("kvm-") || name.starts_with("vhost-") || name.contains("kvm-pit")
}

pub(super) fn ensure_process_descendants_accounted(unit: &UnitState, cgroup: &Path) -> Result<()> {
    let cgroup_processes = read_id_set(&cgroup.join("cgroup.procs"))?;
    let mut parent_by_pid = BTreeMap::new();
    for process in std::fs::read_dir("/proc")? {
        let process = process?;
        let Ok(pid) = process.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(status) = std::fs::read_to_string(process.path().join("status")) else {
            continue;
        };
        let Some(parent) = status
            .lines()
            .find_map(|line| line.strip_prefix("PPid:"))
            .and_then(|value| value.trim().parse::<u32>().ok())
        else {
            continue;
        };
        parent_by_pid.insert(pid, parent);
    }

    let mut descendants = BTreeSet::from([unit.main_pid]);
    loop {
        let previous_len = descendants.len();
        for (pid, parent) in &parent_by_pid {
            if descendants.contains(parent) {
                descendants.insert(*pid);
            }
        }
        if descendants.len() == previous_len {
            break;
        }
    }
    ensure!(
        descendants.iter().all(|pid| cgroup_processes.contains(pid)),
        "one or more Cloud Hypervisor descendants escaped the VM cgroup"
    );
    Ok(())
}

pub(super) async fn prove_cloud_hypervisor_landlock(client: &CloudHypervisorClient) -> Result<()> {
    const CANARY_PATH: &str = "/run/landlock-api-canary";
    const CANARY_ID: &str = "landlock-denied";

    let before = tokio::time::timeout(CLOUD_HYPERVISOR_API_CALL_TIMEOUT, client.vm_info())
        .await
        .context("time out inspecting VM before Landlock-negative add-disk")?
        .context("inspect VM before Landlock-negative add-disk")?;
    ensure!(
        matches!(before.state, VmState::Running),
        "VM is not running before Landlock-negative add-disk"
    );
    ensure!(
        before.config.landlock_enable == Some(true),
        "VM configuration does not enable Landlock"
    );
    let before_disks = serde_json::to_value(&before.config.disks)
        .context("serialize pre-denial disk configuration")?;
    ensure!(
        before
            .config
            .disks
            .as_deref()
            .unwrap_or_default()
            .iter()
            .all(|disk| disk.id.as_deref() != Some(CANARY_ID) && disk.path != CANARY_PATH),
        "Landlock canary is already present before the negative proof"
    );

    // The jailer's outer /run rule grants ReadFile, while this root-owned
    // 0444 canary is absent from the typed VmConfig. The exact v53 EACCES
    // chain therefore proves Cloud Hypervisor's narrower inner Landlock
    // ruleset independently of both DAC and the outer jailer ruleset.
    let canary = DiskConfig {
        path: CANARY_PATH.to_owned(),
        readonly: true,
        id: Some(CANARY_ID.to_owned()),
        image_type: Some(DiskImageType::Raw),
    };
    let denial = tokio::time::timeout(
        CLOUD_HYPERVISOR_API_CALL_TIMEOUT,
        client.vm_add_disk(&canary),
    )
    .await
    .context("time out waiting for Landlock-negative add-disk response")?;
    match denial {
        Err(CloudHypervisorError::HttpStatus { status, body }) => {
            validate_v53_landlock_denial(status, &body)?;
        }
        Err(error) => {
            return Err(error).context("Landlock-negative add-disk failed without an HTTP denial");
        }
        Ok(()) => bail!("Cloud Hypervisor unexpectedly attached the Landlock canary"),
    }

    let ping = tokio::time::timeout(CLOUD_HYPERVISOR_API_CALL_TIMEOUT, client.ping())
        .await
        .context("time out pinging VMM after Landlock-negative add-disk")?
        .context("ping VMM after Landlock-negative add-disk")?;
    let reported_version = ping
        .build_version
        .as_deref()
        .or(ping.version.as_deref())
        .unwrap_or_default();
    ensure!(
        reported_version.contains("53.0"),
        "VMM reported unexpected version after Landlock denial: {reported_version:?}"
    );
    let after = tokio::time::timeout(CLOUD_HYPERVISOR_API_CALL_TIMEOUT, client.vm_info())
        .await
        .context("time out inspecting VM after Landlock-negative add-disk")?
        .context("inspect VM after Landlock-negative add-disk")?;
    ensure!(
        matches!(after.state, VmState::Running),
        "VM is not running after Landlock-negative add-disk"
    );
    ensure!(
        after.config.landlock_enable == Some(true),
        "VM configuration lost Landlock after the negative proof"
    );
    let after_disks = serde_json::to_value(&after.config.disks)
        .context("serialize post-denial disk configuration")?;
    ensure!(
        after_disks == before_disks,
        "Landlock-negative add-disk changed the VM disk configuration"
    );
    ensure!(
        after
            .config
            .disks
            .as_deref()
            .unwrap_or_default()
            .iter()
            .all(|disk| disk.id.as_deref() != Some(CANARY_ID) && disk.path != CANARY_PATH),
        "Landlock canary appeared in the post-denial VM configuration"
    );
    Ok(())
}

pub(super) fn validate_v53_landlock_denial(status: u16, body: &str) -> Result<()> {
    const V53_DENIAL_CHAIN: [&str; 6] = [
        "Error from API",
        "The disk could not be added to the VM",
        "Error from device manager",
        "Cannot open disk path",
        "I/O error (path=/run/landlock-api-canary op=open)",
        "Permission denied (os error 13)",
    ];

    ensure!(
        status == 500,
        "Landlock-negative add-disk returned HTTP {status}, expected 500"
    );
    let chain: Vec<String> =
        serde_json::from_str(body).context("parse Cloud Hypervisor v53 Landlock denial chain")?;
    let expected = V53_DENIAL_CHAIN.map(str::to_owned).to_vec();
    ensure!(
        chain == expected,
        "Cloud Hypervisor returned an unexpected Landlock denial chain: {chain:?}"
    );
    Ok(())
}
