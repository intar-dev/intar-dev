//! This example shows how to run an NBD server
//! (nbdkit) as a subprocess of libnbd.

fn main() -> libnbd::Result<()> {
    // Create the libnbd handle.
    let handle = libnbd::Handle::new()?;

    // Run nbdkit as a subprocess.
    let args = [
        "nbdkit",
        // You must use ‘-s’ (which tells nbdkit to serve
        // a single connection on stdin/stdout).
        "-s",
        // It is recommended to use ‘--exit-with-parent’
        // to ensure nbdkit is always cleaned up even
        // if the main program crashes.
        "--exit-with-parent",
        // Use this to enable nbdkit debugging.
        "-v",
        // The nbdkit plugin name - this is a RAM disk.
        "memory",
        "size=1M",
    ];
    handle.connect_command(&args)?;

    // Write some random data to the first sector.
    let wbuf: Vec<u8> = (0..512).into_iter().map(|i| (i % 13) as u8).collect();
    handle.pwrite(&wbuf, 0, None)?;

    // Read the first sector back.
    let mut rbuf = [0; 512];
    handle.pread(&mut rbuf, 0, None)?;

    // What was read must be exactly the same as what was written.
    assert_eq!(wbuf.as_slice(), rbuf.as_slice());

    Ok(())
}
