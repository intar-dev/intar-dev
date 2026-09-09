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
use std::sync::Arc;
use std::sync::Mutex;

/// A struct with information about set meta contexts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CtxInfo {
    /// Whether the meta context "base:allocation" is set.
    has_alloc: bool,
    /// The number of set meta contexts.
    count: u32,
}

fn set_meta_ctxs(nbd: &libnbd::Handle) -> libnbd::Result<CtxInfo> {
    let info = Arc::new(Mutex::new(CtxInfo {
        has_alloc: false,
        count: 0,
    }));
    let info_clone = info.clone();
    let replies = nbd.opt_set_meta_context(move |ctx| {
        let mut info = info_clone.lock().unwrap();
        info.count += 1;
        if ctx == CONTEXT_BASE_ALLOCATION {
            info.has_alloc = true;
        }
        0
    })?;
    let info = Arc::try_unwrap(info).unwrap().into_inner().unwrap();
    assert_eq!(info.count, replies);
    Ok(info)
}

#[test]
fn test_opt_set_meta() {
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

    // No contexts negotiated yet; can_meta should be error if any requested
    assert!(!nbd.get_structured_replies_negotiated().unwrap());
    assert!(!nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());
    nbd.add_meta_context(CONTEXT_BASE_ALLOCATION).unwrap();
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).is_err());

    // SET cannot succeed until SR is negotiated.
    assert!(nbd.opt_structured_reply().unwrap());
    assert!(nbd.get_structured_replies_negotiated().unwrap());
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).is_err());

    // nbdkit does not match wildcard for SET, even though it does for LIST
    nbd.clear_meta_contexts().unwrap();
    nbd.add_meta_context("base:").unwrap();
    assert_eq!(
        set_meta_ctxs(&nbd).unwrap(),
        CtxInfo {
            count: 0,
            has_alloc: false
        }
    );
    assert!(!nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());

    // Negotiating with no contexts is not an error, but selects nothing
    nbd.clear_meta_contexts().unwrap();
    assert_eq!(
        set_meta_ctxs(&nbd).unwrap(),
        CtxInfo {
            count: 0,
            has_alloc: false
        }
    );

    // Request 2 with expectation of 1; with set_request_meta_context off
    nbd.add_meta_context("x-nosuch:context").unwrap();
    nbd.add_meta_context(CONTEXT_BASE_ALLOCATION).unwrap();
    nbd.set_request_meta_context(false).unwrap();
    assert_eq!(
        set_meta_ctxs(&nbd).unwrap(),
        CtxInfo {
            count: 1,
            has_alloc: true
        }
    );
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());

    // Transition to transmission phase; our last set should remain active
    nbd.clear_meta_contexts().unwrap();
    nbd.add_meta_context("x-nosuch:context").unwrap();
    nbd.opt_go().unwrap();
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());

    // Now too late to set; but should not lose earlier state
    assert!(set_meta_ctxs(&nbd).is_err());
    assert_eq!(nbd.get_size().unwrap(), 1048576);
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());
}
