//! Root-only operational self-test and boot-bound attestation.
//!
//! The normal `intar-agent --doctor` command is intentionally read-only.  This
//! module owns the destructive proof which creates a disposable network
//! namespace, transient systemd unit and cgroup, exercises Landlock and KVM,
//! and removes every object before publishing an attestation.

#![allow(dead_code, reason = "wired into the daemon CLI on Linux only")]

use std::path::{Path, PathBuf};

use anyhow::{Result, bail, ensure};
use intar_jailer_protocol::JailerdConfig;
use serde::{Deserialize, Serialize};

const ATTESTATION_VERSION: u16 = 3;
const ATTESTATION_FILE: &str = "self-test-attestation-v3.json";
const SELF_TEST_CPU_MILLIS: u32 = 500;
const SELF_TEST_CPU_PERIOD_US: u64 = 100_000;
const SELF_TEST_CPU_QUOTA_US: u64 = 50_000;
const SELF_TEST_SATURATION_VM_COUNT: usize = 2;
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
pub struct SelfTestAttestationV3 {
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
    pub startup_quota_verified: bool,
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

/// Run the host proof plus the real Cloud Hypervisor package smoke.
///
/// The self-test always requires bootable, hash-pinned artifacts and publishes
/// its boot-bound readiness attestation only after proving eight concurrent
/// jailed 125m Cloud Hypervisor lifecycles, exact one-core admission saturation,
/// ninth-launch rejection, and KVM accounting.
pub fn run(config: &JailerdConfig, artifacts: &SelfTestArtifacts) -> Result<SelfTestAttestationV3> {
    artifacts.validate()?;
    #[cfg(target_os = "linux")]
    {
        linux::run(config, artifacts)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = config;
        bail!("the jailerd self-test is supported only on Linux")
    }
}

/// How a stored attestation relates to the running host.
#[derive(Debug)]
pub enum AttestationStatus {
    Verified(SelfTestAttestationV3),
    Absent,
    /// Trusted, but written during an earlier boot. Readiness treats it
    /// exactly like `Absent`, whatever else changed since: a reboot is when a
    /// kernel or systemd upgrade lands, and when the clock may still lag.
    /// `stale` names the first platform field that no longer matches, for
    /// the log only.
    PreviousBoot {
        stale: Option<&'static str>,
    },
}

impl AttestationStatus {
    pub fn verified(self) -> Option<SelfTestAttestationV3> {
        match self {
            Self::Verified(attestation) => Some(attestation),
            Self::Absent | Self::PreviousBoot { .. } => None,
        }
    }
}

/// The values a stored attestation must match on the running host.
struct CurrentHost<'a> {
    cloud_hypervisor_sha256: &'a str,
    intar_jailerd_sha256: &'a str,
    intar_jailer_sha256: &'a str,
    config_runtime_fingerprint_sha256: &'a str,
    kernel_version: &'a str,
    systemd_version: &'a str,
    now_unix_s: u64,
}

/// `Some(PreviousBoot)` for an attestation of another boot, decided before
/// anything else is compared. The platform values are best-effort and only
/// feed the diagnostic.
fn previous_boot(
    attestation: &SelfTestAttestationV3,
    current_boot_id: &str,
    kernel_version: Option<&str>,
    systemd_version: Option<&str>,
    now_unix_s: Option<u64>,
) -> Option<AttestationStatus> {
    if attestation.boot_id == current_boot_id {
        return None;
    }
    let stale = if kernel_version.is_some_and(|value| value != attestation.kernel_version) {
        Some("kernel_version")
    } else if systemd_version.is_some_and(|value| value != attestation.systemd_version) {
        Some("systemd_version")
    } else if now_unix_s.is_some_and(|now| attestation.passed_at_unix_s > now.saturating_add(60)) {
        Some("passed_at_unix_s")
    } else {
        None
    };
    Some(AttestationStatus::PreviousBoot { stale })
}

/// For an attestation of the current boot, every mismatch is an error.
fn classify(
    attestation: SelfTestAttestationV3,
    current: &CurrentHost<'_>,
) -> Result<AttestationStatus> {
    ensure!(
        attestation.cloud_hypervisor_sha256 == current.cloud_hypervisor_sha256,
        "self-test attestation runtime hash is stale"
    );
    ensure!(
        attestation.intar_jailerd_sha256 == current.intar_jailerd_sha256,
        "self-test attestation jailerd executable hash is stale"
    );
    ensure!(
        attestation.intar_jailer_sha256 == current.intar_jailer_sha256,
        "self-test attestation jailer executable hash is stale"
    );
    ensure!(
        attestation.config_runtime_fingerprint_sha256 == current.config_runtime_fingerprint_sha256,
        "self-test attestation configuration fingerprint is stale"
    );
    ensure!(
        attestation.kernel_version == current.kernel_version,
        "self-test attestation kernel version is stale"
    );
    ensure!(
        attestation.systemd_version == current.systemd_version,
        "self-test attestation systemd version is stale"
    );
    ensure!(
        attestation.passed_at_unix_s <= current.now_unix_s.saturating_add(60),
        "self-test attestation time is in the future"
    );
    Ok(AttestationStatus::Verified(attestation))
}

/// Load the attestation and classify it against this boot, configuration,
/// and the currently installed runtime bytes.
#[cfg(target_os = "linux")]
pub fn load(config: &JailerdConfig) -> Result<AttestationStatus> {
    linux::load(config)
}

#[cfg(not(target_os = "linux"))]
pub fn load(_config: &JailerdConfig) -> Result<AttestationStatus> {
    Ok(AttestationStatus::Absent)
}

/// Load an attestation only when it is trusted and still matches this boot,
/// configuration, and the currently installed runtime bytes.
pub fn load_verified(config: &JailerdConfig) -> Result<Option<SelfTestAttestationV3>> {
    load(config).map(AttestationStatus::verified)
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

/// Hidden worker used by the root self-test to prove the typed VMM API is
/// reachable after dropping to the exact configured agent identity.
#[cfg(target_os = "linux")]
pub fn agent_api_worker(socket: &Path, expected_uid: u32, expected_gid: u32) -> Result<()> {
    linux::agent_api_worker(socket, expected_uid, expected_gid)
}

#[cfg(not(target_os = "linux"))]
pub fn agent_api_worker(_socket: &Path, _expected_uid: u32, _expected_gid: u32) -> Result<()> {
    bail!("the jailerd agent API worker is supported only on Linux")
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
mod linux;
#[cfg(any(target_os = "linux", test))]
mod machine_image;

#[cfg(test)]
mod tests;
