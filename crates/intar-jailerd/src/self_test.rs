//! Root-only operational self-test and boot-bound attestation.
//!
//! The normal `intar-agent --doctor` command is intentionally read-only.  This
//! module owns the destructive proof which creates a disposable network
//! namespace, transient systemd unit and cgroup, exercises Landlock and KVM,
//! and removes every object before publishing an attestation.

#![allow(dead_code, reason = "wired into the daemon CLI on Linux only")]

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use intar_jailer_protocol::JailerdConfig;
use serde::{Deserialize, Serialize};

const ATTESTATION_VERSION: u16 = 1;
const ATTESTATION_FILE: &str = "self-test-attestation-v1.json";
const SELF_TEST_CPU_MILLIS: u32 = 125;
const SELF_TEST_CPU_PERIOD_US: u64 = 100_000;
const SELF_TEST_CPU_QUOTA_US: u64 = 12_500;
const SELF_TEST_SATURATION_VM_COUNT: usize = 8;
const SELF_TEST_SATURATION_CPU_MILLIS: u64 = 1_000;
const SELF_TEST_VM_MEMORY_MIB: u32 = 256;
const SELF_TEST_RESOURCE_HEADROOM_MIB: u64 = 512;

/// Durable proof consumed by jailerd readiness.
///
/// The fingerprint binds the proof to every security-relevant jailerd setting
/// and the bytes of the pinned Cloud Hypervisor runtime.  The boot ID makes a
/// successful test non-transferable across host reboots.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SelfTestAttestationV1 {
    pub version: u16,
    pub config_runtime_fingerprint_sha256: String,
    pub cloud_hypervisor_sha256: String,
    pub intar_jailerd_sha256: String,
    pub intar_jailer_sha256: String,
    pub boot_id: String,
    pub kernel_version: String,
    pub systemd_version: String,
    pub landlock_abi: u32,
    pub quota_verified: bool,
    pub burst_verified: bool,
    pub network_verified: bool,
    pub landlock_negative_access: bool,
    pub kvm_accounting_proven: bool,
    pub cloud_hypervisor_lifecycle_verified: bool,
    pub passed_at_unix_s: u64,
}

/// Optional, root-owned inputs for the package-level Cloud Hypervisor smoke
/// test.  All inputs are copied into a disposable jail after their hashes are
/// checked; no caller-provided path is sent to Cloud Hypervisor.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SelfTestArtifacts {
    pub kernel: VerifiedArtifact,
    pub initrd: Option<VerifiedArtifact>,
    pub root_disk: VerifiedArtifact,
    pub runtime_disk: VerifiedArtifact,
    pub recording_disk: VerifiedArtifact,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedArtifact {
    pub path: PathBuf,
    pub sha256: String,
}

impl SelfTestArtifacts {
    pub fn validate(&self) -> Result<()> {
        for artifact in [
            Some(&self.kernel),
            self.initrd.as_ref(),
            Some(&self.root_disk),
            Some(&self.runtime_disk),
            Some(&self.recording_disk),
        ]
        .into_iter()
        .flatten()
        {
            if !artifact.path.is_absolute() {
                bail!("self-test artifact paths must be absolute")
            }
            validate_sha256(&artifact.sha256)?;
        }
        Ok(())
    }
}

/// Run the destructive host diagnostics without publishing a readiness
/// attestation.
///
/// This proves the disposable unit, quota, namespace, Landlock, and basic KVM
/// plumbing.  Only [`run_with_artifacts`] boots the pinned VMM and can publish
/// the durable proof consumed by production readiness.
#[cfg(target_os = "linux")]
pub fn run(config: &JailerdConfig) -> Result<SelfTestAttestationV1> {
    linux::run(config)
}

#[cfg(not(target_os = "linux"))]
pub fn run(_config: &JailerdConfig) -> Result<SelfTestAttestationV1> {
    bail!("the jailerd self-test is supported only on Linux")
}

/// Run the host proof plus the real Cloud Hypervisor package smoke.
///
/// This is the only self-test entry point that may publish the boot-bound
/// readiness attestation. It requires bootable, hash-pinned artifacts and
/// proves eight concurrent jailed 125m Cloud Hypervisor lifecycles, exact
/// one-core admission saturation, ninth-launch rejection, and KVM accounting.
pub fn run_with_artifacts(
    config: &JailerdConfig,
    artifacts: &SelfTestArtifacts,
) -> Result<SelfTestAttestationV1> {
    artifacts.validate()?;
    #[cfg(target_os = "linux")]
    {
        linux::run_with_artifacts(config, artifacts)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = config;
        bail!("the jailerd self-test is supported only on Linux")
    }
}

/// Load an attestation only when it is trusted and still matches this boot,
/// configuration, and the currently installed runtime bytes.
#[cfg(target_os = "linux")]
pub fn load_verified(config: &JailerdConfig) -> Result<Option<SelfTestAttestationV1>> {
    linux::load_verified(config)
}

#[cfg(not(target_os = "linux"))]
pub fn load_verified(_config: &JailerdConfig) -> Result<Option<SelfTestAttestationV1>> {
    Ok(None)
}

/// Entry point used only by the hidden systemd self-test worker command.
#[cfg(target_os = "linux")]
pub fn worker(report: &Path, allowed_dir: &Path, denied_path: &Path) -> Result<()> {
    linux::worker(report, allowed_dir, denied_path)
}

#[cfg(not(target_os = "linux"))]
pub fn worker(_report: &Path, _allowed_dir: &Path, _denied_path: &Path) -> Result<()> {
    bail!("the jailerd self-test worker is supported only on Linux")
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("expected a lowercase SHA-256 digest")
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::{BTreeMap, BTreeSet};
    use std::ffi::CString;
    use std::fs::{File, OpenOptions};
    use std::io::{ErrorKind, Read as _, Write as _};
    use std::net::Shutdown;
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
        MemoryConfig, NetConfig, PayloadConfig, SerialConfig, UnixSocketEndpoint, VmConfig,
        VmState,
    };
    use intar_jailer_protocol::{
        ArtifactAccess, ArtifactSource, DestroyRunNetworkRequest, EnsureRunNetworkRequest,
        JailerdConfig, Request, Response, SandboxHealth, Sha256Digest, SourceArtifacts,
        ValidatedId, VmIdentityRequest, VmInspection, VmLaunchRequest, VmLaunchResult,
    };
    use kvm_ioctls::Kvm;
    use landlock::{
        ABI, Access as _, AccessFs, CompatLevel, Compatible as _, LandlockStatus, PathBeneath,
        PathFd, Ruleset, RulesetAttr as _, RulesetCreatedAttr as _, RulesetStatus,
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
        SelfTestAttestationV1, VerifiedArtifact,
    };
    use crate::{
        FileSystemJailPreparer, HostReadiness, JailerdCore, SystemdHostBackend,
        host_cpu_capacity_millis,
    };

    const MAX_ATTESTATION_BYTES: u64 = 64 * 1024;
    const WORKER_SECONDS: u64 = 8;
    const SATURATION_VM_TRANSITION_TIMEOUT: Duration = Duration::from_secs(30);
    const SATURATION_GUEST_READY_TIMEOUT: Duration = Duration::from_secs(45);
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
                let _ = run_command(&self.ip, ["link", "delete", host_veth_name.as_str()]);
            }
            if let Some(namespace_name) = self.namespace_name.take() {
                let _ = run_command(&self.ip, ["netns", "delete", namespace_name.as_str()]);
            }
            if let Some(directory) = self.directory.take() {
                // Never traverse a leaked mount while unwinding.  The checked
                // cleanup leaves a suspicious directory in place for operator
                // inspection if any mount is still attached.
                let _ =
                    remove_disposable_directory(&directory, self.uid_gid_start, self.uid_gid_end);
            }
        }
    }

    pub(super) fn run(config: &JailerdConfig) -> Result<SelfTestAttestationV1> {
        run_inner(config, None)
    }

    pub(super) fn run_with_artifacts(
        config: &JailerdConfig,
        artifacts: &SelfTestArtifacts,
    ) -> Result<SelfTestAttestationV1> {
        // Artifact hashing is performed even before the disposable host proof
        // so a release job cannot accidentally attest a different smoke image.
        let artifact_root = verify_artifacts(artifacts)?;
        run_inner(config, Some((artifacts, &artifact_root)))
    }

    fn run_inner(
        config: &JailerdConfig,
        artifacts: Option<(&SelfTestArtifacts, &Path)>,
    ) -> Result<SelfTestAttestationV1> {
        require_root()?;
        crate::require_supervisor_process_inspection_capability()
            .context("prove cross-UID VMM executable inspection capability")?;
        config
            .validate()
            .context("validate jailerd configuration")?;
        ensure!(
            config.netns_root == Path::new("/run/netns"),
            "self-test requires netns_root=/run/netns"
        );
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
        let namespace_name = format!("ist{short}");
        let host_veth_name = format!("ish{short}");
        let peer_veth_name = format!("isn{short}");
        ensure!(namespace_name.len() <= 15);
        ensure!(host_veth_name.len() <= 15);
        ensure!(peer_veth_name.len() <= 15);
        let mut cleanup = Cleanup {
            ip: ip.clone(),
            unit_name: None,
            namespace_name: None,
            host_veth_name: None,
            directory: Some(directory.clone()),
            uid_gid_start: config.uid_gid_start,
            uid_gid_end: config.uid_gid_end,
        };

        create_test_network(
            &ip,
            &namespace_name,
            &host_veth_name,
            &peer_veth_name,
            short,
        )?;
        cleanup.namespace_name = Some(namespace_name.clone());
        cleanup.host_veth_name = Some(host_veth_name.clone());
        verify_network(&ip, &namespace_name, &host_veth_name, &peer_veth_name)?;

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
        delete_test_network(&ip, &namespace_name, &host_veth_name)?;
        cleanup.namespace_name = None;
        cleanup.host_veth_name = None;

        let lifecycle_result = match artifacts {
            Some((artifacts, artifact_root)) => {
                run_cloud_hypervisor_smoke(config, artifacts, artifact_root, &directory)
            }
            None => Ok(()),
        };
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

        let lifecycle_verified = artifacts.is_some();
        let attestation = SelfTestAttestationV1 {
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
            network_verified: true,
            landlock_negative_access: true,
            kvm_accounting_proven: lifecycle_verified,
            cloud_hypervisor_lifecycle_verified: lifecycle_verified,
            passed_at_unix_s: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .context("system clock predates Unix epoch")?
                .as_secs(),
        };
        if lifecycle_verified {
            validate_attestation(&attestation)?;
            write_attestation(config, &attestation)?;
        }
        Ok(attestation)
    }

    pub(super) fn load_verified(config: &JailerdConfig) -> Result<Option<SelfTestAttestationV1>> {
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
        let attestation: SelfTestAttestationV1 =
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

    fn validate_worker_paths(
        report: &Path,
        allowed_dir: &Path,
        denied_path: &Path,
    ) -> Result<PathBuf> {
        for path in [report, allowed_dir, denied_path] {
            ensure!(
                path.is_absolute(),
                "self-test worker paths must be absolute"
            );
        }
        ensure!(
            report.parent() == Some(allowed_dir),
            "worker report must be directly beneath its allowed directory"
        );
        let root = allowed_dir
            .parent()
            .context("allowed directory has no disposable root")?;
        ensure!(
            denied_path.parent() == Some(root),
            "denied marker must be a sibling of the allowed directory"
        );
        ensure!(
            root.parent().and_then(Path::file_name) == Some(std::ffi::OsStr::new("self-test")),
            "worker paths must be beneath a self-test root"
        );
        Ok(root.to_path_buf())
    }

    fn validate_attestation(attestation: &SelfTestAttestationV1) -> Result<()> {
        ensure!(
            attestation.version == ATTESTATION_VERSION,
            "unsupported self-test attestation version"
        );
        super::validate_sha256(&attestation.config_runtime_fingerprint_sha256)?;
        super::validate_sha256(&attestation.cloud_hypervisor_sha256)?;
        super::validate_sha256(&attestation.intar_jailerd_sha256)?;
        super::validate_sha256(&attestation.intar_jailer_sha256)?;
        ensure!(
            !attestation.boot_id.is_empty(),
            "attestation boot ID is empty"
        );
        ensure!(
            !attestation.kernel_version.is_empty(),
            "attestation kernel version is empty"
        );
        ensure!(
            !attestation.systemd_version.is_empty(),
            "attestation systemd version is empty"
        );
        ensure!(attestation.landlock_abi >= 3, "Landlock ABI 3 is required");
        ensure!(attestation.quota_verified, "CPU quota was not verified");
        ensure!(attestation.burst_verified, "CPU burst was not disabled");
        ensure!(
            attestation.network_verified,
            "run networking was not verified"
        );
        ensure!(
            attestation.landlock_negative_access,
            "Landlock negative-access proof is absent"
        );
        ensure!(
            attestation.kvm_accounting_proven,
            "KVM accounting proof is absent"
        );
        ensure!(
            attestation.cloud_hypervisor_lifecycle_verified,
            "jailed Cloud Hypervisor lifecycle proof is absent"
        );
        ensure!(
            attestation.passed_at_unix_s != 0,
            "attestation time is invalid"
        );
        Ok(())
    }

    fn write_attestation(
        config: &JailerdConfig,
        attestation: &SelfTestAttestationV1,
    ) -> Result<()> {
        let root = open_trusted_attestation_root(config)?;
        let temporary = format!(".{ATTESTATION_FILE}.{}.tmp", Uuid::new_v4());
        let bytes = serde_json::to_vec(attestation)?;
        ensure!(
            bytes.len().saturating_add(1) as u64 <= MAX_ATTESTATION_BYTES,
            "self-test attestation exceeds 64 KiB"
        );
        let mut published = false;
        let operation = (|| -> Result<()> {
            let fd = openat2(
                &root,
                temporary.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::from_raw_mode(0o600),
                trusted_child_resolve_flags(),
            )
            .context("create self-test attestation temporary file")?;
            let mut file = File::from(fd);
            validate_root_file_metadata(&file.metadata()?, 0o600)?;
            file.write_all(&bytes)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            renameat_with(
                &root,
                temporary.as_str(),
                &root,
                ATTESTATION_FILE,
                RenameFlags::NOREPLACE,
            )
            .context("publish self-test attestation without replacement")?;
            published = true;
            rustix::fs::fsync(&root).context("sync self-test attestation directory")?;
            Ok(())
        })();
        if operation.is_err() {
            let name = if published {
                ATTESTATION_FILE
            } else {
                temporary.as_str()
            };
            let _ = unlinkat(&root, name, AtFlags::empty());
            let _ = rustix::fs::fsync(&root);
        }
        operation
    }

    fn invalidate_previous_attestation(config: &JailerdConfig) -> Result<()> {
        let root = open_trusted_attestation_root(config)?;
        let file = match open_attestation_file(&root)? {
            Some(file) => file,
            None => return Ok(()),
        };
        // Never make a suspicious attestation disappear as a side effect of a
        // new run.  An operator must inspect and remove a tampered path.
        let original = file.metadata()?;
        validate_root_file_metadata(&original, 0o600)?;
        drop(file);
        let invalidating = format!(".{ATTESTATION_FILE}.{}.invalidating", Uuid::new_v4());
        renameat_with(
            &root,
            ATTESTATION_FILE,
            &root,
            invalidating.as_str(),
            RenameFlags::NOREPLACE,
        )
        .context("reserve previous attestation for invalidation")?;
        let operation = (|| -> Result<()> {
            let moved = openat2(
                &root,
                invalidating.as_str(),
                OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
                trusted_child_resolve_flags(),
            )?;
            let moved = File::from(moved);
            let current = moved.metadata()?;
            validate_root_file_metadata(&current, 0o600)?;
            ensure!(
                original.dev() == current.dev() && original.ino() == current.ino(),
                "previous attestation changed identity during invalidation"
            );
            drop(moved);
            unlinkat(&root, invalidating.as_str(), AtFlags::empty())
                .context("unlink invalidated self-test attestation")?;
            rustix::fs::fsync(&root).context("sync invalidated self-test attestation")?;
            Ok(())
        })();
        if let Err(error) = operation {
            let restore = renameat_with(
                &root,
                invalidating.as_str(),
                &root,
                ATTESTATION_FILE,
                RenameFlags::NOREPLACE,
            );
            let _ = rustix::fs::fsync(&root);
            return match restore {
                Ok(()) => Err(error),
                Err(restore_error) => Err(error).context(format!(
                    "failed to restore previous attestation after invalidation failure: {restore_error}"
                )),
            };
        }
        Ok(())
    }

    fn trusted_child_resolve_flags() -> ResolveFlags {
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV
    }

    fn open_attestation_file(root: &File) -> Result<Option<File>> {
        match openat2(
            root,
            ATTESTATION_FILE,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
            trusted_child_resolve_flags(),
        ) {
            Ok(fd) => Ok(Some(File::from(fd))),
            Err(error) if error == rustix::io::Errno::NOENT => Ok(None),
            Err(error) => Err(error).context("open self-test attestation beneath trusted root"),
        }
    }

    fn open_trusted_attestation_root(config: &JailerdConfig) -> Result<File> {
        ensure_trusted_directory(&config.jail_root)?;
        let root = open_absolute_nofollow(&config.jail_root, OFlags::RDONLY | OFlags::DIRECTORY)
            .context("open trusted jail root")?;
        let metadata = root.metadata().context("stat opened jail root")?;
        ensure!(metadata.is_dir(), "opened jail root is not a directory");
        ensure!(metadata.uid() == 0, "opened jail root is not root-owned");
        ensure!(
            metadata.mode() & 0o022 == 0,
            "opened jail root is writable by group/other"
        );
        Ok(root)
    }

    fn open_absolute_nofollow(path: &Path, flags: OFlags) -> Result<File> {
        ensure!(path.is_absolute(), "trusted path must be absolute");
        let relative = path
            .strip_prefix(Path::new("/"))
            .context("strip root from trusted path")?;
        ensure!(
            !relative.as_os_str().is_empty()
                && relative
                    .components()
                    .all(|component| matches!(component, std::path::Component::Normal(_))),
            "trusted path must contain only normal components"
        );
        let filesystem_root = open(
            "/",
            OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?;
        let fd = openat2(
            &filesystem_root,
            relative,
            flags | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        )?;
        Ok(File::from(fd))
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CleanupIdentityReservationV1 {
        version: u16,
        generation: ValidatedId,
        uid: u32,
        gid: u32,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum CleanupOwner {
        Root,
        Vm,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct CleanupDevice {
        major: u32,
        minor: u32,
        mode: u32,
    }

    #[derive(Debug, Default)]
    struct CleanupPolicy {
        vm_owners: BTreeMap<String, (u32, u32)>,
    }

    impl CleanupPolicy {
        fn expected_vm_owner(&self, relative: &[Vec<u8>]) -> Option<(u32, u32)> {
            if relative.len() < 6
                || relative[0] != b"cloud-hypervisor-lifecycle"
                || relative[1] != b"jails"
                || !matches!(relative[2].as_slice(), b"cloud-hypervisor" | b"quarantine")
                || relative[4] != b"root"
            {
                return None;
            }
            let generation = std::str::from_utf8(&relative[3]).ok()?;
            self.vm_owners.get(generation).copied()
        }
    }

    fn remove_disposable_directory(
        directory: &Path,
        uid_gid_start: u32,
        uid_gid_end: u32,
    ) -> Result<()> {
        ensure!(
            directory.is_absolute(),
            "disposable self-test jail path must be absolute"
        );
        let parent = directory
            .parent()
            .context("disposable self-test jail has no parent")?;
        ensure!(
            parent.file_name() == Some(std::ffi::OsStr::new("self-test")),
            "disposable self-test jail is outside its dedicated cleanup root"
        );
        let cleanup_root = parent
            .parent()
            .context("self-test cleanup root has no trusted parent")?;
        let original_name = directory
            .file_name()
            .context("disposable self-test jail has no file name")?;
        let generation = original_name
            .to_str()
            .context("disposable self-test generation is not UTF-8")?;
        ensure!(
            generation.len() == 32
                && generation
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "disposable self-test jail has an invalid generation name"
        );

        // Pin the configured jail root once, then resolve the dedicated
        // self-test directory beneath it with NO_XDEV as well as the complete
        // anti-symlink constraint set. Every later lookup and mutation is
        // relative to these stable descriptors; cleanup never canonicalizes
        // and reopens a caller-controlled pathname.
        ensure_trusted_directory(cleanup_root)?;
        let cleanup_root_fd =
            open_absolute_nofollow(cleanup_root, OFlags::RDONLY | OFlags::DIRECTORY)
                .context("open trusted self-test cleanup root")?;
        validate_cleanup_directory(&rustix::fs::fstat(&cleanup_root_fd)?)
            .context("validate trusted self-test cleanup root")?;
        let parent_fd = open_cleanup_directory(&cleanup_root_fd, "self-test")
            .context("open dedicated self-test directory beneath trusted jail root")?;
        validate_cleanup_directory(&rustix::fs::fstat(&parent_fd)?)
            .context("validate disposable self-test parent directory")?;

        let original_fd = open_cleanup_directory(&parent_fd, original_name)
            .context("open disposable self-test jail beneath trusted parent")?;
        let original_stat = rustix::fs::fstat(&original_fd)?;
        validate_cleanup_directory(&original_stat).context("validate disposable self-test jail")?;

        // Detach the operator-visible generation name before recursively
        // deleting anything. RENAME_NOREPLACE makes the transition exclusive;
        // if cleanup later fails we restore the original name when possible.
        let cleanup_name = CString::new(format!(".cleanup-{}", Uuid::new_v4().simple()))?;
        rustix::fs::renameat_with(
            &parent_fd,
            original_name,
            &parent_fd,
            cleanup_name.as_c_str(),
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .context("reserve private disposable self-test cleanup name")?;

        let operation = (|| -> Result<()> {
            rustix::fs::fsync(&parent_fd)?;
            let cleanup_fd = open_cleanup_directory(&parent_fd, cleanup_name.as_c_str())
                .context("reopen renamed disposable self-test jail")?;
            let cleanup_stat = rustix::fs::fstat(&cleanup_fd)?;
            ensure_same_cleanup_object(&original_stat, &cleanup_stat)
                .context("renamed disposable self-test jail changed identity")?;
            let policy = load_cleanup_policy(&cleanup_fd, uid_gid_start, uid_gid_end)?;
            remove_cleanup_directory_contents(&cleanup_fd, &policy, &[])?;

            // Re-resolve and compare immediately before unlinking the final
            // directory entry. This rejects path swaps even by another
            // privileged process instead of deleting the replacement.
            let final_fd = open_cleanup_directory(&parent_fd, cleanup_name.as_c_str())?;
            let final_stat = rustix::fs::fstat(&final_fd)?;
            ensure_same_cleanup_object(&original_stat, &final_stat)?;
            rustix::fs::unlinkat(
                &parent_fd,
                cleanup_name.as_c_str(),
                rustix::fs::AtFlags::REMOVEDIR,
            )?;
            rustix::fs::fsync(&parent_fd)?;
            Ok(())
        })();

        if let Err(operation_error) = operation {
            let restore = rustix::fs::renameat_with(
                &parent_fd,
                cleanup_name.as_c_str(),
                &parent_fd,
                original_name,
                rustix::fs::RenameFlags::NOREPLACE,
            );
            let _ = rustix::fs::fsync(&parent_fd);
            return match restore {
                Ok(()) => Err(operation_error),
                Err(restore_error) => Err(operation_error).context(format!(
                    "failed to restore disposable self-test jail name after cleanup failure: {restore_error}"
                )),
            };
        }
        Ok(())
    }

    fn open_cleanup_directory(
        parent: &impl std::os::fd::AsFd,
        name: impl rustix::path::Arg,
    ) -> Result<std::os::fd::OwnedFd> {
        Ok(openat2(
            parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
            ResolveFlags::BENEATH
                | ResolveFlags::NO_SYMLINKS
                | ResolveFlags::NO_MAGICLINKS
                | ResolveFlags::NO_XDEV,
        )?)
    }

    fn open_cleanup_entry(
        parent: &impl std::os::fd::AsFd,
        name: impl rustix::path::Arg,
    ) -> Result<std::os::fd::OwnedFd> {
        Ok(openat2(
            parent,
            name,
            // Do not combine O_PATH with O_NOFOLLOW here: openat2 permits a
            // trailing symlink under that exact combination even when
            // RESOLVE_NO_SYMLINKS is set. Without O_NOFOLLOW, any symlink in
            // the lookup fails instead of returning a descriptor for it.
            OFlags::PATH | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH
                | ResolveFlags::NO_SYMLINKS
                | ResolveFlags::NO_MAGICLINKS
                | ResolveFlags::NO_XDEV,
        )?)
    }

    fn open_optional_cleanup_directory(
        parent: &impl std::os::fd::AsFd,
        name: &str,
    ) -> Result<Option<std::os::fd::OwnedFd>> {
        match openat2(
            parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
            ResolveFlags::BENEATH
                | ResolveFlags::NO_SYMLINKS
                | ResolveFlags::NO_MAGICLINKS
                | ResolveFlags::NO_XDEV,
        ) {
            Ok(fd) => {
                validate_cleanup_directory(&rustix::fs::fstat(&fd)?)?;
                Ok(Some(fd))
            }
            Err(error) if error == rustix::io::Errno::NOENT => Ok(None),
            Err(error) => Err(error).context("open optional self-test cleanup directory"),
        }
    }

    fn open_cleanup_regular_file(
        parent: &impl std::os::fd::AsFd,
        name: impl rustix::path::Arg,
    ) -> Result<std::os::fd::OwnedFd> {
        Ok(openat2(
            parent,
            name,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
            ResolveFlags::BENEATH
                | ResolveFlags::NO_SYMLINKS
                | ResolveFlags::NO_MAGICLINKS
                | ResolveFlags::NO_XDEV,
        )?)
    }

    fn load_cleanup_policy(
        cleanup_root: &impl std::os::fd::AsFd,
        uid_gid_start: u32,
        uid_gid_end: u32,
    ) -> Result<CleanupPolicy> {
        let Some(lifecycle) =
            open_optional_cleanup_directory(cleanup_root, "cloud-hypervisor-lifecycle")?
        else {
            return Ok(CleanupPolicy::default());
        };
        let Some(jails) = open_optional_cleanup_directory(&lifecycle, "jails")? else {
            return Ok(CleanupPolicy::default());
        };
        let Some(quarantine) = open_optional_cleanup_directory(&jails, "quarantine")? else {
            return Ok(CleanupPolicy::default());
        };
        let Some(reservations) = open_optional_cleanup_directory(&quarantine, "reservations")?
        else {
            return Ok(CleanupPolicy::default());
        };

        let mut policy = CleanupPolicy::default();
        let mut identities = BTreeSet::new();
        let mut stream = rustix::fs::Dir::read_from(&reservations)?;
        let mut names = Vec::new();
        while let Some(entry) = stream.read() {
            let entry = entry?;
            if matches!(entry.file_name().to_bytes(), b"." | b"..") {
                continue;
            }
            names.push(entry.file_name().to_owned());
        }
        drop(stream);

        for name in names {
            let fd = open_cleanup_regular_file(&reservations, name.as_c_str())?;
            let stat = rustix::fs::fstat(&fd)?;
            ensure!(
                rustix::fs::FileType::from_raw_mode(stat.st_mode)
                    == rustix::fs::FileType::RegularFile
                    && stat.st_uid == 0
                    && stat.st_gid == 0
                    && stat.st_nlink == 1
                    && stat.st_mode & 0o177 == 0,
                "self-test identity reservation is not a root-owned private one-link regular file"
            );
            let mut bytes = Vec::new();
            File::from(fd)
                .take(MAX_ATTESTATION_BYTES + 1)
                .read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() <= MAX_ATTESTATION_BYTES as usize,
                "self-test identity reservation exceeds 64 KiB"
            );
            let reservation: CleanupIdentityReservationV1 = serde_json::from_slice(&bytes)?;
            let generation = reservation.generation.as_str();
            ensure!(
                reservation.version == 1
                    && reservation.uid == reservation.gid
                    && (uid_gid_start..=uid_gid_end).contains(&reservation.uid)
                    && name.to_bytes() == format!("{generation}.json").as_bytes(),
                "invalid self-test identity reservation"
            );
            ensure!(
                identities.insert(reservation.uid),
                "duplicate self-test VM identity reservation"
            );
            ensure!(
                policy
                    .vm_owners
                    .insert(generation.to_owned(), (reservation.uid, reservation.gid))
                    .is_none(),
                "duplicate self-test generation reservation"
            );
        }
        Ok(policy)
    }

    fn validate_cleanup_directory(stat: &rustix::fs::Stat) -> Result<()> {
        ensure!(
            rustix::fs::FileType::from_raw_mode(stat.st_mode).is_dir(),
            "cleanup target is not a directory"
        );
        ensure!(
            stat.st_uid == 0 && stat.st_gid == 0,
            "cleanup directory is not root-owned"
        );
        ensure!(
            stat.st_mode & 0o022 == 0,
            "cleanup directory is writable by group/other"
        );
        ensure!(stat.st_nlink >= 1, "cleanup directory has no links");
        Ok(())
    }

    fn cleanup_jail_relative(relative: &[Vec<u8>]) -> Option<&[Vec<u8>]> {
        if relative.len() < 5
            || relative[0] != b"cloud-hypervisor-lifecycle"
            || relative[1] != b"jails"
            || !matches!(relative[2].as_slice(), b"cloud-hypervisor" | b"quarantine")
            || relative[4] != b"root"
        {
            return None;
        }
        Some(&relative[5..])
    }

    fn cleanup_owner(
        stat: &rustix::fs::Stat,
        relative: &[Vec<u8>],
        policy: &CleanupPolicy,
    ) -> Result<CleanupOwner> {
        if (stat.st_uid, stat.st_gid) == (0, 0) {
            return Ok(CleanupOwner::Root);
        }
        ensure!(
            policy.expected_vm_owner(relative) == Some((stat.st_uid, stat.st_gid)),
            "cleanup entry has an unexpected owner"
        );
        Ok(CleanupOwner::Vm)
    }

    fn validate_cleanup_tree_directory(
        stat: &rustix::fs::Stat,
        relative: &[Vec<u8>],
        policy: &CleanupPolicy,
    ) -> Result<CleanupOwner> {
        ensure!(
            rustix::fs::FileType::from_raw_mode(stat.st_mode).is_dir(),
            "cleanup target is not a directory"
        );
        ensure!(stat.st_nlink >= 1, "cleanup directory has no links");
        let owner = cleanup_owner(stat, relative, policy)?;
        if owner == CleanupOwner::Root {
            ensure!(
                stat.st_mode & 0o022 == 0,
                "root-owned cleanup directory is writable by group/other"
            );
        } else {
            ensure!(
                stat.st_mode & 0o002 == 0,
                "VM-owned cleanup directory is other-writable"
            );
        }
        Ok(owner)
    }

    fn expected_cleanup_device(relative: &[Vec<u8>]) -> Option<CleanupDevice> {
        match cleanup_jail_relative(relative)? {
            [dev, kvm] if dev == b"dev" && kvm == b"kvm" => Some(CleanupDevice {
                major: 10,
                minor: 232,
                mode: 0o600,
            }),
            [dev, net, tun] if dev == b"dev" && net == b"net" && tun == b"tun" => {
                Some(CleanupDevice {
                    major: 10,
                    minor: 200,
                    mode: 0o600,
                })
            }
            [dev, urandom] if dev == b"dev" && urandom == b"urandom" => Some(CleanupDevice {
                major: 1,
                minor: 9,
                mode: 0o400,
            }),
            [dev, null] if dev == b"dev" && null == b"null" => Some(CleanupDevice {
                major: 1,
                minor: 3,
                mode: 0o600,
            }),
            _ => None,
        }
    }

    fn cleanup_socket_allowed(relative: &[Vec<u8>]) -> bool {
        matches!(
            cleanup_jail_relative(relative),
            Some([run, socket])
                if run == b"run"
                    && matches!(socket.as_slice(), b"cloud-hypervisor.sock" | b"kino.vsock")
        )
    }

    fn validate_cleanup_leaf(
        stat: &rustix::fs::Stat,
        relative: &[Vec<u8>],
        policy: &CleanupPolicy,
    ) -> Result<()> {
        ensure!(stat.st_nlink == 1, "cleanup leaf must have one link");
        let owner = cleanup_owner(stat, relative, policy)?;
        let file_type = rustix::fs::FileType::from_raw_mode(stat.st_mode);
        match file_type {
            rustix::fs::FileType::RegularFile => {
                if owner == CleanupOwner::Root {
                    ensure!(
                        stat.st_mode & 0o022 == 0,
                        "root-owned cleanup file is writable by group/other"
                    );
                } else {
                    ensure!(
                        stat.st_mode & 0o002 == 0,
                        "VM-owned cleanup file is other-writable"
                    );
                }
            }
            rustix::fs::FileType::CharacterDevice => {
                let expected = expected_cleanup_device(relative)
                    .context("cleanup character device is not allowlisted")?;
                ensure!(
                    owner == CleanupOwner::Vm
                        && rustix::fs::major(stat.st_rdev) == expected.major
                        && rustix::fs::minor(stat.st_rdev) == expected.minor
                        && stat.st_mode & 0o777 == expected.mode,
                    "cleanup character device does not match its allowlist entry"
                );
            }
            rustix::fs::FileType::Socket => {
                ensure!(
                    owner == CleanupOwner::Vm
                        && cleanup_socket_allowed(relative)
                        && stat.st_mode & 0o002 == 0,
                    "cleanup socket is not allowlisted"
                );
            }
            _ => bail!("cleanup leaf has a forbidden file type"),
        }
        Ok(())
    }

    fn lock_cleanup_directory(directory: &impl std::os::fd::AsFd) -> Result<rustix::fs::Stat> {
        rustix::fs::fchown(
            directory,
            Some(rustix::process::Uid::ROOT),
            Some(rustix::process::Gid::ROOT),
        )?;
        rustix::fs::fchmod(directory, Mode::RUSR | Mode::WUSR | Mode::XUSR)?;
        let stat = rustix::fs::fstat(directory)?;
        validate_cleanup_directory(&stat)?;
        Ok(stat)
    }

    fn ensure_same_cleanup_object(
        expected: &rustix::fs::Stat,
        actual: &rustix::fs::Stat,
    ) -> Result<()> {
        ensure!(
            expected.st_dev == actual.st_dev
                && expected.st_ino == actual.st_ino
                && rustix::fs::FileType::from_raw_mode(expected.st_mode)
                    == rustix::fs::FileType::from_raw_mode(actual.st_mode)
                && expected.st_uid == actual.st_uid
                && expected.st_gid == actual.st_gid,
            "cleanup target changed identity"
        );
        Ok(())
    }

    fn remove_cleanup_directory_contents(
        directory: &impl std::os::fd::AsFd,
        policy: &CleanupPolicy,
        relative: &[Vec<u8>],
    ) -> Result<()> {
        let mut stream = rustix::fs::Dir::read_from(directory)?;
        let mut names = Vec::new();
        while let Some(entry) = stream.read() {
            let entry = entry?;
            if matches!(entry.file_name().to_bytes(), b"." | b"..") {
                continue;
            }
            names.push(entry.file_name().to_owned());
        }
        drop(stream);

        for name in names {
            let mut entry_relative = relative.to_vec();
            entry_relative.push(name.to_bytes().to_vec());
            let entry_fd = open_cleanup_entry(directory, name.as_c_str())
                .context("open disposable self-test cleanup entry")?;
            let entry_stat = rustix::fs::fstat(&entry_fd)?;
            let file_type = rustix::fs::FileType::from_raw_mode(entry_stat.st_mode);
            if file_type.is_dir() {
                validate_cleanup_tree_directory(&entry_stat, &entry_relative, policy)?;
                let child_fd = open_cleanup_directory(directory, name.as_c_str())?;
                let child_stat = rustix::fs::fstat(&child_fd)?;
                ensure_same_cleanup_object(&entry_stat, &child_stat)?;
                let locked_stat = lock_cleanup_directory(&child_fd)?;
                remove_cleanup_directory_contents(&child_fd, policy, &entry_relative)?;
                let final_fd = open_cleanup_directory(directory, name.as_c_str())?;
                let final_stat = rustix::fs::fstat(&final_fd)?;
                ensure_same_cleanup_object(&locked_stat, &final_stat)?;
                validate_cleanup_directory(&final_stat)?;
                rustix::fs::unlinkat(directory, name.as_c_str(), rustix::fs::AtFlags::REMOVEDIR)?;
            } else {
                validate_cleanup_leaf(&entry_stat, &entry_relative, policy)?;
                let final_fd = open_cleanup_entry(directory, name.as_c_str())?;
                let final_stat = rustix::fs::fstat(&final_fd)?;
                ensure_same_cleanup_object(&entry_stat, &final_stat)?;
                validate_cleanup_leaf(&final_stat, &entry_relative, policy)?;
                rustix::fs::unlinkat(directory, name.as_c_str(), rustix::fs::AtFlags::empty())?;
            }
        }
        rustix::fs::fsync(directory)?;
        Ok(())
    }

    fn config_runtime_fingerprint(
        config: &JailerdConfig,
        runtime_sha256: &str,
        jailerd_sha256: &str,
        jailer_sha256: &str,
    ) -> Result<String> {
        let mut hasher = Sha256::new();
        hasher.update(b"intar-jailerd-self-test-attestation-v1\0");
        hasher.update(serde_json::to_vec(config)?);
        hasher.update(b"\0");
        hasher.update(runtime_sha256.as_bytes());
        hasher.update(b"\0");
        hasher.update(jailerd_sha256.as_bytes());
        hasher.update(b"\0");
        hasher.update(jailer_sha256.as_bytes());
        Ok(hex_digest(hasher.finalize()))
    }

    fn verify_artifacts(artifacts: &SelfTestArtifacts) -> Result<PathBuf> {
        artifacts.validate()?;
        let artifact_list = [
            Some(&artifacts.kernel),
            artifacts.initrd.as_ref(),
            Some(&artifacts.root_disk),
            Some(&artifacts.runtime_disk),
            Some(&artifacts.recording_disk),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        let artifact_root = shared_artifact_parent(&artifact_list)?;
        ensure_trusted_directory(&artifact_root)
            .context("self-test artifact root is not root-only and trusted")?;
        for artifact in artifact_list {
            let (actual_sha256, metadata) = file_sha256_and_metadata(&artifact.path)?;
            ensure!(
                actual_sha256 == artifact.sha256,
                "self-test artifact hash mismatch: {}",
                artifact.path.display()
            );
            ensure!(
                metadata.is_file(),
                "self-test artifact is not a regular file"
            );
            ensure!(
                metadata.nlink() == 1,
                "self-test artifact must have one link"
            );
            ensure!(
                metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
                "self-test artifacts must be root-owned and non-writable"
            );
        }
        Ok(artifact_root)
    }

    fn shared_artifact_parent(artifacts: &[&VerifiedArtifact]) -> Result<PathBuf> {
        let first = artifacts.first().context("self-test has no artifacts")?;
        let parent = first
            .path
            .parent()
            .context("self-test artifact has no parent directory")?;
        ensure!(
            artifacts
                .iter()
                .all(|artifact| artifact.path.parent() == Some(parent)),
            "all self-test artifacts must share one root-only parent directory"
        );
        Ok(parent.to_path_buf())
    }

    fn run_cloud_hypervisor_smoke(
        config: &JailerdConfig,
        artifacts: &SelfTestArtifacts,
        artifact_root: &Path,
        directory: &Path,
    ) -> Result<()> {
        let lifecycle_root = directory.join("cloud-hypervisor-lifecycle");
        create_root_directory(&lifecycle_root)?;
        let mut smoke_config = config.clone();
        smoke_config.jail_root = lifecycle_root.join("jails");
        create_root_directory(&smoke_config.jail_root)?;
        // This isolated Core instance has no other reservations.  The operator
        // reserve is validated by the normal daemon; retaining it here would
        // make the proof impossible on an otherwise empty one-core CI host.
        smoke_config.cpu_reserved_millis = 0;
        smoke_config.guest_network_pool = "10.77.255.240/28".to_owned();
        if !smoke_config
            .allowed_source_roots
            .iter()
            .any(|root| root == artifact_root)
        {
            smoke_config
                .allowed_source_roots
                .push(artifact_root.to_path_buf());
        }
        ensure_saturation_resources(&smoke_config, artifacts)?;

        // The ordinary constructor accepts only a durable verified
        // attestation.  This narrowly scoped constructor is available only to
        // this root self-test module and carries the in-memory negative-access
        // proof until the full lifecycle succeeds and is published.
        let backend = SystemdHostBackend::connect_with_landlock_attestation(&smoke_config, true)?;
        let readiness = HostReadiness {
            uid_gid_range_collision_free: crate::identity_range_is_free(&smoke_config),
            config_trusted: true,
            source_roots_trusted: true,
            jailer_binary_trusted: true,
            runtime_hash_verified: true,
            runtime_statically_linked: crate::elf_has_no_interpreter(
                &smoke_config.cloud_hypervisor_binary,
            ),
            systemd_version: Some(read_systemd_version()?),
            supports_systemd_transient_units: true,
            supports_cgroup_v2: true,
            seccomp_supported: true,
            landlock_abi: Some(3),
            privileged_self_test_passed: true,
            kvm_accounting_proven: true,
            posix_acl_supported: true,
        };
        let mut core = JailerdCore::new_with_readiness(
            smoke_config.clone(),
            backend,
            FileSystemJailPreparer,
            // The disposable authority intentionally advertises exactly one
            // schedulable core. This makes the ninth 125m launch exercise the
            // same final local admission path used in production even on a
            // host with more CPUs.
            SELF_TEST_SATURATION_CPU_MILLIS,
            readiness,
        )?;

        let suffix = Uuid::new_v4().simple().to_string();
        let run_id = ValidatedId::parse(format!("selftest-{}", &suffix[..12]))?;
        let network_request = EnsureRunNetworkRequest {
            run_id: run_id.clone(),
            guest_cidr: "10.77.255.240/28".to_owned(),
            gateway: "10.77.255.241".to_owned(),
        };
        expect_run_network(core.handle(Request::EnsureRunNetwork(network_request.clone())))?;

        // Boot eight independent VMMs in the same run network. Their 125m
        // reservations fill exactly one advertised schedulable core while
        // retaining separate generations, identities, TAPs, units and leaf
        // cgroups. A ninth typed request is then required to fail admission
        // before any privileged resource is allocated.
        let launch_requests = (0..SELF_TEST_SATURATION_VM_COUNT)
            .map(|index| {
                smoke_launch_request(
                    &smoke_config,
                    artifacts,
                    &run_id,
                    &suffix,
                    u8::try_from(index).expect("saturation VM index fits in u8"),
                )
            })
            .collect::<Result<Vec<_>>>()?;
        let tasks_before = snapshot_tasks()?;
        let mut launches = Vec::with_capacity(launch_requests.len());
        let mut selectors = Vec::with_capacity(launch_requests.len());
        for request in &launch_requests {
            match launch_smoke_vm(&mut core, request) {
                Ok(launch) => {
                    selectors.push(VmIdentityRequest::by_generation(launch.generation.clone()));
                    launches.push(launch);
                }
                Err(operation) => {
                    let cleanup = cleanup_smoke_vms(&mut core, &selectors, &run_id);
                    return match cleanup {
                        Ok(()) => Err(operation),
                        Err(cleanup) => Err(operation).context(format!(
                            "partial saturation package-smoke cleanup also failed: {cleanup:#}"
                        )),
                    };
                }
            }
        }

        let admission = prove_saturation_admission(
            &mut core,
            &smoke_config,
            artifacts,
            &run_id,
            &suffix,
            &mut selectors,
        );
        if let Err(operation) = admission {
            let cleanup = cleanup_smoke_vms(&mut core, &selectors, &run_id);
            return match cleanup {
                Ok(()) => Err(operation),
                Err(cleanup) => Err(operation).context(format!(
                    "saturation admission cleanup also failed: {cleanup:#}"
                )),
            };
        }

        let lifecycle = (|| -> Result<()> {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let mut clients = Vec::with_capacity(launches.len());
            for ((launch, request), index) in launches.iter().zip(&launch_requests).zip(0..) {
                ensure!(
                    !launch.paths.host_jail_root.join("dev/vhost-vsock").exists(),
                    "package smoke VM {index} unexpectedly exposed /dev/vhost-vsock"
                );
                let landlock_canary = launch.paths.host_jail_root.join("run/landlock-api-canary");
                write_new_root_file(&landlock_canary, b"landlock-vmm-negative\n", 0o444)
                    .with_context(|| format!("create package-smoke VM {index} Landlock canary"))?;
                let client = CloudHypervisorClient::new(path_utf8(&launch.paths.host_api_socket)?)?;
                let vm_config = smoke_vm_config(launch, request)?;
                runtime
                    .block_on(start_smoke_vm(&client, &vm_config))
                    .with_context(|| format!("start package-smoke VM {index}"))?;
                clients.push(client);
            }

            let mut inspections = Vec::with_capacity(selectors.len());
            for (index, (selector, launch)) in selectors.iter().zip(&launches).enumerate() {
                let inspection = expect_inspection(
                    core.handle(Request::InspectVm(selector.clone())),
                    &format!("inspect booted package-smoke VM {index}"),
                )?;
                wait_for_guest_ready(
                    &launch.paths.host_console_log,
                    SATURATION_GUEST_READY_TIMEOUT,
                )
                .with_context(|| format!("wait for package-smoke VM {index}"))?;
                assert_smoke_inspection(&inspection)
                    .with_context(|| format!("validate package-smoke VM {index}"))?;
                prove_cloud_hypervisor_landlock(&launch.paths.host_api_socket)
                    .with_context(|| format!("prove package-smoke VM {index} Landlock"))?;
                inspections.push(inspection);
            }

            assert_saturation_vm_isolation(&inspections, &tasks_before)?;
            for (index, client) in clients.iter().enumerate() {
                runtime
                    .block_on(shutdown_smoke_vm(client))
                    .with_context(|| format!("shutdown package-smoke VM {index}"))?;
            }
            Ok(())
        })();

        let cleanup = cleanup_smoke_vms(&mut core, &selectors, &run_id);
        match (lifecycle, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(error)) => Err(error).context("clean up package-smoke VM"),
            (Err(operation), Err(cleanup)) => {
                Err(operation).context(format!("package-smoke cleanup also failed: {cleanup:#}"))
            }
        }
    }

    fn ensure_saturation_resources(
        config: &JailerdConfig,
        artifacts: &SelfTestArtifacts,
    ) -> Result<()> {
        let host_cpu_millis = host_cpu_capacity_millis()?;
        ensure!(
            host_cpu_millis >= SELF_TEST_SATURATION_CPU_MILLIS,
            "eight-VM saturation proof requires at least one online host CPU"
        );
        let identity_count = u64::from(config.uid_gid_end)
            .checked_sub(u64::from(config.uid_gid_start))
            .and_then(|value| value.checked_add(1))
            .context("self-test UID/GID range arithmetic overflow")?;
        ensure!(
            identity_count >= u64::try_from(SELF_TEST_SATURATION_VM_COUNT)?,
            "eight-VM saturation proof requires at least eight disposable identities"
        );

        let meminfo = std::fs::read_to_string("/proc/meminfo")?;
        let available_kib = meminfo
            .lines()
            .find_map(|line| line.strip_prefix("MemAvailable:"))
            .and_then(|value| {
                let mut fields = value.split_whitespace();
                let kib = fields.next()?.parse::<u64>().ok()?;
                (fields.next() == Some("kB") && fields.next().is_none()).then_some(kib)
            })
            .context("/proc/meminfo has no valid MemAvailable value")?;
        let required_memory_mib = u64::from(SELF_TEST_VM_MEMORY_MIB)
            .checked_mul(u64::try_from(SELF_TEST_SATURATION_VM_COUNT)?)
            .and_then(|value| value.checked_add(SELF_TEST_RESOURCE_HEADROOM_MIB))
            .context("self-test memory requirement overflow")?;
        ensure!(
            available_kib >= required_memory_mib.saturating_mul(1024),
            "eight-VM saturation proof requires {required_memory_mib} MiB available memory; host reports {} MiB",
            available_kib / 1024
        );

        let fixture_bytes = [
            Some(&artifacts.kernel),
            artifacts.initrd.as_ref(),
            Some(&artifacts.root_disk),
            Some(&artifacts.runtime_disk),
            Some(&artifacts.recording_disk),
        ]
        .into_iter()
        .flatten()
        .try_fold(0_u64, |total, artifact| {
            total
                .checked_add(std::fs::metadata(&artifact.path)?.len())
                .context("self-test fixture size overflow")
        })?;
        let per_vm_bytes = fixture_bytes
            .checked_add(std::fs::metadata(&config.cloud_hypervisor_binary)?.len())
            .context("self-test per-VM disk requirement overflow")?;
        let required_disk_bytes = per_vm_bytes
            .checked_mul(u64::try_from(SELF_TEST_SATURATION_VM_COUNT)?)
            .and_then(|value| {
                value.checked_add(SELF_TEST_RESOURCE_HEADROOM_MIB.saturating_mul(1024 * 1024))
            })
            .context("self-test disk requirement overflow")?;
        let jail_root =
            open_absolute_nofollow(&config.jail_root, OFlags::RDONLY | OFlags::DIRECTORY)?;
        let filesystem = rustix::fs::fstatvfs(&jail_root)?;
        let fragment_size = if filesystem.f_frsize == 0 {
            filesystem.f_bsize
        } else {
            filesystem.f_frsize
        };
        let available_disk_bytes = filesystem
            .f_bavail
            .checked_mul(fragment_size)
            .context("self-test available disk size overflow")?;
        ensure!(
            available_disk_bytes >= required_disk_bytes,
            "eight-VM saturation proof requires {} MiB free in the jail filesystem; host reports {} MiB",
            required_disk_bytes / (1024 * 1024),
            available_disk_bytes / (1024 * 1024)
        );
        ensure!(
            filesystem.f_favail >= u64::try_from(SELF_TEST_SATURATION_VM_COUNT)?.saturating_mul(64),
            "jail filesystem lacks free inodes for eight disposable VMs"
        );
        Ok(())
    }

    fn prove_saturation_admission(
        core: &mut JailerdCore<SystemdHostBackend, FileSystemJailPreparer>,
        config: &JailerdConfig,
        artifacts: &SelfTestArtifacts,
        run_id: &ValidatedId,
        suffix: &str,
        selectors: &mut Vec<VmIdentityRequest>,
    ) -> Result<()> {
        ensure!(
            selectors.len() == SELF_TEST_SATURATION_VM_COUNT,
            "saturation admission proof requires eight launched VMs"
        );
        let before = core.capabilities();
        ensure!(
            before.total_cpu_millis == SELF_TEST_SATURATION_CPU_MILLIS
                && before.reserved_cpu_millis == 0
                && before.schedulable_cpu_millis == SELF_TEST_SATURATION_CPU_MILLIS
                && before.committed_cpu_millis == SELF_TEST_SATURATION_CPU_MILLIS,
            "eight 125m VM reservations did not fill exactly one schedulable core"
        );
        ensure!(
            before.supports_jailer_v1 && before.supports_hard_cpu_quota,
            "saturation authority stopped advertising hard jailed CPU quotas"
        );

        let rejected_index =
            u8::try_from(SELF_TEST_SATURATION_VM_COUNT).expect("saturation VM count fits in u8");
        let ninth = smoke_launch_request(config, artifacts, run_id, suffix, rejected_index)?;
        match core.handle(Request::LaunchVm(Box::new(ninth))) {
            Response::Error(error) => ensure!(
                error.code == "cpu_capacity_exhausted",
                "ninth 125m launch failed with unexpected error {}: {}",
                error.code,
                error.message
            ),
            Response::LaunchVm(launch) => {
                // Retain the selector so the caller's fail-closed cleanup also
                // drains an erroneously admitted ninth unit and jail.
                selectors.push(VmIdentityRequest::by_generation(launch.generation));
                bail!("ninth 125m VM was admitted after one schedulable core was full")
            }
            response => bail!("ninth 125m launch returned unexpected response: {response:?}"),
        }
        let after = core.capabilities();
        ensure!(
            after.committed_cpu_millis == before.committed_cpu_millis
                && after.schedulable_cpu_millis == before.schedulable_cpu_millis,
            "rejected ninth launch changed local CPU reservations"
        );
        Ok(())
    }

    fn smoke_launch_request(
        config: &JailerdConfig,
        artifacts: &SelfTestArtifacts,
        run_id: &ValidatedId,
        suffix: &str,
        index: u8,
    ) -> Result<VmLaunchRequest> {
        ensure!(
            usize::from(index) <= SELF_TEST_SATURATION_VM_COUNT,
            "package smoke supports eight VMs plus one rejected admission probe"
        );
        Ok(VmLaunchRequest {
            run_id: run_id.clone(),
            vm_id: ValidatedId::parse(format!("vm-{index}"))?,
            cpu_millis: SELF_TEST_CPU_MILLIS,
            vcpu_count: 1,
            memory_mib: SELF_TEST_VM_MEMORY_MIB,
            tap_name: format!("is{index}{}", &suffix[..10]),
            mac_address: format!(
                "02:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                u8::from_str_radix(&suffix[0..2], 16)?,
                u8::from_str_radix(&suffix[2..4], 16)?,
                u8::from_str_radix(&suffix[4..6], 16)?,
                u8::from_str_radix(&suffix[6..8], 16)?,
                index.saturating_add(1),
            ),
            guest_ip_cidr: format!("10.77.255.{}/28", index.saturating_add(242)),
            ssh_public_port: None,
            // Deliberately unused in VmConfig below. The protocol still
            // requires a valid typed CID for parity with production launches.
            vsock_cid: 4_294_000_001_u32.saturating_add(u32::from(index)),
            artifacts: protocol_artifacts(config, artifacts)?,
        })
    }

    fn launch_smoke_vm(
        core: &mut JailerdCore<SystemdHostBackend, FileSystemJailPreparer>,
        request: &VmLaunchRequest,
    ) -> Result<VmLaunchResult> {
        match core.handle(Request::LaunchVm(Box::new(request.clone()))) {
            Response::LaunchVm(launch) => Ok(launch),
            Response::Error(error) => bail!(
                "jailerd package-smoke launch failed for {}: {}: {}",
                request.vm_id,
                error.code,
                error.message
            ),
            response => bail!(
                "unexpected package-smoke launch response for {}: {response:?}",
                request.vm_id
            ),
        }
    }

    fn protocol_artifacts(
        config: &JailerdConfig,
        artifacts: &SelfTestArtifacts,
    ) -> Result<SourceArtifacts> {
        Ok(SourceArtifacts {
            kernel: protocol_artifact(config, &artifacts.kernel, ArtifactAccess::ReadOnly)?,
            initrd: artifacts
                .initrd
                .as_ref()
                .map(|artifact| protocol_artifact(config, artifact, ArtifactAccess::ReadOnly))
                .transpose()?,
            root_disk: protocol_artifact(config, &artifacts.root_disk, ArtifactAccess::ReadWrite)?,
            runtime_disk: protocol_artifact(
                config,
                &artifacts.runtime_disk,
                ArtifactAccess::ReadOnly,
            )?,
            recording_disk: protocol_artifact(
                config,
                &artifacts.recording_disk,
                ArtifactAccess::ReadWrite,
            )?,
        })
    }

    fn protocol_artifact(
        config: &JailerdConfig,
        artifact: &VerifiedArtifact,
        access: ArtifactAccess,
    ) -> Result<ArtifactSource> {
        for (index, root) in config.allowed_source_roots.iter().enumerate() {
            let Ok(relative_path) = artifact.path.strip_prefix(root) else {
                continue;
            };
            if relative_path
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)))
            {
                return Ok(ArtifactSource {
                    source_root: u16::try_from(index).context("too many allowed source roots")?,
                    relative_path: relative_path.to_path_buf(),
                    sha256: Some(Sha256Digest::parse(artifact.sha256.clone())?),
                    access,
                });
            }
        }
        bail!(
            "self-test artifact is not beneath an allowed source root: {}",
            artifact.path.display()
        )
    }

    fn expect_run_network(response: Response) -> Result<()> {
        match response {
            Response::EnsureRunNetwork(_) => Ok(()),
            Response::Error(error) => {
                bail!(
                    "ensure package-smoke network failed: {}: {}",
                    error.code,
                    error.message
                )
            }
            response => bail!("unexpected ensure-network response: {response:?}"),
        }
    }

    fn smoke_vm_config(launch: &VmLaunchResult, request: &VmLaunchRequest) -> Result<VmConfig> {
        Ok(VmConfig {
            cpus: Some(CpusConfig {
                boot_vcpus: 1,
                max_vcpus: 1,
            }),
            memory: Some(MemoryConfig {
                size: i64::from(SELF_TEST_VM_MEMORY_MIB) * 1024 * 1024,
            }),
            payload: PayloadConfig {
                kernel: Some(path_utf8(&launch.paths.jailed_kernel)?),
                initramfs: launch
                    .paths
                    .jailed_initrd
                    .as_ref()
                    .map(|path| path_utf8(path))
                    .transpose()?,
                cmdline: Some(
                    "console=hvc0 root=/dev/vda rw reboot=k panic=1 init=/sbin/init".to_owned(),
                ),
                ..PayloadConfig::default()
            },
            disks: Some(vec![
                DiskConfig {
                    path: path_utf8(&launch.paths.jailed_root_disk)?,
                    readonly: false,
                    id: Some("selftest-root".to_owned()),
                    image_type: Some(DiskImageType::Raw),
                },
                DiskConfig {
                    path: path_utf8(&launch.paths.jailed_runtime_disk)?,
                    readonly: true,
                    id: Some("selftest-runtime".to_owned()),
                    image_type: Some(DiskImageType::Raw),
                },
                DiskConfig {
                    path: path_utf8(&launch.paths.jailed_recording_disk)?,
                    readonly: false,
                    id: Some("selftest-recording".to_owned()),
                    image_type: Some(DiskImageType::Raw),
                },
            ]),
            net: Some(vec![NetConfig {
                tap: request.tap_name.clone(),
                mac: Some(request.mac_address.clone()),
                ip: None,
                mask: None,
            }]),
            serial: Some(SerialConfig {
                file: Some(path_utf8(&launch.paths.jailed_serial_log)?),
                mode: "File".to_owned(),
                iommu: false,
                socket: None,
            }),
            console: Some(ConsoleConfig {
                file: Some(path_utf8(&launch.paths.jailed_console_log)?),
                mode: "File".to_owned(),
                iommu: false,
                socket: None,
            }),
            // This is the explicit package proof that v53 can boot without
            // exposing /dev/vhost-vsock.
            vsock: None,
            landlock_enable: Some(true),
        })
    }

    async fn start_smoke_vm(client: &CloudHypervisorClient, config: &VmConfig) -> Result<()> {
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

    async fn shutdown_smoke_vm(client: &CloudHypervisorClient) -> Result<()> {
        client
            .vm_shutdown()
            .await
            .context("request jailed API shutdown")?;
        let deadline = tokio::time::Instant::now() + SATURATION_VM_TRANSITION_TIMEOUT;
        loop {
            match client.vm_info().await {
                Ok(info) if matches!(info.state, VmState::Shutdown) => break,
                Ok(_) | Err(_) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Ok(info) => bail!("smoke VM did not shut down: {:?}", info.state),
                Err(error) => return Err(error).context("observe jailed API shutdown"),
            }
        }
        client
            .vm_delete()
            .await
            .context("delete shutdown smoke VM")?;
        Ok(())
    }

    fn expect_inspection(response: Response, operation: &str) -> Result<VmInspection> {
        match response {
            Response::InspectVm(inspection) => Ok(inspection),
            Response::Error(error) => {
                bail!("{operation} failed: {}: {}", error.code, error.message)
            }
            response => bail!("{operation} returned unexpected response: {response:?}"),
        }
    }

    fn assert_smoke_inspection(inspection: &VmInspection) -> Result<()> {
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

    fn assert_api_only_vmm_argv(pid: u32) -> Result<()> {
        let bytes = std::fs::read(format!("/proc/{pid}/cmdline"))?;
        validate_api_only_vmm_argv(&bytes)
    }

    fn validate_api_only_vmm_argv(bytes: &[u8]) -> Result<()> {
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

    fn assert_saturation_vm_isolation(
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

    fn assert_jail_devices(inspection: &VmInspection) -> Result<()> {
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

    fn assert_cgroup_process_security(
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

    fn assert_process_root_and_mounts(pid: u32, inspection: &VmInspection) -> Result<()> {
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

    fn assert_process_identity(pid: u32, expected_uid: u32, expected_gid: u32) -> Result<()> {
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

    fn assert_process_namespaces(pid: u32, netns_name: &str) -> Result<()> {
        for namespace in ["mnt", "pid", "uts", "ipc", "cgroup", "net"] {
            let host = std::fs::metadata(format!("/proc/self/ns/{namespace}"))?;
            let guest = std::fs::metadata(format!("/proc/{pid}/ns/{namespace}"))?;
            ensure!(
                host.ino() != guest.ino(),
                "jailed Cloud Hypervisor retained the host {namespace} namespace"
            );
        }
        let named_netns = std::fs::metadata(Path::new("/run/netns").join(netns_name))?;
        let vmm_netns = std::fs::metadata(format!("/proc/{pid}/ns/net"))?;
        ensure!(
            named_netns.ino() == vmm_netns.ino(),
            "jailed Cloud Hypervisor did not join its prepared run network namespace"
        );
        Ok(())
    }

    fn wait_for_guest_ready(serial_log: &Path, timeout: Duration) -> Result<()> {
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
    struct BusyGuestCpuSample {
        usage_usec: u64,
        nr_throttled: u64,
    }

    fn read_busy_guest_cpu_sample(cgroup: &Path) -> Result<BusyGuestCpuSample> {
        let contents = std::fs::read_to_string(cgroup.join("cpu.stat"))?;
        let values = parse_cpu_stat(&contents);
        Ok(BusyGuestCpuSample {
            usage_usec: values.get("usage_usec").copied().unwrap_or_default(),
            nr_throttled: values.get("nr_throttled").copied().unwrap_or_default(),
        })
    }

    fn validate_busy_guest_cpu_sample(
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

    fn prove_cloud_hypervisor_accounting(
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

    fn is_attributable_kvm_helper(name: &str) -> bool {
        name.starts_with("kvm-") || name.starts_with("vhost-") || name.contains("kvm-pit")
    }

    fn ensure_process_descendants_accounted(unit: &UnitState, cgroup: &Path) -> Result<()> {
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

    fn prove_cloud_hypervisor_landlock(socket_path: &Path) -> Result<()> {
        let endpoint = UnixSocketEndpoint::new(socket_path.to_path_buf())?;
        let mut stream = endpoint.connect()?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let body = serde_json::json!({
            // The jailer's outer /run rule grants ReadFile, while this
            // root-owned canary is absent from the typed VmConfig. A denied
            // add-disk therefore proves Cloud Hypervisor v53's inner Landlock
            // layer independently of the inherited outer jailer ruleset.
            "path": "/run/landlock-api-canary",
            "readonly": true,
            "id": "landlock-denied",
            "image_type": "Raw"
        })
        .to_string();
        write!(
            stream,
            "PUT /api/v1/vm.add-disk HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )?;
        stream.shutdown(Shutdown::Write)?;
        let mut response_bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    response_bytes.extend_from_slice(&buffer[..length]);
                    ensure!(
                        response_bytes.len() <= 64 * 1024,
                        "Landlock-negative API response exceeds 64 KiB"
                    );
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    break;
                }
                Err(error) => return Err(error).context("read Landlock-negative API response"),
            }
        }
        let response = String::from_utf8(response_bytes)
            .context("Landlock-negative API response is not UTF-8")?;
        let status = response
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u16>().ok())
            .context("parse Landlock-negative API response")?;
        let lower = response.to_ascii_lowercase();
        ensure!(
            status >= 400
                && (lower.contains("landlock")
                    || lower.contains("permission denied")
                    || lower.contains("operation not permitted")
                    || lower.contains("os error 13")),
            "Cloud Hypervisor did not prove its inner Landlock denial for the outer-allowlisted canary: {response:?}"
        );
        Ok(())
    }

    fn cleanup_smoke_vms(
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

    fn path_utf8(path: &Path) -> Result<String> {
        path.to_str()
            .map(ToOwned::to_owned)
            .context("Cloud Hypervisor jail path is not valid UTF-8")
    }

    #[derive(Clone, Debug)]
    struct UnitState {
        main_pid: u32,
        control_group: String,
    }

    fn start_worker_unit(
        unit_name: &str,
        executable: &Path,
        report: &Path,
        allowed_dir: &Path,
        denied_path: &Path,
        netns_path: &Path,
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
            ("CPUQuotaPerSecUSec", Value::new(125_000_u64)),
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

    fn wait_for_worker_report(
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

    fn inspect_unit(unit_name: &str) -> Result<UnitState> {
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

    fn stop_and_reset_unit(unit_name: &str) -> Result<()> {
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

    fn systemd_manager<'a>(
        connection: &'a zbus::blocking::Connection,
    ) -> Result<zbus::blocking::Proxy<'a>> {
        Ok(zbus::blocking::Proxy::new(
            connection,
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
        )?)
    }

    fn read_systemd_version() -> Result<String> {
        let connection = zbus::blocking::Connection::system()?;
        systemd_manager(&connection)?
            .get_property("Version")
            .context("read systemd version")
    }

    fn cgroup_directory(control_group: &str) -> Result<PathBuf> {
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

    fn assert_cpu_quota(directory: &Path) -> Result<()> {
        let cpu_max = std::fs::read_to_string(directory.join("cpu.max"))?;
        ensure!(
            cpu_max.trim() == format!("{SELF_TEST_CPU_QUOTA_US} {SELF_TEST_CPU_PERIOD_US}"),
            "self-test cpu.max mismatch: {}",
            cpu_max.trim()
        );
        let burst = std::fs::read_to_string(directory.join("cpu.max.burst"))?;
        ensure!(burst.trim() == "0", "self-test cpu.max.burst is not zero");
        ensure!(SELF_TEST_CPU_MILLIS == 125);
        Ok(())
    }

    fn wait_for_throttling(directory: &Path, timeout: Duration) -> Result<()> {
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

    fn parse_cpu_stat(contents: &str) -> BTreeMap<&str, u64> {
        contents
            .lines()
            .filter_map(|line| line.split_once(' '))
            .filter_map(|(name, value)| value.parse().ok().map(|value| (name, value)))
            .collect()
    }

    fn ensure_unit_tasks_accounted(unit: &UnitState, cgroup: &Path) -> Result<()> {
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
    struct TaskSnapshot {
        ids: BTreeSet<u32>,
    }

    fn snapshot_tasks() -> Result<TaskSnapshot> {
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

    fn prove_kvm_accounting(
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

    fn read_id_set(path: &Path) -> Result<BTreeSet<u32>> {
        Ok(std::fs::read_to_string(path)?
            .lines()
            .map(str::parse)
            .collect::<std::result::Result<_, _>>()?)
    }

    fn wait_for_cgroup_drain(directory: &Path, timeout: Duration) -> Result<()> {
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

    fn create_test_network(
        ip: &Path,
        namespace: &str,
        host_veth: &str,
        peer_veth: &str,
        seed: &str,
    ) -> Result<()> {
        let octet = 1 + (u8::from_str_radix(&seed[..2], 16)? % 250);
        let ip_argument = ip
            .to_str()
            .context("trusted ip binary path is not valid UTF-8")?;
        checked_command(ip, ["netns", "add", namespace])?;
        let mut pair_created = false;
        let result = (|| -> Result<()> {
            checked_command(
                ip,
                [
                    "link", "add", host_veth, "type", "veth", "peer", "name", peer_veth,
                ],
            )?;
            pair_created = true;
            checked_command(ip, ["link", "set", peer_veth, "netns", namespace])?;
            let host_cidr = format!("198.18.{octet}.1/30");
            let peer_cidr = format!("198.18.{octet}.2/30");
            checked_command(ip, ["address", "add", host_cidr.as_str(), "dev", host_veth])?;
            checked_command(ip, ["link", "set", host_veth, "up"])?;
            checked_command(
                ip,
                [
                    "netns",
                    "exec",
                    namespace,
                    ip_argument,
                    "link",
                    "set",
                    "lo",
                    "up",
                ],
            )?;
            checked_command(
                ip,
                [
                    "netns",
                    "exec",
                    namespace,
                    ip_argument,
                    "address",
                    "add",
                    peer_cidr.as_str(),
                    "dev",
                    peer_veth,
                ],
            )?;
            checked_command(
                ip,
                [
                    "netns",
                    "exec",
                    namespace,
                    ip_argument,
                    "link",
                    "set",
                    peer_veth,
                    "up",
                ],
            )?;
            Ok(())
        })();
        if let Err(error) = result {
            // Deleting the host end first deterministically removes the pair.
            // Deleting the namespace first can asynchronously remove both
            // veths and race a subsequent host-link deletion.
            if pair_created {
                let _ = run_command(ip, ["link", "delete", host_veth]);
            }
            let _ = run_command(ip, ["netns", "delete", namespace]);
            return Err(error);
        }
        Ok(())
    }

    fn verify_network(ip: &Path, namespace: &str, host_veth: &str, peer_veth: &str) -> Result<()> {
        let ip_argument = ip
            .to_str()
            .context("trusted ip binary path is not valid UTF-8")?;
        ensure!(
            Path::new("/sys/class/net").join(host_veth).is_dir(),
            "self-test host veth is absent"
        );
        let output = checked_command(
            ip,
            [
                "netns",
                "exec",
                namespace,
                ip_argument,
                "-o",
                "link",
                "show",
                peer_veth,
            ],
        )?;
        ensure!(
            String::from_utf8_lossy(&output.stdout).contains(peer_veth),
            "self-test namespace peer is absent"
        );
        let host_namespace = std::fs::metadata("/proc/self/ns/net")?;
        let test_namespace = std::fs::metadata(Path::new("/run/netns").join(namespace))?;
        ensure!(
            host_namespace.ino() != test_namespace.ino(),
            "self-test did not create a distinct network namespace"
        );
        Ok(())
    }

    fn delete_test_network(ip: &Path, namespace: &str, host_veth: &str) -> Result<()> {
        let host_veth_path = Path::new("/sys/class/net").join(host_veth);
        if path_entry_exists(&host_veth_path)? {
            let result = checked_command(ip, ["link", "delete", host_veth]).map(|_| ());
            accept_delete_outcome(
                result,
                path_entry_exists(&host_veth_path)?,
                "self-test host veth",
            )?;
        }
        let namespace_path = Path::new("/run/netns").join(namespace);
        if path_entry_exists(&namespace_path)? {
            let result = checked_command(ip, ["netns", "delete", namespace]).map(|_| ());
            accept_delete_outcome(
                result,
                path_entry_exists(&namespace_path)?,
                "self-test network namespace",
            )?;
        }
        Ok(())
    }

    fn accept_delete_outcome<T>(
        result: Result<T>,
        resource_still_exists: bool,
        resource: &str,
    ) -> Result<()> {
        if !resource_still_exists {
            // A concurrent kernel teardown may report ENODEV after the final
            // state has already been reached. The postcondition is authority.
            return Ok(());
        }
        match result {
            Ok(_) => bail!("{resource} leaked after deletion"),
            Err(error) => Err(error).with_context(|| format!("{resource} deletion failed")),
        }
    }

    fn path_entry_exists(path: &Path) -> Result<bool> {
        match std::fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
        }
    }

    fn trusted_ip_binary() -> Result<PathBuf> {
        for path in ["/usr/bin/ip", "/usr/sbin/ip", "/sbin/ip"] {
            let path = Path::new(path);
            let metadata = match std::fs::symlink_metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("stat trusted ip candidate {}", path.display()));
                }
            };
            // On merged-/usr distributions, /sbin/ip and /usr/sbin/ip are
            // symlinks to /usr/bin/ip. Never follow those aliases across the
            // privileged boundary; select only an actual regular file whose
            // complete ancestor chain can be validated below.
            if !metadata.is_file() {
                continue;
            }
            validate_trusted_executable_metadata(path, &metadata)?;
            return Ok(path.to_path_buf());
        }
        bail!("could not find a trusted absolute ip binary")
    }

    fn trusted_current_exe() -> Result<TrustedCurrentExe> {
        let executable =
            std::fs::read_link("/proc/self/exe").context("read current jailerd executable link")?;
        validate_current_exe_link(&executable)?;
        let mut file = open_absolute_nofollow(&executable, OFlags::RDONLY)
            .context("open current jailerd executable without symlinks")?;
        let opened = file
            .metadata()
            .context("stat opened current jailerd executable")?;
        validate_trusted_executable_metadata(&executable, &opened)?;
        let running = std::fs::metadata("/proc/self/exe")?;
        ensure!(
            running.dev() == opened.dev() && running.ino() == opened.ino(),
            "opened jailerd executable differs from the running image"
        );
        let sha256 = file_sha256_reader(&mut file)?;
        Ok(TrustedCurrentExe {
            path: executable,
            sha256,
        })
    }

    fn validate_current_exe_link(executable: &Path) -> Result<()> {
        ensure!(
            executable.is_absolute(),
            "current executable link is not absolute"
        );
        let text = executable
            .to_str()
            .context("current executable path is not valid UTF-8")?;
        ensure!(
            !text.ends_with(" (deleted)"),
            "current executable has been deleted"
        );
        ensure!(
            executable.components().all(|component| matches!(
                component,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )),
            "current executable path contains a non-normal component"
        );
        Ok(())
    }

    fn trusted_executable_sha256(path: &Path) -> Result<String> {
        let mut file = open_absolute_nofollow(path, OFlags::RDONLY)
            .with_context(|| format!("open trusted executable {}", path.display()))?;
        let metadata = file.metadata().context("stat opened trusted executable")?;
        validate_trusted_executable_metadata(path, &metadata)?;
        file_sha256_reader(&mut file)
    }

    fn validate_trusted_executable_metadata(
        path: &Path,
        metadata: &std::fs::Metadata,
    ) -> Result<()> {
        ensure!(
            metadata.is_file(),
            "trusted executable is not a regular file"
        );
        ensure!(metadata.uid() == 0, "trusted executable is not root-owned");
        ensure!(
            metadata.nlink() == 1,
            "trusted executable must have one hard link"
        );
        ensure!(
            metadata.mode() & 0o022 == 0,
            "trusted executable is group/other writable"
        );
        let mut ancestor = path.parent();
        while let Some(path) = ancestor {
            let metadata = std::fs::symlink_metadata(path)?;
            ensure!(
                metadata.is_dir(),
                "trusted executable ancestor is not a directory"
            );
            ensure!(
                metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
                "trusted executable has an untrusted ancestor"
            );
            ancestor = path.parent();
        }
        Ok(())
    }

    fn checked_command<'a>(
        program: &Path,
        arguments: impl IntoIterator<Item = &'a str>,
    ) -> Result<Output> {
        let output = run_command(program, arguments)?;
        ensure!(
            output.status.success(),
            "{} failed: {}",
            program.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(output)
    }

    fn run_command<'a>(
        program: &Path,
        arguments: impl IntoIterator<Item = &'a str>,
    ) -> Result<Output> {
        Command::new(program)
            .args(arguments)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .with_context(|| format!("execute {}", program.display()))
    }

    fn ensure_trusted_directory(path: &Path) -> Result<()> {
        let mut current = Some(path);
        while let Some(directory) = current {
            let metadata = std::fs::symlink_metadata(directory)?;
            ensure!(metadata.is_dir(), "trusted path is not a directory");
            ensure!(metadata.uid() == 0, "trusted directory is not root-owned");
            ensure!(
                metadata.mode() & 0o022 == 0,
                "trusted directory is writable by group/other"
            );
            current = directory.parent();
        }
        Ok(())
    }

    fn create_root_directory(path: &Path) -> Result<()> {
        if path.exists() {
            return ensure_trusted_directory(path);
        }
        std::fs::create_dir(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        ensure_trusted_directory(path)
    }

    fn validate_root_file_metadata(metadata: &std::fs::Metadata, mode: u32) -> Result<()> {
        ensure!(metadata.is_file(), "trusted file is not a regular file");
        ensure!(metadata.uid() == 0, "trusted file is not root-owned");
        ensure!(
            metadata.nlink() == 1,
            "trusted file must have one hard link"
        );
        ensure!(
            metadata.mode() & 0o777 == mode,
            "trusted file has unexpected permissions"
        );
        Ok(())
    }

    fn write_new_root_file(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            // Keep the file private until all bytes are durable. The root
            // self-test deliberately inherits umask 077, so the requested
            // final mode must be applied through this already-open FD.
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        let mut file = options.open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        set_exact_file_mode(&file, mode)?;
        file.sync_all()?;
        validate_root_file_metadata(&file.metadata()?, mode)
    }

    fn set_exact_file_mode(file: &File, mode: u32) -> Result<()> {
        ensure!(
            mode & !0o777 == 0,
            "trusted file mode contains non-permission bits"
        );
        rustix::fs::fchmod(file, Mode::from_raw_mode(mode))
            .context("set exact trusted file permissions")
    }

    fn read_worker_report(path: &Path) -> Result<WorkerReportV1> {
        let metadata = std::fs::symlink_metadata(path)?;
        validate_root_file_metadata(&metadata, 0o600)?;
        ensure!(metadata.len() <= MAX_ATTESTATION_BYTES);
        let bytes = std::fs::read(path)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn require_root() -> Result<()> {
        ensure!(
            rustix::process::geteuid() == rustix::process::Uid::ROOT,
            "intar-jailerd self-test must run as root"
        );
        Ok(())
    }

    fn file_sha256_and_metadata(path: &Path) -> Result<(String, std::fs::Metadata)> {
        let mut file = open_absolute_nofollow(path, OFlags::RDONLY)
            .context("open self-test artifact without symlinks")?;
        let metadata = file.metadata()?;
        ensure!(metadata.is_file(), "hashed path is not a regular file");
        ensure!(metadata.nlink() == 1, "hashed file must have one link");
        let sha256 = file_sha256_reader(&mut file)?;
        Ok((sha256, metadata))
    }

    fn file_sha256_reader(file: &mut File) -> Result<String> {
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let length = file.read(&mut buffer)?;
            if length == 0 {
                break;
            }
            hasher.update(&buffer[..length]);
        }
        Ok(hex_digest(hasher.finalize()))
    }

    fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
        let mut encoded = String::with_capacity(bytes.as_ref().len() * 2);
        for byte in bytes.as_ref() {
            use std::fmt::Write as _;
            let _ = write!(encoded, "{byte:02x}");
        }
        encoded
    }

    fn read_trimmed(path: &str) -> Result<String> {
        Ok(std::fs::read_to_string(path)?.trim().to_owned())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn trusted_ip_binary_selects_a_regular_non_symlink() {
            let path = trusted_ip_binary().expect("trusted ip binary");
            let metadata = std::fs::symlink_metadata(&path).expect("stat trusted ip binary");
            assert!(metadata.is_file());
            assert!(!metadata.file_type().is_symlink());
        }

        #[test]
        fn delete_outcome_is_accepted_only_when_the_resource_is_absent() {
            accept_delete_outcome(Err::<(), _>(anyhow::anyhow!("ENODEV")), false, "veth")
                .expect("already-absent veth");
            accept_delete_outcome(Ok(()), false, "veth").expect("deleted veth");
            assert!(
                accept_delete_outcome(Err::<(), _>(anyhow::anyhow!("EPERM")), true, "veth")
                    .is_err()
            );
            assert!(accept_delete_outcome(Ok(()), true, "veth").is_err());
        }

        #[test]
        fn path_entry_existence_is_fallible_and_does_not_follow_the_entry() {
            let temporary = tempfile::tempdir().expect("temporary directory");
            let missing = temporary.path().join("missing");
            assert!(!path_entry_exists(&missing).expect("inspect missing entry"));
            std::os::unix::fs::symlink("missing", temporary.path().join("link"))
                .expect("create dangling link");
            assert!(path_entry_exists(&temporary.path().join("link")).expect("inspect link"));
        }

        #[test]
        fn cpu_stat_parser_is_exact() {
            let values = parse_cpu_stat(
                "usage_usec 42\nuser_usec 21\nsystem_usec 21\nnr_periods 9\nnr_throttled 3\nthrottled_usec 7\n",
            );
            assert_eq!(values.get("usage_usec"), Some(&42));
            assert_eq!(values.get("nr_throttled"), Some(&3));
        }

        #[test]
        fn busy_guest_sample_accepts_each_independent_125_millicore_ceiling() {
            let elapsed = Duration::from_secs(30);
            for usage_offset in [0, 500_000] {
                validate_busy_guest_cpu_sample(
                    BusyGuestCpuSample {
                        usage_usec: usage_offset,
                        nr_throttled: 10,
                    },
                    BusyGuestCpuSample {
                        usage_usec: usage_offset + 3_750_000,
                        nr_throttled: 11,
                    },
                    elapsed,
                )
                .expect("independently capped busy VM");
            }
        }

        #[test]
        fn busy_guest_sample_rejects_overuse_missing_throttle_and_counter_rollback() {
            let elapsed = Duration::from_secs(30);
            let before = BusyGuestCpuSample {
                usage_usec: 1_000,
                nr_throttled: 10,
            };
            assert!(
                validate_busy_guest_cpu_sample(
                    before,
                    BusyGuestCpuSample {
                        usage_usec: before.usage_usec + 4_200_001,
                        nr_throttled: 11,
                    },
                    elapsed,
                )
                .is_err()
            );
            assert!(
                validate_busy_guest_cpu_sample(
                    before,
                    BusyGuestCpuSample {
                        usage_usec: before.usage_usec + 3_750_000,
                        nr_throttled: before.nr_throttled,
                    },
                    elapsed,
                )
                .is_err()
            );
            assert!(
                validate_busy_guest_cpu_sample(
                    before,
                    BusyGuestCpuSample {
                        usage_usec: before.usage_usec - 1,
                        nr_throttled: 11,
                    },
                    elapsed,
                )
                .is_err()
            );
        }

        #[test]
        fn worker_paths_must_share_disposable_root() {
            let root = Path::new("/var/lib/intar/jails/self-test/abc");
            assert_eq!(
                validate_worker_paths(
                    &root.join("allowed/report.json"),
                    &root.join("allowed"),
                    &root.join("denied-marker"),
                )
                .expect("valid paths"),
                root
            );
            assert!(
                validate_worker_paths(
                    Path::new("/tmp/report"),
                    &root.join("allowed"),
                    &root.join("denied-marker"),
                )
                .is_err()
            );
        }

        #[test]
        fn cleanup_lookup_rejects_symlinks() {
            let temporary = tempfile::tempdir().expect("temporary directory");
            std::fs::write(temporary.path().join("target"), b"target").expect("write target");
            std::os::unix::fs::symlink("target", temporary.path().join("link"))
                .expect("create symlink");
            let parent = open(
                temporary.path(),
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .expect("open temporary directory");
            assert!(open_cleanup_entry(&parent, "link").is_err());
        }

        #[test]
        fn cleanup_identity_check_rejects_path_substitution() {
            let temporary = tempfile::tempdir().expect("temporary directory");
            let first = File::create(temporary.path().join("first")).expect("create first file");
            let second = File::create(temporary.path().join("second")).expect("create second file");
            let first = rustix::fs::fstat(&first).expect("stat first file");
            let second = rustix::fs::fstat(&second).expect("stat second file");
            assert!(ensure_same_cleanup_object(&first, &second).is_err());
        }

        fn cleanup_test_path(suffix: &[&str]) -> Vec<Vec<u8>> {
            [
                "cloud-hypervisor-lifecycle",
                "jails",
                "quarantine",
                "generation-one",
                "root",
            ]
            .into_iter()
            .chain(suffix.iter().copied())
            .map(|component| component.as_bytes().to_vec())
            .collect()
        }

        #[test]
        fn cleanup_policy_binds_vm_owner_to_its_reserved_generation() {
            let mut policy = CleanupPolicy::default();
            policy
                .vm_owners
                .insert("generation-one".to_owned(), (200_000, 200_000));
            assert_eq!(
                policy.expected_vm_owner(&cleanup_test_path(&["logs", "serial.log"])),
                Some((200_000, 200_000))
            );
            let mut wrong = cleanup_test_path(&["logs", "serial.log"]);
            wrong[3] = b"generation-two".to_vec();
            assert_eq!(policy.expected_vm_owner(&wrong), None);
            assert_eq!(
                policy.expected_vm_owner(&[
                    b"cloud-hypervisor-lifecycle".to_vec(),
                    b"jails".to_vec(),
                    b"quarantine".to_vec(),
                    b"generation-one".to_vec(),
                    b"metadata-v1.json".to_vec(),
                ]),
                None
            );
        }

        #[test]
        fn cleanup_device_and_socket_allowlists_are_path_exact() {
            assert_eq!(
                expected_cleanup_device(&cleanup_test_path(&["dev", "kvm"])),
                Some(CleanupDevice {
                    major: 10,
                    minor: 232,
                    mode: 0o600,
                })
            );
            assert_eq!(
                expected_cleanup_device(&cleanup_test_path(&["dev", "net", "tun"])),
                Some(CleanupDevice {
                    major: 10,
                    minor: 200,
                    mode: 0o600,
                })
            );
            assert_eq!(
                expected_cleanup_device(&cleanup_test_path(&["dev", "urandom"])),
                Some(CleanupDevice {
                    major: 1,
                    minor: 9,
                    mode: 0o400,
                })
            );
            assert_eq!(
                expected_cleanup_device(&cleanup_test_path(&["dev", "null"])),
                Some(CleanupDevice {
                    major: 1,
                    minor: 3,
                    mode: 0o600,
                })
            );
            assert!(expected_cleanup_device(&cleanup_test_path(&["dev", "vhost-vsock"])).is_none());
            assert!(cleanup_socket_allowed(&cleanup_test_path(&[
                "run",
                "cloud-hypervisor.sock"
            ])));
            assert!(cleanup_socket_allowed(&cleanup_test_path(&[
                "run",
                "kino.vsock"
            ])));
            assert!(!cleanup_socket_allowed(&cleanup_test_path(&[
                "run",
                "unexpected.sock"
            ])));
        }

        #[test]
        fn cleanup_leaf_rejects_a_hardlinked_vm_file() {
            if rustix::process::geteuid() == rustix::process::Uid::ROOT {
                return;
            }
            let temporary = tempfile::tempdir().expect("temporary directory");
            let file_path = temporary.path().join("root.raw");
            std::fs::write(&file_path, b"fixture").expect("write cleanup fixture");
            let file = File::open(&file_path).expect("open cleanup fixture");
            let stat = rustix::fs::fstat(&file).expect("stat cleanup fixture");
            let mut policy = CleanupPolicy::default();
            policy
                .vm_owners
                .insert("generation-one".to_owned(), (stat.st_uid, stat.st_gid));
            let relative = cleanup_test_path(&["disks", "root.raw"]);
            validate_cleanup_leaf(&stat, &relative, &policy)
                .expect("one-link VM file is cleanup-safe");

            std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o666))
                .expect("make cleanup fixture other-writable");
            let writable = rustix::fs::fstat(&file).expect("restat writable fixture");
            assert!(validate_cleanup_leaf(&writable, &relative, &policy).is_err());
            std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o600))
                .expect("restore private cleanup fixture mode");

            std::fs::hard_link(&file_path, temporary.path().join("outside-link"))
                .expect("create cleanup hardlink attack");
            let linked = rustix::fs::fstat(&file).expect("restat hardlinked fixture");
            assert!(validate_cleanup_leaf(&linked, &relative, &policy).is_err());
        }

        #[test]
        fn cloud_hypervisor_argv_contract_is_api_only() {
            let exact = EXPECTED_API_ONLY_VMM_ARGV.join("\0") + "\0";
            validate_api_only_vmm_argv(exact.as_bytes()).expect("exact API-only argv");
            assert!(
                validate_api_only_vmm_argv(
                    b"/cloud-hypervisor\0--api-socket\0/run/cloud-hypervisor.sock\0--landlock\0--seccomp\0true\0"
                )
                .is_err()
            );
            assert!(
                validate_api_only_vmm_argv(
                    b"/cloud-hypervisor\0--api-socket\0/run/cloud-hypervisor.sock\0--seccomp\0true\0--kernel\0/boot/kernel\0"
                )
                .is_err()
            );
        }

        #[test]
        fn current_executable_link_must_be_absolute_normal_and_live() {
            validate_current_exe_link(Path::new("/usr/lib/intar/intar-jailerd"))
                .expect("valid installed executable path");
            assert!(validate_current_exe_link(Path::new("relative/intar-jailerd")).is_err());
            assert!(validate_current_exe_link(Path::new("/usr/lib/../tmp/intar-jailerd")).is_err());
            assert!(
                validate_current_exe_link(Path::new("/usr/lib/intar/intar-jailerd (deleted)"))
                    .is_err()
            );
        }

        #[test]
        fn attestation_and_absolute_lookups_reject_symlinks() {
            let temporary = tempfile::tempdir().expect("temporary directory");
            std::fs::write(temporary.path().join("target"), b"attestation").expect("write target");
            std::os::unix::fs::symlink("target", temporary.path().join(ATTESTATION_FILE))
                .expect("create attestation symlink");
            let parent = File::open(temporary.path()).expect("open temporary directory");
            assert!(open_attestation_file(&parent).is_err());

            std::fs::create_dir(temporary.path().join("real")).expect("create real directory");
            std::fs::create_dir(temporary.path().join("real/child")).expect("create real child");
            open_absolute_nofollow(
                &temporary.path().join("real/child"),
                OFlags::RDONLY | OFlags::DIRECTORY,
            )
            .expect("open real child without symlinks");
            std::os::unix::fs::symlink("real", temporary.path().join("alias"))
                .expect("create directory symlink");
            assert!(
                open_absolute_nofollow(
                    &temporary.path().join("alias/child"),
                    OFlags::RDONLY | OFlags::DIRECTORY,
                )
                .is_err()
            );
        }

        #[test]
        fn smoke_artifacts_must_share_one_parent() {
            let digest = "a".repeat(64);
            let kernel = VerifiedArtifact {
                path: PathBuf::from("/var/lib/intar/self-test-assets/runs/one/kernel"),
                sha256: digest.clone(),
            };
            let root_disk = VerifiedArtifact {
                path: PathBuf::from("/var/lib/intar/self-test-assets/runs/one/root.raw"),
                sha256: digest.clone(),
            };
            assert_eq!(
                shared_artifact_parent(&[&kernel, &root_disk]).expect("shared parent"),
                Path::new("/var/lib/intar/self-test-assets/runs/one")
            );

            let other = VerifiedArtifact {
                path: PathBuf::from("/var/lib/intar/self-test-assets/runs/two/runtime.raw"),
                sha256: digest,
            };
            assert!(shared_artifact_parent(&[&kernel, &other]).is_err());
        }

        #[test]
        fn trusted_file_mode_is_normalized_through_the_open_fd() {
            let temporary = tempfile::tempdir().expect("temporary directory");
            let path = temporary.path().join("canary");
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .expect("create private canary");

            set_exact_file_mode(&file, 0o444).expect("normalize canary permissions");

            assert_eq!(file.metadata().expect("stat canary").mode() & 0o777, 0o444);
            assert!(set_exact_file_mode(&file, 0o10_444).is_err());
            assert_eq!(
                file.metadata().expect("restat canary").mode() & 0o777,
                0o444
            );
        }

        #[test]
        fn isolated_smoke_root_does_not_replace_production_source_root() {
            let production_root = PathBuf::from("/var/cache/intar-agent");
            let smoke_root = PathBuf::from("/var/lib/intar/self-test-assets/runs/fresh");
            let mut config = JailerdConfig {
                allowed_source_roots: vec![production_root.clone()],
                ..JailerdConfig::default()
            };
            config.allowed_source_roots.push(smoke_root.clone());
            let artifact = VerifiedArtifact {
                path: smoke_root.join("kernel"),
                sha256: "a".repeat(64),
            };
            let source = protocol_artifact(&config, &artifact, ArtifactAccess::ReadOnly)
                .expect("smoke artifact source");
            assert_eq!(source.source_root, 1);
            assert_eq!(source.relative_path, Path::new("kernel"));
            assert_eq!(config.allowed_source_roots[0], production_root);
        }

        #[test]
        fn saturation_smoke_requests_have_unique_typed_topology() {
            let root = PathBuf::from("/var/lib/intar/self-test-assets/runs/fresh");
            let digest = "a".repeat(64);
            let artifact = |name: &str| VerifiedArtifact {
                path: root.join(name),
                sha256: digest.clone(),
            };
            let artifacts = SelfTestArtifacts {
                kernel: artifact("kernel"),
                initrd: None,
                root_disk: artifact("root.raw"),
                runtime_disk: artifact("runtime.raw"),
                recording_disk: artifact("recordings.vfat"),
            };
            let config = JailerdConfig {
                allowed_source_roots: vec![root],
                ..JailerdConfig::default()
            };
            let run_id = ValidatedId::parse("selftest-fixed").expect("run ID");
            let suffix = "0123456789abcdef0123456789abcdef";
            let requests = (0..=SELF_TEST_SATURATION_VM_COUNT)
                .map(|index| {
                    smoke_launch_request(
                        &config,
                        &artifacts,
                        &run_id,
                        suffix,
                        u8::try_from(index).expect("request index"),
                    )
                    .expect("saturation smoke request")
                })
                .collect::<Vec<_>>();
            assert_eq!(requests.len(), 9);
            assert!(requests.iter().all(|request| request.run_id == run_id));
            assert_eq!(
                requests
                    .iter()
                    .take(SELF_TEST_SATURATION_VM_COUNT)
                    .map(|request| u64::from(request.cpu_millis))
                    .sum::<u64>(),
                SELF_TEST_SATURATION_CPU_MILLIS
            );
            assert_eq!(
                requests
                    .iter()
                    .map(|request| request.vm_id.as_str())
                    .collect::<BTreeSet<_>>()
                    .len(),
                requests.len()
            );
            assert_eq!(
                requests
                    .iter()
                    .map(|request| request.tap_name.as_str())
                    .collect::<BTreeSet<_>>()
                    .len(),
                requests.len()
            );
            assert_eq!(
                requests
                    .iter()
                    .map(|request| request.mac_address.as_str())
                    .collect::<BTreeSet<_>>()
                    .len(),
                requests.len()
            );
            assert_eq!(
                requests
                    .iter()
                    .map(|request| request.guest_ip_cidr.as_str())
                    .collect::<BTreeSet<_>>()
                    .len(),
                requests.len()
            );
            assert_eq!(
                requests
                    .iter()
                    .map(|request| request.vsock_cid)
                    .collect::<BTreeSet<_>>()
                    .len(),
                requests.len()
            );
            assert!(
                smoke_launch_request(&config, &artifacts, &run_id, suffix, 9).is_err(),
                "only the eight saturation VMs and ninth rejection probe are valid"
            );
        }

        #[test]
        fn attestation_requires_every_proof() {
            let mut attestation = SelfTestAttestationV1 {
                version: 1,
                config_runtime_fingerprint_sha256: "a".repeat(64),
                cloud_hypervisor_sha256: "b".repeat(64),
                intar_jailerd_sha256: "c".repeat(64),
                intar_jailer_sha256: "d".repeat(64),
                boot_id: "boot".to_owned(),
                kernel_version: "6.2".to_owned(),
                systemd_version: "252".to_owned(),
                landlock_abi: 3,
                quota_verified: true,
                burst_verified: true,
                network_verified: true,
                landlock_negative_access: true,
                kvm_accounting_proven: true,
                cloud_hypervisor_lifecycle_verified: true,
                passed_at_unix_s: 1,
            };
            validate_attestation(&attestation).expect("complete attestation");
            attestation.kvm_accounting_proven = false;
            assert!(validate_attestation(&attestation).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_validation_rejects_relative_paths_and_bad_hashes() {
        let artifact = VerifiedArtifact {
            path: PathBuf::from("relative"),
            sha256: "a".repeat(64),
        };
        let artifacts = SelfTestArtifacts {
            kernel: artifact.clone(),
            initrd: None,
            root_disk: artifact.clone(),
            runtime_disk: artifact.clone(),
            recording_disk: artifact,
        };
        assert!(artifacts.validate().is_err());

        let mut artifact = VerifiedArtifact {
            path: PathBuf::from("/absolute"),
            sha256: "a".repeat(63),
        };
        assert!(validate_sha256(&artifact.sha256).is_err());
        artifact.sha256.push('a');
        assert!(validate_sha256(&artifact.sha256).is_ok());
    }

    #[test]
    fn attestation_rejects_unknown_fields() {
        let value = serde_json::json!({
            "version": 1,
            "config_runtime_fingerprint_sha256": "a".repeat(64),
            "cloud_hypervisor_sha256": "b".repeat(64),
            "intar_jailerd_sha256": "c".repeat(64),
            "intar_jailer_sha256": "d".repeat(64),
            "boot_id": "boot",
            "kernel_version": "kernel",
            "systemd_version": "systemd",
            "landlock_abi": 3,
            "quota_verified": true,
            "burst_verified": true,
            "network_verified": true,
            "landlock_negative_access": true,
            "kvm_accounting_proven": true,
            "cloud_hypervisor_lifecycle_verified": true,
            "passed_at_unix_s": 1,
            "unexpected": true
        });
        assert!(serde_json::from_value::<SelfTestAttestationV1>(value).is_err());
    }
}
