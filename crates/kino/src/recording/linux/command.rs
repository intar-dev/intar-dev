use super::*;

#[derive(Debug, Clone, Copy)]
pub(super) enum CommandOutputStream {
    Stdout,
    Stderr,
}

pub(super) struct CommandIoCapture {
    rx: mpsc::Receiver<CommandOutputChunk>,
    stdout_handle: thread::JoinHandle<()>,
    stderr_handle: thread::JoinHandle<()>,
    input_error: Arc<Mutex<Option<String>>>,
    stdout_error: Arc<Mutex<Option<String>>>,
    stderr_error: Arc<Mutex<Option<String>>>,
}

pub(super) struct CommandOutputChunk {
    ts_unix_ms: u64,
    stream: CommandOutputStream,
    bytes: Vec<u8>,
}

pub(super) fn write_command_input_event(
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

pub(super) fn spawn_recorded_command(
    real_shell: &Path,
    command: &str,
) -> Result<std::process::Child> {
    Command::new(real_shell)
        .args(["-c", command])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to run shell command via {}", real_shell.display()))
}

pub(super) fn start_command_io_capture(
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

pub(super) fn forward_and_record_command_output(
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

pub(super) fn finalize_command_output_capture(
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

pub(super) fn wait_for_command_exit(child: &mut std::process::Child) -> Result<i32> {
    Ok(child
        .wait()
        .context("failed waiting for shell command")?
        .code()
        .unwrap_or(1))
}

pub(super) fn spawn_command_input_forwarder(
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

pub(super) fn spawn_command_output_forwarder<R>(
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

pub(super) fn join_command_output_forwarder(handle: thread::JoinHandle<()>) -> Result<()> {
    handle
        .join()
        .map_err(|_| anyhow!("command output forwarder thread panicked"))?;
    Ok(())
}

pub(super) fn create_session_file(
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
        let path = output_dir.join(format!("ssh-session-{start_ts_unix_ms}-{pid}{suffix}.krec"));

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

pub(super) struct RawModeGuard;

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

pub(super) fn is_expected_command_pipe_shutdown_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::BrokenPipe | ErrorKind::ConnectionReset | ErrorKind::UnexpectedEof
    ) || matches!(error.raw_os_error(), Some(32 | 104))
}

pub(super) fn write_resize_event(
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

pub(super) fn write_cast_chunk(
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

pub(super) fn store_thread_error(slot: &Arc<Mutex<Option<String>>>, message: String) {
    if let Ok(mut guard) = slot.lock()
        && guard.is_none()
    {
        *guard = Some(message);
    }
}

pub(super) fn take_thread_error(slot: &Arc<Mutex<Option<String>>>) -> Option<String> {
    slot.lock().ok().and_then(|mut guard| guard.take())
}

pub(super) fn build_recording_metadata(
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

pub(super) fn unix_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}
