//! Waking a VM from its image's suspended guest: whether to, the VM config
//! of a wake, and the one fallback to a cold boot.

use cloud_hypervisor_client::{BalloonConfig, CpuProfile, MemoryZoneConfig};
use intar_contracts::oci::WakeV1;
use intar_jailer_protocol::JailWakePaths;

use super::*;
use crate::config::WakeConfig;

/// How long a woken guest has, from `vm.boot`, to send its first report.
pub(super) const WAKE_FIRST_REPORT_LIMIT: Duration = Duration::from_secs(10);
/// How long an image that fell back stays cold on this host.
pub(super) const WAKE_FALLBACK_MEMORY: Duration = Duration::from_secs(60 * 60);
/// The guest's certificates date from the base's cold boot.
const MAX_WAKE_AGE_MS: u64 = 330 * 24 * 60 * 60 * 1000;

/// What one VM start does.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum StartDecision {
    Wake,
    Cold(String),
}

/// Everything a start decision reads.
pub(super) struct StartFacts<'a> {
    pub(super) config: &'a WakeConfig,
    /// The image's machine config `wake`.
    pub(super) wake: Option<&'a WakeV1>,
    /// Whether jailerd prepared the image's wake files.
    pub(super) prepared: bool,
    pub(super) jailer_supports_wake: bool,
    pub(super) vmm_version: &'a str,
    pub(super) now_unix_ms: u64,
    pub(super) memory_mib: u32,
    pub(super) cpu_millis: u32,
    pub(super) fell_back_recently: bool,
}

/// The vCPUs a VM gets, as the cold VM config sets them.
pub(super) fn vcpu_count(cpu_millis: u32) -> u32 {
    cpu_millis.div_ceil(1_000).max(1)
}

/// Wake only when every condition holds; otherwise say which did not.
pub(super) fn decide_start(facts: &StartFacts<'_>) -> StartDecision {
    let cold = |reason: &str| StartDecision::Cold(reason.to_owned());
    if !facts.config.enabled {
        return cold("wake is off on this host");
    }
    let Some(wake) = facts.wake else {
        return cold("the image has no suspended guest");
    };
    if !facts.prepared {
        return cold("the suspended guest is not prepared on this host");
    }
    if !facts.config.profiles.contains(&wake.cpu_profile) {
        return cold("the image's CPU profile is not pinned on this host");
    }
    if !facts.jailer_supports_wake {
        return cold("jailerd cannot launch a suspended guest");
    }
    if !version_at_least(facts.vmm_version, &wake.vmm.min_version) {
        return cold("cloud-hypervisor is older than the image needs");
    }
    if facts.now_unix_ms.saturating_sub(wake.booted_at_unix_ms) >= MAX_WAKE_AGE_MS {
        return cold("the suspended guest is 330 days old or older");
    }
    let requested = u64::from(facts.memory_mib) * 1024 * 1024;
    if requested > wake.shape.memory_bytes
        || (requested != wake.shape.memory_bytes && !wake.shape.balloon)
    {
        return cold("the requested memory does not fit the suspended guest");
    }
    if vcpu_count(facts.cpu_millis) > wake.shape.max_vcpus {
        return cold("the requested vCPUs do not fit the suspended guest");
    }
    if facts.fell_back_recently {
        return cold("the image fell back to a cold boot on this host within the hour");
    }
    StartDecision::Wake
}

/// `v55.0.0` against `v55.0`, number by number; a missing number is 0.
/// A version that does not parse is never enough.
fn version_at_least(actual: &str, minimum: &str) -> bool {
    let parse = |version: &str| -> Option<Vec<u64>> {
        version
            .strip_prefix('v')?
            .split('.')
            .map(|part| part.parse().ok())
            .collect()
    };
    let (Some(mut actual), Some(mut minimum)) = (parse(actual), parse(minimum)) else {
        return false;
    };
    let len = actual.len().max(minimum.len());
    actual.resize(len, 0);
    minimum.resize(len, 0);
    actual >= minimum
}

/// The VM config of a wake: the cold config of the same VM, with the stub
/// as kernel, the suspended guest's vCPU shape and CPU profile, its RAM as
/// the one private memory zone and, on a balloon shape, the balloon taking
/// what the VM was not given.
pub(super) fn wake_vm_config(
    mut cold: VmConfig,
    wake: &WakeV1,
    paths: &JailWakePaths,
    memory_mib: u32,
) -> Result<VmConfig> {
    let shape = &wake.shape;
    let memory_bytes = i64::try_from(shape.memory_bytes).context("wake memory is too large")?;
    cold.payload.kernel = Some(paths.jailed_stub.display().to_string());
    cold.cpus = Some(CpusConfig {
        boot_vcpus: shape.boot_vcpus,
        max_vcpus: shape.max_vcpus,
        profile: Some(CpuProfile::File(
            paths.jailed_cpu_profile.display().to_string(),
        )),
    });
    cold.memory = Some(MemoryConfig {
        size: 0,
        zones: Some(vec![MemoryZoneConfig {
            id: "mem0".to_owned(),
            size: memory_bytes,
            file: Some(paths.jailed_ram.display().to_string()),
            shared: false,
        }]),
    });
    if shape.balloon {
        cold.balloon = Some(BalloonConfig {
            size: memory_bytes - i64::from(memory_mib) * 1024 * 1024,
        });
    }
    Ok(cold)
}

/// Whether an image fell back on this host within the last hour.
pub(super) fn fell_back_recently(
    fallbacks: &BTreeMap<String, Instant>,
    image: &OciDigest,
    now: Instant,
) -> bool {
    fallbacks
        .get(image.as_str())
        .is_some_and(|at| now.saturating_duration_since(*at) < WAKE_FALLBACK_MEMORY)
}

/// Keep that an image fell back, and forget the entries past the hour.
pub(super) fn remember_fallback(
    fallbacks: &mut BTreeMap<String, Instant>,
    image: &OciDigest,
    now: Instant,
) {
    fallbacks.retain(|_, at| now.saturating_duration_since(*at) < WAKE_FALLBACK_MEMORY);
    fallbacks.insert(image.as_str().to_owned(), now);
}

/// The steps of one VM start the fallback drives.
pub(super) trait StartBackend {
    /// One jail generation.
    type Launched;
    async fn launch(&mut self, wake: bool) -> Result<Self::Launched>;
    /// `vm.create`, `vm.boot` and, on a wake, `vm.resize`.
    async fn boot(&mut self, launched: &Self::Launched, wake: bool) -> Result<()>;
    /// `None` once the first report came within `limit` of `vm.boot`,
    /// otherwise why not.
    async fn first_report(
        &mut self,
        launched: &Self::Launched,
        limit: Duration,
    ) -> Option<&'static str>;
    /// Stop and destroy the generation completely.
    async fn destroy(&mut self, launched: Self::Launched) -> Result<()>;
    /// Fails once the VM was deleted, its lease ended included.
    async fn ensure_wanted(&mut self) -> Result<()>;
    fn record_fallback(&mut self);
}

fn start(path: VmStartPath, reason: Option<String>) -> VmStartV1 {
    VmStartV1 {
        path,
        reason,
        first_report_ms: None,
    }
}

/// Launch and boot a VM as decided. A wake that does not report in time is
/// destroyed and the VM is launched once more, cold; a failure of that cold
/// launch fails the VM.
pub(super) async fn start_vm<B: StartBackend>(
    backend: &mut B,
    decision: StartDecision,
) -> Result<(B::Launched, VmStartV1)> {
    let reason = match decision {
        StartDecision::Cold(reason) => {
            let launched = backend.launch(false).await?;
            backend.boot(&launched, false).await?;
            return Ok((launched, start(VmStartPath::Cold, Some(reason))));
        }
        StartDecision::Wake => match backend.launch(true).await {
            Err(error) => {
                warn!(error = %format!("{error:#}"), "the wake launch failed");
                "the wake launch failed"
            }
            Ok(launched) => match backend.boot(&launched, true).await {
                Err(error) => {
                    warn!(error = %format!("{error:#}"), "the VMM refused the wake");
                    backend.destroy(launched).await?;
                    "the VMM refused the wake"
                }
                Ok(()) => match backend
                    .first_report(&launched, WAKE_FIRST_REPORT_LIMIT)
                    .await
                {
                    None => return Ok((launched, start(VmStartPath::Wake, None))),
                    Some(reason) => {
                        backend.destroy(launched).await?;
                        reason
                    }
                },
            },
        },
    };
    // A VM deleted during its wake is gone: no fallback to keep, no
    // cold launch.
    backend.ensure_wanted().await?;
    backend.record_fallback();
    let launched = backend.launch(false).await?;
    backend.boot(&launched, false).await?;
    Ok((
        launched,
        start(VmStartPath::WakeFallback, Some(reason.to_owned())),
    ))
}
