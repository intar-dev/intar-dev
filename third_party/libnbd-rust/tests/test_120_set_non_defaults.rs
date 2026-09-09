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
fn test_set_non_defaults() {
    let nbd = libnbd::Handle::new().unwrap();

    nbd.set_export_name("name").unwrap();
    assert_eq!(nbd.get_export_name().unwrap(), b"name");

    nbd.set_full_info(true).unwrap();
    assert!(nbd.get_full_info().unwrap());

    if nbd.supports_tls() {
        nbd.set_tls(libnbd::Tls::Allow).unwrap();
        assert_eq!(nbd.get_tls(), libnbd::Tls::Allow);
    }

    nbd.set_request_extended_headers(false).unwrap();
    assert!(!nbd.get_request_extended_headers());

    nbd.set_request_structured_replies(false).unwrap();
    assert!(!nbd.get_request_structured_replies());

    nbd.set_request_meta_context(false).unwrap();
    assert!(!nbd.get_request_meta_context().unwrap());

    nbd.set_request_block_size(false).unwrap();
    assert!(!nbd.get_request_block_size().unwrap());

    nbd.set_pread_initialize(false).unwrap();
    assert!(!nbd.get_pread_initialize());

    nbd.set_handshake_flags(libnbd::HandshakeFlag::empty())
        .unwrap();
    assert!(nbd.get_handshake_flags().is_empty());

    nbd.set_opt_mode(true).unwrap();
    assert!(nbd.get_opt_mode());
}
