//! Kino's reports: what a machine's guest says about its boot and its lab.
//!
//! Kino connects to the host and sends frames, each a 4-byte big-endian
//! length and a `kino.v2` body, which `intar-kino-proto` reads the way an
//! agent host does. The frame reader here works on any byte stream; the
//! listener is AF_VSOCK, which only a Linux host has.
//
// ponytail: macOS and Windows need Kino to report over TCP (#394); the
// reader below is ready for that stream.

use std::io::Read;

pub use intar_kino_proto::host::GuestReport;
use intar_kino_proto::kino_v2::MAX_FRAME_BYTES;

/// Reads frames from `stream` until it ends, handing each report to
/// `on_report`. A frame that is not a report this Kino may send ends the
/// reading with the reason: a guest is not trusted.
pub fn read_reports(
    mut stream: impl Read,
    mut on_report: impl FnMut(GuestReport),
) -> Result<(), String> {
    loop {
        let mut length = [0_u8; 4];
        match stream.read_exact(&mut length) {
            Ok(()) => {}
            // The guest closed between frames.
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.to_string()),
        }
        let length = u32::from_be_bytes(length) as usize;
        if length > MAX_FRAME_BYTES {
            return Err(format!("a frame of {length} bytes is over the limit"));
        }
        let mut body = vec![0_u8; length];
        stream
            .read_exact(&mut body)
            .map_err(|error| error.to_string())?;
        on_report(intar_kino_proto::host::decode(&body).map_err(|error| error.to_string())?);
    }
}

/// Kino's reports from one machine over TCP, for a host without vsock. The
/// listener is on the loopback interface, on a port of its own, and closes
/// when this is dropped.
pub struct TcpReports {
    pub port: u16,
    pub reports: std::sync::mpsc::Receiver<GuestReport>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for TcpReports {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Listens on a free loopback port for one machine's reports. The machine's
/// `boot.json` has to name that port; QEMU's network lets the guest reach
/// the host's loopback at its gateway address.
// ponytail: every program on this computer can connect to the port and send
// reports; the app's own network (#408) gives each machine a private link.
pub fn listen_tcp() -> std::io::Result<TcpReports> {
    use std::sync::atomic::Ordering;
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let (sender, reports) = std::sync::mpsc::channel();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = stop.clone();
    std::thread::Builder::new()
        .name("zpm-reports".into())
        .spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        // Kino reconnects after a lost link, so each connection is read on its own.
                        let sender = sender.clone();
                        let _ = std::thread::Builder::new()
                            .name("zpm-report-link".into())
                            .spawn(move || {
                                if stream.set_nonblocking(false).is_ok() {
                                    let _ = read_reports(stream, |report| {
                                        let _ = sender.send(report);
                                    });
                                }
                            });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
        })?;
    Ok(TcpReports {
        port,
        reports,
        stop,
    })
}

/// A report with the vsock id of the guest that sent it.
#[cfg(target_os = "linux")]
pub type FromGuest = (u32, GuestReport);

/// Listens for Kino's reports from every guest of this host, on the port the
/// guest contract names. The listener stops when the receiver is dropped.
/// Read it with `blocking_recv` or `try_recv` outside an async runtime.
#[cfg(target_os = "linux")]
pub fn listen_vsock() -> std::io::Result<tokio::sync::mpsc::UnboundedReceiver<FromGuest>> {
    use tokio::io::AsyncReadExt as _;
    use tokio_vsock::{VMADDR_CID_ANY, VsockAddr, VsockListener};

    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    // Bind before returning, so a guest that boots at once finds the port.
    let listener = runtime.block_on(async {
        VsockListener::bind(VsockAddr::new(
            VMADDR_CID_ANY,
            intar_contracts::guest::REPORT_PORT,
        ))
    })?;
    std::thread::Builder::new()
        .name("zpm-reports".into())
        .spawn(move || {
            runtime.block_on(async move {
                loop {
                    let accepted = tokio::select! {
                        accepted = listener.accept() => accepted,
                        () = sender.closed() => break,
                    };
                    let Ok((mut stream, peer)) = accepted else {
                        break;
                    };
                    let sender = sender.clone();
                    tokio::spawn(async move {
                        while let Ok(length) = stream.read_u32().await {
                            if length as usize > MAX_FRAME_BYTES {
                                break;
                            }
                            let mut body = vec![0_u8; length as usize];
                            if tokio::io::AsyncReadExt::read_exact(&mut stream, &mut body)
                                .await
                                .is_err()
                            {
                                break;
                            }
                            let Ok(report) = intar_kino_proto::host::decode(&body) else {
                                break;
                            };
                            if sender.send((peer.cid(), report)).is_err() {
                                break;
                            }
                        }
                    });
                }
            });
        })?;
    Ok(receiver)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_frames_until_the_stream_ends_and_refuses_what_is_not_a_report() {
        // No frames at all, and a stream that ends between frames, are fine.
        let mut seen = 0;
        assert_eq!(read_reports(&[][..], |_| seen += 1), Ok(()));
        assert_eq!(seen, 0);

        // A body that is no kino.v2 report ends the reading.
        let mut garbage = 3_u32.to_be_bytes().to_vec();
        garbage.extend_from_slice(&[0xff, 0xff, 0xff]);
        assert!(read_reports(&garbage[..], |_| seen += 1).is_err());

        // A frame that claims more than the limit is refused before it is read.
        let huge = (MAX_FRAME_BYTES as u32 + 1).to_be_bytes();
        let refused = read_reports(&huge[..], |_| seen += 1).expect_err("over the limit");
        assert!(refused.contains("over the limit"), "{refused}");

        // A frame cut short is an error, not a silent end.
        let mut cut = 10_u32.to_be_bytes().to_vec();
        cut.extend_from_slice(&[1, 2, 3]);
        assert!(read_reports(&cut[..], |_| seen += 1).is_err());
        assert_eq!(seen, 0);
    }

    #[test]
    fn the_tcp_listener_takes_connections_on_its_own_port_and_closes_when_dropped() {
        use std::io::Write as _;
        let listener = listen_tcp().expect("listen");
        let port = listener.port;
        // Two links, as after a reconnect; garbage on one does not stop the other.
        let mut first = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        first
            .write_all(&[0, 0, 0, 3, 0xff, 0xff, 0xff])
            .expect("write");
        let second = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect again");
        drop(second);
        assert!(
            listener
                .reports
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_err(),
            "no report was sent"
        );
        drop(listener);
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
            "the port is closed"
        );
    }
}
