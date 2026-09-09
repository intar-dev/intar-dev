//! This example shows how to connect to an NBD server
//! and fetch and print the first sector (usually the
//! boot sector or partition table or filesystem
//! superblock).
//!
//! You can test it with nbdkit like this:
//!
//!     nbdkit -U - floppy . \
//!       --run 'cargo run --example fetch-first-sector -- $unixsocket'
//! Or with a URI:
//!     nbdkit -U - floppy . \
//!       --run 'cargo run --example fetch-first-sector -- "$uri"'
//!
//! The nbdkit floppy plugin creates an MBR disk so the
//! first sector is the partition table.

use pretty_hex::pretty_hex;
use std::env;

fn main() -> anyhow::Result<()> {
    let nbd = libnbd::Handle::new()?;

    let args = env::args_os().collect::<Vec<_>>();
    if args.len() != 2 {
        anyhow::bail!("Usage: {:?} socket", args[0]);
    }

    // Check if the user provided a URI or a unix socket.
    let socket_or_uri = args[1].to_str().unwrap();
    if nbd.is_uri(socket_or_uri).unwrap() {
        nbd.connect_uri(socket_or_uri)?;
    } else {
        // Connect to the NBD server over a Unix domain socket.
        nbd.connect_unix(socket_or_uri)?;
    }

    // Read the first sector synchronously.
    let mut buf = [0; 512];
    nbd.pread(&mut buf, 0, None)?;

    // Print the sector in hexdump like format.
    print!("{}", pretty_hex(&buf));

    Ok(())
}
