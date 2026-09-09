// libnbd Rust test case
// Copyright Tage Johansson
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA

#![deny(warnings)]

#[test]
fn test_stats() {
    let nbd = libnbd::Handle::new().unwrap();

    // Pre-connection, stats start out at 0
    assert_eq!(nbd.stats_bytes_sent(), 0);
    assert_eq!(nbd.stats_chunks_sent(), 0);
    assert_eq!(nbd.stats_bytes_received(), 0);
    assert_eq!(nbd.stats_chunks_received(), 0);

    // Connection performs handshaking, which increments stats.
    // The number of bytes/chunks here may grow over time as more features get
    // automatically negotiated, so merely check that they are non-zero.
    nbd.connect_command(&["nbdkit", "-s", "--exit-with-parent", "-v", "null"])
        .unwrap();

    let bs1 = nbd.stats_bytes_sent();
    let cs1 = nbd.stats_chunks_sent();
    let br1 = nbd.stats_bytes_received();
    let cr1 = nbd.stats_chunks_received();
    assert!(cs1 > 0);
    assert!(bs1 > cs1);
    assert!(cr1 > 0);
    assert!(br1 > cr1);

    // A flush command should be one chunk out, one chunk back (even if
    // structured replies are in use)
    nbd.flush(None).unwrap();
    let bs2 = nbd.stats_bytes_sent();
    let cs2 = nbd.stats_chunks_sent();
    let br2 = nbd.stats_bytes_received();
    let cr2 = nbd.stats_chunks_received();
    assert_eq!(bs2, bs1 + 28);
    assert_eq!(cs2, cs1 + 1);
    assert_eq!(br2, br1 + 16); // assumes nbdkit uses simple reply
    assert_eq!(cr2, cr1 + 1);

    // Stats are still readable after the connection closes; we don't know if
    // the server sent reply bytes to our NBD_CMD_DISC, so don't insist on it.
    nbd.shutdown(None).unwrap();
    let bs3 = nbd.stats_bytes_sent();
    let cs3 = nbd.stats_chunks_sent();
    let br3 = nbd.stats_bytes_received();
    let cr3 = nbd.stats_chunks_received();
    assert!(bs3 > bs2);
    assert_eq!(cs3, cs2 + 1);
    assert!(br3 >= br2);
    assert!(cr3 == cr2 || cr3 == cr2 + 1);
}
