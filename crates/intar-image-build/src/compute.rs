use std::sync::{Condvar, Mutex};

// Each stage uses up to four CPU threads. Keep the two stages within the
// existing eight-thread builder budget, including CLI calls in this process.
static AVAILABLE: Mutex<usize> = Mutex::new(2);
static CHANGED: Condvar = Condvar::new();

pub(crate) struct ComputePermit;

pub(crate) fn acquire() -> ComputePermit {
    let mut available = AVAILABLE.lock().unwrap_or_else(|error| error.into_inner());
    while *available == 0 {
        available = CHANGED
            .wait(available)
            .unwrap_or_else(|error| error.into_inner());
    }
    *available -= 1;
    ComputePermit
}

impl Drop for ComputePermit {
    fn drop(&mut self) {
        *AVAILABLE.lock().unwrap_or_else(|error| error.into_inner()) += 1;
        CHANGED.notify_one();
    }
}
