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
fn test_defaults() {
    let nbd = libnbd::Handle::new().unwrap();

    assert!(nbd.get_export_name().unwrap().is_empty());
    assert!(!nbd.get_full_info().unwrap());
    assert_eq!(nbd.get_tls(), libnbd::Tls::Disable);
    assert!(nbd.get_request_extended_headers());
    assert!(nbd.get_request_structured_replies());
    assert!(nbd.get_request_meta_context().unwrap());
    assert!(nbd.get_request_block_size().unwrap());
    assert!(nbd.get_pread_initialize());
    assert!(nbd.get_handshake_flags().is_all());
    assert!(!nbd.get_opt_mode());
}
