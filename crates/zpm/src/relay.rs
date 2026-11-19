//! The link between a guest without internet access and this computer.
//!
//! Such a guest's network is cut off from everything, this computer
//! included. QEMU then runs one program per connection the guest opens to
//! the app and joins the connection to that program's input and output.
//! [`relay`] is what that program does: it passes both on to a port of
//! 127.0.0.1, where the app listens.

use std::io::{self, Write as _};
use std::net::{Shutdown, TcpStream};

/// Joins this process's input and output to 127.0.0.1:`port` until both
/// sides are done.
pub fn relay(port: u16) -> io::Result<()> {
    let mut to_app = TcpStream::connect(("127.0.0.1", port))?;
    let mut from_app = to_app.try_clone()?;
    let upstream = std::thread::spawn(move || {
        let copied = io::copy(&mut io::stdin().lock(), &mut to_app);
        // The guest is done sending; the app may still answer.
        let _ = to_app.shutdown(Shutdown::Write);
        copied
    });
    let mut out = io::stdout().lock();
    io::copy(&mut from_app, &mut out)?;
    out.flush()?;
    upstream
        .join()
        .map_err(|_| io::Error::other("the relay's reader stopped"))?
        .map(drop)
}
