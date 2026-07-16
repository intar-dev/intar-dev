use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CString, OsStr};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read as _, Write as _};
use std::os::unix::fs::{
    FileTypeExt as _, MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _,
};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};
use cloud_hypervisor_client::{
    Client as CloudHypervisorClient, ConsoleConfig, CpusConfig, DiskConfig, DiskImageType,
    Error as CloudHypervisorError, MemoryConfig, NetConfig, PayloadConfig, SerialConfig, VmConfig,
    VmInfo, VmState, VsockConfig,
};
use intar_jailer_protocol::{
    ArtifactAccess, ArtifactSource, DestroyRunNetworkRequest, EnsureRunNetworkRequest,
    FinalizeVmBootRequest, JailerdConfig, LaunchVmV2Request, PrepareImageV2Request,
    PreparedImageV2Result, Request, Response, SandboxHealth, Sha256Digest, SourceArtifacts,
    ValidatedId, VmIdentityRequest, VmInspection, VmLaunchRequest, VmLaunchResult,
};
use kvm_ioctls::Kvm;
use landlock::{
    ABI, Access as _, AccessFs, CompatLevel, Compatible as _, LandlockStatus, PathBeneath, PathFd,
    Ruleset, RulesetAttr as _, RulesetCreatedAttr as _, RulesetStatus,
};
use rustix::fs::{
    AtFlags, Mode, OFlags, RenameFlags, ResolveFlags, open, openat2, renameat_with, unlinkat,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;
use zbus::zvariant::{OwnedObjectPath, Value};

use super::{
    ATTESTATION_FILE, ATTESTATION_VERSION, SELF_TEST_CPU_MILLIS, SELF_TEST_CPU_PERIOD_US,
    SELF_TEST_CPU_QUOTA_US, SELF_TEST_RESOURCE_HEADROOM_MIB, SELF_TEST_SATURATION_CPU_MILLIS,
    SELF_TEST_SATURATION_VM_COUNT, SELF_TEST_VM_MEMORY_MIB, SelfTestArtifacts,
    SelfTestAttestationV2, VerifiedArtifact,
};
use crate::network::{
    add_host_visible_namespace, checked_host_mount_ip, delete_host_visible_namespace,
    initial_mount_namespace_entry, trusted_nsenter_binary, validate_initial_network_namespace,
    verify_host_visible_namespace,
};
use crate::{
    FileSystemJailPreparer, HostReadiness, JailerdCore, SystemdHostBackend,
    host_cpu_capacity_millis,
};

const MAX_ATTESTATION_BYTES: u64 = 64 * 1024;
const WORKER_SECONDS: u64 = 8;
const SATURATION_VM_TRANSITION_TIMEOUT: Duration = Duration::from_secs(30);
const SATURATION_GUEST_READY_TIMEOUT: Duration = Duration::from_secs(45);
const CLOUD_HYPERVISOR_API_CALL_TIMEOUT: Duration = Duration::from_secs(5);
const EXPECTED_API_ONLY_VMM_ARGV: [&str; 5] = [
    "/cloud-hypervisor",
    "--api-socket",
    "/run/cloud-hypervisor.sock",
    "--seccomp",
    "true",
];

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WorkerReportV1 {
    version: u16,
    landlock_abi: u32,
    landlock_negative_access: bool,
    kvm_vm_created: bool,
    kvm_vcpu_created: bool,
}

struct TrustedCurrentExe {
    path: PathBuf,
    sha256: String,
}

struct Cleanup {
    ip: PathBuf,
    nsenter: PathBuf,
    netns_root: PathBuf,
    unit_name: Option<String>,
    namespace_name: Option<String>,
    host_veth_name: Option<String>,
    directory: Option<PathBuf>,
    uid_gid_start: u32,
    uid_gid_end: u32,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(unit_name) = self.unit_name.take() {
            let _ = stop_and_reset_unit(&unit_name);
        }
        if let Some(host_veth_name) = self.host_veth_name.take() {
            let _ = checked_host_mount_ip(
                &self.nsenter,
                &self.ip,
                [
                    OsStr::new("link"),
                    OsStr::new("delete"),
                    OsStr::new(&host_veth_name),
                ],
            );
        }
        if let Some(namespace_name) = self.namespace_name.take() {
            let _ = delete_host_visible_namespace(
                &self.nsenter,
                &self.ip,
                &self.netns_root,
                &namespace_name,
            );
        }
        if let Some(directory) = self.directory.take() {
            // Never traverse a leaked mount while unwinding.  The checked
            // cleanup leaves a suspicious directory in place for operator
            // inspection if any mount is still attached.
            let _ = remove_disposable_directory(&directory, self.uid_gid_start, self.uid_gid_end);
        }
    }
}

pub(super) fn run(
    config: &JailerdConfig,
    artifacts: &SelfTestArtifacts,
) -> Result<SelfTestAttestationV2> {
    // Artifact hashing is performed even before the disposable host proof
    // so a release job cannot accidentally attest a different smoke image.
    let artifact_root = verify_artifacts(artifacts)?;
    run_inner(config, artifacts, &artifact_root)
}

fn run_inner(
    config: &JailerdConfig,
    artifacts: &SelfTestArtifacts,
    artifact_root: &Path,
) -> Result<SelfTestAttestationV2> {
    require_root()?;
    crate::require_supervisor_process_inspection_capability()
        .context("prove cross-UID VMM executable inspection capability")?;
    config
        .validate()
        .context("validate jailerd configuration")?;
    ensure!(
        config.boot_cpu_millis > SELF_TEST_CPU_MILLIS,
        "privileged self-test requires a boot CPU quota above the 125m steady quota"
    );
    ensure!(
        config.netns_root == Path::new("/run/netns"),
        "self-test requires netns_root=/run/netns"
    );
    validate_initial_network_namespace()
        .context("prove self-test uses PID 1's network namespace")?;
    ensure_trusted_directory(&config.jail_root)?;
    invalidate_previous_attestation(config)?;

    let actual_runtime_sha256 = trusted_executable_sha256(&config.cloud_hypervisor_binary)?;
    ensure!(
        actual_runtime_sha256 == config.cloud_hypervisor_sha256.as_str(),
        "installed Cloud Hypervisor runtime hash does not match configuration"
    );
    let current_exe = trusted_current_exe()?;
    let intar_jailerd_sha256 = current_exe.sha256.clone();
    let intar_jailer_sha256 = trusted_executable_sha256(&config.jailer_binary)?;
    let boot_id = read_trimmed("/proc/sys/kernel/random/boot_id")?;
    let kernel_version = read_trimmed("/proc/sys/kernel/osrelease")?;
    let systemd_version = read_systemd_version()?;
    let config_runtime_fingerprint_sha256 = config_runtime_fingerprint(
        config,
        &actual_runtime_sha256,
        &intar_jailerd_sha256,
        &intar_jailer_sha256,
    )?;

    let suffix = Uuid::new_v4().simple().to_string();
    let short = &suffix[..10];
    let self_test_root = config.jail_root.join("self-test");
    create_root_directory(&self_test_root)?;
    let directory = self_test_root.join(&suffix);
    std::fs::create_dir(&directory).context("create disposable self-test jail")?;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;

    let ip = trusted_ip_binary()?;
    let nsenter = trusted_nsenter_binary()?;
    let network_tools = IpNetnsTools {
        nsenter: &nsenter,
        ip: &ip,
        netns_root: &config.netns_root,
    };
    let namespace_name = format!("ist{short}");
    let host_veth_name = format!("ish{short}");
    let peer_veth_name = format!("isn{short}");
    ensure!(namespace_name.len() <= 15);
    ensure!(host_veth_name.len() <= 15);
    ensure!(peer_veth_name.len() <= 15);
    let mut cleanup = Cleanup {
        ip: ip.clone(),
        nsenter: nsenter.clone(),
        netns_root: config.netns_root.clone(),
        unit_name: None,
        namespace_name: None,
        host_veth_name: None,
        directory: Some(directory.clone()),
        uid_gid_start: config.uid_gid_start,
        uid_gid_end: config.uid_gid_end,
    };

    add_host_visible_namespace(&nsenter, &ip, &config.netns_root, &namespace_name)?;
    cleanup.namespace_name = Some(namespace_name.clone());
    if let Err(error) = verify_host_visible_namespace(&config.netns_root, &namespace_name) {
        let rollback =
            delete_test_network(&nsenter, &ip, &config.netns_root, &namespace_name, None);
        if rollback.is_ok() {
            cleanup.namespace_name = None;
        }
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(error).context(format!(
                "host-visible namespace verification rollback also failed: {rollback_error:#}"
            )),
        };
    }
    let network_setup = create_test_network(
        network_tools,
        &namespace_name,
        &host_veth_name,
        &peer_veth_name,
        short,
        &mut cleanup,
    )
    .and_then(|()| {
        verify_network(
            network_tools,
            &namespace_name,
            &host_veth_name,
            &peer_veth_name,
        )
    });
    if let Err(error) = network_setup {
        let owned_host_veth = cleanup.host_veth_name.clone();
        let rollback = delete_test_network(
            &nsenter,
            &ip,
            &config.netns_root,
            &namespace_name,
            owned_host_veth.as_deref(),
        );
        if rollback.is_ok() {
            cleanup.namespace_name = None;
            cleanup.host_veth_name = None;
        }
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(error).context(format!(
                "preliminary network rollback also failed: {rollback_error:#}"
            )),
        };
    }
    let allowed_dir = directory.join("allowed");
    create_root_directory(&allowed_dir)?;
    let denied_path = directory.join("denied-marker");
    write_new_root_file(&denied_path, b"landlock-negative-probe\n", 0o600)?;
    let report_path = allowed_dir.join("worker-report-v1.json");
    let unit_name = format!("intar-selftest-{short}.service");
    let tasks_before = snapshot_tasks()?;
    start_worker_unit(
        &unit_name,
        &current_exe.path,
        &report_path,
        &allowed_dir,
        &denied_path,
        &config.netns_root.join(&namespace_name),
        config.boot_cpu_millis,
    )?;
    cleanup.unit_name = Some(unit_name.clone());

    let unit = wait_for_worker_report(&unit_name, &report_path, Duration::from_secs(10))?;
    let worker_report = read_worker_report(&report_path)?;
    ensure!(
        worker_report.version == 1,
        "unsupported worker report version"
    );
    ensure!(
        worker_report.landlock_abi >= 3,
        "Landlock ABI 3 is required"
    );
    ensure!(
        worker_report.landlock_negative_access,
        "Landlock negative-access probe was not enforced"
    );
    ensure!(
        worker_report.kvm_vm_created && worker_report.kvm_vcpu_created,
        "KVM VM/vCPU creation probe did not complete"
    );

    let cgroup_directory = cgroup_directory(&unit.control_group)?;
    assert_cpu_quota_millis(&cgroup_directory, config.boot_cpu_millis)
        .context("verify privileged self-test boot CPU quota")?;
    update_worker_cpu_quota(&unit_name, SELF_TEST_CPU_MILLIS)
        .context("lower privileged self-test to steady CPU quota")?;
    assert_cpu_quota(&cgroup_directory)?;
    wait_for_throttling(&cgroup_directory, Duration::from_secs(5))?;
    ensure_unit_tasks_accounted(&unit, &cgroup_directory)?;
    let kvm_fd_scope_proven = prove_kvm_accounting(&tasks_before, &unit, &cgroup_directory)?;
    ensure!(
        kvm_fd_scope_proven,
        "could not prove KVM self-test worker accounting"
    );

    stop_and_reset_unit(&unit_name)?;
    cleanup.unit_name = None;
    wait_for_cgroup_drain(&cgroup_directory, Duration::from_secs(10))?;
    delete_test_network(
        &nsenter,
        &ip,
        &config.netns_root,
        &namespace_name,
        Some(&host_veth_name),
    )?;
    cleanup.namespace_name = None;
    cleanup.host_veth_name = None;

    let lifecycle_result = run_cloud_hypervisor_smoke(config, artifacts, artifact_root, &directory);
    let directory_cleanup =
        remove_disposable_directory(&directory, config.uid_gid_start, config.uid_gid_end);
    if directory_cleanup.is_ok() {
        cleanup.directory = None;
    }
    match (lifecycle_result, directory_cleanup) {
        (Ok(()), Ok(())) => {}
        (Err(error), Ok(())) => return Err(error),
        (Ok(()), Err(error)) => {
            return Err(error).context("remove disposable self-test jail");
        }
        (Err(operation), Err(cleanup_error)) => {
            return Err(operation).context(format!(
                "disposable self-test jail cleanup also failed: {cleanup_error:#}"
            ));
        }
    }

    let attestation = SelfTestAttestationV2 {
        version: ATTESTATION_VERSION,
        config_runtime_fingerprint_sha256,
        cloud_hypervisor_sha256: actual_runtime_sha256,
        intar_jailerd_sha256,
        intar_jailer_sha256,
        boot_id,
        kernel_version,
        systemd_version,
        landlock_abi: worker_report.landlock_abi,
        quota_verified: true,
        burst_verified: true,
        boot_quota_transition_verified: true,
        network_verified: true,
        landlock_negative_access: true,
        kvm_accounting_proven: true,
        cloud_hypervisor_lifecycle_verified: true,
        passed_at_unix_s: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system clock predates Unix epoch")?
            .as_secs(),
    };
    validate_attestation(&attestation)?;
    write_attestation(config, &attestation)?;
    Ok(attestation)
}

pub(super) fn load_verified(config: &JailerdConfig) -> Result<Option<SelfTestAttestationV2>> {
    config
        .validate()
        .context("validate jailerd configuration")?;
    let root = open_trusted_attestation_root(config)?;
    let file = match open_attestation_file(&root)? {
        Some(file) => file,
        None => return Ok(None),
    };
    let metadata = file
        .metadata()
        .context("stat opened self-test attestation")?;
    validate_root_file_metadata(&metadata, 0o600)?;
    ensure!(
        metadata.len() <= MAX_ATTESTATION_BYTES,
        "self-test attestation exceeds 64 KiB"
    );
    let mut bytes = Vec::new();
    file.take(MAX_ATTESTATION_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_ATTESTATION_BYTES,
        "self-test attestation exceeds 64 KiB"
    );
    let attestation: SelfTestAttestationV2 =
        serde_json::from_slice(&bytes).context("parse self-test attestation")?;
    validate_attestation(&attestation)?;

    let actual_runtime_sha256 = trusted_executable_sha256(&config.cloud_hypervisor_binary)?;
    let current_exe = trusted_current_exe()?;
    let intar_jailerd_sha256 = current_exe.sha256;
    let intar_jailer_sha256 = trusted_executable_sha256(&config.jailer_binary)?;
    ensure!(
        attestation.cloud_hypervisor_sha256 == actual_runtime_sha256,
        "self-test attestation runtime hash is stale"
    );
    ensure!(
        attestation.intar_jailerd_sha256 == intar_jailerd_sha256,
        "self-test attestation jailerd executable hash is stale"
    );
    ensure!(
        attestation.intar_jailer_sha256 == intar_jailer_sha256,
        "self-test attestation jailer executable hash is stale"
    );
    ensure!(
        actual_runtime_sha256 == config.cloud_hypervisor_sha256.as_str(),
        "configured runtime hash does not match installed bytes"
    );
    ensure!(
        attestation.config_runtime_fingerprint_sha256
            == config_runtime_fingerprint(
                config,
                &actual_runtime_sha256,
                &intar_jailerd_sha256,
                &intar_jailer_sha256,
            )?,
        "self-test attestation configuration fingerprint is stale"
    );
    ensure!(
        attestation.boot_id == read_trimmed("/proc/sys/kernel/random/boot_id")?,
        "self-test attestation belongs to a previous boot"
    );
    ensure!(
        attestation.kernel_version == read_trimmed("/proc/sys/kernel/osrelease")?,
        "self-test attestation kernel version is stale"
    );
    ensure!(
        attestation.systemd_version == read_systemd_version()?,
        "self-test attestation systemd version is stale"
    );
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock predates Unix epoch")?
        .as_secs();
    ensure!(
        attestation.passed_at_unix_s <= now.saturating_add(60),
        "self-test attestation time is in the future"
    );
    Ok(Some(attestation))
}

pub(super) fn worker(report: &Path, allowed_dir: &Path, denied_path: &Path) -> Result<()> {
    require_root()?;
    let root = validate_worker_paths(report, allowed_dir, denied_path)?;
    ensure_trusted_directory(&root)?;
    ensure_trusted_directory(allowed_dir)?;
    // Resolve every caller-generated path beneath the disposable root in a
    // single trusted lookup before applying irreversible Landlock rules.
    let root_fd = open(
        &root,
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    for path in [allowed_dir, denied_path] {
        let relative = path
            .strip_prefix(&root)
            .context("worker path escaped disposable root")?;
        let _ = openat2(
            &root_fd,
            relative,
            OFlags::PATH | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH
                | ResolveFlags::NO_SYMLINKS
                | ResolveFlags::NO_MAGICLINKS
                | ResolveFlags::NO_XDEV,
        )
        .context("resolve self-test worker path")?;
    }

    rustix::thread::set_name(&CString::new("intar-kvm-test")?)?;
    let kvm = Kvm::new().context("open /dev/kvm")?;
    ensure!(kvm.get_api_version() == 12, "unexpected KVM API version");
    let vm = kvm.create_vm().context("create disposable KVM VM")?;
    let vcpu = vm.create_vcpu(0).context("create disposable KVM vCPU")?;

    let requested_abi = ABI::V3;
    let status = Ruleset::default()
        .handle_access(AccessFs::from_all(requested_abi))?
        .create()?
        .add_rule(PathBeneath::new(
            PathFd::new(allowed_dir)?,
            AccessFs::from_all(requested_abi),
        ))?
        .set_compatibility(CompatLevel::HardRequirement)
        .restrict_self()?;
    ensure!(
        status.ruleset == RulesetStatus::FullyEnforced,
        "Landlock ruleset was not fully enforced"
    );
    let landlock_abi = match status.landlock {
        LandlockStatus::Available {
            effective_abi,
            kernel_abi,
        } => kernel_abi
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or_else(|| effective_abi.to_string().parse().unwrap_or_default()),
        _ => 0,
    };
    ensure!(landlock_abi >= 3, "Landlock ABI 3 is required");

    let denied = File::open(denied_path);
    ensure!(
        denied.is_err_and(|error| error.kind() == ErrorKind::PermissionDenied),
        "Landlock did not deny the outside marker"
    );
    let worker_report = WorkerReportV1 {
        version: 1,
        landlock_abi,
        landlock_negative_access: true,
        kvm_vm_created: true,
        kvm_vcpu_created: true,
    };
    let bytes = serde_json::to_vec(&worker_report)?;
    write_new_root_file(report, &bytes, 0o600)?;

    // Keep the KVM VM and vCPU descriptors alive while the parent proves
    // cgroup membership.  A deterministic busy loop must trigger the hard
    // 125-millicore throttle before the worker exits.
    let deadline = Instant::now() + Duration::from_secs(WORKER_SECONDS);
    let mut accumulator = 0_u64;
    while Instant::now() < deadline {
        accumulator = accumulator
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1);
        std::hint::black_box(accumulator);
    }
    drop(vcpu);
    drop(vm);
    drop(kvm);
    Ok(())
}

pub(super) fn agent_api_worker(socket: &Path, expected_uid: u32, expected_gid: u32) -> Result<()> {
    ensure!(
        expected_uid != 0 && expected_gid != 0,
        "agent API worker refuses root identity"
    );
    ensure!(
        socket.is_absolute() && socket.file_name() == Some(OsStr::new("cloud-hypervisor.sock")),
        "agent API worker requires an absolute Cloud Hypervisor socket path"
    );
    ensure!(
        rustix::process::geteuid().is_root(),
        "agent API worker must start as root so it can clear every supplementary group"
    );
    // Drop all three credential IDs in the worker itself. `CommandExt::uid`
    // and `gid` do not clear inherited supplementary groups, so relying on
    // them would make this weaker than the production agent identity.
    let uid = nix::unistd::Uid::from_raw(expected_uid);
    let gid = nix::unistd::Gid::from_raw(expected_gid);
    nix::unistd::setgroups(&[]).context("clear agent API worker supplementary groups")?;
    nix::unistd::setresgid(gid, gid, gid).context("drop agent API worker GID")?;
    nix::unistd::setresuid(uid, uid, uid).context("drop agent API worker UID")?;
    let uid = rustix::process::getuid().as_raw();
    let euid = rustix::process::geteuid().as_raw();
    let gid = rustix::process::getgid().as_raw();
    let egid = rustix::process::getegid().as_raw();
    ensure!(
        uid == expected_uid && euid == expected_uid,
        "agent API worker UID does not match the configured agent"
    );
    ensure!(
        gid == expected_gid && egid == expected_gid,
        "agent API worker GID does not match the configured agent"
    );
    ensure!(
        rustix::process::getgroups()?.is_empty(),
        "agent API worker retained supplementary groups"
    );
    let client = CloudHypervisorClient::new(path_utf8(socket)?)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime
        .block_on(async {
            tokio::time::timeout(CLOUD_HYPERVISOR_API_CALL_TIMEOUT, client.ping()).await
        })
        .context("agent API worker ping timed out")??;
    Ok(())
}

mod cleanup;
use cleanup::*;

mod smoke;
use smoke::*;

mod security;
use security::*;

mod systemd;
use systemd::*;

mod network_tools;
use network_tools::*;

#[cfg(test)]
mod tests;
