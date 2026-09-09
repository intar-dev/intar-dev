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
use errno::Errno;
use std::ffi::{CStr, NulError};
use std::io;

/// A general error type for libnbd.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Non fatal errors used when a command failed but the handle is not dead.
    ///
    /// If such an error is returned, it may still makes sense to call further
    /// commands on the handle.
    #[error(transparent)]
    Recoverable(ErrorKind),
    /// A fatal error. After such an error, the handle is dead and there is no
    /// point in issuing further commands.
    #[error("Fatal: NBD handle is dead: {0}")]
    Fatal(FatalErrorKind),
}

/// An error kind for a Libnbd related error.
#[derive(Debug, thiserror::Error)]
pub enum ErrorKind {
    #[error("Errno: {errno}: {description}")]
    WithErrno { errno: Errno, description: String },
    #[error("{description}")]
    WithoutErrno { description: String },
    #[error(transparent)]
    Errno(#[from] Errno),
}

/// The kind of a fatal error.
#[derive(Debug, thiserror::Error)]
pub enum FatalErrorKind {
    /// A Libnbd related error.
    #[error(transparent)]
    Libnbd(#[from] ErrorKind),
    /// Some other io error.
    #[error(transparent)]
    Io(#[from] io::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl ErrorKind {
    /// Retrieve the last error from libnbd in the current thread.
    pub(crate) unsafe fn get_error() -> Self {
        let description = CStr::from_ptr(sys::nbd_get_error())
            .to_string_lossy()
            .to_string();
        match sys::nbd_get_errno() {
            0 => Self::WithoutErrno { description },
            e => Self::WithErrno {
                description,
                errno: Errno(e),
            },
        }
    }

    /// Create an error from an errno value without any additional description.
    pub fn from_errno(val: i32) -> Self {
        Self::Errno(Errno(val))
    }

    /// Get the errno value if any.
    pub fn errno(&self) -> Option<i32> {
        match self {
            Self::WithErrno {
                errno: Errno(x), ..
            }
            | Self::Errno(Errno(x)) => Some(*x),
            Self::WithoutErrno { .. } => None,
        }
    }
}

impl Error {
    /// Retrieve the last error from libnbd in the current thread and check if
    /// the handle is dead to determine if the error is fatal or not.
    pub(crate) unsafe fn get_error(handle: *mut sys::nbd_handle) -> Self {
        let kind = ErrorKind::get_error();
        if sys::nbd_aio_is_dead(handle) != 0 {
            Self::Fatal(FatalErrorKind::Libnbd(kind))
        } else {
            Self::Recoverable(kind)
        }
    }

    /// Get the errno value if any.
    pub fn errno(&self) -> Option<i32> {
        match self {
            Self::Recoverable(e) | Self::Fatal(FatalErrorKind::Libnbd(e)) => {
                e.errno()
            }
            Self::Fatal(FatalErrorKind::Io(e)) => e.raw_os_error(),
        }
    }

    /// Check if this is a fatal error.
    pub fn is_fatal(&self) -> bool {
        match self {
            Self::Fatal(_) => true,
            Self::Recoverable(_) => false,
        }
    }

    /// Check if this is a recoverable error.
    pub fn is_recoverable(&self) -> bool {
        match self {
            Self::Recoverable(_) => true,
            Self::Fatal(_) => false,
        }
    }

    /// Turn this error to a [FatalErrorKind].
    pub fn to_fatal(self) -> FatalErrorKind {
        match self {
            Self::Fatal(e) => e,
            Self::Recoverable(e) => FatalErrorKind::Libnbd(e),
        }
    }
}

impl From<io::Error> for Error {
    fn from(err: io::Error) -> Self {
        Self::Fatal(err.into())
    }
}

impl From<String> for Error {
    fn from(description: String) -> Self {
        Self::Recoverable(ErrorKind::WithoutErrno { description })
    }
}

impl From<NulError> for Error {
    fn from(e: NulError) -> Self {
        e.to_string().into()
    }
}
