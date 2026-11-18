//! Starting a run from a snapshot this host took of its image (#348).
//!
//! A snapshot belongs to one image and one shape (CPU, memory, root disk
//! size, host name, egress) on this host in its current boot. The first
//! cold boot of a shape queues a capture: a VM of that shape boots with no
//! scenario content, parks, and is snapshotted. Later single-VM runs of the
//! shape are restored from it and woken; a restore that does not get the
//! guest to `SSH_READY` is abandoned and the run cold-boots.

#![cfg_attr(
    not(target_os = "linux"),
    allow(
        dead_code,
        unused_imports,
        reason = "an agent host is Linux; elsewhere this builds for its tests"
    )
)]

use super::*;
use cloud_hypervisor_client::{LandlockRuleConfig, MemoryRestoreMode, RestoreConfig};
use intar_jailer_protocol::{
    JAILED_SNAPSHOT_DIR, PublishSnapshotRequest, RemoveSnapshotRequest, SnapshotInfo,
    SnapshotLaunch,
};
use std::sync::Mutex as SyncMutex;

/// Bumped when a capture is made differently: older snapshots stop matching.
const RECIPE: &str = "1";
/// kvm-clock steps the guest's monotonic clock by the snapshot's age on a
/// restore; the TSC clock source does not (measured in #348).
const CAPTURE_CMDLINE: &str = " clocksource=tsc tsc=reliable";
/// The capture and its test restore live outside the run table under fixed
/// names, so what an interrupted capture left behind can be found again.
const CAPTURE_RUN_ID: &str = "snapshot-capture";
const CAPTURE_VM_ID: &str = "capture";
const CHECK_VM_ID: &str = "check";
const CAPTURE_TAP: &str = "isnapcap0";
const CHECK_TAP: &str = "isnapchk0";
const CAPTURE_MAC: &str = "02:73:6e:61:70:01";
const CHECK_MAC: &str = "02:73:6e:61:70:02";
/// Below the CIDs runs are given.
const CAPTURE_CID: u32 = KINO_VSOCK_CID_MIN - 2;
const CHECK_CID: u32 = KINO_VSOCK_CID_MIN - 1;

/// Boot, lab start, the settle wait (at most 90 s in Kino) and the park.
const PARKED_TIMEOUT: Duration = Duration::from_secs(240);
/// A restore from an uncached memory file answered after up to 8.6 s.
pub(super) const RESTORE_TIMEOUT: Duration = Duration::from_secs(30);
/// Tested: restores within the host boot that took the snapshot, under an
/// hour old. Longer lives need their own proof first.
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// A shape in use is captured again before it expires.
const REFRESH_AGE: Duration = Duration::from_secs(20 * 60 * 60);
const RESTORE_FAILURES_TO_REMOVE: u32 = 2;
const CAPTURE_FAILURES_PER_DAY: u32 = 3;

/// In a restored VM's spool directory, from just before the restore call.
/// The spool lives as long as the VM; its staging directory does not.
const RESTORED_MARKER: &str = "restored-from-snapshot";

fn restored_marker(details: &VmDetails) -> Option<PathBuf> {
    Some(Path::new(details.spool_dir.as_deref()?).join(RESTORED_MARKER))
}

pub(super) async fn write_restored_marker(details: &VmDetails) {
    let Some(marker) = restored_marker(details) else {
        return;
    };
    if let Err(error) = tokio::fs::write(&marker, b"").await {
        warn!(error = %error, path = %marker.display(), "failed to mark a VM as restored");
    }
}

/// A restore that did not get its guest up. The run cold-boots instead.
#[derive(Debug, thiserror::Error)]
#[error("snapshot restore abandoned: {reason}")]
pub(super) struct RestoreAbandoned {
    pub(super) key: String,
    pub(super) reason: String,
}

pub(super) fn abandoned(key: &Sha256Digest, error: &anyhow::Error) -> anyhow::Error {
    RestoreAbandoned {
        key: key.as_str().to_owned(),
        reason: format!("{error:#}"),
    }
    .into()
}

/// Everything a capture needs, taken from the cold boot that asked for it.
pub(super) struct CaptureJob {
    key: Sha256Digest,
    ready: image_cache::ReadyImage,
    kino: OciDigest,
    /// The run's machine spec; its scripts are dropped for the capture.
    spec: Vec<u8>,
    cpu_millis: u32,
    memory_mib: u32,
    disk_mib: Option<u32>,
    hostname: String,
    egress: bool,
    dns: Vec<String>,
    /// `<work dir>/vms`, a trusted source root's child.
    vms_dir: PathBuf,
}

#[derive(Debug, Default)]
struct Counters {
    restore_failures: BTreeMap<String, u32>,
    /// Per key: failed captures and the day (Unix days) they count for.
    capture_failures: BTreeMap<String, (u32, i64)>,
}

#[derive(Debug)]
pub(super) struct Snapshots {
    enabled: bool,
    allow_unstable_tsc: bool,
    /// Published and test-restored, by key.
    usable: SyncMutex<BTreeMap<String, SnapshotInfo>>,
    loaded: OnceCell<()>,
    /// VMs that were restored: their connections are answered with `Wake`.
    restored: SyncMutex<BTreeSet<String>>,
    counters: SyncMutex<Counters>,
    queued: SyncMutex<BTreeSet<String>>,
    capture: SyncMutex<Option<AbortHandle>>,
    lane: Mutex<()>,
}

impl Snapshots {
    pub(super) fn new(config: &crate::config::SnapshotsConfig) -> Self {
        Self {
            enabled: config.enabled,
            allow_unstable_tsc: config.allow_unstable_tsc,
            usable: SyncMutex::default(),
            loaded: OnceCell::new(),
            restored: SyncMutex::default(),
            counters: SyncMutex::default(),
            queued: SyncMutex::default(),
            capture: SyncMutex::default(),
            lane: Mutex::new(()),
        }
    }

    pub(super) fn mark_restored(&self, vm_name: &str) {
        if let Ok(mut restored) = self.restored.lock() {
            restored.insert(vm_name.to_owned());
        }
    }

    pub(super) fn forget_vm(&self, vm_name: &str) {
        if let Ok(mut restored) = self.restored.lock() {
            restored.remove(vm_name);
        }
    }

    /// The `Wake` for a new connection of `vm_name`, when it was restored.
    pub(super) fn wake_for(&self, vm_name: &str) -> Option<Vec<u8>> {
        if !self.restored.lock().ok()?.contains(vm_name) {
            return None;
        }
        let mut seed = vec![0_u8; 32];
        getrandom_fill(&mut seed).ok()?;
        let now = u64::try_from(now_unix_ms()).ok()?;
        Some(intar_kino_proto::host::wake_frame(now, seed))
    }

    /// A failed capture, or a snapshot removed for failed restores: three a
    /// day stop captures of the key until tomorrow.
    fn count_capture_failure(&self, key: &str) {
        if let Ok(mut counters) = self.counters.lock() {
            let today = now_unix_s() / 86_400;
            let entry = counters
                .capture_failures
                .entry(key.to_owned())
                .or_insert((0, today));
            *entry = if entry.1 == today {
                (entry.0 + 1, today)
            } else {
                (1, today)
            };
        }
    }

    pub(super) fn restore_succeeded(&self, key: &Sha256Digest) {
        if let Ok(mut counters) = self.counters.lock() {
            counters.restore_failures.remove(key.as_str());
        }
    }
}

/// From just before the restore call: the VM's connections are answered
/// with `Wake`. This says nothing yet about whether the guest woke.
pub(super) fn expect_wake(inner: &Inner, vm_name: &str) {
    inner.snapshots.mark_restored(vm_name);
}

/// The restored guest got to `SSH_READY`: the VM's report says it runs from
/// a snapshot. Only from here on, since the site takes it as proof.
pub(super) async fn confirm_restored(inner: &Inner, vm_name: &str) {
    if let Some(vm) = inner.states.write().await.get_mut(vm_name) {
        vm.restored_from_snapshot = true;
    }
}

/// A restore was abandoned: no more `Wake`, no claim in the report, and no
/// marker for a later agent start to find beside the cold-booted VM.
pub(super) async fn forget_restore(inner: &Inner, vm_name: &str) {
    inner.snapshots.forget_vm(vm_name);
    let marker = {
        let mut states = inner.states.write().await;
        states.get_mut(vm_name).and_then(|vm| {
            vm.restored_from_snapshot = false;
            vm.details.as_ref().and_then(restored_marker)
        })
    };
    if let Some(marker) = marker
        && let Err(error) = tokio::fs::remove_file(&marker).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        warn!(error = %error, path = %marker.display(), "failed to remove a restore marker");
    }
}

/// Whether this host's CPU keeps one TSC that never stops.
fn stable_tsc() -> bool {
    std::fs::read_to_string("/proc/cpuinfo").is_ok_and(|cpuinfo| {
        cpuinfo
            .lines()
            .find(|line| line.starts_with("flags"))
            .is_some_and(|flags| {
                let has = |flag: &str| flags.split_whitespace().any(|found| found == flag);
                has("constant_tsc") && has("nonstop_tsc")
            })
    })
}

fn available(inner: &Inner) -> bool {
    inner.snapshots.enabled && (inner.snapshots.allow_unstable_tsc || stable_tsc())
}

/// The host facts a snapshot is only valid under.
fn host_identity() -> String {
    let read = |path: &str| std::fs::read_to_string(path).unwrap_or_default();
    let cpuinfo = read("/proc/cpuinfo");
    let field = |name: &str| {
        cpuinfo
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split(':').nth(1))
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    format!(
        "{}\n{}\n{}\n{}",
        field("model name"),
        field("microcode"),
        read("/proc/sys/kernel/osrelease").trim(),
        read("/proc/sys/kernel/random/boot_id").trim(),
    )
}

struct Shape<'a> {
    ready: &'a image_cache::ReadyImage,
    kino: &'a OciDigest,
    cpu_millis: u32,
    memory_mib: u32,
    root_disk_size_bytes: u64,
    hostname: &'a str,
    egress: bool,
    dns: &'a [String],
}

fn key_of(shape: &Shape<'_>, hypervisor_sha256: &str) -> Result<Sha256Digest> {
    let mut hasher = Sha256::new();
    let mut field = |value: &str| {
        hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
        hasher.update(value.as_bytes());
    };
    field(RECIPE);
    field(shape.ready.image.hex());
    field(shape.ready.kernel.hex());
    field(shape.ready.initrd.as_ref().map_or("", OciDigest::hex));
    field(&shape.ready.cmdline);
    field(CAPTURE_CMDLINE);
    field(shape.kino.hex());
    field(&shape.cpu_millis.to_string());
    field(&shape.memory_mib.to_string());
    field(&shape.root_disk_size_bytes.to_string());
    field(shape.hostname);
    field(if shape.egress { "egress" } else { "" });
    field(&if shape.egress {
        shape.dns.join(",")
    } else {
        String::new()
    });
    field(hypervisor_sha256);
    field(&host_identity());
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(Sha256Digest::parse(hex)?)
}

fn root_disk_size_bytes(ready: &image_cache::ReadyImage, disk_mib: Option<u32>) -> u64 {
    disk_mib.map_or(ready.disk_size_bytes, |mib| u64::from(mib) * 1024 * 1024)
}

async fn run_key(
    inner: &Inner,
    req: &RunCreateInput<'_>,
    ready: &image_cache::ReadyImage,
) -> Result<Sha256Digest> {
    let capabilities = cached_jailer_launch_capabilities(inner).await?;
    key_of(
        &Shape {
            ready,
            kino: req.kino,
            cpu_millis: req.cpu_millis,
            memory_mib: req.memory_mib,
            root_disk_size_bytes: root_disk_size_bytes(ready, req.disk_mib),
            hostname: req.hostname,
            egress: req.egress,
            dns: &req.network.dns,
        },
        &capabilities.cloud_hypervisor_sha256,
    )
}

/// A publish stops the capture VM, clones its root disk and reads its whole
/// memory file once to give back the empty pages: more than the daemon's
/// usual request takes. Timing out is worse than waiting, since the agent
/// then removes the snapshot the daemon went on to publish.
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(60);

async fn jailer(inner: &Inner, request: JailerRequest) -> Result<JailerResponse> {
    match request_jailerd(inner, request).await? {
        JailerResponse::Error(error) => Err(JailerdError(error).into()),
        response => Ok(response),
    }
}

fn age_of(snapshot: &SnapshotInfo) -> Duration {
    let captured = i64::try_from(snapshot.captured_at_unix_ms).unwrap_or(i64::MAX);
    Duration::from_millis(u64::try_from(now_unix_ms().saturating_sub(captured)).unwrap_or(0))
}

async fn remove(inner: &Inner, snapshot: &SnapshotInfo) {
    if let Ok(mut usable) = inner.snapshots.usable.lock() {
        usable.remove(snapshot.key.as_str());
    }
    let request = JailerRequest::RemoveSnapshot(RemoveSnapshotRequest {
        image_id: snapshot.image_id.clone(),
        key: snapshot.key.clone(),
    });
    if let Err(error) = jailer(inner, request).await {
        warn!(error = %error, key = snapshot.key.as_str(), "failed to remove a snapshot");
    }
}

/// Once per agent start: what the store holds from this host boot is usable,
/// everything older is removed. A snapshot taken before the last host boot
/// can never match a key again.
async fn load(inner: &Inner) {
    inner
        .snapshots
        .loaded
        .get_or_init(|| async {
            let listed = match jailer(inner, JailerRequest::ListSnapshots).await {
                Ok(JailerResponse::ListSnapshots(listed)) => listed,
                Ok(_) => Vec::new(),
                Err(error) => {
                    warn!(error = %error, "failed to list snapshots");
                    Vec::new()
                }
            };
            let uptime = std::fs::read_to_string("/proc/uptime")
                .ok()
                .and_then(|text| text.split_whitespace().next()?.parse::<f64>().ok())
                .map_or(Duration::ZERO, Duration::from_secs_f64);
            for snapshot in listed {
                let age = age_of(&snapshot);
                if age >= MAX_AGE || age >= uptime {
                    remove(inner, &snapshot).await;
                } else if let Ok(mut usable) = inner.snapshots.usable.lock() {
                    usable.insert(snapshot.key.as_str().to_owned(), snapshot);
                }
            }
        })
        .await;
}

/// The snapshot a run may start from, if any.
pub(super) async fn restore_key(
    inner: &Arc<Inner>,
    req: &RunCreateInput<'_>,
    ready: &image_cache::ReadyImage,
) -> Option<Sha256Digest> {
    if !available(inner) || !req.peer_guest_ips.is_empty() {
        return None;
    }
    load(inner).await;
    let key = run_key(inner, req, ready).await.ok()?;
    let snapshot = inner
        .snapshots
        .usable
        .lock()
        .ok()?
        .get(key.as_str())
        .cloned()?;
    let age = age_of(&snapshot);
    if age >= MAX_AGE {
        remove(inner, &snapshot).await;
        return None;
    }
    Some(key)
}

/// Whether the snapshot a run was restored from is due for its refresh.
pub(super) fn refresh_due(inner: &Inner, key: &Sha256Digest) -> bool {
    inner.snapshots.usable.lock().is_ok_and(|usable| {
        usable
            .get(key.as_str())
            .is_some_and(|snapshot| age_of(snapshot) >= REFRESH_AGE)
    })
}

/// The launch request's snapshot mode for a run.
pub(super) fn restore_launch(key: Option<&Sha256Digest>) -> Option<SnapshotLaunch> {
    key.map(|key| SnapshotLaunch::Restore { key: key.clone() })
}

/// Restore and run, in place of `vm.create` and `vm.boot`.
pub(super) async fn restore_vm(ch: &ChClient) -> Result<()> {
    ch.vm_restore(&RestoreConfig {
        source_url: format!("file://{JAILED_SNAPSHOT_DIR}"),
        memory_restore_mode: MemoryRestoreMode::CopyOnWrite,
        resume: true,
    })
    .await
    .context("cloud-hypervisor vm.restore failed")
}

/// Stop a run's VM without exporting anything and destroy it.
pub(super) async fn discard_run_vm(inner: &Inner, run_id: &str, vm_name: &str) -> Result<()> {
    let selector = VmIdentityRequest::by_logical_id(
        ValidatedId::parse(run_id.to_owned()).context("validate the run ID")?,
        ValidatedId::parse(vm_name.to_owned()).context("validate the VM ID")?,
    );
    cleanup_jailed_vm_by_selector(inner, selector, JailerIdentityOperation::Discard).await
}

/// An agent that restarted while a VM was being restored cannot know how
/// far it got. Resuming a VM that already runs is refused harmlessly, and
/// the listener sends Wake again.
pub(super) async fn recover_restored_vm(
    inner: &Inner,
    vm_name: &str,
    details: &VmDetails,
    ch: &ChClient,
) {
    if !restored_marker(details).is_some_and(|marker| marker.exists()) {
        return;
    }
    expect_wake(inner, vm_name);
    // Only a VM that was already up before the agent stopped is known to
    // have woken; one caught in the middle stays unclaimed.
    if let Some(vm) = inner.states.write().await.get_mut(vm_name)
        && vm.state == VmLifecycleState::Running
    {
        vm.restored_from_snapshot = true;
    }
    if let Err(error) = ch.vm_resume().await {
        debug!(error = %error, vm = vm_name, "a restored VM was not paused");
    }
}

/// A restore was abandoned: after two in a row the snapshot goes.
pub(super) async fn restore_failed(inner: &Inner, abandoned: &RestoreAbandoned) {
    // A refresh that took the snapshot away under this restore is not the
    // snapshot's failure.
    let offered = inner
        .snapshots
        .usable
        .lock()
        .is_ok_and(|usable| usable.contains_key(&abandoned.key));
    if !offered {
        warn!(
            key = abandoned.key,
            reason = abandoned.reason,
            "a snapshot restore was abandoned while its snapshot was replaced; the run cold-boots"
        );
        return;
    }
    let failures = inner.snapshots.counters.lock().map_or(0, |mut counters| {
        let failures = counters
            .restore_failures
            .entry(abandoned.key.clone())
            .or_default();
        *failures += 1;
        *failures
    });
    warn!(
        key = abandoned.key,
        failures,
        reason = abandoned.reason,
        "a snapshot restore was abandoned; the run cold-boots"
    );
    if failures >= RESTORE_FAILURES_TO_REMOVE {
        let snapshot = inner
            .snapshots
            .usable
            .lock()
            .ok()
            .and_then(|usable| usable.get(&abandoned.key).cloned());
        if let Some(snapshot) = snapshot {
            remove(inner, &snapshot).await;
            // A snapshot that passes its test restore but fails real ones
            // would otherwise be captured and removed all day.
            inner.snapshots.count_capture_failure(&abandoned.key);
        }
    }
}

/// After a cold boot of a single-VM run: capture its shape in the
/// background, unless a snapshot exists, one is queued, or captures of it
/// keep failing today.
pub(super) async fn queue_capture(
    inner: &Arc<Inner>,
    req: &RunCreateInput<'_>,
    ready: &image_cache::ReadyImage,
) {
    if !available(inner) || !req.peer_guest_ips.is_empty() {
        return;
    }
    let Ok(key) = run_key(inner, req, ready).await else {
        return;
    };
    let today = now_unix_s() / 86_400;
    let failing = inner.snapshots.counters.lock().is_ok_and(|counters| {
        counters
            .capture_failures
            .get(key.as_str())
            .is_some_and(|(count, day)| *day == today && *count >= CAPTURE_FAILURES_PER_DAY)
    });
    let Some(vms_dir) = req
        .config_disk_path
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
    else {
        return;
    };
    if failing {
        return;
    }
    let Ok(cache_root) = image_cache::default_cache_root() else {
        return;
    };
    let Ok(spec) = inner
        .oci
        .spec(req.spec, &image_cache::BlobStore::new(&cache_root))
        .await
    else {
        return;
    };
    let newly_queued = inner
        .snapshots
        .queued
        .lock()
        .is_ok_and(|mut queued| queued.insert(key.as_str().to_owned()));
    if !newly_queued {
        return;
    }
    let job = CaptureJob {
        key,
        ready: ready.clone(),
        kino: req.kino.clone(),
        spec,
        cpu_millis: req.cpu_millis,
        memory_mib: req.memory_mib,
        disk_mib: req.disk_mib,
        hostname: req.hostname.to_owned(),
        egress: req.egress,
        dns: req.network.dns.clone(),
        vms_dir,
    };
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        // One capture at a time.
        let _lane = inner.snapshots.lane.lock().await;
        let key = job.key.clone();
        // A capture that fails or is aborted after its publish must not
        // leave an untested snapshot for the next agent start to trust.
        let unpublish = JailerRequest::RemoveSnapshot(RemoveSnapshotRequest {
            image_id: job.ready.prepared_image.image_id.clone(),
            key: key.clone(),
        });
        let task = tokio::spawn({
            let inner = Arc::clone(&inner);
            async move { capture(&inner, &job).await }
        });
        if let Ok(mut current) = inner.snapshots.capture.lock() {
            *current = Some(task.abort_handle());
        }
        let outcome = task.await;
        if let Ok(mut current) = inner.snapshots.capture.lock() {
            *current = None;
        }
        if let Ok(mut queued) = inner.snapshots.queued.lock() {
            queued.remove(key.as_str());
        }
        match outcome {
            Ok(Ok(snapshot)) => {
                info!(
                    key = key.as_str(),
                    bytes = snapshot.bytes_on_disk,
                    "snapshot captured and test-restored"
                );
                if let Ok(mut usable) = inner.snapshots.usable.lock() {
                    usable.insert(key.as_str().to_owned(), snapshot);
                }
                if let Ok(mut counters) = inner.snapshots.counters.lock() {
                    counters.restore_failures.remove(key.as_str());
                }
            }
            Ok(Err(error)) => {
                // No CPU for the capture right now is not a failed capture.
                let busy = error
                    .downcast_ref::<JailerdError>()
                    .is_some_and(|error| error.0.code == "cpu_capacity_exhausted");
                warn!(error = %format!("{error:#}"), key = key.as_str(), busy, "snapshot capture failed");
                if !busy {
                    inner.snapshots.count_capture_failure(key.as_str());
                }
                clean_up_until_gone(&inner).await;
                let _ = request_jailerd(&inner, unpublish).await;
            }
            // Aborted for a launch: not a failure.
            Err(_) => {
                clean_up_until_gone(&inner).await;
                let _ = request_jailerd(&inner, unpublish).await;
            }
        }
    });
}

/// A run launch found the CPU budget taken: a capture gives way.
pub(super) fn yield_to_launch(inner: &Inner) {
    if let Ok(current) = inner.snapshots.capture.lock()
        && let Some(capture) = current.as_ref()
    {
        capture.abort();
    }
}

/// At agent start: an agent that stopped in the middle of a capture left its
/// VM running and charged, and maybe a published snapshot that was never
/// test-restored. Remove the VMs, and when there were any, every snapshot.
pub(super) async fn clean_up_at_start(inner: &Inner) {
    let mut interrupted = false;
    for vm_id in [CAPTURE_VM_ID, CHECK_VM_ID] {
        let (Ok(run_id), Ok(vm_id)) = (
            ValidatedId::parse(CAPTURE_RUN_ID.to_owned()),
            ValidatedId::parse(vm_id.to_owned()),
        ) else {
            continue;
        };
        let inspect = JailerRequest::InspectVm(VmIdentityRequest::by_logical_id(run_id, vm_id));
        if matches!(
            request_jailerd(inner, inspect).await,
            Ok(JailerResponse::InspectVm(_))
        ) {
            interrupted = true;
        }
    }
    if !interrupted {
        return;
    }
    warn!("a snapshot capture was interrupted by an agent stop; removing what it left");
    clean_up_until_gone(inner).await;
    if let Ok(JailerResponse::ListSnapshots(listed)) =
        jailer(inner, JailerRequest::ListSnapshots).await
    {
        for snapshot in listed {
            remove(inner, &snapshot).await;
        }
    }
}

/// An aborted capture's launch can still be in flight in the daemon, which
/// finishes it whatever the agent does. Until it has, the VM cannot be
/// found, and the run network says it still has VMs.
async fn clean_up_until_gone(inner: &Inner) {
    for _ in 0..30 {
        if clean_up(inner).await {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    warn!("a snapshot VM could not be removed; the next capture tries again");
}

/// Destroy whatever the capture and the test restore left behind. False
/// when the run network still has a VM that could not be found yet.
async fn clean_up(inner: &Inner) -> bool {
    for vm_id in [CAPTURE_VM_ID, CHECK_VM_ID] {
        let (Ok(run_id), Ok(vm_id)) = (
            ValidatedId::parse(CAPTURE_RUN_ID.to_owned()),
            ValidatedId::parse(vm_id.to_owned()),
        ) else {
            continue;
        };
        let selector = VmIdentityRequest::by_logical_id(run_id, vm_id);
        if let Err(error) =
            cleanup_jailed_vm_by_selector(inner, selector, JailerIdentityOperation::Discard).await
        {
            warn!(error = %error, "failed to clean up a snapshot VM");
        }
    }
    if let Ok(run_id) = ValidatedId::parse(CAPTURE_RUN_ID.to_owned()) {
        let request =
            JailerRequest::DestroyRunNetwork(intar_jailer_protocol::DestroyRunNetworkRequest {
                run_id,
            });
        match request_jailerd(inner, request).await {
            Ok(JailerResponse::Error(error))
                if error.message.contains("still has VM generations") =>
            {
                return false;
            }
            Ok(_) => {}
            Err(error) => warn!(error = %error, "failed to remove the snapshot run network"),
        }
    }
    true
}

/// The capture network: the last /28 of the pool but one (the last is the
/// daemon's self-test). The run allocator never hands it out.
pub(super) fn capture_subnet(pool_network: u32, pool_subnet_count: u32) -> Option<u32> {
    let subnet_size = 1_u32 << u32::from(32_u8 - RUN_SUBNET_PREFIX);
    (pool_subnet_count >= 4)
        .then(|| pool_network.saturating_add((pool_subnet_count - 2).saturating_mul(subnet_size)))
}

fn capture_network(inner: &Inner, host: u32, dns: &[String]) -> Result<CreateVmNetwork> {
    let (pool_ip, pool_prefix) = parse_ipv4_cidr(
        inner.defaults.network.guest_cidr.trim(),
        "vm_defaults.network.guest_cidr",
    )?;
    anyhow::ensure!(
        pool_prefix <= RUN_SUBNET_PREFIX,
        "the guest pool is too small"
    );
    let subnet = capture_subnet(
        ipv4_network_u32(pool_ip, pool_prefix),
        1_u32 << u32::from(RUN_SUBNET_PREFIX - pool_prefix),
    )
    .context("the guest pool has no room for a capture network")?;
    Ok(CreateVmNetwork {
        guest_ip_cidr: format!(
            "{}/{RUN_SUBNET_PREFIX}",
            Ipv4Addr::from(subnet.saturating_add(host))
        ),
        gateway: Ipv4Addr::from(subnet.saturating_add(1)).to_string(),
        dns: dns.to_vec(),
    })
}

struct SnapshotVm<'a> {
    vm_id: &'a str,
    tap: &'a str,
    mac: &'a str,
    cid: u32,
    /// The host part of its address in the capture network.
    host: u32,
    snapshot: SnapshotLaunch,
}

/// Write the run disk and launch one of the two snapshot VMs.
async fn launch(
    inner: &Inner,
    job: &CaptureJob,
    vm: &SnapshotVm<'_>,
) -> Result<(VmLaunchResult, CreateVmNetwork)> {
    let directory = job.vms_dir.join(format!("{CAPTURE_RUN_ID}-{}", vm.vm_id));
    tokio::fs::create_dir_all(&directory)
        .await
        .context("create the snapshot VM directory")?;
    let network = capture_network(inner, vm.host, &job.dns)?;
    ensure_jailed_run_network(inner, CAPTURE_RUN_ID, &network).await?;

    let mut spec: intar_contracts::scenario::MachineSpecV1 =
        serde_json::from_slice(&job.spec).context("the machine spec is not a MachineSpecV1")?;
    // One image serves several scenarios: a snapshot holds none of them.
    spec.ready.clear();
    spec.tasks.clear();
    let root_disk_size_bytes = root_disk_size_bytes(&job.ready, job.disk_mib);
    let boot = runtime_disk::boot_json(&runtime_disk::BootJsonInput {
        hostname: &job.hostname,
        network: &network,
        egress: job.egress,
        peer_guest_ips: &BTreeMap::new(),
        ssh_enabled: false,
        ssh_authorized_keys_openssh: &[],
        root_resize: root_disk_size_bytes > job.ready.disk_size_bytes,
        mode: SpecMode::Learn,
        spec: &serde_json::to_vec(&spec)?,
    })?;
    let cache_root = image_cache::default_cache_root()?;
    let kino = inner
        .oci
        .kino_binary(&job.kino, &image_cache::BlobStore::new(&cache_root))
        .await
        .context("the capture's Kino is unavailable")?;
    let run_disk = directory.join(RUNTIME_DISK_FILENAME);
    let capture = vm.snapshot == SnapshotLaunch::Capture;
    tokio::task::spawn_blocking({
        let run_disk = run_disk.clone();
        move || runtime_disk::write_runtime_disk_with(&run_disk, &boot, &kino, capture)
    })
    .await
    .context("run disk task panicked")??;

    let capabilities = cached_jailer_launch_capabilities(inner).await?;
    let prepared = &job.ready.prepared_image;
    let roots = &capabilities.allowed_source_roots;
    let request = VmLaunchRequest {
        run_id: ValidatedId::parse(CAPTURE_RUN_ID.to_owned())?,
        vm_id: ValidatedId::parse(vm.vm_id.to_owned())?,
        cpu_millis: job.cpu_millis,
        memory_mib: job.memory_mib,
        root_disk_size_bytes,
        tap_name: vm.tap.to_owned(),
        mac_address: vm.mac.to_owned(),
        guest_ip_cidr: network.guest_ip_cidr.clone(),
        ssh_public_port: None,
        vsock_cid: vm.cid,
        egress: false,
        snapshot: Some(vm.snapshot.clone()),
        artifacts: SourceArtifacts {
            kernel: prepared.kernel.clone(),
            initrd: prepared.initrd.clone(),
            root_disk: prepared.root_disk.clone(),
            runtime_disk: artifact_source(&run_disk, roots, None, ArtifactAccess::ReadOnly)?,
            // Never exported: a snapshot VM's stop discards the recording.
            recording_disk: artifact_source(
                &directory.join("recordings.vfat"),
                roots,
                None,
                ArtifactAccess::ReadWrite,
            )?,
        },
    };
    let operation = LaunchVmV3Request {
        image_id: prepared.image_id.clone(),
        chunk_manifest_sha256: prepared.chunk_manifest_sha256.clone(),
        virtual_size_bytes: prepared.virtual_size_bytes,
        launch: request,
    };
    operation.validate()?;
    match jailer(inner, JailerRequest::LaunchVmV3(Box::new(operation))).await? {
        JailerResponse::LaunchVmV3(launch) => Ok((launch, network)),
        response => anyhow::bail!("unexpected answer to a snapshot launch: {response:?}"),
    }
}

async fn discard_and_destroy(inner: &Inner, generation: &ValidatedId) -> Result<()> {
    cleanup_jailed_vm_by_selector(
        inner,
        VmIdentityRequest::by_generation(generation.clone()),
        JailerIdentityOperation::Discard,
    )
    .await
}

/// One length-prefixed frame's body, or `None` at the end of the stream.
async fn read_frame(stream: &mut tokio::net::UnixStream) -> Result<Option<Vec<u8>>> {
    use tokio::io::AsyncReadExt as _;
    let mut length = [0_u8; 4];
    match stream.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error).context("read a guest frame length"),
    }
    let length = u32::from_be_bytes(length) as usize;
    anyhow::ensure!(
        length <= intar_kino_proto::kino_v2::MAX_FRAME_BYTES,
        "guest frame of {length} bytes is over the limit"
    );
    let mut body = vec![0_u8; length];
    stream
        .read_exact(&mut body)
        .await
        .context("read a guest frame")?;
    Ok(Some(body))
}

/// Capture, publish and test-restore one snapshot.
#[cfg(target_os = "linux")]
async fn capture(inner: &Inner, job: &CaptureJob) -> Result<SnapshotInfo> {
    clean_up_until_gone(inner).await;
    // Snapshots past their age go, whatever their key: after a Kino pin
    // change or for a shape nobody runs any more, no run would ask for them.
    let expired: Vec<SnapshotInfo> = inner.snapshots.usable.lock().map_or_else(
        |_| Vec::new(),
        |usable| {
            usable
                .values()
                .filter(|snapshot| age_of(snapshot) >= MAX_AGE)
                .cloned()
                .collect()
        },
    );
    for snapshot in &expired {
        remove(inner, snapshot).await;
    }
    // A refresh: runs stop being offered the old snapshot now, and it leaves
    // the store only just before the new one is published, since a key is
    // published once. VMs restored from it keep their links and clones.
    let old = inner
        .snapshots
        .usable
        .lock()
        .ok()
        .and_then(|mut usable| usable.remove(job.key.as_str()));

    // Capture: boot with no scenario content until Kino reports PARKED.
    let (launched, _) = launch(
        inner,
        job,
        &SnapshotVm {
            vm_id: CAPTURE_VM_ID,
            tap: CAPTURE_TAP,
            mac: CAPTURE_MAC,
            cid: CAPTURE_CID,
            host: 2,
            snapshot: SnapshotLaunch::Capture,
        },
    )
    .await?;
    let (listener, socket_path) =
        prepare_kino_ready_listener(&launched.paths.host_vsock_socket, launched.uid).await?;
    let cmdline = format!("{}{CAPTURE_CMDLINE}", job.ready.cmdline);
    let mut config = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
        cpu_millis: job.cpu_millis,
        name: CAPTURE_VM_ID,
        cmdline: &cmdline,
        paths: &launched.paths,
        memory_mib: job.memory_mib,
        tap: CAPTURE_TAP,
        mac: CAPTURE_MAC,
        kino_vsock_cid: CAPTURE_CID,
    })?;
    // Without its own rule the VMM's Landlock domain refuses the snapshot.
    config.landlock_rules = Some(vec![LandlockRuleConfig {
        path: JAILED_SNAPSHOT_DIR.to_owned(),
        access: "rw".to_owned(),
    }]);
    let ch = ChClient::new(launched.paths.host_api_socket.display().to_string())?;
    ch.vm_create(&config)
        .await
        .context("capture vm.create failed")?;
    ch.vm_boot().await.context("capture vm.boot failed")?;
    // Kino reports its boot on one connection and PARKED on another; the
    // first may still be open when the second arrives.
    let (parked_tx, mut parked_rx) = tokio::sync::mpsc::channel::<()>(1);
    let mut connections = tokio::task::JoinSet::new();
    let parked = timeout(PARKED_TIMEOUT, async {
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (mut stream, _) = accepted.context("accept the capture's Kino")?;
                    let parked_tx = parked_tx.clone();
                    connections.spawn(async move {
                        while let Ok(Some(body)) = read_frame(&mut stream).await {
                            if intar_kino_proto::host::is_parked(&body) {
                                let _ = parked_tx.send(()).await;
                                return;
                            }
                        }
                    });
                }
                _ = parked_rx.recv() => return anyhow::Ok(()),
            }
        }
    })
    .await;
    // Closes every connection: the parked guest takes the end of its PARKED
    // connection as the host's acknowledgement.
    connections.shutdown().await;
    // Nothing may listen from here on: a parked guest wakes on a connection
    // that gets a Wake, and tries until a restore gives it one.
    drop(listener);
    let _ = tokio::fs::remove_file(&socket_path).await;
    parked.context("the capture did not park in time")??;
    ch.vm_pause().await.context("capture vm.pause failed")?;
    ch.vm_snapshot(&format!("file://{JAILED_SNAPSHOT_DIR}"))
        .await
        .context("capture vm.snapshot failed")?;
    if let Some(old) = &old {
        remove(inner, old).await;
    }
    let snapshot = match request_jailerd_with_timeout(
        inner,
        JailerRequest::PublishSnapshot(PublishSnapshotRequest {
            generation: launched.generation.clone(),
            key: job.key.clone(),
        }),
        PUBLISH_TIMEOUT,
    )
    .await?
    {
        JailerResponse::Error(error) => return Err(JailerdError(error).into()),
        JailerResponse::PublishSnapshot(snapshot) => snapshot,
        response => anyhow::bail!("unexpected answer to a snapshot publish: {response:?}"),
    };
    discard_and_destroy(inner, &launched.generation).await?;

    // Test restore: the snapshot is used only once a restored guest woke up
    // and got to SSH_READY, and reported nothing before its Wake.
    let checked = check(inner, job).await;
    clean_up_until_gone(inner).await;
    if let Err(error) = checked {
        remove(inner, &snapshot).await;
        return Err(error.context("the snapshot's test restore failed"));
    }
    Ok(snapshot)
}

#[cfg(target_os = "linux")]
async fn check(inner: &Inner, job: &CaptureJob) -> Result<()> {
    use tokio::io::AsyncWriteExt as _;
    let (launched, _) = launch(
        inner,
        job,
        &SnapshotVm {
            vm_id: CHECK_VM_ID,
            tap: CHECK_TAP,
            mac: CHECK_MAC,
            cid: CHECK_CID,
            host: 3,
            snapshot: SnapshotLaunch::Restore {
                key: job.key.clone(),
            },
        },
    )
    .await?;
    let (listener, socket_path) =
        prepare_kino_ready_listener(&launched.paths.host_vsock_socket, launched.uid).await?;
    let ch = ChClient::new(launched.paths.host_api_socket.display().to_string())?;
    restore_vm(&ch).await?;
    let (ready_tx, mut ready_rx) = tokio::sync::mpsc::channel::<()>(1);
    let mut connections = tokio::task::JoinSet::new();
    let woke = timeout(RESTORE_TIMEOUT, async {
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (mut stream, _) = accepted.context("accept the restored Kino")?;
                    let mut seed = vec![0_u8; 32];
                    getrandom_fill(&mut seed).context("random seed")?;
                    let now = u64::try_from(now_unix_ms()).unwrap_or(0);
                    let wake = intar_kino_proto::host::wake_frame(now, seed);
                    let ready_tx = ready_tx.clone();
                    connections.spawn(async move {
                        if stream.write_all(&wake).await.is_err() {
                            return;
                        }
                        while let Ok(Some(body)) = read_frame(&mut stream).await {
                            if intar_kino_proto::host::decode(&body)
                                .is_ok_and(|report| report.ssh_ready)
                            {
                                let _ = ready_tx.send(()).await;
                                return;
                            }
                        }
                    });
                }
                _ = ready_rx.recv() => return anyhow::Ok(()),
            }
        }
    })
    .await;
    connections.shutdown().await;
    drop(listener);
    let _ = tokio::fs::remove_file(&socket_path).await;
    woke.context("the restored guest did not get to SSH_READY in time")?
}

#[cfg(not(target_os = "linux"))]
async fn capture(_inner: &Inner, _job: &CaptureJob) -> Result<SnapshotInfo> {
    anyhow::bail!("snapshots need a Linux host")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capture_network_is_the_pools_last_subnet_but_one() {
        let pool = u32::from(Ipv4Addr::new(10, 77, 0, 0));
        assert_eq!(
            capture_subnet(pool, 4096).map(Ipv4Addr::from),
            Some(Ipv4Addr::new(10, 77, 255, 224))
        );
        assert_eq!(capture_subnet(pool, 2), None);
    }
}
