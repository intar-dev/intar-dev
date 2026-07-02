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
    let snapshot = store
        .snapshot_proto_with_host_keys(collect_ssh_host_keys_openssh())
        .await;
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
