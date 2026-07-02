pub(crate) use imp::{record_command, record_ssh};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShellStartupMode {
    Login,
    Interactive,
}

#[cfg(target_os = "linux")]
mod imp {
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
    use rustix::process::{Pid, Signal, kill_process_group};
    use serde::Serialize;
    use signal_hook::consts::signal::SIGWINCH;
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
        start_ts_unix_ms: u64,
        last_sync_ts_unix_ms: u64,
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

            let (file, path) = create_session_file(output_dir, start_ts_unix_ms)?;
            let mut writer = Self {
                file,
                start_ts_unix_ms,
                last_sync_ts_unix_ms: start_ts_unix_ms,
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

            Ok((writer, path))
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
            self.file.sync_all()
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

        fn write_event_line(
            &mut self,
            ts_unix_ms: u64,
            event: &RawRecordingEvent,
        ) -> io::Result<()> {
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
        let mut session = LinuxInteractiveSession::start(
            &config.real_shell,
            width,
            height,
            command,
            startup_mode,
        )?;
        let loop_result = run_linux_interactive_loop(&mut session, &shared_writer, &recording_path);
        if loop_result.is_err() {
            best_effort_terminate_process_group(session.child_pid);
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
            let mut signals =
                Signals::new([SIGWINCH]).context("failed to subscribe to SIGWINCH")?;
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
        let mut last_output_at = Instant::now();
        let mut pty_hup_seen = false;
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
            poll(&mut poll_fds, Some(&timeout)).context("failed polling PTY session fds")?;
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
                    pty_hup_seen,
                )?;
            }

            if pty_events.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
                drain_pty_output(
                    session,
                    writer,
                    recording_path,
                    &mut pty_buffer,
                    &mut last_output_at,
                    &mut pty_hup_seen,
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
                    pty_hup_seen,
                )?;
            }

            if !pending_input.is_empty() {
                flush_pending_input(&session.pty, &mut pending_input, exit_code.is_some())?;
            }

            if should_finish_interactive_loop(
                exit_code,
                pending_input.is_empty(),
                pty_hup_seen,
                last_output_at,
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
                Ok(()) => write_resize_event(writer, unix_ms(), next_width, next_height)
                    .with_context(|| {
                        format!(
                            "failed to write resize event to {}",
                            recording_path.display()
                        )
                    })?,
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
        last_output_at: &mut Instant,
        pty_hup_seen: &mut bool,
        exit_code: Option<i32>,
    ) -> Result<()> {
        let mut stdout = io::stdout();
        loop {
            match fd_read(&session.pty, &mut *pty_buffer) {
                Ok(0) => {
                    *pty_hup_seen = true;
                    break;
                }
                Ok(read_count) => {
                    let now = unix_ms();
                    *last_output_at = Instant::now();
                    stdout
                        .write_all(&pty_buffer[..read_count])
                        .context("failed to forward shell output to stdout")?;
                    stdout.flush().context("failed to flush stdout")?;
                    write_cast_chunk(writer, now, "o", &pty_buffer[..read_count]).with_context(
                        || {
                            format!(
                                "failed to write output event to {}",
                                recording_path.display()
                            )
                        },
                    )?;
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error)
                    if is_expected_linux_pty_shutdown_error(error) || exit_code.is_some() =>
                {
                    *pty_hup_seen = true;
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

    fn is_expected_linux_pty_shutdown_error(error: RustixErrno) -> bool {
        matches!(
            error,
            RustixErrno::PIPE | RustixErrno::IO | RustixErrno::CONNRESET
        )
    }

    #[derive(Debug, Clone, Copy)]
    enum CommandOutputStream {
        Stdout,
        Stderr,
    }

    struct CommandIoCapture {
        rx: mpsc::Receiver<CommandOutputChunk>,
        stdout_handle: thread::JoinHandle<()>,
        stderr_handle: thread::JoinHandle<()>,
        input_error: Arc<Mutex<Option<String>>>,
        stdout_error: Arc<Mutex<Option<String>>>,
        stderr_error: Arc<Mutex<Option<String>>>,
    }

    struct CommandOutputChunk {
        ts_unix_ms: u64,
        stream: CommandOutputStream,
        bytes: Vec<u8>,
    }

    fn write_command_input_event(
        writer: &Arc<Mutex<RawEventLogWriter>>,
        recording_path: &Path,
        command: &str,
    ) -> Result<()> {
        if command.is_empty() {
            return Ok(());
        }

        let mut input = command.to_owned();
        input.push('\n');
        write_cast_chunk(writer, unix_ms(), "i", input.as_bytes()).with_context(|| {
            format!(
                "failed to write input event to {}",
                recording_path.display()
            )
        })
    }

    fn spawn_recorded_command(real_shell: &Path, command: &str) -> Result<std::process::Child> {
        Command::new(real_shell)
            .args(["-c", command])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("failed to run shell command via {}", real_shell.display()))
    }

    fn start_command_io_capture(
        child: &mut std::process::Child,
        writer: Arc<Mutex<RawEventLogWriter>>,
    ) -> Result<CommandIoCapture> {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("failed to capture command stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("failed to capture command stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("failed to capture command stderr"))?;

        let (tx, rx) = mpsc::channel::<CommandOutputChunk>();
        let input_error = Arc::new(Mutex::new(None::<String>));
        let stdout_error = Arc::new(Mutex::new(None::<String>));
        let stderr_error = Arc::new(Mutex::new(None::<String>));
        spawn_command_input_forwarder(stdin, writer, Arc::clone(&input_error));
        let stdout_handle = spawn_command_output_forwarder(
            stdout,
            CommandOutputStream::Stdout,
            tx.clone(),
            Arc::clone(&stdout_error),
        );
        let stderr_handle = spawn_command_output_forwarder(
            stderr,
            CommandOutputStream::Stderr,
            tx,
            Arc::clone(&stderr_error),
        );

        Ok(CommandIoCapture {
            rx,
            stdout_handle,
            stderr_handle,
            input_error,
            stdout_error,
            stderr_error,
        })
    }

    fn forward_and_record_command_output(
        writer: &Arc<Mutex<RawEventLogWriter>>,
        recording_path: &Path,
        rx: mpsc::Receiver<CommandOutputChunk>,
    ) -> Result<()> {
        let mut stdout_target = io::stdout();
        let mut stderr_target = io::stderr();

        for chunk in rx {
            match chunk.stream {
                CommandOutputStream::Stdout => {
                    stdout_target
                        .write_all(&chunk.bytes)
                        .context("failed to forward command stdout")?;
                    stdout_target
                        .flush()
                        .context("failed to flush command stdout")?;
                }
                CommandOutputStream::Stderr => {
                    stderr_target
                        .write_all(&chunk.bytes)
                        .context("failed to forward command stderr")?;
                    stderr_target
                        .flush()
                        .context("failed to flush command stderr")?;
                }
            }

            write_cast_chunk(writer, chunk.ts_unix_ms, "o", &chunk.bytes).with_context(|| {
                format!(
                    "failed to write command output event to {}",
                    recording_path.display()
                )
            })?;
        }

        Ok(())
    }

    fn finalize_command_output_capture(
        stdout_handle: thread::JoinHandle<()>,
        stderr_handle: thread::JoinHandle<()>,
        input_error: &Arc<Mutex<Option<String>>>,
        stdout_error: &Arc<Mutex<Option<String>>>,
        stderr_error: &Arc<Mutex<Option<String>>>,
    ) -> Result<()> {
        join_command_output_forwarder(stdout_handle)?;
        join_command_output_forwarder(stderr_handle)?;

        if let Some(message) = take_thread_error(input_error) {
            return Err(anyhow!(message));
        }
        if let Some(message) = take_thread_error(stdout_error) {
            return Err(anyhow!(message));
        }
        if let Some(message) = take_thread_error(stderr_error) {
            return Err(anyhow!(message));
        }

        Ok(())
    }

    fn wait_for_command_exit(child: &mut std::process::Child) -> Result<i32> {
        Ok(child
            .wait()
            .context("failed waiting for shell command")?
            .code()
            .unwrap_or(1))
    }

    fn spawn_command_input_forwarder(
        mut child_stdin: ChildStdin,
        writer: Arc<Mutex<RawEventLogWriter>>,
        error_slot: Arc<Mutex<Option<String>>>,
    ) {
        let _input_thread = thread::spawn(move || {
            let mut input = io::stdin();
            let mut buffer = [0_u8; 4096];

            loop {
                match input.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read_count) => {
                        if let Err(error) = child_stdin
                            .write_all(&buffer[..read_count])
                            .and_then(|()| child_stdin.flush())
                        {
                            if is_expected_command_pipe_shutdown_error(&error) {
                                break;
                            }
                            store_thread_error(
                                &error_slot,
                                format!("failed to forward command stdin: {error}"),
                            );
                            break;
                        }
                        if let Err(error) =
                            write_cast_chunk(&writer, unix_ms(), "i", &buffer[..read_count])
                        {
                            store_thread_error(
                                &error_slot,
                                format!("failed to write command input event: {error}"),
                            );
                            break;
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => {}
                    Err(error) => {
                        store_thread_error(
                            &error_slot,
                            format!("failed to read command stdin: {error}"),
                        );
                        break;
                    }
                }
            }
        });
    }

    fn spawn_command_output_forwarder<R>(
        mut reader: R,
        stream: CommandOutputStream,
        tx: mpsc::Sender<CommandOutputChunk>,
        error_slot: Arc<Mutex<Option<String>>>,
    ) -> thread::JoinHandle<()>
    where
        R: Read + Send + 'static,
    {
        thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read_count) => {
                        if tx
                            .send(CommandOutputChunk {
                                ts_unix_ms: unix_ms(),
                                stream,
                                bytes: buffer[..read_count].to_vec(),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => {}
                    Err(error) => {
                        let label = match stream {
                            CommandOutputStream::Stdout => "stdout",
                            CommandOutputStream::Stderr => "stderr",
                        };
                        store_thread_error(
                            &error_slot,
                            format!("failed to read command {label}: {error}"),
                        );
                        break;
                    }
                }
            }
        })
    }

    fn join_command_output_forwarder(handle: thread::JoinHandle<()>) -> Result<()> {
        handle
            .join()
            .map_err(|_| anyhow!("command output forwarder thread panicked"))?;
        Ok(())
    }

    fn create_session_file(
        output_dir: &Path,
        start_ts_unix_ms: u64,
    ) -> io::Result<(File, PathBuf)> {
        let pid = std::process::id();

        for attempt in 0..1000_u32 {
            let suffix = if attempt == 0 {
                String::new()
            } else {
                format!("-{attempt}")
            };
            let path =
                output_dir.join(format!("ssh-session-{start_ts_unix_ms}-{pid}{suffix}.krec"));

            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => return Ok((file, path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }

        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "failed to allocate a unique recording file path",
        ))
    }

    struct RawModeGuard;

    impl RawModeGuard {
        fn new() -> Result<Self> {
            terminal::enable_raw_mode()
                .map_err(io::Error::other)
                .context("failed to enable raw terminal mode")?;
            Ok(Self)
        }
    }

    impl Drop for RawModeGuard {
        fn drop(&mut self) {
            let _ = terminal::disable_raw_mode();
        }
    }

    fn is_expected_command_pipe_shutdown_error(error: &io::Error) -> bool {
        matches!(
            error.kind(),
            ErrorKind::BrokenPipe | ErrorKind::ConnectionReset | ErrorKind::UnexpectedEof
        ) || matches!(error.raw_os_error(), Some(32 | 104))
    }

    fn write_resize_event(
        writer: &Arc<Mutex<RawEventLogWriter>>,
        ts_unix_ms: u64,
        width: u16,
        height: u16,
    ) -> Result<()> {
        let mut writer = writer
            .lock()
            .map_err(|_| anyhow!("cast writer lock poisoned"))?;
        writer.write_resize(ts_unix_ms, width, height)?;
        Ok(())
    }

    fn write_cast_chunk(
        writer: &Arc<Mutex<RawEventLogWriter>>,
        ts_unix_ms: u64,
        kind: &'static str,
        bytes: &[u8],
    ) -> Result<()> {
        let mut writer = writer
            .lock()
            .map_err(|_| anyhow!("cast writer lock poisoned"))?;
        match kind {
            "i" => writer.write_input_bytes(ts_unix_ms, bytes)?,
            "o" => writer.write_output_bytes(ts_unix_ms, bytes)?,
            _ => bail!("unsupported cast event kind '{kind}'"),
        }
        Ok(())
    }

    fn store_thread_error(slot: &Arc<Mutex<Option<String>>>, message: String) {
        if let Ok(mut guard) = slot.lock()
            && guard.is_none()
        {
            *guard = Some(message);
        }
    }

    fn take_thread_error(slot: &Arc<Mutex<Option<String>>>) -> Option<String> {
        slot.lock().ok().and_then(|mut guard| guard.take())
    }

    fn build_recording_metadata(
        config: &RecordingConfig,
        command: Option<String>,
    ) -> RecordingMetadata {
        let mut env = BTreeMap::new();
        env.insert(
            "SHELL".to_owned(),
            config.real_shell.to_string_lossy().into_owned(),
        );

        if let Ok(term) = std::env::var("TERM")
            && !term.is_empty()
        {
            env.insert("TERM".to_owned(), term);
        }

        RecordingMetadata { command, env }
    }

    fn unix_ms() -> u64 {
        u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        )
        .unwrap_or(u64::MAX)
    }

    #[cfg(test)]
    mod tests {
        use super::{
            RAW_RECORDING_FORMAT, RAW_RECORDING_VERSION, RawEventLogWriter, RecordingMetadata,
            record_command, shell_startup_args,
        };
        use crate::config::RecordingConfig;
        use crate::recording::ShellStartupMode;
        use base64::Engine as _;
        use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
        use serde_json::Value;
        use std::collections::BTreeMap;
        use std::fs;
        use std::path::PathBuf;

        #[test]
        fn cast_writer_persists_header_and_events() {
            let temp =
                tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
            let start_ts_unix_ms = 1_700_000_000_000;
            let metadata = RecordingMetadata {
                command: Some("/bin/sh".to_owned()),
                env: BTreeMap::from([
                    ("SHELL".to_owned(), "/bin/sh".to_owned()),
                    ("TERM".to_owned(), "xterm-256color".to_owned()),
                ]),
            };
            let (mut writer, recording_path) =
                RawEventLogWriter::start(temp.path(), start_ts_unix_ms, 120, 40, metadata)
                    .unwrap_or_else(|error| panic!("recording writer start failed: {error}"));

            writer
                .write_input_bytes(start_ts_unix_ms, b"echo hello\n")
                .unwrap_or_else(|error| panic!("write input failed: {error}"));
            writer
                .write_output_bytes(start_ts_unix_ms + 500, b"hello\n")
                .unwrap_or_else(|error| panic!("write output failed: {error}"));
            writer
                .write_resize(start_ts_unix_ms + 900, 100, 30)
                .unwrap_or_else(|error| panic!("write resize failed: {error}"));
            writer
                .write_exit(start_ts_unix_ms + 900, 0)
                .unwrap_or_else(|error| panic!("write exit failed: {error}"));
            writer
                .finish()
                .unwrap_or_else(|error| panic!("finish failed: {error}"));

            let content = fs::read_to_string(recording_path)
                .unwrap_or_else(|error| panic!("failed to read recording file: {error}"));
            let lines = content.lines().collect::<Vec<_>>();
            assert_eq!(lines.len(), 5);

            let header = serde_json::from_str::<Value>(lines[0])
                .unwrap_or_else(|error| panic!("invalid recording header: {error}"));
            assert_eq!(header["type"], "header");
            assert_eq!(header["format"], RAW_RECORDING_FORMAT);
            assert_eq!(header["version"], RAW_RECORDING_VERSION);
            assert_eq!(header["width"], 120);
            assert_eq!(header["height"], 40);
            assert_eq!(header["start_timestamp_ms"], start_ts_unix_ms);
            assert_eq!(header["command"], "/bin/sh");
            assert_eq!(header["env"]["SHELL"], "/bin/sh");
            assert_eq!(header["env"]["TERM"], "xterm-256color");

            let input = serde_json::from_str::<Value>(lines[1])
                .unwrap_or_else(|error| panic!("invalid input event: {error}"));
            assert_eq!(input["type"], "event");
            assert_eq!(input["offset_ms"], 0);
            assert_eq!(input["event"], "i");
            assert_eq!(
                BASE64_STANDARD
                    .decode(input["data_b64"].as_str().unwrap_or_default())
                    .unwrap_or_else(|error| panic!("invalid input event bytes: {error}")),
                b"echo hello\n"
            );

            let output = serde_json::from_str::<Value>(lines[2])
                .unwrap_or_else(|error| panic!("invalid output event: {error}"));
            assert_eq!(output["event"], "o");
            assert_eq!(
                BASE64_STANDARD
                    .decode(output["data_b64"].as_str().unwrap_or_default())
                    .unwrap_or_else(|error| panic!("invalid output event bytes: {error}")),
                b"hello\n"
            );

            let resize = serde_json::from_str::<Value>(lines[3])
                .unwrap_or_else(|error| panic!("invalid resize event: {error}"));
            assert_eq!(resize["event"], "r");
            assert_eq!(resize["width"], 100);
            assert_eq!(resize["height"], 30);

            let exit = serde_json::from_str::<Value>(lines[4])
                .unwrap_or_else(|error| panic!("invalid exit event: {error}"));
            assert_eq!(exit["event"], "x");
            assert_eq!(exit["exit_code"], 0);
        }

        #[test]
        fn record_command_creates_recording_file() {
            let temp =
                tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
            let config = RecordingConfig {
                output_dir: temp.path().to_path_buf(),
                real_shell: PathBuf::from("/bin/sh"),
            };

            let exit_code = record_command(&config, "printf 'hello\\n'; >&2 printf 'oops\\n'")
                .unwrap_or_else(|error| panic!("record_command failed: {error}"));
            assert_eq!(exit_code, 0);

            let entries = fs::read_dir(temp.path())
                .unwrap_or_else(|error| panic!("read_dir failed: {error}"))
                .map(|entry| {
                    entry
                        .unwrap_or_else(|error| panic!("dir entry failed: {error}"))
                        .path()
                })
                .collect::<Vec<_>>();
            assert_eq!(entries.len(), 1);

            let content = fs::read_to_string(&entries[0])
                .unwrap_or_else(|error| panic!("failed to read recording file: {error}"));
            let lines = content.lines().skip(1).collect::<Vec<_>>();
            let events = lines
                .iter()
                .map(|line| {
                    serde_json::from_str::<Value>(line)
                        .unwrap_or_else(|error| panic!("invalid recording line: {error}"))
                })
                .collect::<Vec<_>>();

            assert!(events.iter().any(|event| {
                event["event"] == "i"
                    && BASE64_STANDARD
                        .decode(event["data_b64"].as_str().unwrap_or_default())
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                        .as_deref()
                        .is_some_and(|data| data.contains("printf 'hello"))
            }));
            assert!(events.iter().all(|event| {
                event["offset_ms"].is_number()
                    && matches!(event["event"].as_str(), Some("i" | "o" | "r" | "x"))
            }));
            assert!(events.iter().any(|event| {
                event["event"] == "o"
                    && BASE64_STANDARD
                        .decode(event["data_b64"].as_str().unwrap_or_default())
                        .ok()
                        .as_deref()
                        == Some(b"hello\n".as_slice())
            }));
            assert!(events.iter().any(|event| {
                event["event"] == "o"
                    && BASE64_STANDARD
                        .decode(event["data_b64"].as_str().unwrap_or_default())
                        .ok()
                        .as_deref()
                        == Some(b"oops\n".as_slice())
            }));
        }

        #[test]
        fn record_command_fails_closed_when_output_dir_is_a_file() {
            let temp =
                tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
            let output_path = temp.path().join("not-a-directory");
            fs::write(&output_path, "occupied")
                .unwrap_or_else(|error| panic!("write failed: {error}"));

            let config = RecordingConfig {
                output_dir: output_path,
                real_shell: PathBuf::from("/bin/sh"),
            };

            let result = record_command(&config, "printf 'hello\\n'");
            assert!(result.is_err());
        }

        #[test]
        fn shell_startup_args_use_login_mode_by_default() {
            assert_eq!(
                shell_startup_args(ShellStartupMode::Login, None),
                vec!["-l".to_owned()]
            );
        }

        #[test]
        fn shell_startup_args_support_interactive_mode() {
            assert_eq!(
                shell_startup_args(ShellStartupMode::Interactive, None),
                vec!["-i".to_owned()]
            );
        }

        #[test]
        fn shell_startup_args_prefer_command_execution() {
            assert_eq!(
                shell_startup_args(ShellStartupMode::Login, Some("printf hi")),
                vec!["-c".to_owned(), "printf hi".to_owned()]
            );
            assert_eq!(
                shell_startup_args(ShellStartupMode::Interactive, Some("printf hi")),
                vec!["-c".to_owned(), "printf hi".to_owned()]
            );
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use crate::config::RecordingConfig;
    use anyhow::{Result, bail};

    pub(crate) fn record_command(_config: &RecordingConfig, _command: &str) -> Result<i32> {
        bail!("recording is only supported on Linux")
    }

    pub(crate) fn record_ssh(
        _config: &RecordingConfig,
        _command: Option<&str>,
        _startup_mode: super::ShellStartupMode,
    ) -> Result<i32> {
        bail!("recording is only supported on Linux")
    }
}
