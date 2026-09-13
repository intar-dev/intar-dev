use super::*;

use std::io::ErrorKind;
use std::sync::mpsc::{SyncSender, sync_channel};

/// Fixed read and hash block. One reader never holds more than this. The
/// allocation below is this size, so a scrub of hundreds of images does not
/// carry a large buffer per job.
pub(super) const HASH_BLOCK_BYTES: usize = 4 * 1024 * 1024;

/// The background reader budget: 16 MiB/s in total, for every background
/// hash in the process.
pub(super) const BACKGROUND_READ_BYTES_PER_SECOND: u64 = 16 * 1024 * 1024;

/// Background hashing runs on this many dedicated threads. They are not Tokio
/// blocking threads, and the count does not grow per chunk, per image, or per
/// pass. The reader pace lives on the thread, so every job shares one bucket.
const BACKGROUND_HASH_THREADS: usize = 1;

/// Pending hash requests per thread. A full queue is a bounded refusal.
const HASH_QUEUE_DEPTH: usize = 16;

/// How long the background reader parks before it looks at the boot guard
/// again. The value trades wakeups against the delay after a boot finishes.
const BOOT_PAUSE_POLL: Duration = Duration::from_millis(10);

/// Identity of the open file that a hash read covered.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct HashFileIdentity {
    pub(super) device: u64,
    pub(super) inode: u64,
    pub(super) size_bytes: u64,
    pub(super) mtime_seconds: i64,
    pub(super) mtime_nanoseconds: i64,
    pub(super) ctime_seconds: i64,
    pub(super) ctime_nanoseconds: i64,
}

impl HashFileIdentity {
    pub(super) fn from_metadata(metadata: &std::fs::Metadata) -> Option<Self> {
        if !metadata.is_file() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            Some(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
                size_bytes: metadata.len(),
                mtime_seconds: metadata.mtime(),
                mtime_nanoseconds: metadata.mtime_nsec(),
                ctime_seconds: metadata.ctime(),
                ctime_nanoseconds: metadata.ctime_nsec(),
            })
        }
        #[cfg(not(unix))]
        {
            let modified = metadata
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?;
            Some(Self {
                device: 0,
                inode: 0,
                size_bytes: metadata.len(),
                mtime_seconds: modified.as_secs() as i64,
                mtime_nanoseconds: i64::from(modified.subsec_nanos()),
                ctime_seconds: 0,
                ctime_nanoseconds: 0,
            })
        }
    }
}

/// The digest of a full read, with the identity the read started on and the
/// identity it ended on. A verification record is written only when the two
/// identities match, so a concurrent writer cannot donate its identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct HashedFile {
    pub(super) bytes_read: u64,
    pub(super) digest: [u8; 32],
    pub(super) before: HashFileIdentity,
    pub(super) after: HashFileIdentity,
}

impl HashedFile {
    pub(super) fn stable(&self) -> bool {
        self.before == self.after
    }

    pub(super) fn digest_hex(&self) -> String {
        to_hex_lower(&self.digest)
    }
}

/// The pace of the background reader: one token bucket per reader thread.
///
/// The bucket refills at `bytes_per_second` and its burst capacity is exactly
/// one block. That cap is the whole point. An idle period, a boot pause, or a
/// gap between two jobs must not bank credit, because a reader that spends a
/// parked pause as a burst moves a whole image at disk speed and starves the
/// boot it was parked for. The elapsed time of a job is never an input here.
///
/// The state is a single instant, the earliest time the next block may start:
///
/// - `wait_before_block` first clamps the stored instant forward to
///   `now - burst`, so at most one block of credit can ever accumulate, and
///   returns the remaining wait.
/// - `charge_block` then moves the stored instant to `max(stored, now)` plus
///   the cost of the bytes just read. Charging from the completion time means
///   the read itself counts toward the pace, and a slow read is not punished
///   twice.
pub(super) struct ReaderPace {
    bytes_per_second: u64,
    block_bytes: u64,
    next_eligible: Option<Instant>,
}

impl ReaderPace {
    pub(super) fn new(bytes_per_second: u64, block_bytes: u64) -> Self {
        Self {
            bytes_per_second: bytes_per_second.max(1),
            block_bytes,
            next_eligible: None,
        }
    }

    /// The cost of one block, which is also the burst capacity.
    fn burst(&self) -> Duration {
        self.block_cost(self.block_bytes)
    }

    fn block_cost(&self, bytes: u64) -> Duration {
        let nanos =
            u128::from(bytes).saturating_mul(1_000_000_000) / u128::from(self.bytes_per_second);
        Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
    }

    /// How long the next block must wait, after clamping the credit to one
    /// block. `now` is an argument so a test can drive the clock.
    pub(super) fn wait_before_block(&mut self, now: Instant) -> Duration {
        let floor = now.checked_sub(self.burst()).unwrap_or(now);
        let next = self.next_eligible.map_or(floor, |next| next.max(floor));
        self.next_eligible = Some(next);
        next.saturating_duration_since(now)
    }

    /// Charge one completed block against the budget.
    pub(super) fn charge_block(&mut self, now: Instant, bytes: u64) {
        let base = self.next_eligible.unwrap_or(now).max(now);
        self.next_eligible = Some(base.checked_add(self.block_cost(bytes)).unwrap_or(base));
    }
}

struct HashRequest {
    path: PathBuf,
}

/// One queued background request with the channel that reports its result.
struct BackgroundHashJob {
    request: HashRequest,
    response: tokio::sync::oneshot::Sender<Result<HashedFile>>,
}

static BACKGROUND_HASH_DISPATCH: OnceLock<Vec<SyncSender<BackgroundHashJob>>> = OnceLock::new();

fn background_hash_dispatch() -> &'static [SyncSender<BackgroundHashJob>] {
    BACKGROUND_HASH_DISPATCH.get_or_init(|| {
        let mut senders = Vec::with_capacity(BACKGROUND_HASH_THREADS);
        for index in 0..BACKGROUND_HASH_THREADS {
            let (sender, receiver) = sync_channel::<BackgroundHashJob>(HASH_QUEUE_DEPTH);
            let spawn = std::thread::Builder::new()
                .name(format!("image-cache-hash-{index}"))
                .spawn(move || hash_worker(receiver));
            match spawn {
                Ok(_) => senders.push(sender),
                Err(error) => {
                    error!(error = %error, "failed to start image cache hash thread");
                    break;
                }
            }
        }
        senders
    })
}

fn hash_worker(receiver: std::sync::mpsc::Receiver<BackgroundHashJob>) {
    // One bucket for the whole thread, so the pace holds across jobs and a
    // scrub of many small files cannot reset it per file.
    let mut pace = ReaderPace::new(BACKGROUND_READ_BYTES_PER_SECOND, HASH_BLOCK_BYTES as u64);
    while let Ok(job) = receiver.recv() {
        let result = hash_request(&job.request, &mut pace, &job.response);
        let _ = job.response.send(result);
    }
}

/// Hash one cache file on the background reader.
///
/// This reader is for cache maintenance only, and it has three properties the
/// launch path must never take:
///
/// - It parks between two blocks while a boot-critical window is live. The
///   launch path keeps its own reader on the Tokio blocking pool
///   (`sha256_file`, `sha256_open_file`), which never parks, so a learner check
///   can never queue behind a parked pass.
/// - It is paced by `ReaderPace`, which caps the burst at one block so a pause
///   cannot be spent as a burst.
/// - It uses one fixed thread behind a bounded queue. A scrub of hundreds of
///   images does not grow the Tokio blocking pool, and a full queue is a
///   bounded refusal instead of a new task.
pub(super) async fn hash_file_bounded(path: &Path) -> Result<HashedFile> {
    let senders = background_hash_dispatch();
    let Some(sender) = senders.first() else {
        anyhow::bail!("image cache hash thread is unavailable");
    };
    let (response, receiver) = tokio::sync::oneshot::channel();
    // `try_send`, never a blocking send: an async task must not block on the
    // bounded queue. A dropped receiver means the caller gave up, and the
    // worker stops that read at its next block boundary.
    sender
        .try_send(BackgroundHashJob {
            request: HashRequest {
                path: path.to_path_buf(),
            },
            response,
        })
        .map_err(|error| match error {
            std::sync::mpsc::TrySendError::Full(_) => {
                anyhow::anyhow!("image cache hash queue is full; refusing more work")
            }
            std::sync::mpsc::TrySendError::Disconnected(_) => {
                anyhow::anyhow!("image cache hash thread has stopped")
            }
        })?;
    receiver.await.context("image cache hash worker stopped")?
}

fn hash_request(
    request: &HashRequest,
    pace: &mut ReaderPace,
    response: &tokio::sync::oneshot::Sender<Result<HashedFile>>,
) -> Result<HashedFile> {
    let path = request.path.as_path();
    let mut file = open_cache_file_no_follow(path)?;
    let before = cached_file_identity(&file, path)?;

    let mut hasher = Sha256::new();
    let mut bytes_read: u64 = 0;
    let mut buffer = vec![0_u8; HASH_BLOCK_BYTES];
    loop {
        if response.is_closed() {
            // The caller dropped its future. Stop here instead of reading a
            // whole image that nobody waits for.
            anyhow::bail!("the caller stopped waiting for this hash read");
        }
        park_while_boot_critical();
        let wait = pace.wait_before_block(Instant::now());
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        let read = match file.read(&mut buffer) {
            Ok(read) => read,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed reading file for hashing at {}", path.display())
                });
            }
        };
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes_read = bytes_read.saturating_add(read as u64);
        pace.charge_block(Instant::now(), read as u64);
    }
    let after = cached_file_identity(&file, path)?;
    Ok(HashedFile {
        bytes_read,
        digest: hasher.finalize().into(),
        before,
        after,
    })
}

/// Open a cache file without following a final symlink, and refuse anything
/// that is not a regular file.
///
/// The cache root is unprivileged. A path planted in it must not redirect a
/// read at another file, and a FIFO must not stall the reader, so the open uses
/// the same flags as the tools disk path: `O_NOFOLLOW` and `O_NONBLOCK`.
fn open_cache_file_no_follow(path: &Path) -> Result<std::fs::File> {
    let descriptor = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::CLOEXEC
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::NONBLOCK,
        rustix::fs::Mode::empty(),
    )
    .map_err(|error| {
        anyhow::anyhow!(
            "failed to open cache file without following a symlink at {}: {error}",
            path.display()
        )
    })?;
    let file = std::fs::File::from(descriptor);
    let metadata = file
        .metadata()
        .with_context(|| format!("failed to stat cache file at {}", path.display()))?;
    anyhow::ensure!(
        metadata.is_file(),
        "cache path is not a regular file at {}",
        path.display()
    );
    Ok(file)
}

fn cached_file_identity(file: &std::fs::File, path: &Path) -> Result<HashFileIdentity> {
    let metadata = file
        .metadata()
        .with_context(|| format!("failed to stat file for hashing at {}", path.display()))?;
    HashFileIdentity::from_metadata(&metadata)
        .with_context(|| format!("cached file is not a regular file at {}", path.display()))
}

/// Park a background read between two blocks while a boot needs the disk and
/// the CPU. The pace still charges the pause, so parking never becomes a burst.
fn park_while_boot_critical() {
    while vm_boot_critical() {
        std::thread::sleep(BOOT_PAUSE_POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One block at the configured reader budget.
    const ONE_BLOCK_COST: Duration = Duration::from_millis(250);

    fn pace() -> ReaderPace {
        ReaderPace::new(BACKGROUND_READ_BYTES_PER_SECOND, HASH_BLOCK_BYTES as u64)
    }

    /// Drive `blocks` blocks from `start` with reads that take no time, and
    /// report how long the reader had to wait in total.
    fn wait_for_blocks(pace: &mut ReaderPace, start: Instant, blocks: usize) -> Duration {
        let mut now = start;
        let mut waited = Duration::ZERO;
        for _ in 0..blocks {
            let wait = pace.wait_before_block(now);
            waited = waited.saturating_add(wait);
            now = now.checked_add(wait).unwrap_or(now);
            pace.charge_block(now, HASH_BLOCK_BYTES as u64);
        }
        waited
    }

    /// The bug this rules out. The old allowance came from the elapsed time of
    /// the job, so a ten second boot pause banked 160 MiB of credit and the next
    /// read moved at disk speed. Eight MiB after a ten minute idle period must
    /// still wait one block.
    #[test]
    fn a_ten_minute_idle_period_does_not_buy_a_burst() {
        let base = Instant::now();
        let mut pace = pace();
        pace.charge_block(base, HASH_BLOCK_BYTES as u64);

        let waited = wait_for_blocks(&mut pace, base + Duration::from_secs(600), 2);

        assert!(
            waited >= ONE_BLOCK_COST,
            "eight MiB after an idle period must wait at least one block, waited {waited:?}"
        );
    }

    /// A parked boot must not bank credit for the blocks that follow it.
    #[test]
    fn a_boot_pause_banks_at_most_one_block_for_a_large_read() {
        let base = Instant::now();
        // 64 MiB is sixteen blocks.
        let without_pause = wait_for_blocks(&mut pace(), base, 16);
        for pause in [Duration::from_secs(10), Duration::from_secs(600)] {
            let mut pace = pace();
            pace.charge_block(base, HASH_BLOCK_BYTES as u64);

            let waited = wait_for_blocks(&mut pace, base + pause, 16);

            assert!(
                waited >= Duration::from_millis(3_500),
                "a {pause:?} pause must not buy a burst; waited only {waited:?}"
            );
            assert!(
                without_pause.saturating_sub(waited)
                    <= ONE_BLOCK_COST.saturating_add(Duration::from_millis(1)),
                "a pause may buy at most one block: {without_pause:?} against {waited:?}"
            );
        }
    }

    /// The bucket lives on the thread, so a scrub of many small files cannot
    /// reset the pace for every file.
    #[test]
    fn two_consecutive_single_block_jobs_share_one_bucket() {
        let base = Instant::now();
        let mut pace = pace();

        let first = wait_for_blocks(&mut pace, base, 1);
        let second = wait_for_blocks(&mut pace, base, 1);

        assert_eq!(
            first,
            Duration::ZERO,
            "the first block uses the free credit"
        );
        assert!(
            second >= ONE_BLOCK_COST,
            "the second file must pay its block cost, waited {second:?}"
        );
    }

    /// The pace must never be computed from the elapsed time of a job.
    #[test]
    fn the_pace_ignores_elapsed_time_between_blocks() {
        let base = Instant::now();
        let mut pace = pace();
        pace.charge_block(base, HASH_BLOCK_BYTES as u64);

        // One block immediately, and one block after ten minutes, must cost the
        // same: the state is the next eligible instant, not a byte allowance.
        let immediate = pace.wait_before_block(base);
        let after_idle = pace.wait_before_block(base + Duration::from_secs(600));

        assert_eq!(immediate, ONE_BLOCK_COST);
        assert_eq!(after_idle, Duration::ZERO, "at most one block of credit");
    }

    #[tokio::test]
    async fn a_small_read_inside_the_budget_produces_a_stable_digest() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("small.bin");
        let bytes = vec![1_u8; 64 * 1024];
        std::fs::write(&path, &bytes)?;

        let hashed = hash_file_bounded(&path).await?;

        assert!(hashed.stable());
        assert_eq!(hashed.bytes_read, bytes.len() as u64);
        assert_eq!(hashed.digest_hex(), to_hex_lower(&Sha256::digest(&bytes)));
        // The same answer as the launch-path reader.
        assert_eq!(hashed.digest_hex(), sha256_file(&path).await?);
        Ok(())
    }

    #[tokio::test]
    async fn a_read_of_a_replaced_file_reports_a_different_digest() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("replaced.bin");
        std::fs::write(&path, vec![2_u8; 128 * 1024])?;
        let hashed = hash_file_bounded(&path).await?;
        std::fs::write(&path, vec![9_u8; 128 * 1024])?;
        let after = hash_file_bounded(&path).await?;

        assert!(hashed.stable());
        assert!(after.stable());
        assert_ne!(hashed.digest_hex(), after.digest_hex());
        Ok(())
    }

    /// The reader must refuse a symlink at the cache path, so a planted path
    /// cannot redirect a read.
    #[tokio::test]
    async fn a_symlinked_cache_path_is_refused() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let target = dir.path().join("target.bin");
        std::fs::write(&target, b"intar")?;
        let link = dir.path().join("link.bin");
        std::os::unix::fs::symlink(&target, &link)?;

        let error = hash_file_bounded(&link)
            .await
            .expect_err("a symlinked cache path must be refused");

        assert!(
            error.to_string().contains("symlink"),
            "unexpected error: {error}"
        );
        Ok(())
    }

    /// The deadlock this test rules out: a learner boot holds the boot guard
    /// while a background scrub read is parked in the middle of a file. A
    /// foreground verification on the launch path must still finish, because
    /// the foreground class never shares the parked background thread.
    ///
    /// The read of 8 MiB needs 0.5 s at the 16 MiB/s budget. The guard goes up
    /// at 300 ms, so a read that is not parked must be complete well inside the
    /// 1 s observation window. The read is still incomplete at the end of that
    /// window, which proves it parked, and the digest after the release proves
    /// it resumed from where it stopped.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_parked_background_read_does_not_block_the_launch_path_reader() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let background_path = dir.path().join("background.bin").clone();
        let foreground_path = dir.path().join("foreground.bin").clone();
        let background_bytes = vec![3_u8; 8 * 1024 * 1024];
        std::fs::write(&background_path, &background_bytes)?;
        std::fs::write(&foreground_path, b"intar launch check")?;

        let read_path = background_path.clone();
        let mut background = tokio::spawn(async move { hash_file_bounded(&read_path).await });
        tokio::time::sleep(Duration::from_millis(300)).await;

        let guard = begin_vm_boot_critical();
        assert!(vm_boot_critical());

        let foreground_started = std::time::Instant::now();
        let foreground = sha256_file(&foreground_path).await?;
        let foreground_elapsed = foreground_started.elapsed();
        assert!(
            vm_boot_critical(),
            "the boot guard must still be live for this proof"
        );
        assert_eq!(
            foreground,
            to_hex_lower(&Sha256::digest(b"intar launch check"))
        );
        assert!(
            foreground_elapsed < Duration::from_secs(1),
            "the launch-path reader must not queue behind a parked background read"
        );

        let observed = tokio::time::timeout(Duration::from_millis(1000), &mut background).await;
        assert!(
            observed.is_err(),
            "a background read must stay parked while the boot guard is live"
        );

        drop(guard);
        let resumed = tokio::time::timeout(Duration::from_secs(10), &mut background)
            .await
            .expect("the parked read must resume after the release")??;
        assert_eq!(
            resumed.digest_hex(),
            to_hex_lower(&Sha256::digest(&background_bytes))
        );
        Ok(())
    }
}
