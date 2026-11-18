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
}
