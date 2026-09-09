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

use std::ffi::c_void;

/// Take a C pointer to some rust data of type `T` on the heap and drop it.
pub unsafe extern "C" fn drop_data<T>(data: *mut c_void) {
    drop(Box::from_raw(data as *mut T))
}

/// Turn a [FnOnce] (with a single `&mut` argument) to a [FnMut]
/// which panics on the second invocation.
pub fn fn_once_to_fn_mut<T, U>(
    f: impl FnOnce(&mut T) -> U,
) -> impl FnMut(&mut T) -> U {
    let mut f = Some(f);
    move |x| (f.take().unwrap())(x)
}
