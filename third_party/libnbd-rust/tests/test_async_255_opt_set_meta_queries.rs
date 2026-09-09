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
use std::sync::{Arc, Mutex};

/// A struct with information about set meta contexts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CtxInfo {
    /// Whether the meta context "base:allocation" is set.
    has_alloc: bool,
    /// The number of set meta contexts.
    count: u32,
}

async fn set_meta_ctxs_queries(
    nbd: &libnbd::AsyncHandle,
    queries: &[impl AsRef<[u8]>],
) -> libnbd::SharedResult<CtxInfo> {
    let info = Arc::new(Mutex::new(CtxInfo {
        has_alloc: false,
        count: 0,
    }));
    let info_clone = info.clone();
    nbd.opt_set_meta_context_queries(queries, move |ctx| {
        let mut info = info_clone.lock().unwrap();
        info.count += 1;
        if ctx == CONTEXT_BASE_ALLOCATION {
            info.has_alloc = true;
        }
        0
    })
    .await?;
    let info = Arc::try_unwrap(info).unwrap().into_inner().unwrap();
    Ok(info)
}

#[tokio::test]
async fn test_async_opt_set_meta_queries() {
    let nbd = libnbd::AsyncHandle::new().unwrap();
    nbd.set_opt_mode(true).unwrap();
    nbd.connect_command(&[
        "nbdkit",
        "-s",
        "--exit-with-parent",
        "-v",
        "memory",
        "size=1M",
    ])
    .await
    .unwrap();

    // nbdkit does not match wildcard for SET, even though it does for LIST
    assert_eq!(
        set_meta_ctxs_queries(&nbd, &["base:"]).await.unwrap(),
        CtxInfo {
            count: 0,
            has_alloc: false
        }
    );
    assert!(!nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());

    // Negotiating with no contexts is not an error, but selects nothing
    // An explicit empty list overrides a non-empty implicit list.
    nbd.add_meta_context(CONTEXT_BASE_ALLOCATION).unwrap();
    assert_eq!(
        set_meta_ctxs_queries(&nbd, &[] as &[&str]).await.unwrap(),
        CtxInfo {
            count: 0,
            has_alloc: false
        }
    );
    assert!(!nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());

    // Request 2 with expectation of 1.
    assert_eq!(
        set_meta_ctxs_queries(
            &nbd,
            &[b"x-nosuch:context".as_slice(), CONTEXT_BASE_ALLOCATION]
        )
        .await
        .unwrap(),
        CtxInfo {
            count: 1,
            has_alloc: true
        }
    );
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());

    // Transition to transmission phase; our last set should remain active
    nbd.set_request_meta_context(false).unwrap();
    nbd.opt_go().await.unwrap();
    assert!(nbd.can_meta_context(CONTEXT_BASE_ALLOCATION).unwrap());
}
