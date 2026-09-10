#[cfg(target_os = "linux")]
use crate::host_keys::collect_ssh_host_keys_openssh;
#[cfg(any(target_os = "linux", test))]
use crate::proto::kino_v1;
use crate::state::{ProbeStore, duration_millis_u64};
#[cfg(target_os = "linux")]
use prost::Message as _;
#[cfg(target_os = "linux")]
use rustix::time::{ClockId, clock_gettime};
use std::env;
#[cfg(any(target_os = "linux", test))]
use std::time::Duration;
use std::time::Instant;
use tokio::task::JoinHandle;

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

const ENV_KINO_HOST_READY_PORT: &str = "KINO_HOST_READY_PORT";
#[cfg(target_os = "linux")]
const ENV_KINO_SHA256: &str = "INTAR_KINO_SHA256";
#[cfg(target_os = "linux")]
const ENV_GUEST_BOOTSTRAP_ABI: &str = "INTAR_GUEST_BOOTSTRAP_ABI";
#[cfg(target_os = "linux")]
const PHASE_TIMINGS_PATH: &str = "/run/intar/phase-timings.env";
#[cfg(target_os = "linux")]
const READY_PUSH_KEEPALIVE: Duration = Duration::from_secs(10);
#[cfg(target_os = "linux")]
const READY_PUSH_RECONNECT_DELAY: Duration = Duration::from_millis(250);
#[cfg(target_os = "linux")]
const MAX_READY_FRAME_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct NativeReadyTimings {
    kino_ms: u64,
    ready_uptime_ms: u64,
}

impl NativeReadyTimings {
    pub(crate) fn capture(kino_started_at: Instant) -> Self {
        let kino_ms = duration_millis_u64(kino_started_at.elapsed());

        #[cfg(target_os = "linux")]
        let ready_uptime_ms = duration_millis_u64(
            Duration::try_from(clock_gettime(ClockId::Boottime))
                .unwrap_or_else(|_| unreachable!("CLOCK_BOOTTIME cannot be negative")),
        );
        #[cfg(not(target_os = "linux"))]
        let ready_uptime_ms = 0;

        Self {
            kino_ms,
            ready_uptime_ms,
        }
    }

    #[cfg(test)]
    fn from_elapsed(kino_elapsed: Duration, ready_uptime_ms: u64) -> Self {
        Self {
            kino_ms: duration_millis_u64(kino_elapsed),
            ready_uptime_ms,
        }
    }

    #[cfg(any(target_os = "linux", test))]
    fn overlay(self, mut timings: kino_v1::GuestPhaseTimingsV1) -> kino_v1::GuestPhaseTimingsV1 {
        timings.kino_ms = self.kino_ms;
        timings.ready_uptime_ms = self.ready_uptime_ms;
        timings
    }
}

#[cfg(test)]
static READY_PUSH_START_COUNT: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn reset_ready_push_start_count() {
    READY_PUSH_START_COUNT.store(0, Ordering::Relaxed);
}

#[cfg(test)]
pub(crate) fn ready_push_start_count() -> usize {
    READY_PUSH_START_COUNT.load(Ordering::Relaxed)
}

pub(crate) fn spawn_ready_push_task(
    store: &ProbeStore,
    native_timings: NativeReadyTimings,
) -> Option<JoinHandle<()>> {
    #[cfg(test)]
    READY_PUSH_START_COUNT.fetch_add(1, Ordering::Relaxed);

    let port = read_ready_port()?;
    let store = store.clone();

    Some(tokio::spawn(async move {
        run_ready_push_loop(store, port, native_timings).await;
    }))
}

fn read_ready_port() -> Option<u32> {
    let raw = env::var(ENV_KINO_HOST_READY_PORT).ok()?;
    match raw.parse::<u32>() {
        Ok(port) if port > 0 => Some(port),
        _ => {
            eprintln!("{ENV_KINO_HOST_READY_PORT} must be a positive u32; readiness push disabled");
            None
        }
    }
}

#[cfg(target_os = "linux")]
async fn run_ready_push_loop(store: ProbeStore, port: u32, native_timings: NativeReadyTimings) {
    use tokio_vsock::{VMADDR_CID_HOST, VsockAddr, VsockStream};

    loop {
        match VsockStream::connect(VsockAddr::new(VMADDR_CID_HOST, port)).await {
            Ok(mut stream) => {
                eprintln!("kino readiness push connected to vsock://{VMADDR_CID_HOST}:{port}");
                let mut changes = store.subscribe_changes();
                let mut last_frame = Vec::new();
                let mut force_send = true;

                loop {
                    match encode_ready_frame(&store, native_timings).await {
                        Ok(frame) => {
                            if force_send || frame != last_frame {
                                if let Err(error) = write_ready_frame(&mut stream, &frame).await {
                                    eprintln!("kino readiness push write failed: {error}");
                                    break;
                                }
                                last_frame = frame;
                            }
                        }
                        Err(error) => {
                            eprintln!("kino readiness snapshot encode failed: {error}");
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        }
                    }
                    force_send = false;

                    tokio::select! {
                        result = changes.changed() => {
                            if result.is_err() {
                                break;
                            }
                        }
                        () = tokio::time::sleep(READY_PUSH_KEEPALIVE) => {
                            force_send = true;
                        }
                    }
                }
            }
            Err(error) => {
                eprintln!(
                    "kino readiness push could not connect to vsock://{}:{}: {}",
                    VMADDR_CID_HOST, port, error
                );
            }
        }

        tokio::time::sleep(READY_PUSH_RECONNECT_DELAY).await;
    }
}

#[cfg(not(target_os = "linux"))]
async fn run_ready_push_loop(_store: ProbeStore, port: u32, _native_timings: NativeReadyTimings) {
    eprintln!("kino readiness push is only supported on Linux; requested port {port}");
}

#[cfg(target_os = "linux")]
async fn encode_ready_frame(
    store: &ProbeStore,
    native_timings: NativeReadyTimings,
) -> anyhow::Result<Vec<u8>> {
    let mut snapshot = store
        .snapshot_proto_with_host_keys(collect_ssh_host_keys_openssh())
        .await;
    snapshot.kino_sha256 = env::var(ENV_KINO_SHA256)
        .ok()
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
        .ok_or_else(|| anyhow::anyhow!("{ENV_KINO_SHA256} is missing or invalid"))?;
    snapshot.guest_bootstrap_abi = env::var(ENV_GUEST_BOOTSTRAP_ABI)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value == 1)
        .ok_or_else(|| anyhow::anyhow!("{ENV_GUEST_BOOTSTRAP_ABI} is missing or invalid"))?;
    snapshot.guest_phase_timings = Some(native_timings.overlay(read_guest_phase_timings()));
    let len = snapshot.encoded_len();
    anyhow::ensure!(
        len <= MAX_READY_FRAME_BYTES,
        "readiness frame is too large: {len} bytes"
    );
    let mut bytes = Vec::with_capacity(len);
    snapshot.encode(&mut bytes)?;
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn read_guest_phase_timings() -> intar_kino_proto::kino_v1::GuestPhaseTimingsV1 {
    let content = std::fs::read_to_string(PHASE_TIMINGS_PATH).unwrap_or_default();
    let values = content
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter_map(|(key, value)| value.parse::<u64>().ok().map(|value| (key, value)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let get = |key: &str| values.get(key).copied().unwrap_or_default();
    intar_kino_proto::kino_v1::GuestPhaseTimingsV1 {
        runtime_disk_ms: get("RUNTIME_DISK_MS"),
        tools_disk_ms: get("TOOLS_MOUNT_MS"),
        network_ms: get("NETWORK_CONFIG_MS"),
        ssh_keys_ms: get("SSH_HOST_KEYS_MS"),
        ssh_service_ms: get("SSH_BOOT_MS"),
        kino_ms: get("KINO_BOOT_MS"),
        ready_uptime_ms: get("READY_UPTIME_MS"),
    }
}

#[cfg(target_os = "linux")]
async fn write_ready_frame(
    stream: &mut tokio_vsock::VsockStream,
    frame: &[u8],
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt as _;

    let len = u32::try_from(frame.len())?;
    stream.write_all(&len.to_be_bytes()).await?;
    stream.write_all(frame).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::NativeReadyTimings;
    use crate::proto::kino_v1::{GuestPhaseTimingsV1, ProbesSnapshotV1};
    use prost::Message as _;
    use std::time::Duration;

    #[test]
    fn encodes_native_timings_before_shell_markers_with_zero_kino_duration() {
        let native = NativeReadyTimings::from_elapsed(Duration::ZERO, 12_345);
        let snapshot = ProbesSnapshotV1 {
            kino_sha256: "a".repeat(64),
            guest_bootstrap_abi: 1,
            guest_phase_timings: Some(native.overlay(GuestPhaseTimingsV1::default())),
            ..ProbesSnapshotV1::default()
        };
        let mut frame = Vec::new();
        snapshot
            .encode(&mut frame)
            .expect("encode native ready frame");
        let snapshot = ProbesSnapshotV1::decode(frame.as_slice()).expect("decode ready frame");
        let timings = snapshot.guest_phase_timings.expect("guest timings");

        assert_eq!(timings.kino_ms, 0);
        assert_eq!(timings.ready_uptime_ms, 12_345);
    }

    #[test]
    fn native_timings_keep_legacy_phase_values_but_replace_shell_ready_markers() {
        let native = NativeReadyTimings::from_elapsed(Duration::from_millis(7), 12_345);
        let timings = native.overlay(GuestPhaseTimingsV1 {
            runtime_disk_ms: 1,
            tools_disk_ms: 2,
            network_ms: 3,
            ssh_keys_ms: 4,
            ssh_service_ms: 5,
            kino_ms: 999,
            ready_uptime_ms: 998,
        });

        assert_eq!(timings.runtime_disk_ms, 1);
        assert_eq!(timings.tools_disk_ms, 2);
        assert_eq!(timings.network_ms, 3);
        assert_eq!(timings.ssh_keys_ms, 4);
        assert_eq!(timings.ssh_service_ms, 5);
        assert_eq!(timings.kino_ms, 7);
        assert_eq!(timings.ready_uptime_ms, 12_345);
    }
}
