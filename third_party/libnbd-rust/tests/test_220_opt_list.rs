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

use std::env;
use std::os::unix::ffi::OsStringExt as _;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

/// Test different types of connections.
struct ConnTester {
    script_path: String,
}

impl ConnTester {
    fn new() -> Self {
        let srcdir = env::var("srcdir").unwrap();
        let srcdir = Path::new(&srcdir);
        let script_path = srcdir.join("../tests/opt-list.sh");
        let script_path = String::from_utf8(script_path.into_os_string().into_vec()).unwrap();
        Self { script_path }
    }

    fn connect(&self, mode: u8, expected_exports: &[&str]) -> libnbd::Result<()> {
        let nbd = libnbd::Handle::new().unwrap();
        nbd.set_opt_mode(true).unwrap();
        nbd.connect_command(&[
            "nbdkit",
            "-s",
            "--exit-with-parent",
            "-v",
            "sh",
            &self.script_path,
            &format!("mode={mode}"),
        ])
        .unwrap();

        // Collect all exports in this list.
        let exports = Arc::new(Mutex::new(Vec::new()));
        let exports_clone = exports.clone();
        let count = nbd.opt_list(move |name, _| {
            exports_clone
                .lock()
                .unwrap()
                .push(String::from_utf8(name.to_owned()).unwrap());
            0
        })?;
        let exports = Arc::try_unwrap(exports).unwrap().into_inner().unwrap();
        assert_eq!(exports.len(), count as usize);
        assert_eq!(exports.len(), expected_exports.len());
        for (export, &expected) in exports.iter().zip(expected_exports) {
            assert_eq!(export, expected);
        }
        Ok(())
    }
}

#[test]
fn test_opt_list() {
    let conn_tester = ConnTester::new();
    assert!(conn_tester.connect(0, &[]).is_err());
    assert!(conn_tester.connect(1, &["a", "b"]).is_ok());
    assert!(conn_tester.connect(2, &[]).is_ok());
    assert!(conn_tester.connect(3, &["a"]).is_ok());
}
