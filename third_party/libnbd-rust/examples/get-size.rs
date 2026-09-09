//! This example shows how to connect to an NBD
//! server and read the size of the disk.
//!
//! You can test it with nbdkit like this:
//!
//!     nbdkit -U - memory 1M \
//!       --run 'cargo run --example get-size -- $unixsocket'
//! Or with a URI:
//!     nbdkit -U - memory 1M \
//!       --run 'cargo run --example get-size -- "$uri"'
//!
//! Or connect over a URI:
//!     cargo run --example get-size -- nbd://hostname:port

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

    // Read the size in bytes and print it.
    let size = nbd.get_size()?;
    println!("{:?}: size = {size} bytes", socket_or_uri);

    Ok(())
}
