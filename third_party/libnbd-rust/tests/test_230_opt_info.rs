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

use libnbd::CONTEXT_BASE_ALLOCATION;
use std::env;
use std::path::Path;

#[test]
fn test_opt_info() {
    let srcdir = env::var("srcdir").unwrap();
    let srcdir = Path::new(&srcdir);
    let script_path = srcdir.join("../tests/opt-info.sh");
    let script_path = script_path.to_str().unwrap();

    let nbd = libnbd::Handle::new().unwrap();
    nbd.set_opt_mode(true).unwrap();
    nbd.connect_command(&[
        "nbdkit",
        "-s",
        "--exit-with-parent",
        "-v",
        "sh",
        script_path,
    ])
    .unwrap();
    nbd.add_meta_context(CONTEXT_BASE_ALLOCATION).unwrap();

    // No size, flags, or meta-contexts yet
    assert!(nbd.get_size().is_err());
    assert!(nbd.is_read_only().is_err());
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).is_err());

    // info with no prior name gets info on ""
    assert!(nbd.opt_info().is_ok());
    assert_eq!(nbd.get_size().unwrap(), 0);
    assert!(nbd.is_read_only().unwrap());
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());

    // changing export wipes out prior info
    nbd.set_export_name("b").unwrap();
    assert!(nbd.get_size().is_err());
    assert!(nbd.is_read_only().is_err());
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).is_err());

    // info on something not present fails
    nbd.set_export_name("a").unwrap();
    assert!(nbd.opt_info().is_err());

    // info for a different export, with automatic meta_context disabled
    nbd.set_export_name("b").unwrap();
    nbd.set_request_meta_context(false).unwrap();
    nbd.opt_info().unwrap();
    // idempotent name change is no-op
    nbd.set_export_name("b").unwrap();
    assert_eq!(nbd.get_size().unwrap(), 1);
    assert!(!nbd.is_read_only().unwrap());
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).is_err());
    nbd.set_request_meta_context(true).unwrap();

    // go on something not present
    nbd.set_export_name("a").unwrap();
    assert!(nbd.opt_go().is_err());
    assert!(nbd.get_size().is_err());
    assert!(nbd.is_read_only().is_err());
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).is_err());

    // go on a valid export
    nbd.set_export_name("good").unwrap();
    nbd.opt_go().unwrap();
    assert_eq!(nbd.get_size().unwrap(), 4);
    assert!(nbd.is_read_only().unwrap());
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());

    // now info is no longer valid, but does not wipe data
    assert!(nbd.set_export_name("a").is_err());
    assert_eq!(nbd.get_export_name().unwrap(), b"good");
    assert!(nbd.opt_info().is_err());
    assert_eq!(nbd.get_size().unwrap(), 4);
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());
    nbd.shutdown(None).unwrap();

    // Another connection. This time, check that SET_META triggered by opt_info
    // persists through nbd_opt_go with set_request_meta_context disabled.
    let nbd = libnbd::Handle::new().unwrap();
    nbd.set_opt_mode(true).unwrap();
    nbd.connect_command(&[
        "nbdkit",
        "-s",
        "--exit-with-parent",
        "-v",
        "sh",
        &script_path,
    ])
    .unwrap();
    nbd.add_meta_context("x-unexpected:bogus").unwrap();
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).is_err());
    nbd.opt_info().unwrap();
    assert!(!nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());
    nbd.set_request_meta_context(false).unwrap();
    // Adding to the request list now won't matter
    nbd.add_meta_context(CONTEXT_BASE_ALLOCATION).unwrap();
    nbd.opt_go().unwrap();
    assert!(!nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());
}
