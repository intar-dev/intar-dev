//! A cluster lab's L2 network on one host: QEMU `-netdev stream` clients on
//! one unix socket, each frame a 4-byte big-endian length and the Ethernet
//! frame. The hub learns source MACs, sends unicast to a known port and
//! floods the rest. Only processes that can open the socket join, so it
//! lives in a `0700` directory.

use std::collections::HashMap;
use std::io::{self, Read as _, Write as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// The largest frame a port may send; a longer one ends the port.
const MAX_FRAME: usize = 65_550;

type Mac = [u8; 6];

#[derive(Default)]
struct Ports {
    next: u64,
    /// Each port's write half, by port id.
    writers: HashMap<u64, Arc<Mutex<UnixStream>>>,
    macs: HashMap<Mac, u64>,
}

/// A running hub; dropping it stops it and closes every port.
pub struct LabHub {
    path: PathBuf,
    stop: Arc<AtomicBool>,
    ports: Arc<Mutex<Ports>>,
    accept: Option<JoinHandle<()>>,
}

impl LabHub {
    /// Listen on `path`, which must not exist.
    ///
    /// # Errors
    /// Returns an error when the socket cannot be bound.
    pub fn start(path: &Path) -> io::Result<Self> {
        let listener = UnixListener::bind(path)?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let ports = Arc::new(Mutex::new(Ports::default()));
        let accept = {
            let (stop, ports) = (Arc::clone(&stop), Arc::clone(&ports));
            thread::Builder::new()
                .name("lab-hub".to_owned())
                .spawn(move || accept_loop(&listener, &stop, &ports))?
        };
        Ok(Self {
            path: path.to_owned(),
            stop,
            ports,
            accept: Some(accept),
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for LabHub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
        // Each port's reader ends once its socket is shut down.
        let ports = self.ports.lock().unwrap_or_else(PoisonError::into_inner);
        for writer in ports.writers.values() {
            let writer = writer.lock().unwrap_or_else(PoisonError::into_inner);
            let _ = writer.shutdown(std::net::Shutdown::Both);
        }
        drop(ports);
        let _ = std::fs::remove_file(&self.path);
    }
}

fn accept_loop(listener: &UnixListener, stop: &AtomicBool, ports: &Arc<Mutex<Ports>>) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Err(error) = join(stream, ports) {
                    tracing::warn!(%error, "lab hub: a port could not join");
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                tracing::warn!(%error, "lab hub: accept failed");
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn join(stream: UnixStream, ports: &Arc<Mutex<Ports>>) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let id = {
        let mut locked = ports.lock().unwrap_or_else(PoisonError::into_inner);
        locked.next += 1;
        let id = locked.next;
        locked.writers.insert(id, writer);
        id
    };
    let ports = Arc::clone(ports);
    thread::Builder::new()
        .name(format!("lab-hub-port-{id}"))
        .spawn(move || {
            serve(stream, id, &ports);
            let mut locked = ports.lock().unwrap_or_else(PoisonError::into_inner);
            locked.writers.remove(&id);
            locked.macs.retain(|_, port| *port != id);
        })?;
    Ok(())
}

fn serve(mut stream: UnixStream, id: u64, ports: &Mutex<Ports>) {
    let mut frame = Vec::with_capacity(2048);
    loop {
        let mut length = [0; 4];
        if stream.read_exact(&mut length).is_err() {
            return;
        }
        let length = u32::from_be_bytes(length) as usize;
        if !(12..=MAX_FRAME).contains(&length) {
            return;
        }
        frame.resize(length, 0);
        if stream.read_exact(&mut frame).is_err() {
            return;
        }
        let mut destination = [0; 6];
        let mut source = [0; 6];
        destination.copy_from_slice(&frame[..6]);
        source.copy_from_slice(&frame[6..12]);
        let targets: Vec<_> = {
            let mut locked = ports.lock().unwrap_or_else(PoisonError::into_inner);
            locked.macs.insert(source, id);
            // The group bit marks broadcast and multicast.
            let known = (destination[0] & 1 == 0)
                .then(|| locked.macs.get(&destination).copied())
                .flatten()
                .filter(|port| *port != id);
            locked
                .writers
                .iter()
                .filter(|(port, _)| known.map_or(**port != id, |known| **port == known))
                .map(|(_, writer)| Arc::clone(writer))
                .collect()
        };
        let mut message = Vec::with_capacity(4 + length);
        message.extend_from_slice(&u32::try_from(length).unwrap_or(0).to_be_bytes());
        message.extend_from_slice(&frame);
        for target in targets {
            let mut writer = target.lock().unwrap_or_else(PoisonError::into_inner);
            // A port that cannot take the frame drops it, like a full queue.
            let _ = writer.write_all(&message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(destination: Mac, source: Mac, payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&u32::try_from(12 + payload.len()).unwrap_or(0).to_be_bytes());
        bytes.extend_from_slice(&destination);
        bytes.extend_from_slice(&source);
        bytes.extend_from_slice(payload);
        bytes
    }

    fn received(stream: &mut UnixStream) -> Option<Vec<u8>> {
        let mut length = [0; 4];
        stream.read_exact(&mut length).ok()?;
        let mut body = vec![0; u32::from_be_bytes(length) as usize];
        stream.read_exact(&mut body).ok()?;
        Some(body[12..].to_vec())
    }

    #[test]
    fn floods_unknown_frames_then_switches_learned_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let hub = LabHub::start(&dir.path().join("hub.sock")).expect("hub");
        let connect = || {
            let stream = UnixStream::connect(hub.path()).expect("connect");
            stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .expect("timeout");
            stream
        };
        let (mut a, mut b, mut c) = (connect(), connect(), connect());
        // Let the hub register all three ports.
        thread::sleep(Duration::from_millis(200));
        let (mac_a, mac_b) = ([2, 0, 0, 0, 0, 1], [2, 0, 0, 0, 0, 2]);
        let broadcast = [0xff; 6];

        a.write_all(&frame(broadcast, mac_a, b"hello"))
            .expect("send");
        assert_eq!(received(&mut b).as_deref(), Some(&b"hello"[..]));
        assert_eq!(received(&mut c).as_deref(), Some(&b"hello"[..]));

        b.write_all(&frame(mac_a, mac_b, b"to-a")).expect("send");
        assert_eq!(received(&mut a).as_deref(), Some(&b"to-a"[..]));
        // c is not a's port, so the learned unicast skips it.
        assert_eq!(received(&mut c), None);
        drop(hub);
        assert_eq!(received(&mut a), None);
    }
}
