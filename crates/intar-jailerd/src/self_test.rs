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

const ATTESTATION_VERSION: u16 = 2;
const ATTESTATION_FILE: &str = "self-test-attestation-v2.json";
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
pub struct SelfTestAttestationV2 {
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
    pub boot_quota_transition_verified: bool,
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
pub fn run(config: &JailerdConfig, artifacts: &SelfTestArtifacts) -> Result<SelfTestAttestationV2> {
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

/// Load an attestation only when it is trusted and still matches this boot,
/// configuration, and the currently installed runtime bytes.
#[cfg(target_os = "linux")]
pub fn load_verified(config: &JailerdConfig) -> Result<Option<SelfTestAttestationV2>> {
    linux::load_verified(config)
}

#[cfg(not(target_os = "linux"))]
pub fn load_verified(_config: &JailerdConfig) -> Result<Option<SelfTestAttestationV2>> {
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

#[cfg(test)]
mod tests;
