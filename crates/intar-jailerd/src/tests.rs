use super::*;
use intar_jailer_protocol::{ArtifactAccess, ArtifactSource, SourceArtifacts};
use std::sync::Condvar;

mod templates;
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
            cgroup_path: Some(format!("/intar.slice/intar-vms.slice/{}", spec.unit_name).into()),
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

mod launch;
mod recovery;
mod security;
fn unsafe_test_uid() -> u32 {
    std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(".").expect("cwd metadata"))
}

fn unsafe_test_gid() -> u32 {
    std::os::unix::fs::MetadataExt::gid(&std::fs::metadata(".").expect("cwd metadata"))
}

fn lifecycle_test_config(root: &Path) -> JailerdConfig {
    let mut config = test_config();
    config.jail_root = root.to_path_buf();
    let metadata = std::fs::metadata(root).expect("lifecycle fixture metadata");
    config.agent_uid = std::os::unix::fs::MetadataExt::uid(&metadata);
    config.agent_gid = std::os::unix::fs::MetadataExt::gid(&metadata);
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
