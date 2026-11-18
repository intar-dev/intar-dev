//! The `kino.v2` stream: length-prefixed protobuf frames on the connection
//! Kino opens to the host's report port, over vsock or, when `boot.json`
//! says so, TCP.

use super::{Report, head, verify};
use intar_kino_proto::kino_v2::{GuestFrame, HostFrame, MAX_FRAME_BYTES, guest_frame, host_frame};
use prost::Message as _;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};
use tokio::sync::{oneshot, watch};

const KEEPALIVE: Duration = Duration::from_secs(10);
const RECONNECT: Duration = Duration::from_millis(100);

type Sink = Box<dyn AsyncWrite + Unpin + Send>;
/// The write half, a signal that fires when the host closed the stream, and
/// the reader task. Dropping the link stops the reader, which closes the
/// stream: a publisher that is aborted leaves no connection behind.
type Link = (Sink, oneshot::Receiver<()>, Reader);

struct Reader(tokio::task::JoinHandle<()>);

impl Drop for Reader {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Send every report change, and the latest report every 10 s. A lost
/// connection is opened again and the latest report resent, so the host
/// never has to ask.
pub(crate) async fn publish(mut changes: watch::Receiver<Report>, host: oneshot::Receiver<Host>) {
    let mut seq = 0_u64;
    // A dropped sender means init is gone; vsock is the contract's default.
    let host = host.await.unwrap_or(Host::Vsock);
    let mut link = connect(host).await;
    loop {
        let mut next = changes.borrow_and_update().clone();
        seq += 1;
        next.seq = seq;
        let frame = encode(next);
        if link.0.write_all(&frame).await.is_err() || link.0.flush().await.is_err() {
            link = connect(host).await;
            continue;
        }
        tokio::select! {
            changed = changes.changed() => {
                if changed.is_err() {
                    return;
                }
            }
            () = tokio::time::sleep(KEEPALIVE) => {}
            _ = &mut link.1 => link = connect(host).await,
        }
    }
}

/// tokio-vsock opens its socket without close-on-exec: without this every
/// script Kino runs, and the run started after a park, inherits the report
/// connection.
#[cfg(target_os = "linux")]
pub(super) fn close_on_exec(stream: &tokio_vsock::VsockStream) {
    if let Err(error) = rustix::io::fcntl_setfd(stream, rustix::io::FdFlags::CLOEXEC) {
        eprintln!("kino init: close-on-exec on the report connection: {error}");
    }
}

/// Where the host is, from `boot.json`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Host {
    Vsock,
    Tcp {
        reports: std::net::SocketAddr,
        run_cli: std::net::SocketAddr,
    },
}

impl Host {
    pub(crate) fn of(boot: &intar_contracts::guest::GuestBootV3) -> Result<Self, String> {
        use intar_contracts::guest::GuestHostV3;
        match &boot.host {
            None | Some(GuestHostV3::Vsock) => Ok(Self::Vsock),
            Some(GuestHostV3::Tcp {
                address,
                report_port,
                run_cli_port,
            }) => {
                let ip: std::net::IpAddr = address.parse().map_err(|_| {
                    format!("boot.json: the host address {address:?} is not an IP address")
                })?;
                if *report_port == 0 || *run_cli_port == 0 {
                    return Err("boot.json: a host port is 0".to_owned());
                }
                Ok(Self::Tcp {
                    reports: (ip, *report_port).into(),
                    run_cli: (ip, *run_cli_port).into(),
                })
            }
        }
    }
}

/// The link over an open stream: its write half, and a reader that signals
/// when the host closed it.
#[cfg_attr(
    not(target_os = "linux"),
    allow(dead_code, reason = "used by the Linux guest only")
)]
fn link(stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static) -> Link {
    let (read, write) = tokio::io::split(stream);
    let (done, closed) = oneshot::channel();
    let reader = tokio::spawn(async move {
        read_host_frames(read).await;
        let _ = done.send(());
    });
    (Box::new(write), closed, Reader(reader))
}

/// Retries until the host listens. Over TCP the first tries fail until the
/// guest's network is up.
#[cfg(target_os = "linux")]
async fn connect(host: Host) -> Link {
    use intar_contracts::guest::REPORT_PORT;
    use tokio_vsock::{VMADDR_CID_HOST, VsockAddr, VsockStream};
    loop {
        match host {
            Host::Vsock => {
                if let Ok(stream) =
                    VsockStream::connect(VsockAddr::new(VMADDR_CID_HOST, REPORT_PORT)).await
                {
                    close_on_exec(&stream);
                    return link(stream);
                }
            }
            Host::Tcp { reports, .. } => {
                // std sockets are close-on-exec; no script inherits this one.
                if let Ok(stream) = tokio::net::TcpStream::connect(reports).await {
                    let _ = stream.set_nodelay(true);
                    return link(stream);
                }
            }
        }
        tokio::time::sleep(RECONNECT).await;
    }
}

/// There is no vsock off Linux; the supervisor only runs in a guest.
#[cfg(not(target_os = "linux"))]
async fn connect(_host: Host) -> Link {
    let _ = RECONNECT;
    std::future::pending().await
}

/// Host frames until the stream ends or sends something that is not one.
#[cfg_attr(
    not(target_os = "linux"),
    allow(dead_code, reason = "used by the Linux guest only")
)]
pub(crate) async fn read_host_frames(mut read: impl AsyncRead + Unpin) {
    loop {
        let Ok(length) = read.read_u32().await else {
            return;
        };
        let length = length as usize;
        if length > MAX_FRAME_BYTES {
            eprintln!("kino init: host frame of {length} bytes refused");
            return;
        }
        let mut bytes = vec![0; length];
        if read.read_exact(&mut bytes).await.is_err() {
            return;
        }
        match HostFrame::decode(bytes.as_slice()) {
            Ok(HostFrame {
                frame: Some(host_frame::Frame::PeerTasks(peers)),
            }) => {
                verify::set_peers(peers);
            }
            // `Wake` is for a parked Kino only.
            Ok(HostFrame {
                frame: None | Some(host_frame::Frame::Wake(_)),
            }) => {}
            Err(error) => {
                eprintln!("kino init: host frame refused: {error}");
                return;
            }
        }
    }
}

/// One frame: a 4-byte big-endian length, then the `GuestFrame`. A report
/// over the frame cap loses admin-only text, longest first, and never a
/// task or a verify status.
pub(crate) fn encode(mut report: Report) -> Vec<u8> {
    loop {
        let frame = GuestFrame {
            frame: Some(guest_frame::Frame::Report(report.clone())),
        };
        let body = frame.encode_to_vec();
        if body.len() <= MAX_FRAME_BYTES || !halve_longest_tail(&mut report) {
            let length = u32::try_from(body.len()).unwrap_or(u32::MAX);
            return [length.to_be_bytes().as_slice(), &body].concat();
        }
    }
}

/// Cut the longest admin-only text to half; false when none is left.
fn halve_longest_tail(report: &mut Report) -> bool {
    let steps = report
        .verify
        .iter_mut()
        .flat_map(|verify| &mut verify.steps);
    let longest = steps
        .map(|step| &mut step.tail)
        .chain(report.ready.iter_mut().map(|ready| &mut ready.tail))
        .chain(std::iter::once(&mut report.failure))
        .max_by_key(|text| text.len());
    match longest {
        Some(text) if !text.is_empty() => {
            *text = head(text, text.len() / 2).to_owned();
            true
        }
        _ => false,
    }
}
