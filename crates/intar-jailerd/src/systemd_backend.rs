use super::*;

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct BootCpuGuardianUnitSpec {
    pub(super) unit_name: String,
    pub(super) executable: String,
    pub(super) request: BootCpuGuardianRequest,
}

#[cfg(any(target_os = "linux", test))]
impl BootCpuGuardianUnitSpec {
    pub(super) fn new(executable: PathBuf, request: BootCpuGuardianRequest) -> Result<Self> {
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

    pub(super) fn command_argv(&self) -> Vec<String> {
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
    pub(super) fn required_properties(&self) -> BTreeMap<&'static str, String> {
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

pub(super) fn vm_unit_name(generation: &ValidatedId) -> String {
    format!("intar-vm-{generation}.service")
}

pub(super) fn boot_cpu_guardian_unit_name(generation: &ValidatedId) -> String {
    format!("intar-vm-boot-lease-{generation}.service")
}

#[cfg(target_os = "linux")]
pub(super) fn restrict_all_namespaces_dbus_value() -> zbus::zvariant::Value<'static> {
    // systemd exposes RestrictNamespaces as the uint64 namespace-type mask on
    // D-Bus. `yes` in a unit file maps to every bit set; a boolean variant
    // makes StartTransientUnit reject the entire auxiliary unit with
    // "Unexpected message contents".
    zbus::zvariant::Value::new(u64::MAX)
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn vm_cgroup_path(unit_name: &str) -> PathBuf {
    Path::new("/intar.slice/intar-vms.slice").join(unit_name)
}

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

    pub(super) fn manager<'a>(
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

    pub(super) fn get_unit_path(
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
            spawn_hard_cpu_seal(
                self.clone(),
                spec.unit_name.clone(),
                cgroup_path.clone(),
                spec.steady_cpu_quota,
                boot_deadline,
            )?;
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
