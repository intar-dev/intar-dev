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
use std::path::Path;
use std::sync::{Arc, Mutex};

async fn block_status_get_entries(
    nbd: &libnbd::AsyncHandle,
    count: u64,
    offset: u64,
    flags: Option<libnbd::CmdFlag>,
) -> Vec<u32> {
    let entries = Arc::new(Mutex::new(None));
    let entries_clone = entries.clone();
    nbd.block_status(
        count,
        offset,
        move |metacontext, _, entries, err| {
            assert_eq!(*err, 0);
            if metacontext == libnbd::CONTEXT_BASE_ALLOCATION {
                *entries_clone.lock().unwrap() = Some(entries.to_vec());
            }
            0
        },
        flags,
    )
    .await
    .unwrap();
    Arc::try_unwrap(entries)
        .unwrap()
        .into_inner()
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn test_async_block_status() {
    let srcdir = env::var("srcdir").unwrap();
    let srcdir = Path::new(&srcdir);
    let script_path = srcdir.join("../tests/meta-base-allocation.sh");
    let script_path = script_path.to_str().unwrap();
    let nbd = libnbd::AsyncHandle::new().unwrap();
    nbd.add_meta_context(libnbd::CONTEXT_BASE_ALLOCATION)
        .unwrap();
    nbd.connect_command(&[
        "nbdkit",
        "-s",
        "--exit-with-parent",
        "-v",
        "sh",
        script_path,
    ])
    .await
    .unwrap();

    assert_eq!(
        block_status_get_entries(&nbd, 65536, 0, None)
            .await
            .as_slice(),
        &[8192, 0, 8192, 1, 16384, 3, 16384, 2, 16384, 0,]
    );

    assert_eq!(
        block_status_get_entries(&nbd, 1024, 32256, None)
            .await
            .as_slice(),
        &[512, 3, 16384, 2]
    );

    assert_eq!(
        block_status_get_entries(&nbd, 1024, 32256, Some(libnbd::CmdFlag::REQ_ONE))
            .await
            .as_slice(),
        &[512, 3]
    );
}
