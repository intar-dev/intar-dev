//! Example usage with nbdkit:
//!     nbdkit -U - memory 100M \
//!       --run 'cargo run --example concurrent-read-write -- $unixsocket'
//! Or connect over a URI:
//!     nbdkit -U - memory 100M \
//!       --run 'cargo run --example concurrent-read-write -- "$uri"'
//!
//! This will read and write randomly over the plugin using multi-conn,
//! multiple threads and multiple requests in flight on each thread.

#![deny(warnings)]
use rand::prelude::*;
use std::env;
use std::sync::Arc;
use tokio::task::JoinSet;

/// Number of simultaneous connections to the NBD server.
///
/// Note that some servers only support a limited number of
/// simultaneous connections, and/or have a configurable thread pool
/// internally, and if you exceed those limits then something will break.
const NR_MULTI_CONN: usize = 8;

/// Number of commands that can be "in flight" at the same time on each
/// connection.  (Therefore the total number of requests in flight may
/// be up to NR_MULTI_CONN * MAX_IN_FLIGHT).
const MAX_IN_FLIGHT: usize = 16;

/// The size of large reads and writes, must be > 512.
const BUFFER_SIZE: usize = 1024;

/// Number of commands we issue (per [task][tokio::task]).
const NR_CYCLES: usize = 32;

/// Statistics gathered during the run.
#[derive(Debug, Default)]
struct Stats {
    /// The total number of requests made.
    requests: usize,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = env::args_os().collect::<Vec<_>>();
    if args.len() != 2 {
        anyhow::bail!("Usage: {:?} socket", args[0]);
    }

    // We begin by making a connection to the server to get the export size
    // and ensure that it supports multiple connections and is writable.
    let nbd = libnbd::Handle::new()?;

    // Check if the user provided a URI or a unix socket.
    let socket_or_uri = args[1].to_str().unwrap();
    if nbd.is_uri(socket_or_uri).unwrap() {
        nbd.connect_uri(socket_or_uri)?;
    } else {
        nbd.connect_unix(socket_or_uri)?;
    }

    let export_size = nbd.get_size()?;
    anyhow::ensure!(
        (BUFFER_SIZE as u64) < export_size,
        "export is {export_size}B, must be larger than {BUFFER_SIZE}B"
    );
    anyhow::ensure!(!nbd.is_read_only()?, "error: this NBD export is read-only");
    anyhow::ensure!(
        nbd.can_multi_conn()?,
        "error: this NBD export does not support multi-conn"
    );
    drop(nbd); // Close the connection.

    // Start the worker tasks, one per connection.
    let mut tasks = JoinSet::new();
    for i in 0..NR_MULTI_CONN {
        tasks.spawn(run_thread(i, socket_or_uri.to_owned(), export_size));
    }

    // Wait for the tasks to complete.
    let mut stats = Stats::default();
    while !tasks.is_empty() {
        let this_stats = tasks.join_next().await.unwrap().unwrap()?;
        stats.requests += this_stats.requests;
    }

    // Make sure the number of requests that were required matches what
    // we expect.
    assert_eq!(stats.requests, NR_MULTI_CONN * NR_CYCLES);

    Ok(())
}

async fn run_thread(
    task_idx: usize,
    socket_or_uri: String,
    export_size: u64,
) -> anyhow::Result<Stats> {
    // Start a new connection to the server.
    // We shall spawn many commands concurrently on different tasks and those
    // futures must be `'static`, hence we wrap the handle in an [Arc].
    let nbd = Arc::new(libnbd::AsyncHandle::new()?);

    // Check if the user provided a URI or a unix socket.
    if nbd.is_uri(socket_or_uri.clone()).unwrap() {
        nbd.connect_uri(socket_or_uri).await?;
    } else {
        nbd.connect_unix(socket_or_uri).await?;
    }

    let mut rng = SmallRng::seed_from_u64(task_idx as u64);

    // Issue commands.
    let mut stats = Stats::default();
    let mut join_set = JoinSet::new();
    while stats.requests < NR_CYCLES || !join_set.is_empty() {
        while stats.requests < NR_CYCLES && join_set.len() < MAX_IN_FLIGHT {
            // If we want to issue another request, do so.  Note that we reuse
            // the same buffer for multiple in-flight requests.  It doesn't
            // matter here because we're just trying to write random stuff,
            // but that would be Very Bad in a real application.
            // Simulate a mix of large and small requests.
            let size = if rng.gen() { BUFFER_SIZE } else { 512 };
            let offset = rng.gen_range(0..export_size - size as u64);

            let mut buf = [0u8; BUFFER_SIZE];
            let nbd = nbd.clone();
            if rng.gen() {
                join_set.spawn(async move { nbd.pread(&mut buf, offset, None).await });
            } else {
                // Fill the buf with random data.
                rng.fill(&mut buf);
                join_set.spawn(async move { nbd.pwrite(&buf, offset, None).await });
            }
            stats.requests += 1;
        }
        join_set.join_next().await.unwrap().unwrap()?;
    }

    Ok(stats)
}
