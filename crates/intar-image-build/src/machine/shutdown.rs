//! The strict QMP powerdown of a build VM, and its SSH endpoint.

use std::io::{BufRead as _, BufReader, ErrorKind, Read as _, Write as _};
use std::net::TcpListener;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, ExitStatus};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Error, Result, anyhow, bail, ensure};

pub(crate) const SSH_HOST: &str = "127.0.0.1";
// A build guest can briefly expose port 22 before its ephemeral key and
// network setup have settled. Avoid hammering OpenSSH's unauthenticated
// connection limits while retaining responsive readiness detection.
pub(crate) const SSH_POLL_INTERVAL: Duration = Duration::from_secs(2);
const QMP_SOCKET_FILE_NAME: &str = "qmp.sock";
const QEMU_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const QMP_IO_TIMEOUT: Duration = Duration::from_secs(2);
const QMP_READ_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) fn allocate_ssh_host_port() -> Result<u16> {
    let listener = TcpListener::bind((SSH_HOST, 0))
        .with_context(|| format!("failed to allocate build SSH host port on {SSH_HOST}"))?;
    let port = listener
        .local_addr()
        .context("failed to read allocated build SSH host port")?
        .port();
    drop(listener);
    Ok(port)
}

pub struct DirectQemuShutdownInput<'a> {
    pub qmp_socket_path: &'a Path,
    pub serial_log_path: &'a Path,
    pub build_log_path: &'a Path,
    pub timeout_seconds: u64,
}

/// Complete the strict QMP powerdown handshake and reap a direct-QEMU guest.
/// The helper fails closed and kills/reaps the child on every handshake or
/// timeout failure.
pub fn acknowledged_qmp_shutdown(
    qemu: &mut Child,
    input: &DirectQemuShutdownInput<'_>,
) -> Result<()> {
    acknowledged_qmp_shutdown_with_cancel(qemu, input, || false)
}

/// Complete the strict QMP shutdown handshake while allowing an operator
/// shutdown to interrupt QMP polling. Cancellation fails closed: QEMU is
/// killed and reaped before the error is returned.
pub fn acknowledged_qmp_shutdown_with_cancel(
    qemu: &mut Child,
    input: &DirectQemuShutdownInput<'_>,
    is_cancelled: impl Fn() -> bool,
) -> Result<()> {
    if is_cancelled() {
        return Err(qemu_failure_after_cleanup(
            qemu,
            anyhow!("QEMU shutdown cancelled"),
        ));
    }
    if let Some(status) = poll_qemu_or_cleanup(qemu)? {
        bail!(
            "QEMU exited with status {status} before the host requested acknowledged QMP powerdown; serial log: {}; build log: {}",
            input.serial_log_path.display(),
            input.build_log_path.display()
        );
    }

    let qemu_exit_timeout_seconds = input.timeout_seconds.max(1);
    let deadline = Instant::now() + Duration::from_secs(qemu_exit_timeout_seconds);
    if let Err(error) = request_qemu_powerdown(input.qmp_socket_path, deadline, &is_cancelled) {
        return Err(qemu_failure_after_cleanup(
            qemu,
            anyhow!(
                "failed to complete QMP guest powerdown handshake after provisioning; serial log: {}; build log: {}: {error:#}",
                input.serial_log_path.display(),
                input.build_log_path.display()
            ),
        ));
    }
    while Instant::now() < deadline {
        if is_cancelled() {
            return Err(qemu_failure_after_cleanup(
                qemu,
                anyhow!("QEMU shutdown cancelled"),
            ));
        }
        if let Some(status) = poll_qemu_or_cleanup(qemu)? {
            return qemu_status_to_result(status, input);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(QEMU_EXIT_POLL_INTERVAL.min(remaining));
    }

    if let Some(status) = poll_qemu_or_cleanup(qemu)? {
        return qemu_status_to_result(status, input);
    }

    Err(qemu_failure_after_cleanup(
        qemu,
        anyhow!(
            "timed out waiting {qemu_exit_timeout_seconds}s for QEMU to exit after a guest-originated QMP shutdown event; serial log: {}; build log: {}",
            input.serial_log_path.display(),
            input.build_log_path.display(),
        ),
    ))
}

fn qemu_status_to_result(status: ExitStatus, input: &DirectQemuShutdownInput<'_>) -> Result<()> {
    if status.success() {
        return Ok(());
    }
    bail!(
        "QEMU exited with status {status}; serial log: {}; build log: {}",
        input.serial_log_path.display(),
        input.build_log_path.display()
    )
}

fn request_qemu_powerdown(
    qmp_socket_path: &Path,
    shutdown_deadline: Instant,
    is_cancelled: &impl Fn() -> bool,
) -> Result<()> {
    let mut stream = connect_qmp_socket(qmp_socket_path).with_context(|| {
        format!(
            "failed to connect to QMP socket '{}'",
            qmp_socket_path.display()
        )
    })?;
    stream
        .set_read_timeout(Some(QMP_READ_POLL_INTERVAL))
        .context("failed to set QMP read timeout")?;
    stream
        .set_write_timeout(Some(QMP_IO_TIMEOUT))
        .context("failed to set QMP write timeout")?;
    let handshake_deadline = (Instant::now() + QMP_IO_TIMEOUT).min(shutdown_deadline);
    let reader_stream = stream
        .try_clone()
        .context("failed to clone QMP socket for response reads")?;
    let mut reader = BufReader::new(reader_stream);

    let greeting = read_qmp_message(&mut reader, "greeting", handshake_deadline, is_cancelled)?;
    if !greeting
        .get("QMP")
        .is_some_and(serde_json::Value::is_object)
    {
        bail!("QMP socket returned an invalid greeting: {greeting}");
    }
    if execute_qmp_command(
        &mut stream,
        &mut reader,
        "qmp_capabilities",
        handshake_deadline,
        is_cancelled,
    )? {
        bail!("QMP reported shutdown before the host requested system_powerdown");
    }
    if execute_qmp_command(
        &mut stream,
        &mut reader,
        "system_powerdown",
        handshake_deadline,
        is_cancelled,
    )? {
        bail!("QMP reported shutdown before acknowledging system_powerdown");
    }
    wait_for_guest_shutdown_event(&mut reader, shutdown_deadline, is_cancelled)
}

pub(crate) fn connect_qmp_socket(qmp_socket_path: &Path) -> Result<UnixStream> {
    // Unix-domain socket APIs reject the pathname supplied by the client when
    // it exceeds SUN_LEN even if QEMU successfully bound the same socket from
    // its work directory using the relative name `qmp.sock`. Resolve the
    // trusted absolute socket through a private short alias so connect(2) sees
    // a bounded pathname. The connected stream remains valid after the alias
    // directory is removed on return.
    let absolute_qmp_socket_path = if qmp_socket_path.is_absolute() {
        qmp_socket_path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("failed to resolve the current directory for a relative QMP socket")?
            .join(qmp_socket_path)
    };
    let alias_root = tempfile::Builder::new()
        .prefix("intar-qmp-")
        .tempdir_in("/tmp")
        .context("failed to create short QMP socket alias directory")?;
    let alias_path = alias_root.path().join(QMP_SOCKET_FILE_NAME);
    std::os::unix::fs::symlink(&absolute_qmp_socket_path, &alias_path).with_context(|| {
        format!(
            "failed to create short QMP socket alias '{}' -> '{}'",
            alias_path.display(),
            absolute_qmp_socket_path.display()
        )
    })?;
    UnixStream::connect(&alias_path).with_context(|| {
        format!(
            "failed to connect through short QMP socket alias '{}'",
            alias_path.display()
        )
    })
}

fn execute_qmp_command(
    stream: &mut UnixStream,
    reader: &mut BufReader<UnixStream>,
    command: &str,
    deadline: Instant,
    is_cancelled: &impl Fn() -> bool,
) -> Result<bool> {
    ensure!(!is_cancelled(), "QEMU shutdown cancelled");
    stream
        .set_write_timeout(Some(qmp_remaining(deadline, command)?))
        .with_context(|| format!("failed to set QMP {command} write timeout"))?;
    serde_json::to_writer(
        &mut *stream,
        &serde_json::json!({ "execute": command, "id": command }),
    )
    .with_context(|| format!("failed to encode QMP {command} command"))?;
    stream
        .write_all(b"\n")
        .with_context(|| format!("failed to terminate QMP {command} command"))?;
    stream
        .flush()
        .with_context(|| format!("failed to flush QMP {command} command"))?;

    let mut saw_shutdown = false;
    loop {
        let response = read_qmp_message(reader, command, deadline, is_cancelled)?;
        if response.get("event").is_some() {
            saw_shutdown |= is_qmp_shutdown_event(&response);
            continue;
        }
        if response.get("id").and_then(serde_json::Value::as_str) != Some(command) {
            bail!("QMP {command} returned a response with a missing or mismatched id: {response}");
        }
        if let Some(error) = response.get("error") {
            bail!("QMP {command} command failed: {error}");
        }
        if response.get("return").is_some() {
            return Ok(saw_shutdown);
        }
        bail!("QMP {command} returned an unexpected response: {response}");
    }
}

fn wait_for_guest_shutdown_event(
    reader: &mut BufReader<UnixStream>,
    deadline: Instant,
    is_cancelled: &impl Fn() -> bool,
) -> Result<()> {
    loop {
        let message = read_qmp_message(reader, "guest SHUTDOWN event", deadline, is_cancelled)?;
        if validate_guest_shutdown_event(&message)? {
            return Ok(());
        }
        if message.get("event").is_none() {
            bail!(
                "QMP returned an unexpected response while waiting for guest shutdown: {message}"
            );
        }
    }
}

fn validate_guest_shutdown_event(message: &serde_json::Value) -> Result<bool> {
    if !is_qmp_shutdown_event(message) {
        return Ok(false);
    }
    let data = message.get("data").and_then(serde_json::Value::as_object);
    let guest = data
        .and_then(|data| data.get("guest"))
        .and_then(serde_json::Value::as_bool);
    let reason = data
        .and_then(|data| data.get("reason"))
        .and_then(serde_json::Value::as_str);
    if guest == Some(true) && reason == Some("guest-shutdown") {
        return Ok(true);
    }
    bail!("QMP reported a non-guest or unexpected SHUTDOWN event: {message}")
}

fn is_qmp_shutdown_event(message: &serde_json::Value) -> bool {
    message.get("event").and_then(serde_json::Value::as_str) == Some("SHUTDOWN")
}

pub(crate) fn read_qmp_message(
    reader: &mut BufReader<UnixStream>,
    phase: &str,
    deadline: Instant,
    is_cancelled: &impl Fn() -> bool,
) -> Result<serde_json::Value> {
    const MAX_QMP_MESSAGE_BYTES: usize = 64 * 1024;
    let mut line = String::new();
    loop {
        ensure!(!is_cancelled(), "QEMU shutdown cancelled");
        qmp_remaining(deadline, phase)?;
        if line.len() > MAX_QMP_MESSAGE_BYTES {
            bail!("QMP {phase} response exceeded {MAX_QMP_MESSAGE_BYTES} bytes");
        }
        let remaining_capacity = MAX_QMP_MESSAGE_BYTES + 1 - line.len();
        let bytes = match reader.take(remaining_capacity as u64).read_line(&mut line) {
            Ok(bytes) => bytes,
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
                if Instant::now() >= deadline {
                    bail!("QMP deadline expired while waiting for {phase}");
                }
                if line.len() > MAX_QMP_MESSAGE_BYTES {
                    bail!("QMP {phase} response exceeded {MAX_QMP_MESSAGE_BYTES} bytes");
                }
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read QMP {phase} response"));
            }
        };
        if bytes == 0 {
            bail!("QMP socket closed before the {phase} response");
        }
        if line.len() > MAX_QMP_MESSAGE_BYTES {
            bail!("QMP {phase} response exceeded {MAX_QMP_MESSAGE_BYTES} bytes");
        }
        if !line.ends_with('\n') {
            bail!("QMP {phase} response was not newline-terminated");
        }
        if line.trim().is_empty() {
            line.clear();
            continue;
        }
        return serde_json::from_str(line.trim())
            .with_context(|| format!("QMP {phase} response was not valid JSON"));
    }
}

fn qmp_remaining(deadline: Instant, phase: &str) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .with_context(|| format!("QMP deadline expired while waiting for {phase}"))
}

fn poll_qemu_or_cleanup(qemu: &mut Child) -> Result<Option<ExitStatus>> {
    match qemu.try_wait() {
        Ok(status) => Ok(status),
        Err(error) => Err(qemu_failure_after_cleanup(
            qemu,
            Error::new(error).context(format!("failed to poll QEMU pid {}", qemu.id())),
        )),
    }
}

fn qemu_failure_after_cleanup(qemu: &mut Child, failure: Error) -> Error {
    match terminate_qemu(qemu) {
        Ok(status) => failure.context(format!(
            "QEMU pid {} was terminated and reaped with status {status}",
            qemu.id()
        )),
        Err(cleanup_error) => anyhow!(
            "{failure:#}; additionally failed to terminate and reap QEMU pid {}: {cleanup_error:#}",
            qemu.id()
        ),
    }
}

pub(crate) fn terminate_qemu(qemu: &mut Child) -> Result<ExitStatus> {
    let pid = qemu.id();
    if let Err(kill_error) = qemu.kill() {
        return match qemu.try_wait() {
            Ok(Some(status)) => Ok(status),
            Ok(None) => Err(Error::new(kill_error)
                .context(format!("failed to kill still-running QEMU pid {pid}"))),
            Err(poll_error) => Err(anyhow!(
                "failed to kill QEMU pid {pid}: {kill_error}; failed to determine whether it exited: {poll_error}"
            )),
        };
    }
    qemu.wait()
        .with_context(|| format!("failed to reap QEMU pid {pid} after killing it"))
}

#[cfg(test)]
mod tests;
