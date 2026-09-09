use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, anyhow, bail, ensure};
#[cfg(target_os = "linux")]
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::process::{Pid, Signal, kill_process};
#[cfg(target_os = "linux")]
use rustix::process::{PidfdFlags, pidfd_open, pidfd_send_signal};
use tempfile::TempDir;

use crate::checkpoint::CheckpointLease;
use crate::config::QemuBuildConfig;

const RAW_VIEW_START_TIMEOUT: Duration = Duration::from_secs(30);
const RAW_VIEW_CLEANUP_TIMEOUT: Duration = Duration::from_secs(30);
const RAW_VIEW_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Keeps the final qcow2 source and its checkpoint backing alive while the
/// scanner and encoder read its readonly FUSE raw view.
pub(super) struct RawViewGuard {
    state: Option<RawViewState>,
    watchdog: Option<RawViewWatchdog>,
    read_timed_out: Arc<AtomicBool>,
    watchdog_error: Arc<Mutex<Option<String>>>,
}

struct RawViewWatchdog {
    stop: mpsc::Sender<()>,
    join: JoinHandle<()>,
}

struct RawViewState {
    source_qcow2_path: PathBuf,
    mountpoint: PathBuf,
    pidfile: PathBuf,
    qemu_storage_daemon_binary: PathBuf,
    umount_binary: PathBuf,
    child: Option<Child>,
    mounted: bool,
    _checkpoint_lease: Option<CheckpointLease>,
    _temporary_snapshot: Option<TempDir>,
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
        mountpoint: PathBuf,
        checkpoint_lease: Option<CheckpointLease>,
        temporary_snapshot: Option<TempDir>,
        read_timeout: Duration,
    ) -> Result<Self> {
        let mut guard = Self {
            state: Some(RawViewState {
                source_qcow2_path,
                mountpoint,
                pidfile: work_root.join("raw-view.pid"),
                qemu_storage_daemon_binary: config.qemu_storage_daemon_binary.clone(),
                umount_binary: config.umount_binary.clone(),
                child: None,
                mounted: false,
                _checkpoint_lease: checkpoint_lease,
                _temporary_snapshot: temporary_snapshot,
            }),
            watchdog: None,
            read_timed_out: Arc::new(AtomicBool::new(false)),
            watchdog_error: Arc::new(Mutex::new(None)),
        };
        guard.start_export(work_root)?;
        #[cfg(target_os = "linux")]
        {
            let pidfd = guard.qsd_pidfd()?;
            guard.start_watchdog(read_timeout, pidfd)?;
        }
        #[cfg(not(target_os = "linux"))]
        let _ = read_timeout;
        Ok(guard)
    }

    pub(super) fn close(&mut self) -> Result<()> {
        self.stop_watchdog()?;
        if let Some(raw_view) = self.state.as_mut() {
            close_state(raw_view)?;
            self.state = None;
        }
        let watchdog_error = self
            .watchdog_error
            .lock()
            .map_err(|_| anyhow!("raw view watchdog error lock is poisoned"))?
            .take();
        let timed_out = self.read_timed_out.swap(false, Ordering::AcqRel);
        if let Some(error) = watchdog_error {
            bail!("raw view watchdog failed: {error}");
        }
        ensure!(!timed_out, "raw view image-read deadline expired");
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn qsd_pidfd(&mut self) -> Result<rustix::fd::OwnedFd> {
        let state = self
            .state
            .as_mut()
            .context("raw view was closed before its watchdog could start")?;
        let child = state
            .child
            .as_mut()
            .context("raw view storage daemon did not start")?;
        ensure!(
            child
                .try_wait()
                .context("failed to poll raw view storage daemon")?
                .is_none(),
            "raw view storage daemon exited before its watchdog could start"
        );
        let raw_pid = i32::try_from(child.id()).context("QSD PID does not fit i32")?;
        let pid = Pid::from_raw(raw_pid).context("QSD PID is not valid")?;
        pidfd_open(pid, PidfdFlags::empty()).context("failed to bind raw view watchdog to QSD")
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
                if let Err(error) = terminate_stale_pidfd(pidfd, "raw view image-read deadline")
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
        let watchdog = self.watchdog.take();
        if let Some(watchdog) = watchdog {
            let _ = watchdog.stop.send(());
            watchdog
                .join
                .join()
                .map_err(|_| anyhow!("raw view watchdog panicked"))?;
        }
        Ok(())
    }

    fn start_export(&mut self, work_root: &Path) -> Result<()> {
        let state = self
            .state
            .as_mut()
            .context("raw view was closed before it could start")?;
        prepare_mountpoint(&state.mountpoint)?;
        remove_file_if_exists(&state.pidfile)?;
        let log_path = work_root.join("raw-view.log");
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("failed to open raw view log '{}'", log_path.display()))?;
        let log_stderr = log.try_clone().context("failed to clone raw view log")?;
        let arguments = qsd_arguments(&state.source_qcow2_path, &state.mountpoint, &state.pidfile)?;
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
                        "failed to start readonly QEMU storage daemon '{}'",
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
                    .context("raw view was closed while it was starting")?;
                let child = state
                    .child
                    .as_mut()
                    .context("raw view storage daemon did not start")?;
                if let Some(status) = child
                    .try_wait()
                    .context("failed to poll raw view storage daemon")?
                {
                    bail!(
                        "raw view storage daemon exited before FUSE became ready with status {status}"
                    );
                }
                if state.pidfile.is_file() && mountpoint_is_active(&state.mountpoint)? {
                    state.mounted = true;
                    true
                } else {
                    false
                }
            };
            if ready {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!("raw view FUSE export did not become ready before timeout");
            }
            thread::sleep(RAW_VIEW_POLL_INTERVAL);
        }
    }
}

impl Drop for RawViewGuard {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("[intar-raw-view] cleanup_failed error={error:#}");
        }
    }
}

fn qsd_arguments(source: &Path, mountpoint: &Path, pidfile: &Path) -> Result<Vec<OsString>> {
    let source = source
        .to_str()
        .context("raw view source path is not UTF-8")?;
    let mountpoint = mountpoint
        .to_str()
        .context("raw view mountpoint path is not UTF-8")?;
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
        "type": "fuse",
        "id": "intar-raw-view",
        "node-name": "qcow2",
        "mountpoint": mountpoint,
        "writable": false,
        "allow-other": "off",
    })
    .to_string();
    Ok(vec![
        "--pidfile".into(),
        pidfile.as_os_str().to_owned(),
        "--blockdev".into(),
        file_node.into(),
        "--blockdev".into(),
        qcow2_node.into(),
        "--export".into(),
        export.into(),
    ])
}

fn close_state(state: &mut RawViewState) -> Result<()> {
    let mut errors = Vec::new();
    let mounted = match mountpoint_is_active(&state.mountpoint) {
        Ok(active) => state.mounted || active,
        Err(error) => {
            errors.push(format!("failed to inspect raw view mountpoint: {error:#}"));
            state.mounted
        }
    };
    let unmount_error = if mounted {
        run_umount(&state.umount_binary, &state.mountpoint).err()
    } else {
        None
    };
    let mut child_stopped = true;
    if let Some(child) = state.child.as_mut()
        && let Err(error) = terminate_process(child, "raw view storage daemon")
    {
        errors.push(format!("failed to stop raw view storage daemon: {error:#}"));
        child_stopped = false;
    }
    let still_mounted = match mountpoint_is_active(&state.mountpoint) {
        Ok(active) => active,
        Err(error) => {
            errors.push(format!("failed to confirm raw view unmount: {error:#}"));
            true
        }
    };
    if still_mounted {
        if let Some(error) = unmount_error {
            errors.push(format!("failed to unmount raw view: {error:#}"));
        }
        errors.push(format!(
            "raw view mountpoint '{}' is still mounted",
            state.mountpoint.display()
        ));
    } else if child_stopped {
        state.mounted = false;
        for path in [&state.pidfile, &state.mountpoint, &state.source_qcow2_path] {
            if let Err(error) = remove_file_if_exists(path) {
                errors.push(format!("failed to remove '{}': {error:#}", path.display()));
            }
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
    mountpoint: &Path,
    source_qcow2_path: &Path,
) -> Result<()> {
    let state = RawViewState {
        source_qcow2_path: source_qcow2_path.to_path_buf(),
        mountpoint: mountpoint.to_path_buf(),
        pidfile: work_root.join("raw-view.pid"),
        qemu_storage_daemon_binary: config.qemu_storage_daemon_binary.clone(),
        umount_binary: config.umount_binary.clone(),
        child: None,
        mounted: false,
        _checkpoint_lease: None,
        _temporary_snapshot: None,
    };
    recover_stale_raw_view(&state)?;
    remove_file_if_exists(&state.mountpoint)?;
    remove_file_if_exists(&state.source_qcow2_path)?;
    Ok(())
}

fn recover_stale_raw_view(state: &RawViewState) -> Result<()> {
    let mounted = mountpoint_is_active(&state.mountpoint)?;
    let stale_pidfd = stale_qsd_pidfd(state)?;
    if mounted
        && let Err(error) = run_umount(&state.umount_binary, &state.mountpoint)
        && mountpoint_is_active(&state.mountpoint)?
    {
        return Err(error).context("failed to unmount an interrupted raw view");
    }
    if let Some(pidfd) = stale_pidfd {
        terminate_stale_pidfd(pidfd, "interrupted raw view storage daemon")?;
    }
    ensure!(
        !mountpoint_is_active(&state.mountpoint)?,
        "interrupted raw view mountpoint '{}' is still mounted",
        state.mountpoint.display()
    );
    remove_file_if_exists(&state.pidfile)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn mountpoint_is_active(path: &Path) -> Result<bool> {
    let expected = mountinfo_path(path)?;
    let mountinfo = fs::read_to_string("/proc/self/mountinfo")
        .context("failed to read /proc/self/mountinfo")?;
    Ok(mountinfo
        .lines()
        .any(|line| line.split_whitespace().nth(4) == Some(expected.as_str())))
}

#[cfg(not(target_os = "linux"))]
fn mountpoint_is_active(_path: &Path) -> Result<bool> {
    Ok(false)
}

#[cfg(target_os = "linux")]
fn mountinfo_path(path: &Path) -> Result<String> {
    let path = path
        .to_str()
        .context("raw view mountpoint path is not UTF-8")?;
    Ok(path
        .replace('\\', "\\134")
        .replace(' ', "\\040")
        .replace('\t', "\\011")
        .replace('\n', "\\012"))
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
        .context("raw view pidfile contains an invalid PID")
}

#[cfg(target_os = "linux")]
fn stale_qsd_pidfd(state: &RawViewState) -> Result<Option<rustix::fd::OwnedFd>> {
    let Some(pid) = read_pidfile(&state.pidfile)? else {
        return Ok(None);
    };
    let pidfd = match pidfd_open(pid, PidfdFlags::empty()) {
        Ok(pidfd) => pidfd,
        Err(error) if error == rustix::io::Errno::SRCH => return Ok(None),
        Err(error) => return Err(error).context("failed to bind raw view pidfile to a process"),
    };
    if !qsd_command_matches(pid, &state.pidfile, &state.mountpoint)? {
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
fn qsd_command_matches(pid: Pid, pidfile: &Path, mountpoint: &Path) -> Result<bool> {
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
    let mountpoint = mountpoint
        .to_str()
        .context("raw view mountpoint path is not UTF-8")?;
    Ok(qsd_command_arguments_match(
        &arguments,
        pidfile.as_os_str().as_bytes(),
        mountpoint,
    ))
}

#[cfg(target_os = "linux")]
fn qsd_command_arguments_match(
    arguments: &[&[u8]],
    expected_pidfile: &[u8],
    expected_mountpoint: &str,
) -> bool {
    let pidfile_matches = arguments
        .windows(2)
        .any(|pair| pair[0] == b"--pidfile" && pair[1] == expected_pidfile);
    let mountpoint_matches = arguments.windows(2).any(|pair| {
        pair[0] == b"--export"
            && serde_json::from_slice::<serde_json::Value>(pair[1]).is_ok_and(|export| {
                export["type"] == "fuse"
                    && export["mountpoint"].as_str() == Some(expected_mountpoint)
            })
    });
    pidfile_matches && mountpoint_matches
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
        Err(error) => {
            return Err(error).with_context(|| format!("failed to kill timed out {label}"));
        }
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
        .context("failed to poll raw view pidfd")?;
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

fn run_umount(binary: &Path, mountpoint: &Path) -> Result<()> {
    let mut child = Command::new(binary)
        .arg(mountpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to start umount '{}'", binary.display()))?;
    let status = wait_for_process(&mut child, RAW_VIEW_CLEANUP_TIMEOUT, "raw view umount")?;
    ensure!(
        status.success(),
        "raw view umount exited with status {status}"
    );
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

fn prepare_mountpoint(path: &Path) -> Result<()> {
    remove_file_if_exists(path)?;
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("failed to create raw view mountpoint '{}'", path.display()))?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove '{}'", path.display())),
    }
}

#[cfg(test)]
pub(super) fn test_guard(
    source_qcow2_path: PathBuf,
    mountpoint: PathBuf,
    read_timed_out: bool,
) -> RawViewGuard {
    RawViewGuard {
        state: Some(RawViewState {
            pidfile: mountpoint.with_extension("pid"),
            source_qcow2_path,
            mountpoint,
            qemu_storage_daemon_binary: PathBuf::from("qemu-storage-daemon"),
            umount_binary: PathBuf::from("umount"),
            child: None,
            mounted: false,
            _checkpoint_lease: None,
            _temporary_snapshot: None,
        }),
        watchdog: None,
        read_timed_out: Arc::new(AtomicBool::new(read_timed_out)),
        watchdog_error: Arc::new(Mutex::new(None)),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::PathBuf;
    #[cfg(target_os = "linux")]
    use std::process::{Command, Stdio};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tempfile::tempdir;

    use crate::config::QemuBuildConfig;
    #[cfg(target_os = "linux")]
    use rustix::process::{Pid, PidfdFlags, pidfd_open};

    #[cfg(target_os = "linux")]
    use super::qsd_command_arguments_match;
    use super::{
        RawViewGuard, RawViewState, prepare_mountpoint, qsd_arguments, read_pidfile,
        recover_interrupted_raw_view, recover_stale_raw_view,
    };

    #[test]
    fn qsd_arguments_keep_both_nodes_readonly_and_paths_structured() {
        let args = qsd_arguments(
            PathBuf::from("/work/source,quoted.qcow2").as_path(),
            PathBuf::from("/work/root.raw").as_path(),
            PathBuf::from("/work/raw-view.pid").as_path(),
        )
        .unwrap();
        let args = args
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let file: serde_json::Value = serde_json::from_str(&args[3]).unwrap();
        let qcow2: serde_json::Value = serde_json::from_str(&args[5]).unwrap();
        let export: serde_json::Value = serde_json::from_str(&args[7]).unwrap();

        assert_eq!(file["filename"], "/work/source,quoted.qcow2");
        assert_eq!(file["read-only"], true);
        assert_eq!(qcow2["read-only"], true);
        assert_eq!(export["mountpoint"], "/work/root.raw");
        assert_eq!(export["writable"], false);
        assert_eq!(export["allow-other"], "off");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stale_qsd_recovery_requires_its_exact_pidfile_and_mountpoint() {
        let command: &[&[u8]] = &[
            b"qemu-storage-daemon",
            b"--pidfile",
            b"/work/raw-view.pid",
            b"--export",
            br#"{"type":"fuse","mountpoint":"/work/root.raw","writable":false}"#,
        ];

        assert!(qsd_command_arguments_match(
            command,
            b"/work/raw-view.pid",
            "/work/root.raw"
        ));
        assert!(!qsd_command_arguments_match(
            command,
            b"/work/other.pid",
            "/work/root.raw"
        ));
        assert!(!qsd_command_arguments_match(
            command,
            b"/work/raw-view.pid",
            "/work/other.raw"
        ));
    }

    #[test]
    fn preparation_replaces_a_stale_raw_file_with_an_empty_mountpoint() {
        let directory = tempdir().unwrap();
        let mountpoint = directory.path().join("root.raw");
        std::fs::write(&mountpoint, b"stale raw disk").unwrap();

        prepare_mountpoint(&mountpoint).unwrap();

        assert!(mountpoint.is_file());
        assert_eq!(std::fs::metadata(&mountpoint).unwrap().len(), 0);
    }

    #[test]
    fn close_removes_private_source_and_mountpoint_once() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let mountpoint = directory.path().join("root.raw");
        let pidfile = directory.path().join("raw-view.pid");
        for path in [&source, &mountpoint, &pidfile] {
            std::fs::write(path, b"private").unwrap();
        }
        let mut guard = RawViewGuard {
            state: Some(RawViewState {
                source_qcow2_path: source.clone(),
                mountpoint: mountpoint.clone(),
                pidfile: pidfile.clone(),
                qemu_storage_daemon_binary: PathBuf::from("qemu-storage-daemon"),
                umount_binary: PathBuf::from("umount"),
                child: None,
                mounted: false,
                _checkpoint_lease: None,
                _temporary_snapshot: None,
            }),
            watchdog: None,
            read_timed_out: Arc::new(AtomicBool::new(false)),
            watchdog_error: Arc::new(Mutex::new(None)),
        };

        assert!(source.exists());
        assert!(mountpoint.exists());
        guard.close().unwrap();
        guard.close().unwrap();

        assert!(!source.exists());
        assert!(!mountpoint.exists());
        assert!(!pidfile.exists());
    }

    #[test]
    fn failed_start_reclaims_the_private_source_and_mountpoint() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let mountpoint = directory.path().join("root.raw");
        std::fs::write(&source, b"private").unwrap();
        let config = QemuBuildConfig {
            qemu_storage_daemon_binary: PathBuf::from("true"),
            umount_binary: PathBuf::from("true"),
            ..QemuBuildConfig::default()
        };

        let error = RawViewGuard::start(
            &config,
            directory.path(),
            source.clone(),
            mountpoint.clone(),
            None,
            None,
            Duration::from_secs(1),
        )
        .unwrap_err();

        assert!(format!("{error:#}").contains("storage daemon exited"));
        assert!(!source.exists());
        assert!(!mountpoint.exists());
        assert!(!directory.path().join("raw-view.pid").exists());
    }

    #[test]
    fn recovery_discards_malformed_and_nonpositive_stale_pidfiles_before_reuse() {
        let directory = tempdir().unwrap();
        for value in ["not-a-pid", "0", "-1"] {
            let pidfile = directory.path().join("raw-view.pid");
            std::fs::write(&pidfile, format!("{value}\n")).unwrap();
            let state = RawViewState {
                source_qcow2_path: directory.path().join("active.qcow2"),
                mountpoint: directory.path().join("root.raw"),
                pidfile: pidfile.clone(),
                qemu_storage_daemon_binary: PathBuf::from("qemu-storage-daemon"),
                umount_binary: PathBuf::from("umount"),
                child: None,
                mounted: false,
                _checkpoint_lease: None,
                _temporary_snapshot: None,
            };

            assert!(read_pidfile(&pidfile).unwrap().is_none(), "{value}");
            recover_stale_raw_view(&state).unwrap();

            assert!(!pidfile.exists(), "{value}");
        }
    }

    #[test]
    fn early_recovery_removes_stale_raw_view_files_before_disk_preparation() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let mountpoint = directory.path().join("root.raw");
        std::fs::write(&source, b"stale source").unwrap();
        std::fs::write(&mountpoint, b"stale root").unwrap();

        recover_interrupted_raw_view(
            &QemuBuildConfig::default(),
            directory.path(),
            &mountpoint,
            &source,
        )
        .unwrap();

        assert!(!source.exists());
        assert!(!mountpoint.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn read_deadline_terminates_the_owned_process() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let mountpoint = directory.path().join("root.raw");
        std::fs::write(&source, b"private").unwrap();
        std::fs::write(&mountpoint, b"private").unwrap();
        let child = Command::new("sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = Pid::from_raw(i32::try_from(child.id()).unwrap()).unwrap();
        let pidfd = pidfd_open(pid, PidfdFlags::empty()).unwrap();
        let mut guard = RawViewGuard {
            state: Some(RawViewState {
                source_qcow2_path: source.clone(),
                mountpoint: mountpoint.clone(),
                pidfile: directory.path().join("raw-view.pid"),
                qemu_storage_daemon_binary: PathBuf::from("qemu-storage-daemon"),
                umount_binary: PathBuf::from("umount"),
                child: Some(child),
                mounted: false,
                _checkpoint_lease: None,
                _temporary_snapshot: None,
            }),
            watchdog: None,
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
        assert!(!mountpoint.exists());
    }
}
