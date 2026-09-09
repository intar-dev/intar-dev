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

//! This module provides facilities for capturing log output and asserting that
//! it does or does not contain certain messages. The primary use of this module
//! is to assert that certain libnbd operations are or are not performed.

#![allow(unused)]

use std::sync::Mutex;

/// Logger that stores all debug messages in a list.
pub struct DebugLogger {
    /// All targets and messages logged. Wrapped in a mutex so that it can be
    /// updated with an imutable reference to self.
    entries: Mutex<Vec<(String, String)>>,
    is_initialized: Mutex<bool>,
}

impl DebugLogger {
    const fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            is_initialized: Mutex::new(false),
        }
    }

    /// Set this logger as the global logger.
    pub fn init(&'static self) {
        let mut is_initialized = self.is_initialized.lock().unwrap();
        if !*is_initialized {
            log::set_logger(self).unwrap();
            log::set_max_level(log::LevelFilter::Debug);
            *is_initialized = true;
        }
    }

    /// Check wether a specific message has been logged.
    pub fn contains(&self, msg: &str) -> bool {
        self.entries.lock().unwrap().iter().any(|(_, x)| x == msg)
    }

    /// Print all logged messages, in no particular order.
    ///
    /// Only for debug purposes. Remember to run cargo test with the `--
    /// --nocapture` arguments. That is, from the rust directory run:
    /// `./../run cargo test -- --nocapture`
    pub fn print_messages(&self) {
        for (target, msg) in self.entries.lock().unwrap().iter() {
            eprintln!("{target}: {msg}");
        }
    }
}

/// A static global `DebugLogger`. Just call `.init()` on this to set it as the
/// global logger.
pub static DEBUG_LOGGER: DebugLogger = DebugLogger::new();

impl log::Log for DebugLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() == log::Level::Debug
    }

    fn log(&self, record: &log::Record<'_>) {
        self.entries
            .lock()
            .unwrap()
            .push((record.target().to_string(), record.args().to_string()));
    }

    fn flush(&self) {}
}
