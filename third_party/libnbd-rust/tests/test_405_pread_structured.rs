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

mod nbdkit_pattern;
use nbdkit_pattern::PATTERN;

#[test]
fn test_pread_structured() {
    let nbd = libnbd::Handle::new().unwrap();
    nbd.connect_command(&[
        "nbdkit",
        "-s",
        "--exit-with-parent",
        "-v",
        "pattern",
        "size=1M",
    ])
    .unwrap();

    fn f(buf: &[u8], offset: u64, s: u32, err: &mut i32) {
        assert_eq!(*err, 0);
        *err = 42;
        assert_eq!(buf, PATTERN.as_slice());
        assert_eq!(offset, 0);
        assert_eq!(s, libnbd::READ_DATA);
    }

    let mut buf = [0; 512];
    nbd.pread_structured(
        &mut buf,
        0,
        |b, o, s, e| {
            f(b, o, s, e);
            0
        },
        None,
    )
    .unwrap();
    assert_eq!(buf.as_slice(), PATTERN.as_slice());

    nbd.pread_structured(
        &mut buf,
        0,
        |b, o, s, e| {
            f(b, o, s, e);
            0
        },
        Some(libnbd::CmdFlag::DF),
    )
    .unwrap();
    assert_eq!(buf.as_slice(), PATTERN.as_slice());

    let res = nbd.pread_structured(
        &mut buf,
        0,
        |b, o, s, e| {
            f(b, o, s, e);
            -1
        },
        Some(libnbd::CmdFlag::DF),
    );
    assert_eq!(res.unwrap_err().errno(), Some(42));
}
