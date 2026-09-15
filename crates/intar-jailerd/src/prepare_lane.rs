use super::*;

// Bound background preparation deferral independently of VM CPU limits.
pub(super) const BACKGROUND_BOOT_WINDOW: Duration = Duration::from_secs(45);

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

// Aggregate background read budget: one background import at a time, so this
// is the whole process budget. The value comes from the protocol crate because
// the agent sizes its own client budget from the same number. If the two
// drifted apart, a client would abandon an import that this lane still runs.
use intar_jailer_protocol::BACKGROUND_PREPARE_BYTES_PER_SECOND as BACKGROUND_BYTES_PER_SECOND;

/// Largest single charge, and the largest credit the bucket may bank.
///
/// 4 MiB is one image chunk in the catalog contract, so the allowance matches
/// the unit the reader already works in. The cap is what stops an idle process
/// from banking an unbounded burst: without it, an idle hour would grant 56 GiB
/// of unthrottled reads.
const BACKGROUND_CHARGE_BLOCK_BYTES: u64 = 4 * 1024 * 1024;

/// Longest single wait before the holder rechecks the boot window, so a boot
/// that starts during a paced wait defers the import within one slice.
const THROTTLE_SLICE: Duration = Duration::from_millis(50);

/// The time source and the wait for one budget.
///
/// Production reads the monotonic clock and sleeps. Tests advance a virtual
/// clock, so a pacing assertion is exact instead of a timing fixture.
trait LaneTime: Send + Sync {
    /// Time since the budget was created.
    fn elapsed(&self) -> Duration;
    /// Wait for `slice`, or advance the clock by `slice` in a test.
    fn wait(&self, slice: Duration);
}

struct MonotonicTime {
    epoch: Instant,
}

impl LaneTime for MonotonicTime {
    fn elapsed(&self) -> Duration {
        self.epoch.elapsed()
    }

    fn wait(&self, slice: Duration) {
        std::thread::sleep(slice);
    }
}

/// The scheduling budget of one jailerd process.
///
/// One instance exists in production. Tests build their own instance on a
/// virtual clock, so a unit test never observes a real boot window, a real
/// token balance, or real time.
pub(super) struct LaneBudget {
    /// One background raw import in the whole process.
    background_taken: AtomicBool,
    /// Live boot windows, keyed by jail generation. The stored instant is a
    /// self-expiry, so a missed close cannot hold the lane open forever.
    boot_windows: Mutex<BTreeMap<ValidatedId, Instant>>,
    /// Fast path for the block boundary. Zero means no window is live.
    boot_window_count: AtomicUsize,
    /// Token bucket in bytes.
    bucket: Mutex<Bucket>,
    /// Every byte charged, so a test can assert the exact spend.
    charged_bytes: AtomicU64,
    time: Arc<dyn LaneTime>,
}

/// A token bucket in bytes.
///
/// Credit accrues at the budget rate and is capped at one charge block. The
/// bucket starts empty and never banks more than one block, so the pacing is a
/// rate over the bytes actually read rather than an average that idle time can
/// subsidise. The arithmetic is integer: a fractional deficit would drift and
/// a zero-length wait would spin.
struct Bucket {
    credit_bytes: u64,
    last_tick: Duration,
}

impl Bucket {
    /// Add the credit earned since the last settlement, capped at one block.
    fn refill(&mut self, now: Duration) {
        let elapsed_nanos = now.saturating_sub(self.last_tick).as_nanos();
        self.last_tick = now;
        let gained =
            elapsed_nanos.saturating_mul(u128::from(BACKGROUND_BYTES_PER_SECOND)) / 1_000_000_000;
        let credit = u128::from(self.credit_bytes).saturating_add(gained);
        self.credit_bytes = u64::try_from(credit.min(u128::from(BACKGROUND_CHARGE_BLOCK_BYTES)))
            .unwrap_or(BACKGROUND_CHARGE_BLOCK_BYTES);
    }

    /// Consume `bytes` from the credit and return the wait that covers the
    /// rest. When a wait is owed the credit is spent and the clock is settled
    /// at `now`, so the wait below is paid once and is not credited again.
    fn take(&mut self, now: Duration, bytes: u64) -> Duration {
        self.refill(now);
        if self.credit_bytes >= bytes {
            self.credit_bytes -= bytes;
            return Duration::ZERO;
        }
        let deficit = bytes - self.credit_bytes;
        self.credit_bytes = 0;
        let nanos = u128::from(deficit)
            .saturating_mul(1_000_000_000)
            .div_ceil(u128::from(BACKGROUND_BYTES_PER_SECOND));
        Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
    }

    /// Restart the clock after a paced wait. The wait paid for the deficit, so
    /// the time it consumed must not be credited a second time.
    fn settle(&mut self, now: Duration) {
        self.last_tick = now;
        self.credit_bytes = 0;
    }
}

static LANE_BUDGET: OnceLock<Arc<LaneBudget>> = OnceLock::new();

fn lane_budget() -> &'static Arc<LaneBudget> {
    LANE_BUDGET.get_or_init(|| Arc::new(LaneBudget::new()))
}

impl LaneBudget {
    fn new() -> Self {
        Self::with_time(Arc::new(MonotonicTime {
            epoch: Instant::now(),
        }))
    }

    fn with_time(time: Arc<dyn LaneTime>) -> Self {
        Self {
            background_taken: AtomicBool::new(false),
            boot_windows: Mutex::new(BTreeMap::new()),
            boot_window_count: AtomicUsize::new(0),
            bucket: Mutex::new(Bucket {
                credit_bytes: 0,
                last_tick: Duration::ZERO,
            }),
            charged_bytes: AtomicU64::new(0),
            time,
        }
    }

    /// True while any VM boot window is live. One relaxed load on the fast
    /// path; the map itself is the authority and purges expired windows.
    pub(super) fn boot_lease_active(&self) -> bool {
        if self.boot_window_count.load(Ordering::Acquire) == 0 {
            return false;
        }
        self.with_boot_windows(|windows| !windows.is_empty())
    }

    fn with_boot_windows<T>(&self, f: impl FnOnce(&mut BTreeMap<ValidatedId, Instant>) -> T) -> T {
        let mut windows = self
            .boot_windows
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        windows.retain(|_, expires_at| *expires_at > now);
        let result = f(&mut windows);
        self.boot_window_count
            .store(windows.len(), Ordering::Release);
        result
    }

    /// Open a boot window for one generation. It self-expires after `lease`.
    ///
    /// Boot admission calls this while it holds the lifecycle lock. A later
    /// admission for the same generation replaces the deadline rather than
    /// extending an unrelated boot.
    pub(super) fn open_boot_window(&self, generation: &ValidatedId, lease: Duration) {
        let expires_at = Instant::now()
            .checked_add(lease)
            .unwrap_or_else(Instant::now);
        self.with_boot_windows(|windows| {
            windows.insert(generation.clone(), expires_at);
        });
    }

    /// Close a boot window. Every terminal path calls this: a sealed boot, a
    /// failed launch, a rollback, a cancel, and a destroy.
    pub(super) fn close_boot_window(&self, generation: &ValidatedId) {
        self.with_boot_windows(|windows| {
            windows.remove(generation);
        });
    }

    /// Charge one delta against the budget and pace it.
    ///
    /// A live boot window defers the caller before any charge and before any
    /// early return, including a zero-byte charge. Credit is capped at one
    /// block, so the caller is paced over the bytes it read and not over the
    /// wall-clock age of the process.
    fn spend(&self, bytes: u64) -> Result<()> {
        if self.boot_lease_active() {
            return Err(anyhow::Error::from(PrepareDeferred));
        }
        if bytes == 0 {
            return Ok(());
        }
        let wait = {
            let mut bucket = self
                .bucket
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            bucket.take(self.time.elapsed(), bytes)
        };
        // Pay the deficit in slices. The boot window is checked before every
        // slice, so a boot that starts during the wait never pays another one.
        // Every slice is at least one nanosecond, so this loop always ends.
        let mut left = wait;
        while left > Duration::ZERO {
            if self.boot_lease_active() {
                return Err(anyhow::Error::from(PrepareDeferred));
            }
            let slice = left.min(THROTTLE_SLICE);
            self.time.wait(slice);
            left = left.saturating_sub(slice);
        }
        if wait > Duration::ZERO {
            let mut bucket = self
                .bucket
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            bucket.settle(self.time.elapsed());
        }
        self.charged_bytes.fetch_add(bytes, Ordering::AcqRel);
        Ok(())
    }
}

/// Open a boot window in the process budget.
pub(super) fn open_boot_window(generation: &ValidatedId, lease: Duration) {
    lane_budget().open_boot_window(generation, lease);
}

/// Close a boot window in the process budget.
pub(super) fn close_boot_window(generation: &ValidatedId) {
    lane_budget().close_boot_window(generation);
}

/// A background preparation gave its turn back. The caller requeues the work
/// and tries again later. Nothing is lost: no partially written template is
/// published, and a previous valid template stays untouched.
#[derive(Debug, Error)]
#[error("background image preparation was requeued to keep a VM boot responsive")]
pub(super) struct PrepareDeferred;

/// The scheduling decision for one preparation request.
///
/// A foreground caller never waits and is never deferred: a learner launch
/// must not queue behind background work. A background caller never waits
/// across a boot either. It takes the free lane or returns `PrepareDeferred`,
/// and at any charge it defers as soon as a boot window opens.
pub(super) struct PrepareLane {
    budget: Arc<LaneBudget>,
    background: bool,
}

impl Drop for PrepareLane {
    fn drop(&mut self) {
        if self.background {
            self.budget.background_taken.store(false, Ordering::Release);
        }
    }
}

impl PrepareLane {
    pub(super) fn claim(class: RequestClass) -> Result<Self> {
        Self::claim_in(Arc::clone(lane_budget()), class)
    }

    fn claim_in(budget: Arc<LaneBudget>, class: RequestClass) -> Result<Self> {
        if class != RequestClass::Background {
            return Ok(Self {
                budget,
                background: false,
            });
        }
        if budget.boot_lease_active() {
            return Err(anyhow::Error::from(PrepareDeferred));
        }
        budget
            .background_taken
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| anyhow::Error::from(PrepareDeferred))?;
        Ok(Self {
            budget,
            background: true,
        })
    }

    /// Charge one delta of the bytes the reader just consumed.
    ///
    /// `bytes` is a delta and not a running total. Every byte is therefore
    /// charged exactly once: a cumulative value would charge the whole file
    /// again on every call, which paces a 32 MiB import as if it were 144 MiB.
    /// Callers pass the bytes of the current read or chunk, so a charge is at
    /// most one block and the bucket cap matches it.
    pub(super) fn charge(&self, bytes: u64) -> Result<()> {
        if !self.background {
            return Ok(());
        }
        debug_assert!(
            bytes <= BACKGROUND_CHARGE_BLOCK_BYTES,
            "a background charge must be one delta of at most one block"
        );
        self.budget.spend(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A virtual clock: `wait` advances it instead of sleeping, so every
    /// assertion below is exact and independent of CI timing.
    #[derive(Default)]
    struct VirtualTime {
        elapsed_nanos: AtomicU64,
        /// Runs after each advance, so a test can inject a boot mid-throttle
        /// without racing the wall clock.
        on_wait: OnceLock<Box<dyn Fn() + Send + Sync>>,
    }

    impl VirtualTime {
        fn advance(&self, duration: Duration) {
            let nanos = u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX);
            self.elapsed_nanos.fetch_add(nanos, Ordering::AcqRel);
        }
    }

    impl LaneTime for VirtualTime {
        fn elapsed(&self) -> Duration {
            Duration::from_nanos(self.elapsed_nanos.load(Ordering::Acquire))
        }

        fn wait(&self, slice: Duration) {
            self.advance(slice);
            if let Some(hook) = self.on_wait.get() {
                hook();
            }
        }
    }

    const BLOCK: u64 = BACKGROUND_CHARGE_BLOCK_BYTES;

    fn generation(name: &str) -> ValidatedId {
        ValidatedId::parse(name).expect("valid generation")
    }

    /// A private budget on a virtual clock: no real boot, no real time.
    fn budget() -> (Arc<LaneBudget>, Arc<VirtualTime>) {
        let time = Arc::new(VirtualTime::default());
        let budget = Arc::new(LaneBudget::with_time(time.clone()));
        (budget, time)
    }

    fn background(budget: &Arc<LaneBudget>) -> Result<PrepareLane> {
        PrepareLane::claim_in(Arc::clone(budget), RequestClass::Background)
    }

    fn foreground(budget: &Arc<LaneBudget>) -> Result<PrepareLane> {
        PrepareLane::claim_in(Arc::clone(budget), RequestClass::Foreground)
    }

    #[test]
    fn a_foreground_request_always_claims_and_never_waits() {
        let (budget, clock) = budget();
        let held = background(&budget).expect("background lane");
        let boot = generation("a");
        budget.open_boot_window(&boot, Duration::from_secs(45));
        let launch = foreground(&budget).expect("foreground lane");
        // A live boot window and a held background lane never defer a launch,
        // and a foreground charge never spends the background budget.
        assert!(launch.charge(BLOCK).is_ok());
        assert!(launch.charge(0).is_ok());
        assert_eq!(clock.elapsed(), Duration::ZERO);
        assert_eq!(budget.charged_bytes.load(Ordering::Acquire), 0);
        drop(launch);
        drop(held);
    }

    #[test]
    fn one_background_prepare_runs_at_a_time() {
        let (budget, _clock) = budget();
        let first = background(&budget).expect("background lane");
        assert!(background(&budget).is_err());
        drop(first);
        assert!(background(&budget).is_ok());
    }

    #[test]
    fn a_boot_window_blocks_a_new_background_claim() {
        let (budget, _clock) = budget();
        let boot = generation("b");
        budget.open_boot_window(&boot, Duration::from_secs(45));
        assert!(budget.boot_lease_active());
        assert!(background(&budget).is_err());
    }

    #[test]
    fn a_sealed_or_failed_boot_releases_the_window_early() {
        let (budget, _clock) = budget();
        // A boot that finishes in a second must not hold the lane for the
        // whole lease: the terminal path closes the window.
        let boot = generation("c");
        budget.open_boot_window(&boot, Duration::from_secs(45));
        assert!(budget.boot_lease_active());
        budget.close_boot_window(&boot);
        assert!(
            !budget.boot_lease_active(),
            "a closed boot window still parked the lane"
        );
        assert!(background(&budget).is_ok());
    }

    #[test]
    fn an_abandoned_boot_window_self_expires() {
        let (budget, _clock) = budget();
        let boot = generation("d");
        budget.open_boot_window(&boot, Duration::from_millis(20));
        assert!(budget.boot_lease_active());
        std::thread::sleep(Duration::from_millis(40));
        assert!(
            !budget.boot_lease_active(),
            "an expired boot window still parked the lane"
        );
    }

    #[test]
    fn one_generation_does_not_extend_another() {
        let (budget, _clock) = budget();
        let short = generation("e");
        let long = generation("f");
        budget.open_boot_window(&short, Duration::from_millis(20));
        budget.open_boot_window(&long, Duration::from_millis(500));
        budget.close_boot_window(&long);
        std::thread::sleep(Duration::from_millis(40));
        assert!(
            !budget.boot_lease_active(),
            "a finished boot held the lane open after its own window closed"
        );
    }

    #[test]
    fn every_byte_is_charged_exactly_once() {
        let (budget, _clock) = budget();
        let lane = background(&budget).expect("background lane");
        // The read pattern of a real import: 64 KiB deltas up to 32 MiB.
        for _ in 0..(32 * 1024 * 1024 / (64 * 1024)) {
            lane.charge(64 * 1024).expect("no boot window is live");
        }
        assert_eq!(
            budget.charged_bytes.load(Ordering::Acquire),
            32 * 1024 * 1024,
            "a delta charges its own bytes only; a cumulative value charged 144 MiB"
        );
    }

    #[test]
    fn a_32_mib_import_spends_exactly_two_seconds() {
        let (budget, clock) = budget();
        let lane = background(&budget).expect("background lane");
        for _ in 0..8 {
            lane.charge(BLOCK).expect("no boot window is live");
        }
        assert_eq!(
            budget.charged_bytes.load(Ordering::Acquire),
            32 * 1024 * 1024
        );
        // 32 MiB at 16 MiB/s is 2 s. The old cumulative charge spent 9 s here.
        assert_eq!(clock.elapsed(), Duration::from_secs(2));
    }

    #[test]
    fn idle_time_cannot_bank_a_burst_larger_than_one_block() {
        let (budget, clock) = budget();
        let lane = background(&budget).expect("background lane");
        // An idle hour would bank 56 GiB of credit without a cap, so the next
        // import would run unthrottled. The cap allows exactly one block.
        clock.advance(Duration::from_secs(3_600));
        let before = clock.elapsed();
        lane.charge(BLOCK).expect("no boot window is live");
        assert_eq!(
            clock.elapsed(),
            before,
            "the capped credit covers one block"
        );
        lane.charge(BLOCK).expect("no boot window is live");
        assert_eq!(
            clock.elapsed() - before,
            Duration::from_millis(250),
            "the second block must pay the full rate"
        );
    }

    #[test]
    fn a_live_boot_defers_even_when_the_budget_has_credit() {
        let (budget, clock) = budget();
        let lane = background(&budget).expect("background lane");
        clock.advance(Duration::from_secs(3_600));
        let boot = generation("k");
        budget.open_boot_window(&boot, Duration::from_secs(45));
        // The bucket is full, so a charge would return at once if the boot
        // check ran after the credit check.
        assert!(
            lane.charge(BLOCK).is_err(),
            "a live boot must defer a charge that the bucket could afford"
        );
        // A zero-byte boundary is not exempt either.
        assert!(
            lane.charge(0).is_err(),
            "a zero-byte boundary ignored the boot"
        );
        assert_eq!(budget.charged_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_boot_preempts_a_paced_charge_within_one_slice() {
        let (budget, clock) = budget();
        let lane = background(&budget).expect("background lane");
        // Open a boot window as soon as the first pacing slice completes.
        let opener = {
            let budget = Arc::clone(&budget);
            move || {
                let boot = ValidatedId::parse("l").expect("valid generation");
                budget.open_boot_window(&boot, Duration::from_secs(45));
            }
        };
        assert!(clock.on_wait.set(Box::new(opener)).is_ok(), "hook set once");
        assert!(
            lane.charge(BLOCK).is_err(),
            "a live boot did not preempt the paced charge"
        );
        // Exactly one slice was paid, and a deferred charge is not counted.
        assert_eq!(clock.elapsed(), THROTTLE_SLICE);
        assert_eq!(
            budget.charged_bytes.load(Ordering::Acquire),
            0,
            "a deferred charge must not be paid"
        );
    }

    #[test]
    fn the_charge_block_matches_one_image_chunk() {
        assert_eq!(
            BACKGROUND_CHARGE_BLOCK_BYTES,
            u64::from(intar_contracts::catalog::IMAGE_CHUNK_SIZE_BYTES)
        );
    }

    #[test]
    fn the_default_class_is_foreground() {
        assert_eq!(RequestClass::default(), RequestClass::Foreground);
    }
}
