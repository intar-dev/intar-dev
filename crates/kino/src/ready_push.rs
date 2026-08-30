#[cfg(target_os = "linux")]
use crate::host_keys::collect_ssh_host_keys_openssh;
use crate::state::ProbeStore;
#[cfg(target_os = "linux")]
use prost::Message as _;
use std::env;
#[cfg(target_os = "linux")]
use std::time::Duration;
use tokio::task::JoinHandle;

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

pub(crate) fn spawn_ready_push_task(store: &ProbeStore) -> Option<JoinHandle<()>> {
    let port = read_ready_port()?;
    let store = store.clone();

    Some(tokio::spawn(async move {
        run_ready_push_loop(store, port).await;
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
async fn run_ready_push_loop(store: ProbeStore, port: u32) {
    use tokio_vsock::{VMADDR_CID_HOST, VsockAddr, VsockStream};

    loop {
        match VsockStream::connect(VsockAddr::new(VMADDR_CID_HOST, port)).await {
            Ok(mut stream) => {
                eprintln!("kino readiness push connected to vsock://{VMADDR_CID_HOST}:{port}");
                let mut changes = store.subscribe_changes();
                let mut last_frame = Vec::new();
                let mut force_send = true;

                loop {
                    match encode_ready_frame(&store).await {
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
async fn run_ready_push_loop(_store: ProbeStore, port: u32) {
    eprintln!("kino readiness push is only supported on Linux; requested port {port}");
}

#[cfg(target_os = "linux")]
async fn encode_ready_frame(store: &ProbeStore) -> anyhow::Result<Vec<u8>> {
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
    let timings = read_guest_phase_timings();
    anyhow::ensure!(
        timings.ready_uptime_ms > 0 && timings.kino_ms > 0,
        "guest phase timings are not ready"
    );
    snapshot.guest_phase_timings = Some(timings);
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
    let values = std::fs::read_to_string(PHASE_TIMINGS_PATH)
        .unwrap_or_default()
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
