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

use std::sync::Arc;
use std::sync::Mutex;

/// A struct with information about listed meta contexts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CtxInfo {
    /// Whether the meta context "base:allocation" is listed.
    has_alloc: bool,
    /// The number of listed meta contexts.
    count: u32,
}

fn list_meta_ctxs(nbd: &libnbd::Handle, queries: &[&[u8]]) -> libnbd::Result<CtxInfo> {
    let info = Arc::new(Mutex::new(CtxInfo {
        has_alloc: false,
        count: 0,
    }));
    let info_clone = info.clone();
    let replies = nbd.opt_list_meta_context_queries(queries, move |ctx| {
        let mut info = info_clone.lock().unwrap();
        info.count += 1;
        if ctx == libnbd::CONTEXT_BASE_ALLOCATION {
            info.has_alloc = true;
        }
        0
    })?;
    let info = Arc::try_unwrap(info).unwrap().into_inner().unwrap();
    assert_eq!(info.count, replies);
    Ok(info)
}

#[test]
fn test_opt_list_meta_queries() {
    let nbd = libnbd::Handle::new().unwrap();
    nbd.set_opt_mode(true).unwrap();
    nbd.connect_command(&[
        "nbdkit",
        "-s",
        "--exit-with-parent",
        "-v",
        "memory",
        "size=1M",
    ])
    .unwrap();

    // First pass: empty query should give at least "base:allocation".
    nbd.add_meta_context("x-nosuch:").unwrap();
    let info = list_meta_ctxs(&nbd, &[]).unwrap();
    assert!(info.count >= 1);
    assert!(info.has_alloc);

    // Second pass: bogus query has no response.
    nbd.clear_meta_contexts().unwrap();
    assert_eq!(
        list_meta_ctxs(&nbd, &[b"x-nosuch:"]).unwrap(),
        CtxInfo {
            count: 0,
            has_alloc: false
        }
    );

    // Third pass: specific query should have one match.
    assert_eq!(
        list_meta_ctxs(&nbd, &[b"x-nosuch:", libnbd::CONTEXT_BASE_ALLOCATION]).unwrap(),
        CtxInfo {
            count: 1,
            has_alloc: true
        }
    );
}
