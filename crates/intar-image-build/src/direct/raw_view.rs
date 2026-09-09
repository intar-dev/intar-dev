use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::ops::Range;
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd as _;
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::{FileTypeExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use anyhow::ensure;
use anyhow::{Context as _, Result, anyhow, bail};
#[cfg(target_os = "linux")]
use intar_contracts::catalog::IMAGE_CHUNK_SIZE_BYTES;
#[cfg(target_os = "linux")]
use libnbd::{AsyncHandle, CONTEXT_BASE_ALLOCATION, CmdFlag, STATE_ZERO};
#[cfg(target_os = "linux")]
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::process::{Pid, Signal, kill_process};
#[cfg(target_os = "linux")]
use rustix::process::{PidfdFlags, pidfd_open, pidfd_send_signal};

use crate::checkpoint::CheckpointLease;
#[cfg(target_os = "linux")]
use crate::chunked::MAX_CHUNK_READS_IN_FLIGHT;
use crate::chunked::{
    ChunkedImageArtifact, ImageChunkRead, ImageChunkReader, ReusedEncodedImageChunk,
    ScannedChunkedImage, scan_image_chunks, write_scanned_chunked_image_artifact_from_reader,
};
use crate::config::QemuBuildConfig;

const RAW_VIEW_START_TIMEOUT: Duration = Duration::from_secs(30);
const RAW_VIEW_CLEANUP_TIMEOUT: Duration = Duration::from_secs(30);
const RAW_VIEW_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(target_os = "linux")]
const NBD_STATUS_WINDOW_BYTES: u64 = 64 * 1024 * 1024;
const NBD_SOCKET_DIRECTORY: &str = "raw-view-nbd";
const NBD_SOCKET_FILENAME: &str = "raw-view.sock";
const NBD_SOCKET_RELATIVE_PATH: &str = "raw-view-nbd/raw-view.sock";

/// Keeps the final qcow2 source and its checkpoint backing alive while the
/// scanner and encoder use one private readonly Unix NBD export.
pub(super) struct RawViewGuard {
    // The reader is dropped before state. It owns every libnbd request buffer
    // and polling task, while state owns the source files and cache lease.
    reader: Option<NbdChunkReader>,
    #[cfg(test)]
    test_reader: Option<TestChunkReader>,
    state: Option<RawViewState>,
    watchdog: Option<RawViewWatchdog>,
    deadline: Instant,
    read_timed_out: Arc<AtomicBool>,
    watchdog_error: Arc<Mutex<Option<String>>>,
}

struct RawViewWatchdog {
    stop: mpsc::Sender<()>,
    join: JoinHandle<()>,
}

struct RawViewState {
    source_qcow2_path: PathBuf,
    parent_qcow2_paths: Vec<PathBuf>,
    stale_raw_path: PathBuf,
    socket_directory: PathBuf,
    socket_path: PathBuf,
    pidfile: PathBuf,
    qemu_storage_daemon_binary: PathBuf,
    child: Option<Child>,
    _checkpoint_lease: Option<CheckpointLease>,
}

impl std::fmt::Debug for RawViewGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RawViewGuard")
    }
}

impl RawViewGuard {
    pub(super) fn start(
        config: &QemuBuildConfig,
        work_root: &Path,
        source_qcow2_path: PathBuf,
        parent_qcow2_paths: Vec<PathBuf>,
        stale_raw_path: PathBuf,
        checkpoint_lease: Option<CheckpointLease>,
        read_timeout: Duration,
    ) -> Result<Self> {
        let socket_directory = work_root.join(NBD_SOCKET_DIRECTORY);
        let socket_path = socket_directory.join(NBD_SOCKET_FILENAME);
        let mut guard = Self {
            reader: None,
            #[cfg(test)]
            test_reader: None,
            state: Some(RawViewState {
                source_qcow2_path,
                parent_qcow2_paths,
                stale_raw_path,
                socket_directory,
                socket_path,
                pidfile: work_root.join("raw-view.pid"),
                qemu_storage_daemon_binary: config.qemu_storage_daemon_binary.clone(),
                child: None,
                _checkpoint_lease: checkpoint_lease,
            }),
            watchdog: None,
            deadline: Instant::now() + read_timeout,
            read_timed_out: Arc::new(AtomicBool::new(false)),
            watchdog_error: Arc::new(Mutex::new(None)),
        };
        guard.start_export(work_root)?;
        // The separate read budget begins after QSD has made its private
        // socket ready. Startup has its own bounded timeout above.
        let deadline = Instant::now() + read_timeout;
        guard.deadline = deadline;
        guard.start_reader(read_timeout, deadline)?;
        Ok(guard)
    }

    pub(super) fn scan(&mut self) -> Result<ScannedChunkedImage> {
        let source_label = self
            .state
            .as_ref()
            .context("NBD export was closed before image scanning")?
            .stale_raw_path
            .clone();
        #[cfg(test)]
        if let Some(reader) = self.test_reader.as_mut() {
            return scan_image_chunks(reader, source_label);
        }
        let reader = self
            .reader
            .as_mut()
            .context("NBD client was closed before image scanning")?;
        scan_image_chunks(reader, source_label)
    }

    pub(super) fn write_scanned(
        &mut self,
        scan: &ScannedChunkedImage,
        chunks_dir: &Path,
        manifest_path: &Path,
        reused: &BTreeMap<String, ReusedEncodedImageChunk>,
    ) -> Result<ChunkedImageArtifact> {
        #[cfg(test)]
        if let Some(reader) = self.test_reader.as_mut() {
            return write_scanned_chunked_image_artifact_from_reader(
                scan,
                reader,
                chunks_dir,
                manifest_path,
                reused,
            );
        }
        let reader = self
            .reader
            .as_mut()
            .context("NBD client was closed before image encoding")?;
        write_scanned_chunked_image_artifact_from_reader(
            scan,
            reader,
            chunks_dir,
            manifest_path,
            reused,
        )
    }

    pub(super) fn close(&mut self) -> Result<()> {
        let mut errors = Vec::new();
        // `take` and drop the reader before stopping QSD. A mutable reader
        // method cannot overlap this close, and every pread task drains its
        // buffer before it returns.
        if let Some(mut reader) = self.reader.take()
            && let Err(error) = reader.close()
        {
            errors.push(format!("failed to close NBD client: {error:#}"));
        }
        self.clear_test_reader();
        if let Err(error) = self.stop_watchdog() {
            errors.push(format!("failed to stop NBD watchdog: {error:#}"));
        }
        if let Some(state) = self.state.as_mut() {
            match close_state(state) {
                Ok(()) => self.state = None,
                Err(error) => errors.push(format!("failed to close NBD export: {error:#}")),
            }
        }
        let watchdog_error = self
            .watchdog_error
            .lock()
            .map_err(|_| anyhow!("NBD watchdog error lock is poisoned"))?
            .take();
        let timed_out = self.read_timed_out.swap(false, Ordering::AcqRel);
        if let Some(error) = watchdog_error {
            errors.push(format!("NBD watchdog failed: {error}"));
        }
        if timed_out || Instant::now() >= self.deadline {
            errors.push("raw view image-read deadline expired".to_string());
        }
        if errors.is_empty() {
            Ok(())
        } else {
            bail!(errors.join("; "))
        }
    }

    #[cfg(target_os = "linux")]
    fn qsd_pidfd(&mut self) -> Result<rustix::fd::OwnedFd> {
        let state = self
            .state
            .as_mut()
            .context("NBD export was closed before its watchdog could start")?;
        let child = state
            .child
            .as_mut()
            .context("NBD storage daemon did not start")?;
        ensure!(
            child
                .try_wait()
                .context("failed to poll NBD storage daemon")?
                .is_none(),
            "NBD storage daemon exited before its watchdog could start"
        );
        let raw_pid = i32::try_from(child.id()).context("QSD PID does not fit i32")?;
        let pid = Pid::from_raw(raw_pid).context("QSD PID is not valid")?;
        pidfd_open(pid, PidfdFlags::empty()).context("failed to bind NBD watchdog to QSD")
    }

    #[cfg(target_os = "linux")]
    fn start_reader(&mut self, timeout: Duration, deadline: Instant) -> Result<()> {
        let pidfd = self.qsd_pidfd()?;
        self.start_watchdog(timeout, pidfd)?;
        let socket_directory = self
            .state
            .as_ref()
            .context("NBD export was closed before its client could start")?
            .socket_directory
            .clone();
        self.reader = Some(NbdChunkReader::connect(
            &socket_directory,
            deadline,
            Arc::clone(&self.read_timed_out),
        )?);
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    fn start_reader(&mut self, _timeout: Duration, _deadline: Instant) -> Result<()> {
        bail!("Unix NBD image reading requires Linux")
    }

    #[cfg(target_os = "linux")]
    fn start_watchdog(&mut self, timeout: Duration, pidfd: rustix::fd::OwnedFd) -> Result<()> {
        let (stop, stopped) = mpsc::channel();
        let timed_out = Arc::clone(&self.read_timed_out);
        let error_slot = Arc::clone(&self.watchdog_error);
        let join = thread::spawn(move || {
            if matches!(
                stopped.recv_timeout(timeout),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                timed_out.store(true, Ordering::Release);
                if let Err(error) = terminate_stale_pidfd(pidfd, "NBD image-read deadline")
                    && let Ok(mut error_slot) = error_slot.lock()
                {
                    *error_slot = Some(format!("{error:#}"));
                }
            }
        });
        self.watchdog = Some(RawViewWatchdog { stop, join });
        Ok(())
    }

    fn stop_watchdog(&mut self) -> Result<()> {
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.stop.send(());
            watchdog
                .join
                .join()
                .map_err(|_| anyhow!("NBD watchdog panicked"))?;
        }
        Ok(())
    }

    #[cfg(test)]
    fn clear_test_reader(&mut self) {
        self.test_reader = None;
    }

    #[cfg(not(test))]
    fn clear_test_reader(&mut self) {}

    fn start_export(&mut self, work_root: &Path) -> Result<()> {
        let state = self
            .state
            .as_mut()
            .context("NBD export was closed before it could start")?;
        prepare_socket_directory(&state.socket_directory)?;
        remove_file_if_exists(&state.pidfile)?;
        let log_path = work_root.join("raw-view.log");
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("failed to open NBD export log '{}'", log_path.display()))?;
        let log_stderr = log.try_clone().context("failed to clone NBD export log")?;
        let arguments = qsd_arguments(
            &state.source_qcow2_path,
            NBD_SOCKET_RELATIVE_PATH,
            &state.pidfile,
        )?;
        state.child = Some(
            Command::new(&state.qemu_storage_daemon_binary)
                .args(arguments)
                .current_dir(work_root)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log))
                .stderr(Stdio::from(log_stderr))
                .spawn()
                .with_context(|| {
                    format!(
                        "failed to start readonly QEMU NBD daemon '{}'",
                        state.qemu_storage_daemon_binary.display()
                    )
                })?,
        );
        self.wait_until_ready()
    }

    fn wait_until_ready(&mut self) -> Result<()> {
        let deadline = Instant::now() + RAW_VIEW_START_TIMEOUT;
        loop {
            let ready = {
                let state = self
                    .state
                    .as_mut()
                    .context("NBD export was closed while it was starting")?;
                let child = state
                    .child
                    .as_mut()
                    .context("NBD storage daemon did not start")?;
                if let Some(status) = child
                    .try_wait()
                    .context("failed to poll NBD storage daemon")?
                {
                    bail!(
                        "NBD storage daemon exited before its socket became ready with status {status}"
                    );
                }
                state.pidfile.is_file() && socket_is_active(&state.socket_path)?
            };
            if ready {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!("NBD export did not become ready before timeout");
            }
            thread::sleep(RAW_VIEW_POLL_INTERVAL);
        }
    }
}

impl Drop for RawViewGuard {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("[intar-nbd-view] cleanup_failed error={error:#}");
        }
    }
}

#[cfg(target_os = "linux")]
struct NbdChunkReader {
    runtime: Option<tokio::runtime::Runtime>,
    handle: Option<Arc<AsyncHandle>>,
    virtual_size_bytes: u64,
    zero_ranges: Vec<Range<u64>>,
    deadline: Instant,
    timed_out: Arc<AtomicBool>,
    _socket_directory: fs::File,
}

#[cfg(target_os = "linux")]
impl NbdChunkReader {
    fn connect(
        socket_directory: &Path,
        deadline: Instant,
        timed_out: Arc<AtomicBool>,
    ) -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .context("failed to create NBD client runtime")?;
        let socket_directory = fs::File::open(socket_directory).with_context(|| {
            format!(
                "failed to open private NBD socket directory '{}'",
                socket_directory.display()
            )
        })?;
        let socket = nbd_socket_client_path(&socket_directory);
        let (handle, virtual_size_bytes, zero_ranges) = runtime.block_on(async move {
            let handle = Arc::new(
                AsyncHandle::new()
                    .map_err(|error| anyhow!("failed to create NBD client: {error}"))?,
            );
            handle
                .add_meta_context(CONTEXT_BASE_ALLOCATION)
                .map_err(|error| anyhow!("failed to request NBD allocation metadata: {error}"))?;
            let remaining = nbd_remaining(deadline, "NBD connect")?;
            tokio::time::timeout(remaining, handle.connect_unix(socket))
                .await
                .context("NBD connect timed out")?
                .map_err(|error| anyhow!("failed to connect to NBD export: {error}"))?;
            ensure!(
                handle
                    .is_read_only()
                    .map_err(|error| anyhow!("failed to inspect NBD readonly state: {error}"))?,
                "NBD export is writable"
            );
            let virtual_size_bytes = handle
                .get_size()
                .map_err(|error| anyhow!("failed to read NBD export size: {error}"))?;
            ensure!(virtual_size_bytes > 0, "NBD export has zero size");
            let zero_ranges = match handle.can_meta_context(CONTEXT_BASE_ALLOCATION) {
                Ok(true) => match query_zero_ranges(&handle, virtual_size_bytes, deadline).await {
                    Ok(ranges) => ranges,
                    Err(error) => {
                        eprintln!(
                            "[intar-nbd-view] allocation_metadata_unavailable error={error:#}; reading all chunks"
                        );
                        Vec::new()
                    }
                },
                Ok(false) => Vec::new(),
                Err(error) => {
                    eprintln!(
                        "[intar-nbd-view] allocation_metadata_unavailable error={error}; reading all chunks"
                    );
                    Vec::new()
                }
            };
            Ok::<_, anyhow::Error>((handle, virtual_size_bytes, zero_ranges))
        })?;
        Ok(Self {
            runtime: Some(runtime),
            handle: Some(handle),
            virtual_size_bytes,
            zero_ranges,
            deadline,
            timed_out,
            _socket_directory: socket_directory,
        })
    }

    fn close(&mut self) -> Result<()> {
        let Some(handle) = self.handle.take() else {
            if let Some(runtime) = self.runtime.take() {
                runtime.shutdown_background();
            }
            return Ok(());
        };
        let result = if tokio::runtime::Handle::try_current().is_ok() {
            // A late RawDirectBuild drop can run inside the builder runtime.
            // No read can be active because reader methods borrow `&mut self`.
            Ok(())
        } else {
            self.runtime
                .as_ref()
                .context("NBD client runtime was already closed")?
                .block_on(async {
                    tokio::time::timeout(RAW_VIEW_CLEANUP_TIMEOUT, handle.disconnect(None))
                        .await
                        .context("NBD client disconnect timed out")?
                        .map_err(|error| anyhow!("failed to disconnect NBD client: {error}"))
                })
        };
        drop(handle);
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
        result
    }
}

#[cfg(target_os = "linux")]
impl Drop for NbdChunkReader {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("[intar-nbd-view] client_cleanup_failed error={error:#}");
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

#[cfg(target_os = "linux")]
impl ImageChunkReader for NbdChunkReader {
    fn virtual_size_bytes(&mut self) -> Result<u64> {
        Ok(self.virtual_size_bytes)
    }

    fn known_zero_ranges(&mut self) -> Result<Option<Vec<Range<u64>>>> {
        Ok(Some(self.zero_ranges.clone()))
    }

    fn read_chunks(&mut self, reads: &[ImageChunkRead]) -> Result<Vec<Vec<u8>>> {
        ensure!(
            !reads.is_empty() && reads.len() <= MAX_CHUNK_READS_IN_FLIGHT,
            "invalid NBD read batch"
        );
        nbd_remaining(self.deadline, "NBD read batch")?;
        for read in reads {
            ensure!(
                read.length > 0
                    && read.length <= IMAGE_CHUNK_SIZE_BYTES as usize
                    && read
                        .offset
                        .checked_add(u64::try_from(read.length)?)
                        .is_some_and(|end| end <= self.virtual_size_bytes),
                "invalid NBD image read"
            );
        }
        let handle = Arc::clone(
            self.handle
                .as_ref()
                .context("NBD client was closed before image reading")?,
        );
        let reads = reads.to_vec();
        let timed_out = Arc::clone(&self.timed_out);
        let deadline = self.deadline;
        self.runtime
            .as_ref()
            .context("NBD client runtime was already closed")?
            .block_on(async move {
                let mut pending = tokio::task::JoinSet::new();
                for (position, read) in reads.iter().enumerate() {
                    let handle = Arc::clone(&handle);
                    let offset = read.offset;
                    let length = read.length;
                    pending.spawn(async move {
                        let mut bytes = vec![0_u8; length];
                        handle
                            .pread(&mut bytes, offset, Some(CmdFlag::empty()))
                            .await
                            .map_err(|error| {
                                anyhow!("NBD read at byte {offset} failed: {error}")
                            })?;
                        Ok::<_, anyhow::Error>((position, bytes))
                    });
                }
                // Do not apply `timeout` here. libnbd owns each Vec pointer until
                // pread completes. The pidfd watchdog closes QSD at the shared
                // deadline; then all tasks drain their buffers before returning.
                let mut results = vec![None; reads.len()];
                let mut first_error = None;
                while let Some(result) = pending.join_next().await {
                    match result {
                        Ok(Ok((position, bytes))) if bytes.len() == reads[position].length => {
                            results[position] = Some(bytes);
                        }
                        Ok(Ok((position, _))) => {
                            first_error.get_or_insert_with(|| {
                                anyhow!("NBD reader returned a partial chunk at index {position}")
                            });
                        }
                        Ok(Err(error)) => {
                            first_error.get_or_insert(error);
                        }
                        Err(error) => {
                            first_error
                                .get_or_insert_with(|| anyhow!("NBD reader task failed: {error}"));
                        }
                    }
                }
                if let Some(error) = first_error {
                    return Err(error);
                }
                ensure!(
                    Instant::now() < deadline && !timed_out.load(Ordering::Acquire),
                    "raw view image-read deadline expired"
                );
                results
                    .into_iter()
                    .map(|bytes| bytes.context("NBD reader omitted a chunk result"))
                    .collect()
            })
    }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct NbdZeroRanges {
    ranges: Vec<Range<u64>>,
    invalid: bool,
}

#[cfg(target_os = "linux")]
async fn query_zero_ranges(
    handle: &Arc<AsyncHandle>,
    virtual_size_bytes: u64,
    deadline: Instant,
) -> Result<Vec<Range<u64>>> {
    let ranges = Arc::new(Mutex::new(NbdZeroRanges::default()));
    let mut offset = 0_u64;
    while offset < virtual_size_bytes {
        nbd_remaining(deadline, "NBD block-status")?;
        let length = (virtual_size_bytes - offset).min(NBD_STATUS_WINDOW_BYTES);
        let end = offset + length;
        let callback_ranges = Arc::clone(&ranges);
        handle
            .block_status_64(
                length,
                offset,
                move |metacontext, callback_offset, extents, callback_error| {
                    if metacontext != CONTEXT_BASE_ALLOCATION {
                        return 0;
                    }
                    let Ok(mut ranges) = callback_ranges.lock() else {
                        *callback_error = 1;
                        return -1;
                    };
                    let mut cursor = callback_offset;
                    for extent in extents {
                        let Some(extent_end) = cursor.checked_add(extent.length) else {
                            ranges.invalid = true;
                            *callback_error = 1;
                            return -1;
                        };
                        if extent.length == 0 || cursor < offset || extent_end > end {
                            ranges.invalid = true;
                            *callback_error = 1;
                            return -1;
                        }
                        if extent.flags & u64::from(STATE_ZERO) != 0 {
                            ranges.ranges.push(cursor..extent_end);
                        }
                        cursor = extent_end;
                    }
                    0
                },
                Some(CmdFlag::empty()),
            )
            .await
            .map_err(|error| anyhow!("NBD block-status at byte {offset} failed: {error}"))?;
        offset = end;
    }
    let ranges = Arc::try_unwrap(ranges)
        .map_err(|_| anyhow!("NBD block-status callback retained zero ranges"))?
        .into_inner()
        .map_err(|_| anyhow!("NBD block-status range lock is poisoned"))?;
    ensure!(
        !ranges.invalid,
        "NBD block-status returned an invalid extent"
    );
    Ok(ranges.ranges)
}

#[cfg(target_os = "linux")]
fn nbd_remaining(deadline: Instant, phase: &str) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .with_context(|| format!("raw view image-read deadline expired before {phase}"))
}

#[cfg(not(target_os = "linux"))]
struct NbdChunkReader;

#[cfg(not(target_os = "linux"))]
impl NbdChunkReader {
    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
impl ImageChunkReader for NbdChunkReader {
    fn virtual_size_bytes(&mut self) -> Result<u64> {
        bail!("Unix NBD image reading requires Linux")
    }

    fn known_zero_ranges(&mut self) -> Result<Option<Vec<Range<u64>>>> {
        bail!("Unix NBD image reading requires Linux")
    }

    fn read_chunks(&mut self, _reads: &[ImageChunkRead]) -> Result<Vec<Vec<u8>>> {
        bail!("Unix NBD image reading requires Linux")
    }
}

fn qsd_arguments(source: &Path, socket: &str, pidfile: &Path) -> Result<Vec<OsString>> {
    let source = source.to_str().context("NBD source path is not UTF-8")?;
    let file_node = serde_json::json!({
        "driver": "file",
        "node-name": "file",
        "filename": source,
        "read-only": true,
    })
    .to_string();
    let qcow2_node = serde_json::json!({
        "driver": "qcow2",
        "node-name": "qcow2",
        "file": "file",
        "read-only": true,
    })
    .to_string();
    let export = serde_json::json!({
        "type": "nbd",
        "id": "intar-raw-view",
        "node-name": "qcow2",
        "name": "",
        "writable": false,
    })
    .to_string();
    Ok(vec![
        "--pidfile".into(),
        pidfile.as_os_str().to_owned(),
        "--blockdev".into(),
        file_node.into(),
        "--blockdev".into(),
        qcow2_node.into(),
        "--nbd-server".into(),
        format!("addr.type=unix,addr.path={socket}").into(),
        "--export".into(),
        export.into(),
    ])
}

fn close_state(state: &mut RawViewState) -> Result<()> {
    let mut errors = Vec::new();
    let mut child_stopped = true;
    if let Some(child) = state.child.as_mut()
        && let Err(error) = terminate_process(child, "NBD storage daemon")
    {
        errors.push(format!("failed to stop NBD storage daemon: {error:#}"));
        child_stopped = false;
    }
    if child_stopped {
        for path in state.parent_qcow2_paths.iter().chain([
            &state.pidfile,
            &state.socket_path,
            &state.stale_raw_path,
            &state.source_qcow2_path,
        ]) {
            if let Err(error) = remove_file_if_exists(path) {
                errors.push(format!("failed to remove '{}': {error:#}", path.display()));
            }
        }
        if let Err(error) = remove_empty_dir_if_exists(&state.socket_directory) {
            errors.push(format!(
                "failed to remove NBD socket directory '{}': {error:#}",
                state.socket_directory.display()
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        bail!(errors.join("; "))
    }
}

pub(super) fn recover_interrupted_raw_view(
    config: &QemuBuildConfig,
    work_root: &Path,
    stale_raw_path: &Path,
    source_qcow2_path: &Path,
) -> Result<()> {
    let socket_directory = work_root.join(NBD_SOCKET_DIRECTORY);
    let state = RawViewState {
        source_qcow2_path: source_qcow2_path.to_path_buf(),
        parent_qcow2_paths: Vec::new(),
        stale_raw_path: stale_raw_path.to_path_buf(),
        socket_path: socket_directory.join(NBD_SOCKET_FILENAME),
        socket_directory,
        pidfile: work_root.join("raw-view.pid"),
        qemu_storage_daemon_binary: config.qemu_storage_daemon_binary.clone(),
        child: None,
        _checkpoint_lease: None,
    };
    recover_stale_raw_view(&state)?;
    remove_file_if_exists(&state.stale_raw_path)?;
    remove_file_if_exists(&state.source_qcow2_path)?;
    for entry in fs::read_dir(work_root).with_context(|| {
        format!(
            "failed to read NBD work directory '{}'",
            work_root.display()
        )
    })? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("active-checkpoint-") && name.ends_with(".qcow2") {
            remove_file_if_exists(&entry.path())?;
        }
        // `capture` creates these directories only under this work root. The
        // caller holds the exclusive direct-build lease, so an interrupted
        // capture cannot still be writing one while it is reclaimed.
        if name.starts_with("checkpoint-") && entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path()).with_context(|| {
                format!(
                    "failed to remove interrupted checkpoint directory '{}'",
                    entry.path().display()
                )
            })?;
        }
    }
    Ok(())
}

fn recover_stale_raw_view(state: &RawViewState) -> Result<()> {
    if let Some(pidfd) = stale_qsd_pidfd(state)? {
        terminate_stale_pidfd(pidfd, "interrupted NBD storage daemon")?;
    }
    remove_file_if_exists(&state.pidfile)?;
    remove_file_if_exists(&state.socket_path)?;
    remove_empty_dir_if_exists(&state.socket_directory)?;
    Ok(())
}

fn socket_is_active(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_socket()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("failed to stat '{}'", path.display())),
    }
}

#[cfg(target_os = "linux")]
fn nbd_socket_client_path(socket_directory: &fs::File) -> PathBuf {
    PathBuf::from(format!(
        "/proc/self/fd/{}/{}",
        socket_directory.as_raw_fd(),
        NBD_SOCKET_FILENAME
    ))
}

fn read_pidfile(path: &Path) -> Result<Option<Pid>> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read '{}'", path.display()));
        }
    };
    let Ok(raw_pid) = contents.trim().parse::<i32>() else {
        return Ok(None);
    };
    if raw_pid <= 0 {
        return Ok(None);
    }
    Pid::from_raw(raw_pid)
        .map(Some)
        .context("NBD pidfile contains an invalid PID")
}

#[cfg(target_os = "linux")]
fn stale_qsd_pidfd(state: &RawViewState) -> Result<Option<rustix::fd::OwnedFd>> {
    let Some(pid) = read_pidfile(&state.pidfile)? else {
        return Ok(None);
    };
    let pidfd = match pidfd_open(pid, PidfdFlags::empty()) {
        Ok(pidfd) => pidfd,
        Err(error) if error == rustix::io::Errno::SRCH => return Ok(None),
        Err(error) => return Err(error).context("failed to bind NBD pidfile to a process"),
    };
    if !qsd_command_matches(pid, &state.pidfile)? {
        return Ok(None);
    }
    Ok(Some(pidfd))
}

#[cfg(not(target_os = "linux"))]
fn stale_qsd_pidfd(state: &RawViewState) -> Result<Option<rustix::fd::OwnedFd>> {
    let _ = read_pidfile(&state.pidfile)?;
    Ok(None)
}

#[cfg(target_os = "linux")]
fn qsd_command_matches(pid: Pid, pidfile: &Path) -> Result<bool> {
    let command_path = format!("/proc/{}/cmdline", pid.as_raw_pid());
    let command = match fs::read(&command_path) {
        Ok(command) => command,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read QSD command line '{}'", command_path));
        }
    };
    let arguments = command
        .split(|byte| *byte == 0)
        .filter(|argument| !argument.is_empty())
        .collect::<Vec<_>>();
    Ok(qsd_command_arguments_match(
        &arguments,
        pidfile.as_os_str().as_bytes(),
        NBD_SOCKET_RELATIVE_PATH,
    ))
}

#[cfg(target_os = "linux")]
fn qsd_command_arguments_match(
    arguments: &[&[u8]],
    expected_pidfile: &[u8],
    expected_socket: &str,
) -> bool {
    let pidfile_matches = arguments
        .windows(2)
        .any(|pair| pair[0] == b"--pidfile" && pair[1] == expected_pidfile);
    let expected_server = format!("addr.type=unix,addr.path={expected_socket}");
    let server_matches = arguments
        .windows(2)
        .any(|pair| pair[0] == b"--nbd-server" && pair[1] == expected_server.as_bytes());
    let export_matches = arguments.windows(2).any(|pair| {
        pair[0] == b"--export"
            && serde_json::from_slice::<serde_json::Value>(pair[1]).is_ok_and(|export| {
                export["type"] == "nbd"
                    && export["node-name"] == "qcow2"
                    && export["writable"] == false
            })
    });
    pidfile_matches && server_matches && export_matches
}

#[cfg(target_os = "linux")]
fn terminate_stale_pidfd(pidfd: rustix::fd::OwnedFd, label: &str) -> Result<()> {
    match pidfd_send_signal(&pidfd, Signal::TERM) {
        Ok(()) => {}
        Err(error) if error == rustix::io::Errno::SRCH => return Ok(()),
        Err(error) => {
            return force_kill_pidfd(&pidfd, label).with_context(|| {
                format!("failed to send SIGTERM to {label}: {error}; SIGKILL fallback failed")
            });
        }
    }
    match wait_for_pidfd_exit(&pidfd, RAW_VIEW_CLEANUP_TIMEOUT, label) {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(error) => {
            return force_kill_pidfd(&pidfd, label).with_context(|| {
                format!("failed while waiting for {label} after SIGTERM: {error}; SIGKILL fallback failed")
            });
        }
    }
    force_kill_pidfd(&pidfd, label)
}

#[cfg(target_os = "linux")]
fn force_kill_pidfd(pidfd: &rustix::fd::OwnedFd, label: &str) -> Result<()> {
    match pidfd_send_signal(pidfd, Signal::KILL) {
        Ok(()) => {}
        Err(error) if error == rustix::io::Errno::SRCH => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("failed to kill {label}")),
    }
    ensure!(
        wait_for_pidfd_exit(pidfd, RAW_VIEW_CLEANUP_TIMEOUT, label)?,
        "{label} did not exit after SIGKILL"
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn wait_for_pidfd_exit(
    pidfd: &rustix::fd::OwnedFd,
    timeout: Duration,
    _label: &str,
) -> Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        let mut pollfd = [PollFd::new(pidfd, PollFlags::IN)];
        poll(
            &mut pollfd,
            Some(&Timespec {
                tv_sec: 0,
                tv_nsec: i64::try_from(RAW_VIEW_POLL_INTERVAL.as_nanos())?,
            }),
        )
        .context("failed to poll NBD pidfd")?;
        if !pollfd[0].revents().is_empty() {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn terminate_stale_pidfd(_pidfd: rustix::fd::OwnedFd, _label: &str) -> Result<()> {
    Ok(())
}

fn wait_for_process(child: &mut Child, timeout: Duration, label: &str) -> Result<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("failed to poll {label}"))?
        {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let status = child
                .wait()
                .with_context(|| format!("failed to reap timed out {label}"))?;
            bail!("{label} timed out and was terminated with status {status}");
        }
        thread::sleep(RAW_VIEW_POLL_INTERVAL);
    }
}

fn terminate_process(child: &mut Child, label: &str) -> Result<()> {
    match child.try_wait() {
        Ok(Some(_)) => return Ok(()),
        Ok(None) => {}
        Err(error) => return Err(error).with_context(|| format!("failed to poll {label}")),
    }
    let raw_pid = i32::try_from(child.id()).context("child PID does not fit i32")?;
    let pid = Pid::from_raw(raw_pid).context("child PID is not valid")?;
    if let Err(error) = kill_process(pid, Signal::TERM) {
        if child
            .try_wait()
            .with_context(|| format!("failed to poll {label} after SIGTERM"))?
            .is_none()
        {
            return Err(error).with_context(|| format!("failed to send SIGTERM to {label}"));
        }
        return Ok(());
    }
    let _ = wait_for_process(child, RAW_VIEW_CLEANUP_TIMEOUT, label)?;
    Ok(())
}

fn prepare_socket_directory(path: &Path) -> Result<()> {
    fs::create_dir(path).with_context(|| {
        format!(
            "failed to create private NBD socket directory '{}'",
            path.display()
        )
    })?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).with_context(|| {
        format!(
            "failed to set private NBD socket directory mode '{}'",
            path.display()
        )
    })?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove '{}'", path.display())),
    }
}

fn remove_empty_dir_if_exists(path: &Path) -> Result<()> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove '{}'", path.display())),
    }
}

#[cfg(test)]
struct TestChunkReader {
    virtual_size_bytes: u64,
}

#[cfg(test)]
impl ImageChunkReader for TestChunkReader {
    fn virtual_size_bytes(&mut self) -> Result<u64> {
        Ok(self.virtual_size_bytes)
    }

    fn known_zero_ranges(&mut self) -> Result<Option<Vec<Range<u64>>>> {
        Ok(None)
    }

    fn read_chunks(&mut self, _reads: &[ImageChunkRead]) -> Result<Vec<Vec<u8>>> {
        bail!("test NBD reader must not read a registry-reused chunk")
    }
}

#[cfg(test)]
pub(super) fn test_guard(
    source_qcow2_path: PathBuf,
    stale_raw_path: PathBuf,
    read_timed_out: bool,
) -> RawViewGuard {
    let socket_directory = stale_raw_path.with_extension("nbd");
    let virtual_size_bytes = fs::metadata(&stale_raw_path)
        .map(|metadata| metadata.len())
        .ok()
        .filter(|size| *size > 0)
        .unwrap_or(1);
    RawViewGuard {
        reader: None,
        test_reader: Some(TestChunkReader { virtual_size_bytes }),
        state: Some(RawViewState {
            pidfile: stale_raw_path.with_extension("pid"),
            source_qcow2_path,
            parent_qcow2_paths: Vec::new(),
            stale_raw_path,
            socket_path: socket_directory.join(NBD_SOCKET_FILENAME),
            socket_directory,
            qemu_storage_daemon_binary: PathBuf::from("qemu-storage-daemon"),
            child: None,
            _checkpoint_lease: None,
        }),
        watchdog: None,
        deadline: if read_timed_out {
            Instant::now()
        } else {
            Instant::now() + Duration::from_secs(60)
        },
        read_timed_out: Arc::new(AtomicBool::new(read_timed_out)),
        watchdog_error: Arc::new(Mutex::new(None)),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::os::unix::fs::PermissionsExt as _;
    use std::path::PathBuf;
    #[cfg(target_os = "linux")]
    use std::process::{Command, Stdio};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use tempfile::tempdir;

    use crate::config::QemuBuildConfig;
    #[cfg(target_os = "linux")]
    use rustix::process::{Pid, PidfdFlags, pidfd_open};

    use super::{
        NBD_SOCKET_FILENAME, NBD_SOCKET_RELATIVE_PATH, RawViewGuard, RawViewState,
        prepare_socket_directory, qsd_arguments, read_pidfile, recover_interrupted_raw_view,
        recover_stale_raw_view, test_guard,
    };
    #[cfg(target_os = "linux")]
    use super::{nbd_socket_client_path, qsd_command_arguments_match};

    #[test]
    fn qsd_arguments_keep_both_nodes_readonly_and_use_one_private_nbd_socket() {
        let args = qsd_arguments(
            PathBuf::from("/work/source,quoted.qcow2").as_path(),
            NBD_SOCKET_RELATIVE_PATH,
            PathBuf::from("/work/raw-view.pid").as_path(),
        )
        .unwrap();
        let args = args
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let file: serde_json::Value = serde_json::from_str(&args[3]).unwrap();
        let qcow2: serde_json::Value = serde_json::from_str(&args[5]).unwrap();
        let export: serde_json::Value = serde_json::from_str(&args[9]).unwrap();

        assert_eq!(file["filename"], "/work/source,quoted.qcow2");
        assert_eq!(file["read-only"], true);
        assert_eq!(qcow2["read-only"], true);
        assert_eq!(args[6], "--nbd-server");
        assert_eq!(
            args[7],
            "addr.type=unix,addr.path=raw-view-nbd/raw-view.sock"
        );
        assert_eq!(export["type"], "nbd");
        assert_eq!(export["name"], "");
        assert_eq!(export["writable"], false);
    }

    #[test]
    fn private_socket_directory_has_owner_only_permissions() {
        let directory = tempdir().unwrap();
        let socket_directory = directory.path().join("raw-view-nbd");

        prepare_socket_directory(&socket_directory).unwrap();

        assert_eq!(
            std::fs::metadata(&socket_directory)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn long_work_paths_use_short_qsd_and_client_socket_paths() {
        let directory = tempdir().unwrap();
        let work_root = directory
            .path()
            .join("scenario-".to_string() + &"x".repeat(80))
            .join("vm-".to_string() + &"y".repeat(80));
        let socket_directory = work_root.join("raw-view-nbd");
        std::fs::create_dir_all(&socket_directory).unwrap();
        let directory_fd = std::fs::File::open(&socket_directory).unwrap();
        let client_path = nbd_socket_client_path(&directory_fd);

        assert!(
            socket_directory
                .join(NBD_SOCKET_FILENAME)
                .as_os_str()
                .as_encoded_bytes()
                .len()
                >= 108
        );
        assert!(NBD_SOCKET_RELATIVE_PATH.len() < 108);
        assert!(client_path.as_os_str().as_encoded_bytes().len() < 108);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stale_qsd_recovery_requires_its_exact_pidfile_and_nbd_socket() {
        let command: &[&[u8]] = &[
            b"qemu-storage-daemon",
            b"--pidfile",
            b"/work/raw-view.pid",
            b"--nbd-server",
            b"addr.type=unix,addr.path=raw-view-nbd/raw-view.sock",
            b"--export",
            br#"{"type":"nbd","node-name":"qcow2","writable":false}"#,
        ];

        assert!(qsd_command_arguments_match(
            command,
            b"/work/raw-view.pid",
            "raw-view-nbd/raw-view.sock"
        ));
        assert!(!qsd_command_arguments_match(
            command,
            b"/work/other.pid",
            "raw-view-nbd/raw-view.sock"
        ));
        assert!(!qsd_command_arguments_match(
            command,
            b"/work/raw-view.pid",
            "/work/other.sock"
        ));
    }

    #[test]
    fn close_removes_private_source_parents_socket_and_stale_raw_file_once() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let parent = directory.path().join("active-checkpoint-0.qcow2");
        let stale_raw = directory.path().join("root.raw");
        let socket_directory = directory.path().join("raw-view-nbd");
        let socket = socket_directory.join(NBD_SOCKET_FILENAME);
        let pidfile = directory.path().join("raw-view.pid");
        std::fs::create_dir(&socket_directory).unwrap();
        for path in [&source, &parent, &stale_raw, &socket, &pidfile] {
            std::fs::write(path, b"private").unwrap();
        }
        let mut guard = RawViewGuard {
            reader: None,
            test_reader: None,
            state: Some(RawViewState {
                source_qcow2_path: source.clone(),
                parent_qcow2_paths: vec![parent.clone()],
                stale_raw_path: stale_raw.clone(),
                socket_directory: socket_directory.clone(),
                socket_path: socket.clone(),
                pidfile: pidfile.clone(),
                qemu_storage_daemon_binary: PathBuf::from("qemu-storage-daemon"),
                child: None,
                _checkpoint_lease: None,
            }),
            watchdog: None,
            deadline: Instant::now() + Duration::from_secs(60),
            read_timed_out: Arc::new(AtomicBool::new(false)),
            watchdog_error: Arc::new(Mutex::new(None)),
        };

        guard.close().unwrap();
        guard.close().unwrap();

        assert!(!source.exists());
        assert!(!parent.exists());
        assert!(!stale_raw.exists());
        assert!(!socket.exists());
        assert!(!socket_directory.exists());
        assert!(!pidfile.exists());
    }

    #[test]
    fn close_rejects_an_elapsed_deadline_without_a_watchdog_event() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let stale_raw = directory.path().join("root.raw");
        std::fs::write(&source, b"private").unwrap();
        std::fs::write(&stale_raw, b"stale").unwrap();
        let mut guard = test_guard(source.clone(), stale_raw.clone(), false);
        guard.deadline = Instant::now() - Duration::from_millis(1);

        let error = guard.close().unwrap_err();

        assert!(format!("{error:#}").contains("image-read deadline expired"));
        assert!(!source.exists());
        assert!(!stale_raw.exists());
    }

    #[test]
    fn failed_start_reclaims_private_source_socket_and_stale_raw_file() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let stale_raw = directory.path().join("root.raw");
        std::fs::write(&source, b"private").unwrap();
        std::fs::write(&stale_raw, b"stale").unwrap();
        let config = QemuBuildConfig {
            qemu_storage_daemon_binary: PathBuf::from("true"),
            ..QemuBuildConfig::default()
        };

        let error = RawViewGuard::start(
            &config,
            directory.path(),
            source.clone(),
            Vec::new(),
            stale_raw.clone(),
            None,
            Duration::from_secs(1),
        )
        .unwrap_err();

        assert!(format!("{error:#}").contains("storage daemon exited"));
        assert!(!source.exists());
        assert!(!stale_raw.exists());
        assert!(!directory.path().join("raw-view-nbd").exists());
        assert!(!directory.path().join("raw-view.pid").exists());
    }

    #[test]
    fn recovery_discards_malformed_and_nonpositive_stale_pidfiles_before_reuse() {
        let directory = tempdir().unwrap();
        for value in ["not-a-pid", "0", "-1"] {
            let pidfile = directory.path().join("raw-view.pid");
            std::fs::write(&pidfile, format!("{value}\n")).unwrap();
            let socket_directory = directory.path().join("raw-view-nbd");
            let state = RawViewState {
                source_qcow2_path: directory.path().join("active.qcow2"),
                parent_qcow2_paths: Vec::new(),
                stale_raw_path: directory.path().join("root.raw"),
                socket_path: socket_directory.join(NBD_SOCKET_FILENAME),
                socket_directory,
                pidfile: pidfile.clone(),
                qemu_storage_daemon_binary: PathBuf::from("qemu-storage-daemon"),
                child: None,
                _checkpoint_lease: None,
            };

            assert!(read_pidfile(&pidfile).unwrap().is_none(), "{value}");
            recover_stale_raw_view(&state).unwrap();

            assert!(!pidfile.exists(), "{value}");
        }
    }

    #[test]
    fn early_recovery_removes_stale_nbd_files_before_disk_preparation() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let parent = directory.path().join("active-checkpoint-0.qcow2");
        let stale_raw = directory.path().join("root.raw");
        let checkpoint = directory.path().join("checkpoint-interrupted");
        let socket_directory = directory.path().join("raw-view-nbd");
        std::fs::create_dir(&checkpoint).unwrap();
        std::fs::create_dir(&socket_directory).unwrap();
        std::fs::write(checkpoint.join("memory.state.zst"), b"stale memory").unwrap();
        std::fs::write(checkpoint.join("checkpoint.qcow2"), b"stale disk").unwrap();
        std::fs::write(socket_directory.join(NBD_SOCKET_FILENAME), b"stale socket").unwrap();
        std::fs::write(&source, b"stale source").unwrap();
        std::fs::write(&parent, b"stale parent").unwrap();
        std::fs::write(&stale_raw, b"stale root").unwrap();

        recover_interrupted_raw_view(
            &QemuBuildConfig::default(),
            directory.path(),
            &stale_raw,
            &source,
        )
        .unwrap();

        assert!(!source.exists());
        assert!(!parent.exists());
        assert!(!stale_raw.exists());
        assert!(!checkpoint.exists());
        assert!(!socket_directory.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn read_deadline_terminates_the_owned_process() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let stale_raw = directory.path().join("root.raw");
        std::fs::write(&source, b"private").unwrap();
        std::fs::write(&stale_raw, b"stale").unwrap();
        let child = Command::new("sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = Pid::from_raw(i32::try_from(child.id()).unwrap()).unwrap();
        let pidfd = pidfd_open(pid, PidfdFlags::empty()).unwrap();
        let socket_directory = directory.path().join("raw-view-nbd");
        let mut guard = RawViewGuard {
            reader: None,
            test_reader: None,
            state: Some(RawViewState {
                source_qcow2_path: source.clone(),
                parent_qcow2_paths: Vec::new(),
                stale_raw_path: stale_raw.clone(),
                socket_path: socket_directory.join(NBD_SOCKET_FILENAME),
                socket_directory,
                pidfile: directory.path().join("raw-view.pid"),
                qemu_storage_daemon_binary: PathBuf::from("qemu-storage-daemon"),
                child: Some(child),
                _checkpoint_lease: None,
            }),
            watchdog: None,
            deadline: Instant::now() + Duration::from_secs(60),
            read_timed_out: Arc::new(AtomicBool::new(false)),
            watchdog_error: Arc::new(Mutex::new(None)),
        };

        guard
            .start_watchdog(Duration::from_millis(10), pidfd)
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let error = guard.close().unwrap_err();

        assert!(format!("{error:#}").contains("image-read deadline expired"));
        assert!(!source.exists());
        assert!(!stale_raw.exists());
    }
}
