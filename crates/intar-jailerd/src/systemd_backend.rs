use super::*;

pub(super) fn vm_unit_name(generation: &ValidatedId) -> String {
    format!("intar-vm-{generation}.service")
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

    fn verify_unit_cpu_quota(
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
        let system_bus = zbus::blocking::Connection::system().context("connect to system D-Bus")?;
        Ok(Self {
            network: Arc::new(Mutex::new(NetworkManager::new(config)?)),
            system_bus,
            cloud_hypervisor_sha256: config.cloud_hypervisor_sha256.clone(),
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
        let _: OwnedObjectPath = manager
            .call(
                "StartTransientUnit",
                &(
                    spec.unit_name.as_str(),
                    "fail",
                    properties,
                    Vec::<(&str, Vec<(&str, Value)>)>::new(),
                ),
            )
            .with_context(|| format!("start transient unit {}", spec.unit_name))?;
        drop(manager);

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

    fn verify_unit_cpu_quota(
        &mut self,
        unit_name: &str,
        cgroup_path: &Path,
        quota: CpuQuota,
    ) -> Result<()> {
        assert_cpu_quota(cgroup_path, quota)
            .with_context(|| format!("verify CPU quota for {unit_name}"))
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
