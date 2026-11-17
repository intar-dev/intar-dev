//! What launches wait on, and when a waiting launch wakes the cache pass
//! again.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use intar_contracts::oci::OciDigest;

static AWAITED: OnceLock<StdMutex<HashMap<OciDigest, usize>>> = OnceLock::new();
static PASS_RUNNING: AtomicBool = AtomicBool::new(false);

fn awaited() -> &'static StdMutex<HashMap<OciDigest, usize>> {
    AWAITED.get_or_init(Default::default)
}

/// A launch waiting on an image; the pass puts the image first while this
/// lives.
pub(crate) struct AwaitedImage(OciDigest);

impl AwaitedImage {
    pub(crate) fn new(image: &OciDigest) -> Self {
        if let Ok(mut awaited) = awaited().lock() {
            *awaited.entry(image.clone()).or_default() += 1;
        }
        Self(image.clone())
    }
}

impl Drop for AwaitedImage {
    fn drop(&mut self) {
        if let Ok(mut awaited) = awaited().lock()
            && let Some(count) = awaited.get_mut(&self.0)
        {
            *count -= 1;
            if *count == 0 {
                awaited.remove(&self.0);
            }
        }
    }
}

pub(super) fn is_awaited(image: &OciDigest) -> bool {
    awaited()
        .lock()
        .is_ok_and(|awaited| awaited.contains_key(image))
}

/// Marks a cache pass as running while it lives.
pub(super) struct PassRunning;

impl PassRunning {
    pub(super) fn start() -> Self {
        PASS_RUNNING.store(true, Ordering::SeqCst);
        Self
    }
}

impl Drop for PassRunning {
    fn drop(&mut self) {
        PASS_RUNNING.store(false, Ordering::SeqCst);
    }
}

pub(crate) fn pass_running() -> bool {
    PASS_RUNNING.load(Ordering::SeqCst)
}

/// The index of the pending image to prepare next: the first one a launch
/// waits on, else the first in pin order.
pub(super) fn next_pending(pending: &[&OciDigest], awaited: impl Fn(&OciDigest) -> bool) -> usize {
    pending
        .iter()
        .position(|image| awaited(image))
        .unwrap_or_default()
}

const FIRST_REWAKE: Duration = Duration::from_secs(4);
const MAX_REWAKE: Duration = Duration::from_secs(30);

/// When a launch waiting behind an unready image wakes the cache pass again.
/// The delay doubles after each wake up to [`MAX_REWAKE`], and counts from
/// the end of a running pass, so a registry that is down sees at most one
/// pass per delay.
pub(crate) struct RewakeBackoff {
    next: Instant,
    delay: Duration,
}

impl RewakeBackoff {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            next: now + FIRST_REWAKE,
            delay: FIRST_REWAKE,
        }
    }

    /// Whether to wake the pass now.
    pub(crate) fn due(&mut self, now: Instant, pass_running: bool) -> bool {
        if pass_running {
            self.next = self.next.max(now + self.delay);
            return false;
        }
        if now < self.next {
            return false;
        }
        self.delay = (self.delay * 2).min(MAX_REWAKE);
        self.next = now + self.delay;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: char) -> OciDigest {
        OciDigest::try_from(format!("sha256:{}", byte.to_string().repeat(64))).expect("a digest")
    }

    #[test]
    fn an_awaited_image_goes_first_and_pin_order_otherwise() {
        let (a, b, c) = (digest('a'), digest('b'), digest('c'));
        let pending = [&a, &b, &c];
        assert_eq!(next_pending(&pending, |image| *image == c), 2);
        assert_eq!(next_pending(&pending, |image| *image != a), 1);
        assert_eq!(next_pending(&pending, |_| false), 0);

        let guard = AwaitedImage::new(&b);
        let second = AwaitedImage::new(&b);
        assert_eq!(next_pending(&pending, is_awaited), 1);
        drop(guard);
        assert!(is_awaited(&b));
        drop(second);
        assert!(!is_awaited(&b));
    }

    #[test]
    fn a_waiting_launch_wakes_the_pass_with_a_capped_backoff() {
        let start = Instant::now();
        let at = |seconds| start + Duration::from_secs(seconds);
        let mut backoff = RewakeBackoff::new(start);
        assert!(!backoff.due(at(3), false));
        assert!(backoff.due(at(4), false));
        assert!(!backoff.due(at(11), false));
        assert!(backoff.due(at(12), false)); // after 8 s
        // A running pass is never woken, and the delay counts from its end.
        assert!(!backoff.due(at(28), true));
        assert!(!backoff.due(at(100), true));
        assert!(!backoff.due(at(115), false));
        assert!(backoff.due(at(116), false)); // 16 s after the pass was last seen
        assert!(backoff.due(at(146), false)); // capped at 30 s
        assert!(!backoff.due(at(175), false));
        assert!(backoff.due(at(176), false));
    }
}
