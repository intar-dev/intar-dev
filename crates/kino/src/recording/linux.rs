use crate::config::RecordingConfig;
use crate::recording::ShellStartupMode;
use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use crossterm::terminal;
use pty_process::Size as BlockingPtySize;
use pty_process::blocking::{Command as PtyCommand, Pty as BlockingPty, open as open_pty};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};
use rustix::io::{Errno as RustixErrno, dup, read as fd_read, write as fd_write};
use rustix::pipe::{PipeFlags, pipe_with};
use rustix::process::{Pid, Signal, kill_process, kill_process_group};
use serde::Serialize;
use signal_hook::consts::signal::{SIGHUP, SIGTERM, SIGWINCH};
use signal_hook::iterator::{Handle as SignalsHandle, Signals};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::io::{self, IsTerminal, Read, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_TTY_WIDTH: u16 = 80;
const DEFAULT_TTY_HEIGHT: u16 = 24;
const RECORDING_SYNC_INTERVAL_MS: u64 = 250;
const RAW_RECORDING_VERSION: u8 = 1;
const RAW_RECORDING_FORMAT: &str = "kino.raw-event-log";
const INTERACTIVE_POLL_INTERVAL: Duration = Duration::from_millis(50);
const INTERACTIVE_DRAIN_QUIET_PERIOD: Duration = Duration::from_millis(500);

#[derive(Debug, Serialize)]
struct RawRecordingHeader {
    #[serde(rename = "type")]
    line_type: &'static str,
    format: &'static str,
    version: u8,
    width: u16,
    height: u16,
    start_timestamp_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default)]
struct RecordingMetadata {
    command: Option<String>,
    env: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
struct RawRecordingEvent {
    #[serde(rename = "type")]
    line_type: &'static str,
    offset_ms: u64,
    event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

struct RawEventLogWriter {
    file: File,
    partial_path: PathBuf,
    final_path: PathBuf,
    start_ts_unix_ms: u64,
    last_sync_ts_unix_ms: u64,
    finished: bool,
}

impl RawEventLogWriter {
    fn start(
        output_dir: &Path,
        start_ts_unix_ms: u64,
        width: u16,
        height: u16,
        metadata: RecordingMetadata,
    ) -> io::Result<(Self, PathBuf)> {
        fs::create_dir_all(output_dir)?;

        let (file, partial_path, final_path) = create_session_file(output_dir, start_ts_unix_ms)?;
        let mut writer = Self {
            file,
            partial_path,
            final_path: final_path.clone(),
            start_ts_unix_ms,
            last_sync_ts_unix_ms: start_ts_unix_ms,
            finished: false,
        };

        let header = RawRecordingHeader {
            line_type: "header",
            format: RAW_RECORDING_FORMAT,
            version: RAW_RECORDING_VERSION,
            width,
            height,
            start_timestamp_ms: start_ts_unix_ms,
            command: metadata.command,
            env: metadata.env,
        };
        let line = serde_json::to_string(&header).map_err(io::Error::other)?;
        writer.file.write_all(line.as_bytes())?;
        writer.file.write_all(b"\n")?;
        writer.file.sync_data()?;

        Ok((writer, final_path))
    }

    fn write_input_bytes(&mut self, ts_unix_ms: u64, bytes: &[u8]) -> io::Result<()> {
        self.write_stream_event(ts_unix_ms, "i", bytes)
    }

    fn write_output_bytes(&mut self, ts_unix_ms: u64, bytes: &[u8]) -> io::Result<()> {
        self.write_stream_event(ts_unix_ms, "o", bytes)
    }

    fn write_resize(&mut self, ts_unix_ms: u64, width: u16, height: u16) -> io::Result<()> {
        let event = RawRecordingEvent {
            line_type: "event",
            offset_ms: ts_unix_ms.saturating_sub(self.start_ts_unix_ms),
            event: "r",
            data_b64: None,
            width: Some(width),
            height: Some(height),
            exit_code: None,
        };
        self.write_event_line(ts_unix_ms, &event)
    }

    fn write_exit(&mut self, ts_unix_ms: u64, exit_code: i32) -> io::Result<()> {
        let event = RawRecordingEvent {
            line_type: "event",
            offset_ms: ts_unix_ms.saturating_sub(self.start_ts_unix_ms),
            event: "x",
            data_b64: None,
            width: None,
            height: None,
            exit_code: Some(exit_code),
        };
        self.write_event_line(ts_unix_ms, &event)
    }

    fn finish(&mut self) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        self.file.sync_all()?;
        // Publish completion without ever replacing a learner-created path.
        // `RENAME_NOREPLACE` atomically moves the fully synced partial file
        // into place. A collision leaves both the final file and our partial
        // recording untouched, so the caller can surface the error safely.
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            &self.partial_path,
            rustix::fs::CWD,
            &self.final_path,
            rustix::fs::RenameFlags::NOREPLACE,
        )?;
        self.finished = true;
        Ok(())
    }

    fn sync_data_if_due(&mut self, ts_unix_ms: u64) -> io::Result<()> {
        if ts_unix_ms.saturating_sub(self.last_sync_ts_unix_ms) < RECORDING_SYNC_INTERVAL_MS {
            return Ok(());
        }
        self.file.sync_data()?;
        self.last_sync_ts_unix_ms = ts_unix_ms;
        Ok(())
    }

    fn write_stream_event(
        &mut self,
        ts_unix_ms: u64,
        kind: &'static str,
        bytes: &[u8],
    ) -> io::Result<()> {
        let event = RawRecordingEvent {
            line_type: "event",
            offset_ms: ts_unix_ms.saturating_sub(self.start_ts_unix_ms),
            event: kind,
            data_b64: Some(BASE64_STANDARD.encode(bytes)),
            width: None,
            height: None,
            exit_code: None,
        };
        self.write_event_line(ts_unix_ms, &event)
    }

    fn write_event_line(&mut self, ts_unix_ms: u64, event: &RawRecordingEvent) -> io::Result<()> {
        let line = serde_json::to_string(event).map_err(io::Error::other)?;
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.sync_data_if_due(ts_unix_ms)?;
        Ok(())
    }
}

pub(crate) fn record_command(config: &RecordingConfig, command: &str) -> Result<i32> {
    let start_ts_unix_ms = unix_ms();
    let (width, height) = tty_dimensions();
    let metadata =
        build_recording_metadata(config, (!command.is_empty()).then(|| command.to_owned()));
    let (writer, recording_path) = RawEventLogWriter::start(
        &config.output_dir,
        start_ts_unix_ms,
        width,
        height,
        metadata,
    )
    .with_context(|| {
        format!(
            "failed to create recording file in {}",
            config.output_dir.display()
        )
    })?;

    let shared_writer = Arc::new(Mutex::new(writer));
    write_command_input_event(&shared_writer, &recording_path, command)?;

    let mut child = spawn_recorded_command(&config.real_shell, command)?;
    let CommandIoCapture {
        rx,
        stdout_handle,
        stderr_handle,
        input_error,
        stdout_error,
        stderr_error,
    } = start_command_io_capture(&mut child, Arc::clone(&shared_writer))?;

    forward_and_record_command_output(&shared_writer, &recording_path, rx)?;
    finalize_command_output_capture(
        stdout_handle,
        stderr_handle,
        &input_error,
        &stdout_error,
        &stderr_error,
    )?;

    let exit_code = wait_for_command_exit(&mut child)?;

    {
        let mut writer = shared_writer
            .lock()
            .map_err(|_| anyhow!("cast writer lock poisoned"))?;
        writer.write_exit(unix_ms(), exit_code).with_context(|| {
            format!(
                "failed to write command exit event to {}",
                recording_path.display()
            )
        })?;
        writer.finish().with_context(|| {
            format!(
                "failed to flush recording file {}",
                recording_path.display()
            )
        })?;
    }

    Ok(exit_code)
}

pub(crate) fn record_ssh(
    config: &RecordingConfig,
    command: Option<&str>,
    startup_mode: ShellStartupMode,
) -> Result<i32> {
    ensure_interactive_tty()?;
    record_ssh_linux(config, command, startup_mode)
}

fn record_ssh_linux(
    config: &RecordingConfig,
    command: Option<&str>,
    startup_mode: ShellStartupMode,
) -> Result<i32> {
    let (width, height) = tty_dimensions();
    let (shared_writer, recording_path, _raw_mode) =
        prepare_interactive_writer(config, width, height, command)?;
    if let Some(command) = command {
        write_command_input_event(&shared_writer, &recording_path, command)?;
    }
    let mut session =
        LinuxInteractiveSession::start(&config.real_shell, width, height, command, startup_mode)?;
    let loop_result = run_linux_interactive_loop(&mut session, &shared_writer, &recording_path);
    if loop_result.is_err() {
        // Interactive shells ignore TERM; escalate so finish() can join
        // the shell wait thread instead of hanging on an immortal shell.
        best_effort_terminate_process_group(session.child_pid);
        best_effort_kill_shell(session.child_pid, Signal::KILL);
    }
    let exit_code = session.finish(loop_result)?;

    {
        let mut writer = shared_writer
            .lock()
            .map_err(|_| anyhow!("cast writer lock poisoned"))?;
        writer.write_exit(unix_ms(), exit_code).with_context(|| {
            format!(
                "failed to write shell exit event to {}",
                recording_path.display()
            )
        })?;
        writer.finish().with_context(|| {
            format!(
                "failed to flush recording file {}",
                recording_path.display()
            )
        })?;
    }

    Ok(exit_code)
}

fn ensure_interactive_tty() -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();

    if !stdin.is_terminal() || !stdout.is_terminal() {
        bail!("interactive recording requires a TTY");
    }

    Ok(())
}

fn tty_dimensions() -> (u16, u16) {
    match terminal::size() {
        Ok((width, height)) if width > 0 && height > 0 => (width, height),
        _ => (DEFAULT_TTY_WIDTH, DEFAULT_TTY_HEIGHT),
    }
}

fn prepare_interactive_writer(
    config: &RecordingConfig,
    width: u16,
    height: u16,
    command: Option<&str>,
) -> Result<(Arc<Mutex<RawEventLogWriter>>, PathBuf, RawModeGuard)> {
    let start_ts_unix_ms = unix_ms();
    let metadata = build_recording_metadata(
        config,
        command
            .map(str::to_owned)
            .or_else(|| Some(config.real_shell.to_string_lossy().into_owned())),
    );
    let (writer, recording_path) = RawEventLogWriter::start(
        &config.output_dir,
        start_ts_unix_ms,
        width,
        height,
        metadata,
    )
    .with_context(|| {
        format!(
            "failed to create recording file in {}",
            config.output_dir.display()
        )
    })?;
    let raw_mode = RawModeGuard::new()?;

    Ok((Arc::new(Mutex::new(writer)), recording_path, raw_mode))
}

struct PendingInputBuffer {
    bytes: Vec<u8>,
    offset: usize,
}

impl PendingInputBuffer {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            offset: 0,
        }
    }

    fn is_empty(&self) -> bool {
        self.offset >= self.bytes.len()
    }

    fn push(&mut self, bytes: &[u8]) {
        if self.is_empty() {
            self.bytes.clear();
            self.offset = 0;
        }
        self.bytes.extend_from_slice(bytes);
    }

    fn remaining(&self) -> &[u8] {
        &self.bytes[self.offset..]
    }

    fn advance(&mut self, written: usize) {
        self.offset = self.offset.saturating_add(written);
        if self.is_empty() {
            self.bytes.clear();
            self.offset = 0;
        }
    }
}

struct LinuxInteractiveSession {
    pty: BlockingPty,
    child_pid: Option<Pid>,
    exit_state: Arc<Mutex<Option<Result<i32, String>>>>,
    exit_notify_read: OwnedFd,
    wait_handle: thread::JoinHandle<()>,
    resize_state: Arc<Mutex<Option<(u16, u16)>>>,
    hangup_state: Arc<AtomicBool>,
    resize_notify_read: OwnedFd,
    resize_handle: SignalsHandle,
    resize_thread: thread::JoinHandle<()>,
}

impl LinuxInteractiveSession {
    fn start(
        real_shell: &Path,
        width: u16,
        height: u16,
        command: Option<&str>,
        startup_mode: ShellStartupMode,
    ) -> Result<Self> {
        let (pty, pts) = open_pty().context("failed to allocate PTY")?;
        pty.resize(BlockingPtySize::new(height, width))
            .context("failed to set PTY size")?;
        set_nonblocking(&pty)?;

        let slave_keepalive = dup(&pts).context("failed to duplicate PTY slave")?;
        let mut builder = PtyCommand::new(real_shell);
        for arg in shell_startup_args(startup_mode, command) {
            builder = builder.arg(arg);
        }
        let mut child = builder
            .spawn(pts)
            .with_context(|| format!("failed to launch shell {}", real_shell.display()))?;
        let child_pid = Pid::from_raw(i32::try_from(child.id()).unwrap_or_default());

        let (exit_notify_read, exit_notify_write) =
            pipe_with(PipeFlags::NONBLOCK | PipeFlags::CLOEXEC)
                .context("failed to create child exit notify pipe")?;
        let exit_state = Arc::new(Mutex::new(None::<Result<i32, String>>));
        let exit_state_thread = Arc::clone(&exit_state);
        let wait_handle = thread::spawn(move || {
            let result = child
                .wait()
                .map(normalize_exit_status)
                .map_err(|error| format!("failed waiting for shell: {error}"));
            drop(slave_keepalive);
            if let Ok(mut guard) = exit_state_thread.lock()
                && guard.is_none()
            {
                *guard = Some(result);
            }
            notify_pipe(&exit_notify_write);
        });

        let (resize_notify_read, resize_notify_write) =
            pipe_with(PipeFlags::NONBLOCK | PipeFlags::CLOEXEC)
                .context("failed to create resize notify pipe")?;
        let resize_state = Arc::new(Mutex::new(None::<(u16, u16)>));
        let resize_state_thread = Arc::clone(&resize_state);
        // Registering SIGHUP/SIGTERM keeps the recorder alive when sshd
        // tears the session down (browser close, route revocation): the
        // loop drains what the shell already produced, writes the exit
        // event, and syncs the recording instead of dying mid-write. The
        // 50ms poll tick observes the flag.
        let hangup_state = Arc::new(AtomicBool::new(false));
        signal_hook::flag::register(SIGHUP, Arc::clone(&hangup_state))
            .context("failed to subscribe to SIGHUP")?;
        signal_hook::flag::register(SIGTERM, Arc::clone(&hangup_state))
            .context("failed to subscribe to SIGTERM")?;
        let mut signals = Signals::new([SIGWINCH]).context("failed to subscribe to SIGWINCH")?;
        let resize_handle = signals.handle();
        let resize_thread = thread::spawn(move || {
            for _ in signals.forever() {
                let dimensions = tty_dimensions();
                if let Ok(mut guard) = resize_state_thread.lock() {
                    *guard = Some(dimensions);
                }
                notify_pipe(&resize_notify_write);
            }
        });

        Ok(Self {
            pty,
            child_pid,
            exit_state,
            exit_notify_read,
            wait_handle,
            resize_state,
            hangup_state,
            resize_notify_read,
            resize_handle,
            resize_thread,
        })
    }

    fn finish(self, loop_result: Result<i32>) -> Result<i32> {
        self.resize_handle.close();
        let _ = self.resize_thread.join();
        let _ = self.wait_handle.join();

        let wait_result = take_shared_result(&self.exit_state);

        match loop_result {
            Ok(exit_code) => Ok(exit_code),
            Err(error) => match wait_result {
                Some(Err(wait_error)) => Err(anyhow!(wait_error)).context(error),
                Some(Ok(_)) | None => Err(error),
            },
        }
    }
}

fn shell_startup_args(startup_mode: ShellStartupMode, command: Option<&str>) -> Vec<String> {
    if let Some(command) = command {
        return vec!["-c".to_owned(), command.to_owned()];
    }

    match startup_mode {
        ShellStartupMode::Login => vec!["-l".to_owned()],
        ShellStartupMode::Interactive => vec!["-i".to_owned()],
    }
}

const HANGUP_SHELL_KILL_GRACE: Duration = Duration::from_secs(2);
const HANGUP_DRAIN_DEADLINE: Duration = Duration::from_secs(5);

struct OutputDrainState {
    last_output_at: Instant,
    pty_hup_seen: bool,
    forwarding_broken: bool,
}

fn run_linux_interactive_loop(
    session: &mut LinuxInteractiveSession,
    writer: &Arc<Mutex<RawEventLogWriter>>,
    recording_path: &Path,
) -> Result<i32> {
    let stdin = io::stdin();
    let mut pending_input = PendingInputBuffer::new();
    let mut stdin_closed = false;
    let mut exit_code = None::<i32>;
    let mut exit_observed_at = None::<Instant>;
    let mut output = OutputDrainState {
        last_output_at: Instant::now(),
        pty_hup_seen: false,
        forwarding_broken: false,
    };
    let mut hangup_observed_at = None::<Instant>;
    let mut hangup_killed_shell = false;
    let mut pty_buffer = [0_u8; 4096];
    let mut stdin_buffer = [0_u8; 4096];

    loop {
        let mut poll_fds = [
            PollFd::new(
                &session.pty,
                PollFlags::IN
                    | PollFlags::ERR
                    | PollFlags::HUP
                    | if pending_input.is_empty() {
                        PollFlags::empty()
                    } else {
                        PollFlags::OUT
                    },
            ),
            PollFd::new(
                &stdin,
                if stdin_closed {
                    PollFlags::empty()
                } else {
                    PollFlags::IN
                },
            ),
            PollFd::new(&session.exit_notify_read, PollFlags::IN),
            PollFd::new(&session.resize_notify_read, PollFlags::IN),
        ];
        let timeout = Timespec::try_from(INTERACTIVE_POLL_INTERVAL)
            .context("failed to build PTY poll timeout")?;
        // EINTR is a signal wakeup (SIGWINCH resize, SIGHUP/SIGTERM
        // hangup) — fall through so the flag checks below observe it.
        match poll(&mut poll_fds, Some(&timeout)) {
            Ok(_) | Err(RustixErrno::INTR) => {}
            Err(error) => {
                return Err(error).context("failed polling PTY session fds");
            }
        }
        let exit_ready = poll_fds[2].revents().contains(PollFlags::IN);
        let resize_ready = poll_fds[3].revents().contains(PollFlags::IN);
        let pty_events = poll_fds[0].revents();
        let stdin_ready = !stdin_closed && poll_fds[1].revents().contains(PollFlags::IN);

        if exit_ready {
            handle_exit_notification(session, &mut exit_code, &mut exit_observed_at)?;
        }

        if resize_ready {
            handle_resize_notification(
                session,
                writer,
                recording_path,
                exit_code,
                output.pty_hup_seen,
            )?;
        }

        // A hangup means the outer session is gone; keep recording what
        // the shell already produced, hang the shell up, and finish once
        // it exits (or the drain deadline passes).
        if session.hangup_state.load(Ordering::SeqCst) && hangup_observed_at.is_none() {
            hangup_observed_at = Some(Instant::now());
            stdin_closed = true;
            output.forwarding_broken = true;
            if exit_code.is_none() {
                best_effort_hangup_process_group(session.child_pid);
            }
        }

        if pty_events.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
            drain_pty_output(
                session,
                writer,
                recording_path,
                &mut pty_buffer,
                &mut output,
                exit_code,
            )?;
        }

        if stdin_ready {
            read_stdin_chunk(
                writer,
                recording_path,
                &mut stdin_buffer,
                &mut pending_input,
                &mut stdin_closed,
                exit_code,
                output.pty_hup_seen,
            )?;
        }

        if !pending_input.is_empty() {
            flush_pending_input(&session.pty, &mut pending_input, exit_code.is_some())?;
        }

        if let Some(hangup_at) = hangup_observed_at {
            if exit_code.is_none()
                && !hangup_killed_shell
                && hangup_at.elapsed() >= HANGUP_SHELL_KILL_GRACE
            {
                hangup_killed_shell = true;
                best_effort_kill_shell(session.child_pid, Signal::KILL);
            }
            if hangup_at.elapsed() >= HANGUP_DRAIN_DEADLINE {
                // The wait thread joins on the shell; make sure it can.
                best_effort_kill_shell(session.child_pid, Signal::KILL);
                return Ok(exit_code.unwrap_or(128 + 1));
            }
        }

        if should_finish_interactive_loop(
            exit_code,
            pending_input.is_empty(),
            output.pty_hup_seen,
            output.last_output_at,
            exit_observed_at,
        ) {
            return Ok(exit_code.expect("checked above"));
        }
    }
}

fn handle_exit_notification(
    session: &LinuxInteractiveSession,
    exit_code: &mut Option<i32>,
    exit_observed_at: &mut Option<Instant>,
) -> Result<()> {
    drain_notify_pipe(&session.exit_notify_read)?;
    if let Some(result) = take_shared_result(&session.exit_state) {
        *exit_code = Some(result.map_err(anyhow::Error::msg)?);
        *exit_observed_at = Some(Instant::now());
    }
    Ok(())
}

fn handle_resize_notification(
    session: &mut LinuxInteractiveSession,
    writer: &Arc<Mutex<RawEventLogWriter>>,
    recording_path: &Path,
    exit_code: Option<i32>,
    pty_hup_seen: bool,
) -> Result<()> {
    drain_notify_pipe(&session.resize_notify_read)?;
    if let Some((next_width, next_height)) = take_shared_value(&session.resize_state) {
        let size = BlockingPtySize::new(next_height, next_width);
        match session.pty.resize(size) {
            Ok(()) => write_resize_event(writer, unix_ms(), next_width, next_height).with_context(
                || {
                    format!(
                        "failed to write resize event to {}",
                        recording_path.display()
                    )
                },
            )?,
            Err(_) if exit_code.is_some() || pty_hup_seen => {}
            Err(error) => return Err(error).context("failed to resize interactive PTY"),
        }
    }
    Ok(())
}

fn drain_pty_output(
    session: &LinuxInteractiveSession,
    writer: &Arc<Mutex<RawEventLogWriter>>,
    recording_path: &Path,
    pty_buffer: &mut [u8; 4096],
    output: &mut OutputDrainState,
    exit_code: Option<i32>,
) -> Result<()> {
    let mut stdout = io::stdout();
    loop {
        match fd_read(&session.pty, &mut *pty_buffer) {
            Ok(0) => {
                output.pty_hup_seen = true;
                break;
            }
            Ok(read_count) => {
                let now = unix_ms();
                output.last_output_at = Instant::now();
                // Record before forwarding so a torn-down session can
                // never lose output the viewer already saw. Forwarding is
                // best-effort: once the outer pty is gone (browser closed,
                // sshd hangup) the recording is the only consumer left.
                write_cast_chunk(writer, now, "o", &pty_buffer[..read_count]).with_context(
                    || {
                        format!(
                            "failed to write output event to {}",
                            recording_path.display()
                        )
                    },
                )?;
                if !output.forwarding_broken {
                    let forwarded = stdout
                        .write_all(&pty_buffer[..read_count])
                        .and_then(|()| stdout.flush());
                    if forwarded.is_err() {
                        output.forwarding_broken = true;
                    }
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => break,
            Err(error) if is_expected_linux_pty_shutdown_error(error) || exit_code.is_some() => {
                output.pty_hup_seen = true;
                break;
            }
            Err(error) => return Err(error).context("failed to read PTY output"),
        }
    }
    Ok(())
}

fn read_stdin_chunk(
    writer: &Arc<Mutex<RawEventLogWriter>>,
    recording_path: &Path,
    stdin_buffer: &mut [u8; 4096],
    pending_input: &mut PendingInputBuffer,
    stdin_closed: &mut bool,
    exit_code: Option<i32>,
    pty_hup_seen: bool,
) -> Result<()> {
    let stdin = io::stdin();
    match fd_read(stdin, &mut *stdin_buffer) {
        Ok(0) => *stdin_closed = true,
        Ok(read_count) => {
            let chunk = &stdin_buffer[..read_count];
            pending_input.push(chunk);
            write_cast_chunk(writer, unix_ms(), "i", chunk).with_context(|| {
                format!(
                    "failed to write input event to {}",
                    recording_path.display()
                )
            })?;
        }
        Err(error) if error.kind() == ErrorKind::Interrupted => {}
        Err(error) if error.kind() == ErrorKind::WouldBlock => {}
        Err(_) if exit_code.is_some() || pty_hup_seen => *stdin_closed = true,
        Err(error) => return Err(error).context("failed to read stdin"),
    }
    Ok(())
}

fn should_finish_interactive_loop(
    exit_code: Option<i32>,
    pending_input_empty: bool,
    pty_hup_seen: bool,
    last_output_at: Instant,
    exit_observed_at: Option<Instant>,
) -> bool {
    let Some(_) = exit_code else {
        return false;
    };

    let now = Instant::now();
    let quiet_start = std::cmp::max(last_output_at, exit_observed_at.unwrap_or(now));
    pending_input_empty
        && (pty_hup_seen || now.duration_since(quiet_start) >= INTERACTIVE_DRAIN_QUIET_PERIOD)
}

fn set_nonblocking(fd: &impl AsFd) -> Result<()> {
    let flags = fcntl_getfl(fd).context("failed to read PTY flags")?;
    fcntl_setfl(fd, flags | OFlags::NONBLOCK).context("failed to set PTY nonblocking mode")
}

fn flush_pending_input(
    pty: &BlockingPty,
    pending_input: &mut PendingInputBuffer,
    exit_known: bool,
) -> Result<()> {
    while !pending_input.is_empty() {
        match fd_write(pty, pending_input.remaining()) {
            Ok(0) => break,
            Ok(written) => pending_input.advance(written),
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => break,
            Err(error) if is_expected_linux_pty_shutdown_error(error) || exit_known => {
                pending_input.advance(pending_input.remaining().len());
                break;
            }
            Err(error) => return Err(error).context("failed to forward input to PTY"),
        }
    }

    Ok(())
}

fn drain_notify_pipe(fd: &OwnedFd) -> Result<()> {
    let mut buffer = [0_u8; 64];
    loop {
        match fd_read(fd, &mut buffer) {
            Ok(0) => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(error).context("failed to drain notify pipe"),
        }
    }
}

fn notify_pipe(fd: &OwnedFd) {
    let _ = fd_write(fd, &[1]);
}

fn take_shared_result<T>(slot: &Arc<Mutex<Option<T>>>) -> Option<T> {
    slot.lock().ok().and_then(|mut guard| guard.take())
}

fn take_shared_value<T: Copy>(slot: &Arc<Mutex<Option<T>>>) -> Option<T> {
    slot.lock().ok().and_then(|mut guard| guard.take())
}

fn normalize_exit_status(status: ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
}

fn best_effort_terminate_process_group(pid: Option<Pid>) {
    if let Some(pid) = pid {
        let _ = kill_process_group(pid, Signal::TERM);
    }
}

fn best_effort_hangup_process_group(pid: Option<Pid>) {
    best_effort_kill_shell(pid, Signal::HUP);
}

fn best_effort_kill_shell(pid: Option<Pid>, signal: Signal) {
    if let Some(pid) = pid {
        // Interactive shells ignore HUP/TERM in their own group; signal
        // both the group and the shell process itself.
        let _ = kill_process_group(pid, signal);
        let _ = kill_process(pid, signal);
    }
}

fn is_expected_linux_pty_shutdown_error(error: RustixErrno) -> bool {
    matches!(
        error,
        RustixErrno::PIPE | RustixErrno::IO | RustixErrno::CONNRESET
    )
}

#[path = "linux/command.rs"]
mod command;
use command::*;

#[cfg(test)]
#[path = "linux/tests.rs"]
mod tests;
