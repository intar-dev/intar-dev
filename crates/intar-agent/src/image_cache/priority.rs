use super::*;

use std::sync::atomic::{AtomicUsize, Ordering};

/// The boot priority of one agent process.
///
/// A counter holds the number of live boot-critical windows and a `Notify`
/// wakes the parked background work when the counter reaches zero. The state
/// is an instance, so a test builds its own and parallel tests cannot see each
/// other's counter.
pub(crate) struct BootPriority {
    critical: AtomicUsize,
    idle: Notify,
}

impl Default for BootPriority {
    fn default() -> Self {
        Self::new()
    }
}

impl BootPriority {
    pub(crate) fn new() -> Self {
        Self {
            critical: AtomicUsize::new(0),
            idle: Notify::new(),
        }
    }

    /// Raise the counter for the lifetime of the returned guard.
    pub(crate) fn begin(self: &Arc<Self>) -> BootCriticalGuard {
        self.critical.fetch_add(1, Ordering::AcqRel);
        BootCriticalGuard {
            priority: Arc::clone(self),
        }
    }

    /// One atomic load. The launch path uses this to stay cheap.
    pub(crate) fn is_critical(&self) -> bool {
        self.critical.load(Ordering::Acquire) > 0
    }

    /// Wait until no boot-critical window is live.
    ///
    /// Only background work calls this, and only at a block boundary. The
    /// waiter registers its notification with `enable` before it reads the
    /// counter, so a release that lands between the registration and the read,
    /// or between the read and the wait, cannot be lost. `notify_waiters` in
    /// `Drop` wakes every registered waiter, so one boot cannot starve another
    /// background reader.
    pub(crate) async fn wait_idle(&self) {
        self.wait_idle_hooked(|| {}, || {}).await;
    }

    /// The same wait with hooks on both sides of the counter read. The hooks
    /// exist for a deterministic test of the two notify windows.
    async fn wait_idle_hooked<A: FnMut(), B: FnMut()>(
        &self,
        mut after_registration: A,
        mut before_wait: B,
    ) {
        loop {
            let notified = self.idle.notified();
            tokio::pin!(notified);
            // Register before the counter read. `Notify::notify_waiters` only
            // wakes waiters that are registered at the time of the call.
            notified.as_mut().enable();
            after_registration();
            if !self.is_critical() {
                return;
            }
            before_wait();
            notified.await;
        }
    }
}

/// A live boot-critical window, such as VM create, disk preparation, or boot.
///
/// Background cache work parks at its next block boundary while a guard is
/// alive. The guard holds no lock and no permit, so `Drop` is one decrement
/// and, when the last window closes, one wake of every waiter.
pub(crate) struct BootCriticalGuard {
    priority: Arc<BootPriority>,
}

impl Drop for BootCriticalGuard {
    fn drop(&mut self) {
        if self.priority.critical.fetch_sub(1, Ordering::Release) == 1 {
            self.priority.idle.notify_waiters();
        }
    }
}

static VM_BOOT_PRIORITY: OnceLock<Arc<BootPriority>> = OnceLock::new();

pub(crate) fn vm_boot_priority() -> &'static Arc<BootPriority> {
    VM_BOOT_PRIORITY.get_or_init(|| Arc::new(BootPriority::new()))
}

/// Mark the start of a boot-critical window for the lifetime of the guard.
pub(crate) fn begin_vm_boot_critical() -> BootCriticalGuard {
    vm_boot_priority().begin()
}

/// Cheap check for a background worker. One atomic load, no lock.
pub(crate) fn vm_boot_critical() -> bool {
    vm_boot_priority().is_critical()
}

/// Park background work until no boot-critical window is live.
///
/// Foreground work never calls this. A learner launch, a launch-time hash
/// check, or a guest disk verification at VM create is itself inside the
/// window, so waiting here would deadlock it against its own guard.
pub(crate) async fn wait_for_vm_boot_idle() {
    vm_boot_priority().wait_idle().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_live_guard_parks_background_work_until_the_last_drop() {
        let priority = Arc::new(BootPriority::new());
        let guard = priority.begin();
        assert!(priority.is_critical());

        let waiter = priority.wait_idle();
        tokio::pin!(waiter);
        assert!(
            futures_util::poll!(waiter.as_mut()).is_pending(),
            "a live window must park the waiter"
        );

        drop(guard);
        assert!(!priority.is_critical());
        waiter.await;
    }

    #[tokio::test]
    async fn nested_guards_keep_the_window_open_until_the_last_drop() {
        let priority = Arc::new(BootPriority::new());
        let outer = priority.begin();
        let inner = priority.begin();

        drop(inner);
        assert!(priority.is_critical());
        drop(outer);
        assert!(!priority.is_critical());
    }

    #[tokio::test]
    async fn a_release_between_registration_and_the_read_is_not_lost() {
        let priority = Arc::new(BootPriority::new());
        let mut guard = Some(priority.begin());
        let mut reached_wait = false;

        let wait = priority.wait_idle_hooked(
            || {
                guard.take();
            },
            || reached_wait = true,
        );

        tokio::time::timeout(Duration::from_secs(1), wait)
            .await
            .expect("the waiter must observe the release without a wake");
        assert!(
            !reached_wait,
            "the release landed before the read, so the check must return"
        );
    }

    #[tokio::test]
    async fn a_release_after_the_read_still_wakes_the_registered_waiter() {
        let priority = Arc::new(BootPriority::new());
        let mut guard = Some(priority.begin());

        let wait = priority.wait_idle_hooked(
            || {},
            || {
                // The counter was read as critical and the notification is
                // already registered. Dropping here is the window that
                // `notify_waiters` must cover.
                guard.take();
            },
        );

        tokio::time::timeout(Duration::from_secs(1), wait)
            .await
            .expect("a registered waiter must be woken by notify_waiters");
    }

    #[tokio::test]
    async fn every_registered_waiter_wakes_when_the_window_closes() {
        let priority = Arc::new(BootPriority::new());
        let guard = priority.begin();
        let first = priority.wait_idle();
        let second = priority.wait_idle();
        tokio::pin!(first);
        tokio::pin!(second);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        assert!(futures_util::poll!(second.as_mut()).is_pending());

        drop(guard);

        let joined = async {
            let (_, _) = tokio::join!(first, second);
        };
        tokio::time::timeout(Duration::from_secs(1), joined)
            .await
            .expect("no waiter may stay parked after the counter reaches zero");
    }

    /// The counter must not get stuck. A boot that fails mid-scope unwinds, and
    /// the guard's `Drop` still runs, so the next boot can open its own window
    /// and background work is not parked forever behind a dead counter.
    #[test]
    fn a_panicking_boot_scope_does_not_leave_the_counter_stuck() {
        let priority = Arc::new(BootPriority::new());

        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
            let priority = Arc::clone(&priority);
            move || {
                let _guard = priority.begin();
                let _nested = priority.begin();
                assert!(priority.is_critical());
                panic!("the boot failed");
            }
        }));

        assert!(unwound.is_err(), "the boot scope must unwind");
        assert!(
            !priority.is_critical(),
            "both guards must release on unwind, so the counter reaches zero"
        );
        // The next boot still opens and closes its own window.
        let guard = priority.begin();
        assert!(priority.is_critical());
        drop(guard);
        assert!(!priority.is_critical());
    }
}
