// nbd client library in userspace
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

use crate::sys;
use crate::{Error, ErrorKind, Result};

/// An NBD client handle.
#[derive(Debug)]
pub struct Handle {
    /// A pointer to the raw handle.
    pub(crate) handle: *mut sys::nbd_handle,
}

impl Handle {
    pub fn new() -> Result<Self> {
        let handle = unsafe { sys::nbd_create() };
        if handle.is_null() {
            Err(unsafe { Error::Fatal(ErrorKind::get_error().into()) })
        } else {
            #[allow(unused_mut)]
            let mut nbd = Handle { handle };
            #[cfg(feature = "log")]
            {
                nbd.set_debug_callback(|func_name, msg| {
                    log::debug!(
                        target: String::from_utf8_lossy(func_name).as_ref(),
                        "{}",
                        String::from_utf8_lossy(msg)
                    );
                    0
                })?;
                nbd.set_debug(true)?;
            }
            Ok(nbd)
        }
    }

    /// Get the underlying C pointer to the handle.
    pub(crate) fn raw_handle(&self) -> *mut sys::nbd_handle {
        self.handle
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { sys::nbd_close(self.handle) }
    }
}

unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
