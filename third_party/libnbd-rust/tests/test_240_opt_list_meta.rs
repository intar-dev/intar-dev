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
    /// Whether the meta context "base:alloc" is listed.
    has_alloc: bool,
    /// The number of listed meta contexts.
    count: u32,
}

fn list_meta_ctxs(nbd: &libnbd::Handle) -> libnbd::Result<CtxInfo> {
    let info = Arc::new(Mutex::new(CtxInfo {
        has_alloc: false,
        count: 0,
    }));
    let info_clone = info.clone();
    let replies = nbd.opt_list_meta_context(move |ctx| {
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
fn test_opt_list_meta() {
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
    let info = list_meta_ctxs(&nbd).unwrap();
    assert!(info.count >= 1);
    assert!(info.has_alloc);
    let max = info.count;

    // Second pass: bogus query has no response.
    nbd.add_meta_context("x-nosuch:").unwrap();
    assert_eq!(
        list_meta_ctxs(&nbd).unwrap(),
        CtxInfo {
            count: 0,
            has_alloc: false
        }
    );

    // Third pass: specific query should have one match.
    nbd.add_meta_context("base:allocation").unwrap();
    assert_eq!(nbd.get_nr_meta_contexts().unwrap(), 2);
    assert_eq!(nbd.get_meta_context(1).unwrap(), b"base:allocation");
    assert_eq!(
        list_meta_ctxs(&nbd).unwrap(),
        CtxInfo {
            count: 1,
            has_alloc: true
        }
    );

    // Fourth pass: opt_list_meta_context is stateless, so it should
    // not wipe status learned during opt_info
    assert!(nbd.can_meta_context("base:allocation").is_err());
    assert!(nbd.get_size().is_err());
    nbd.opt_info().unwrap();
    assert_eq!(nbd.get_size().unwrap(), 1048576);
    assert!(nbd.can_meta_context("base:allocation").unwrap());
    nbd.clear_meta_contexts().unwrap();
    nbd.add_meta_context("x-nosuch:").unwrap();
    assert_eq!(
        list_meta_ctxs(&nbd).unwrap(),
        CtxInfo {
            count: 0,
            has_alloc: false
        }
    );
    assert_eq!(nbd.get_size().unwrap(), 1048576);
    assert!(nbd.can_meta_context("base:allocation").unwrap());

    // Final pass: "base:" query should get at least "base:allocation"
    nbd.add_meta_context("base:").unwrap();
    let info = list_meta_ctxs(&nbd).unwrap();
    assert!(info.count >= 1);
    assert!(info.count <= max);
    assert!(info.has_alloc);

    // Repeat but this time without structured replies. Deal gracefully
    // with older servers that don't allow the attempt.
    let nbd = libnbd::Handle::new().unwrap();
    nbd.set_opt_mode(true).unwrap();
    nbd.set_request_structured_replies(false).unwrap();
    nbd.connect_command(&[
        "nbdkit",
        "-s",
        "--exit-with-parent",
        "-v",
        "memory",
        "size=1M",
    ])
    .unwrap();
    let bytes = nbd.stats_bytes_sent();
    if let Ok(info) = list_meta_ctxs(&nbd) {
        assert!(info.count >= 1);
        assert!(info.has_alloc)
    } else {
        assert!(nbd.stats_bytes_sent() > bytes);
        // ignoring failure from old server
    }

    // Now enable structured replies, and a retry should pass.
    assert!(nbd.opt_structured_reply().unwrap());
    let info = list_meta_ctxs(&nbd).unwrap();
    assert!(info.count >= 1);
    assert!(info.has_alloc);
}
