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

// This module implements an asynchronous handle working on top of the
// [Tokio](https://tokio.rs) runtime. When the handle is created,
// a "polling task" is spawned on the Tokio runtime. The purpose of that
// "polling task" is to call `aio_notify_*` when appropriate. It shares a
// reference to the handle as well as some other things with the handle in the
// [HandleData] struct. The "polling task" is sleeping when no command is in
// flight, but wakes up as soon as any command is issued.
//
// The commands are implemented as
// [`async fn`s](https://doc.rust-lang.org/std/keyword.async.html)
// in async_bindings.rs. When a new command is issued, it registers a
// completion predicate with [Handle::add_command]. That predicate takes a
// reference to the handle and should return [true] iff the command is complete.
// Whenever some work is performed in the polling task, the completion
// predicates for all pending commands are called.

use crate::sys;
use crate::Handle;
use crate::{Error, FatalErrorKind, Result};
use crate::{AIO_DIRECTION_BOTH, AIO_DIRECTION_READ, AIO_DIRECTION_WRITE};
use mio::unix::SourceFd;
use mio::{Events, Interest as MioInterest, Poll, Token};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{unix::AsyncFd, Interest, Ready as IoReady};
use tokio::sync::Notify;
use tokio::task;

/// A custom result type with a shared [crate::Error] as default error type.
pub type SharedResult<T, E = Arc<Error>> = Result<T, E>;

/// An NBD handle using Rust's `async` functionality on top of the
/// [Tokio](https://docs.rs/tokio/) runtime.
pub struct AsyncHandle {
    /// Data shared both by this struct and the polling task.
    pub(crate) data: Arc<HandleData>,

    /// A task which sole purpose is to poll the NBD handle.
    polling_task: tokio::task::AbortHandle,
}

pub(crate) struct HandleData {
    /// The underlying handle.
    pub handle: Handle,

    /// A list of all pending commands.
    ///
    /// For every pending command (commands in flight), a predicate will be
    /// stored in this list. Whenever some progress is made on the file
    /// descriptor, the predicate is called with a reference to the handle
    /// and a reference to the result of that call to `aio_notify_*`.
    /// Iff the predicate returns [true], the command is considered completed
    /// and removed from this list.
    ///
    /// If the polling task dies for some reason, this [SharedResult] will be
    /// set to some error.
    pub pending_commands: Mutex<
        SharedResult<
            Vec<
                Box<
                    dyn FnMut(&Handle, &SharedResult<()>) -> bool
                        + Send
                        + Sync
                        + 'static,
                >,
            >,
        >,
    >,

    /// A notifier used by commands to notify the polling task when a new
    /// asynchronous command is issued.
    pub new_command: Notify,
}

impl AsyncHandle {
    pub fn new() -> Result<Self> {
        let handle_data = Arc::new(HandleData {
            handle: Handle::new()?,
            pending_commands: Mutex::new(Ok(Vec::new())),
            new_command: Notify::new(),
        });

        let handle_data_2 = handle_data.clone();
        let polling_task = task::spawn(async move {
            // The polling task should never finish without an error. If the
            // handle is dropped, the task is aborted so it won't return in
            // that case either.
            let Err(err) = polling_task(&handle_data_2).await else {
                unreachable!()
            };
            let err = Arc::new(Error::Fatal(err));
            // Call the completion predicates for all pending commands with the
            // error.
            let mut pending_cmds =
                handle_data_2.pending_commands.lock().unwrap();
            let res = Err(err);
            for f in pending_cmds.as_mut().unwrap().iter_mut() {
                f(&handle_data_2.handle, &res);
            }
            *pending_cmds = Err(res.unwrap_err());
        })
        .abort_handle();
        Ok(Self {
            data: handle_data,
            polling_task,
        })
    }

    /// Get the underlying C pointer to the handle.
    pub(crate) fn raw_handle(&self) -> *mut sys::nbd_handle {
        self.data.handle.raw_handle()
    }

    /// Call this method when a new command is issued. It takes as argument a
    /// predicate which should return [true] iff the command is completed.
    pub(crate) fn add_command(
        &self,
        mut completion_predicate: impl FnMut(&Handle, &SharedResult<()>) -> bool
            + Send
            + Sync
            + 'static,
    ) -> SharedResult<()> {
        if !completion_predicate(&self.data.handle, &Ok(())) {
            let mut pending_cmds_lock =
                self.data.pending_commands.lock().unwrap();
            pending_cmds_lock
                .as_mut()
                .map_err(|e| e.clone())?
                .push(Box::new(completion_predicate));
            self.data.new_command.notify_one();
        }
        Ok(())
    }
}

impl Drop for AsyncHandle {
    fn drop(&mut self) {
        self.polling_task.abort();
    }
}

/// Get the read/write direction that the handle wants on the file descriptor.
fn get_fd_interest(handle: &Handle) -> Option<Interest> {
    match handle.aio_get_direction() {
        0 => None,
        AIO_DIRECTION_READ => Some(Interest::READABLE),
        AIO_DIRECTION_WRITE => Some(Interest::WRITABLE),
        AIO_DIRECTION_BOTH => Some(Interest::READABLE | Interest::WRITABLE),
        _ => unreachable!(),
    }
}

/// A task that will run as long as the handle is alive. It will poll the
/// file descriptor when new data is available.
async fn polling_task(handle_data: &HandleData) -> Result<(), FatalErrorKind> {
    let HandleData {
        handle,
        pending_commands,
        new_command,
    } = handle_data;
    let fd = handle.aio_get_fd().map_err(Error::to_fatal)?;
    let tokio_fd = AsyncFd::new(fd)?;
    let mut events = Events::with_capacity(1);
    let mut poll = Poll::new()?;

    // The following loop does approximately the following things:
    //
    // 1. Determine what Libnbd wants to do next on the file descriptor,
    //    (read/write/both/none), and store that in [fd_interest].
    // 2. Wait for either:
    //   a) That interest to be available on the file descriptor in which case:
    //     I.   Call the correct `aio_notify_*` method.
    //     II.  Execute step 1.
    //     III. Send the result of the call to `aio_notify_*` on
    //          [result_channel] to notify pending commands that some progress
    //          has been made.
    //     IV.  Resume execution from step 2.
    //   b) A notification was received on [new_command] signaling that a new
    //      command was registered and that the interest on the file descriptor
    //      might have changed. Resume execution from step 1.
    loop {
        let Some(fd_interest) = get_fd_interest(handle) else {
            // The handle does not wait for any data of the file descriptor,
            // so we wait until some command is issued.
            new_command.notified().await;
            continue;
        };

        if pending_commands
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_empty()
        {
            // No command is pending so there is no point to do anything.
            new_command.notified().await;
            continue;
        }

        // Wait for the requested interest to be available on the fd.
        let mut ready_guard = tokio_fd.ready(fd_interest).await?;
        let readiness = ready_guard.ready();
        let res = if readiness.is_readable() && fd_interest.is_readable() {
            handle.aio_notify_read()
        } else if readiness.is_writable() && fd_interest.is_writable() {
            handle.aio_notify_write()
        } else {
            continue;
        };
        let res = match res {
            Ok(()) => Ok(()),
            Err(e @ Error::Recoverable(_)) => Err(Arc::new(e)),
            Err(Error::Fatal(e)) => return Err(e),
        };

        // Call the completion predicates of all pending commands.
        let mut pending_cmds_lock = pending_commands.lock().unwrap();
        let pending_cmds = pending_cmds_lock.as_mut().unwrap();
        let mut i = 0;
        while i < pending_cmds.len() {
            if (pending_cmds[i])(handle, &res) {
                let _ = pending_cmds.swap_remove(i);
            } else {
                i += 1;
            }
        }
        drop(pending_cmds_lock);

        // Use mio poll to check the current read/write availability on the fd.
        // This is needed because Tokio supports only edge-triggered
        // notifications but Libnbd requires level-triggered notifications.
        // Setting timeout to 0 means that it will return immediately.
        // mio states that it is OS-dependent on whether a single event
        // can be both readable and writable, but we survive just fine
        // if we only see one direction even when both are available.
        poll.registry().register(
            &mut SourceFd(&fd),
            Token(0),
            MioInterest::READABLE | MioInterest::WRITABLE,
        )?;
        match poll.poll(&mut events, Some(Duration::ZERO)) {
            Ok(_) => {
                for event in &events {
                    if !event.is_readable() {
                        ready_guard.clear_ready_matching(IoReady::READABLE);
                    }
                    if !event.is_writable() {
                        ready_guard.clear_ready_matching(IoReady::WRITABLE);
                    }
                }
            }
            Err(_) => {
                ready_guard.clear_ready_matching(IoReady::READABLE);
                ready_guard.clear_ready_matching(IoReady::WRITABLE);
            }
        };
        ready_guard.retain_ready();
        poll.registry().deregister(&mut SourceFd(&fd))?;
    }
}
