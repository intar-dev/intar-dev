//! Host-side helpers of the build VM: QEMU's identity, its extra devices,
//! the checkpoint writer and bounded child commands.

use std::fs;
use std::future::Future;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::sha256::sha256_file_hex;

const ROOT_BLOCK_DEVICE: &str = "intar-root";
const VIRTIO_BALLOON_DEVICE: &str = "virtio-balloon-pci,id=intar-balloon,free-page-reporting=on";
pub(crate) const VIRTIO_BALLOON_VERIFY_COMMAND: &str = r#"set -eu
modprobe virtio_balloon
driver=/sys/bus/virtio/drivers/virtio_balloon
test -d "$driver"
page_reporting_order=/sys/module/page_reporting/parameters/page_reporting_order
test -r "$page_reporting_order"
test -w "$page_reporting_order"
for device in /sys/bus/virtio/devices/virtio*; do
  test -e "$device/device" || continue
  test -L "$device/driver" || continue
  if test "$(readlink -f "$device/driver")" = "$driver"; then
    exit 0
  fi
done
exit 1
"#;
pub(crate) const CHECKPOINT_MEMORY_RELEASE_COMMAND: &str = r#"set -eu
sync
fstrim / || true
page_reporting_order=/sys/module/page_reporting/parameters/page_reporting_order
test -r "$page_reporting_order"
test -w "$page_reporting_order"
previous_order=$(cat "$page_reporting_order")
restore_order() {
  printf '%s\n' "$previous_order" > "$page_reporting_order"
}
trap restore_order EXIT
printf 0 > "$page_reporting_order"
test "$(cat "$page_reporting_order")" = 0
sync
printf 3 > /proc/sys/vm/drop_caches
sleep 3
test "$(cat "$page_reporting_order")" = 0
restore_order
trap - EXIT
test "$(cat "$page_reporting_order")" = "$previous_order"
sync
"#;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ResumeMetadata {
    pub(crate) bootstrap_private_key: String,
    pub(crate) memory_encoding: String,
}

pub(crate) fn migration_writer_command(
    zstd: &Path,
    partial: &Path,
    output: &Path,
    complete: &Path,
) -> Result<String> {
    let zstd = zstd.to_str().context("checkpoint zstd path is not UTF-8")?;
    Ok(format!(
        "set -eu\nrm -f {partial} {output} {complete}\n{zstd} -1 -q -o {partial}\nmv {partial} {output}\n: > {complete}\n",
        partial = shell_quote(&partial.display().to_string()),
        output = shell_quote(&output.display().to_string()),
        complete = shell_quote(&complete.display().to_string()),
        zstd = shell_quote(zstd),
    ))
}

pub(crate) fn link_frozen_checkpoint_scratch(source: &Path, scratch: &Path) -> Result<()> {
    ensure!(
        source != scratch,
        "checkpoint scratch must differ from source"
    );
    fs::hard_link(source, scratch).with_context(|| {
        format!(
            "failed to hard-link frozen checkpoint '{}' into scratch '{}'",
            source.display(),
            scratch.display()
        )
    })
}

pub(crate) fn wait_for_checkpoint_output(
    output: &Path,
    complete: &Path,
    deadline: Instant,
) -> Result<()> {
    loop {
        if output.is_file() && complete.is_file() {
            return Ok(());
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .context("checkpoint migration writer did not finish")?;
        thread::sleep(Duration::from_millis(50).min(remaining));
    }
}

pub(crate) fn snapshot_sync_arguments(continuation_disk: &Path) -> Result<serde_json::Value> {
    let snapshot_file = continuation_disk
        .to_str()
        .context("checkpoint continuation path is not UTF-8")?;
    Ok(json!({
        "device": ROOT_BLOCK_DEVICE,
        "snapshot-file": snapshot_file,
        "format": "qcow2",
    }))
}

pub(crate) fn append_layered_devices(args: &mut Vec<String>) {
    args.extend([
        "-device".to_string(),
        "vmgenid,guid=auto".to_string(),
        "-device".to_string(),
        VIRTIO_BALLOON_DEVICE.to_string(),
    ]);
}

pub(crate) fn replace_serial_log_with_append(args: &mut Vec<String>, serial_log_path: &Path) {
    let Some(index) = args.iter().position(|argument| argument == "-serial") else {
        return;
    };
    if index + 1 >= args.len() {
        return;
    }
    args.splice(
        index..=index + 1,
        [
            "-chardev".to_string(),
            format!(
                "file,id=intar-build-serial,path={},append=on",
                serial_log_path.display()
            ),
            "-serial".to_string(),
            "chardev:intar-build-serial".to_string(),
        ],
    );
}

/// The QEMU version and binary hash, and the host CPU lines a checkpoint
/// depends on.
pub(crate) fn qemu_host_identity(
    qemu_binary: &Path,
    work_root: &Path,
    timeout_seconds: u64,
) -> Result<(String, String)> {
    let executable = resolve_binary(qemu_binary)?;
    let mut version_command = Command::new(&executable);
    version_command.arg("--version");
    let version = run_command_output_until(
        version_command,
        work_root,
        deadline_after(timeout_seconds),
        "QEMU version query",
    )?;
    ensure!(version.status.success(), "failed to read QEMU version");
    let qemu_version = format!(
        "{}\nsha256={}",
        String::from_utf8(version.stdout)?,
        sha256_file_hex(&executable)?
    );
    let cpu = fs::read_to_string("/proc/cpuinfo")?
        .lines()
        .filter(|line| {
            [
                "vendor_id",
                "cpu family",
                "model\t",
                "model name",
                "stepping",
                "flags",
            ]
            .iter()
            .any(|key| line.starts_with(key))
        })
        .take(6)
        .collect::<Vec<_>>()
        .join("\n");
    Ok((qemu_version, cpu))
}

pub(crate) fn resolve_binary(binary: &Path) -> Result<PathBuf> {
    if binary.is_absolute() || binary.components().count() > 1 {
        return fs::canonicalize(binary).context("build executable is unavailable");
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|path| path.join(binary))
        .find(|path| path.is_file())
        .context("build executable is not on PATH")
        .and_then(|path| fs::canonicalize(path).map_err(Into::into))
}

pub(crate) fn run_command_output_until(
    mut command: Command,
    work_root: &Path,
    deadline: Instant,
    label: &str,
) -> Result<std::process::Output> {
    let mut stdout = tempfile::tempfile_in(work_root)
        .with_context(|| format!("failed to create {label} stdout capture"))?;
    let mut stderr = tempfile::tempfile_in(work_root)
        .with_context(|| format!("failed to create {label} stderr capture"))?;
    let stdout_child = stdout
        .try_clone()
        .with_context(|| format!("failed to clone {label} stdout capture"))?;
    let stderr_child = stderr
        .try_clone()
        .with_context(|| format!("failed to clone {label} stderr capture"))?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_child))
        .stderr(Stdio::from(stderr_child))
        .spawn()
        .with_context(|| format!("failed to start {label}"))?;
    let status = wait_for_command_until(&mut child, deadline, label)?;
    let stdout = read_command_capture(&mut stdout, label, "stdout")?;
    let stderr = read_command_capture(&mut stderr, label, "stderr")?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn read_command_capture(file: &mut fs::File, label: &str, stream: &str) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))
        .with_context(|| format!("failed to seek {label} {stream} capture"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {label} {stream} capture"))?;
    Ok(bytes)
}

fn wait_for_command_until(child: &mut Child, deadline: Instant, label: &str) -> Result<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(error) => {
                return Err(command_failure_after_cleanup(
                    child,
                    label,
                    format!("failed to poll {label}: {error}"),
                ));
            }
        }
        let remaining = match deadline.checked_duration_since(Instant::now()) {
            Some(remaining) if !remaining.is_zero() => remaining,
            _ => {
                return Err(command_failure_after_cleanup(
                    child,
                    label,
                    format!("{label} timed out"),
                ));
            }
        };
        thread::sleep(Duration::from_millis(50).min(remaining));
    }
}

fn command_failure_after_cleanup(child: &mut Child, label: &str, failure: String) -> anyhow::Error {
    match terminate_command(child, label) {
        Ok(status) => anyhow!("{failure}; {label} was terminated and reaped with status {status}"),
        Err(cleanup_error) => anyhow!(
            "{failure}; additionally failed to terminate and reap {label}: {cleanup_error:#}"
        ),
    }
}

fn terminate_command(child: &mut Child, label: &str) -> Result<ExitStatus> {
    let pid = child.id();
    if let Err(kill_error) = child.kill() {
        return match child.try_wait() {
            Ok(Some(status)) => Ok(status),
            Ok(None) => Err(anyhow!(
                "failed to kill still-running {label} pid {pid}: {kill_error}"
            )),
            Err(poll_error) => Err(anyhow!(
                "failed to kill {label} pid {pid}: {kill_error}; failed to determine whether it exited: {poll_error}"
            )),
        };
    }
    child
        .wait()
        .with_context(|| format!("failed to reap {label} pid {pid} after killing it"))
}

pub(crate) fn deadline_after(timeout_seconds: u64) -> Instant {
    Instant::now() + Duration::from_secs(timeout_seconds.max(1))
}

pub(crate) fn timeout_in_runtime<T>(
    runtime: &tokio::runtime::Runtime,
    timeout: Duration,
    phase: &str,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    runtime.block_on(async move {
        tokio::time::timeout(timeout, future)
            .await
            .with_context(|| format!("{phase} timed out"))?
    })
}

pub(crate) fn remaining_until(deadline: Instant, phase: &str) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .with_context(|| format!("{phase} deadline expired"))
}

pub(crate) fn remove_work_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn render_clock_set_command(unix_seconds: u64) -> String {
    format!("sudo date -u -s @{unix_seconds}")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::os::unix::fs::MetadataExt as _;

    use super::*;
    use crate::checkpoint::CheckpointIdentity;
    use crate::machine::plan::PROVISIONING_ABI;

    #[test]
    fn checkpoint_source_commands_freeze_then_continue_with_a_private_overlay() {
        let output = Path::new("/work/memory.state.zst");
        let partial = Path::new("/work/memory.state.zst.partial");
        let marker = Path::new("/work/memory.state.complete");
        let command =
            migration_writer_command(Path::new("/usr/bin/zstd"), partial, output, marker).unwrap();
        let snapshot =
            snapshot_sync_arguments(Path::new("/work/active-checkpoint-2.qcow2")).unwrap();

        assert!(command.contains("-o '/work/memory.state.zst.partial'"));
        assert!(command.contains("mv '/work/memory.state.zst.partial' '/work/memory.state.zst'"));
        assert!(command.contains(": > '/work/memory.state.complete'"));
        assert_eq!(snapshot["device"], ROOT_BLOCK_DEVICE);
        assert_eq!(snapshot["snapshot-file"], "/work/active-checkpoint-2.qcow2");
        assert_eq!(snapshot["format"], "qcow2");
    }

    #[test]
    fn checkpoint_output_wait_requires_the_writer_completion_marker() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("memory.state.zst");
        let marker = directory.path().join("memory.state.complete");
        std::fs::write(&output, b"state").unwrap();

        assert!(wait_for_checkpoint_output(&output, &marker, Instant::now()).is_err());
        std::fs::write(&marker, b"").unwrap();
        wait_for_checkpoint_output(&output, &marker, Instant::now() + Duration::from_secs(1))
            .unwrap();
    }

    #[test]
    fn self_contained_checkpoint_uses_a_distinct_publish_scratch_hardlink() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("active.qcow2");
        let scratch = directory.path().join("checkpoint.qcow2");
        std::fs::write(&source, b"frozen checkpoint").unwrap();

        link_frozen_checkpoint_scratch(&source, &scratch).unwrap();

        assert_ne!(source, scratch);
        assert_eq!(
            std::fs::metadata(&source).unwrap().ino(),
            std::fs::metadata(&scratch).unwrap().ino()
        );
    }

    #[test]
    fn layered_serial_device_appends_to_the_single_build_log() {
        let mut args = vec![
            "-display".to_string(),
            "none".to_string(),
            "-serial".to_string(),
            "file:/work/serial.log".to_string(),
        ];

        replace_serial_log_with_append(&mut args, Path::new("/work/serial.log"));

        assert!(args.windows(2).any(|pair| {
            pair == [
                "-chardev",
                "file,id=intar-build-serial,path=/work/serial.log,append=on",
            ]
        }));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-serial", "chardev:intar-build-serial"])
        );
        assert!(
            !args
                .iter()
                .any(|argument| argument == "file:/work/serial.log")
        );
    }

    #[test]
    fn balloon_device_is_stable_and_invalidates_checkpoint_identity() {
        let mut devices = Vec::new();
        append_layered_devices(&mut devices);
        assert_eq!(
            devices
                .windows(2)
                .filter(|pair| pair[0] == "-device" && pair[1] == VIRTIO_BALLOON_DEVICE)
                .count(),
            1
        );
        assert!(
            devices
                .windows(2)
                .any(|pair| pair == ["-device", "vmgenid,guid=auto"])
        );

        let identity = |qemu_devices: Vec<String>| CheckpointIdentity {
            scenario_id: "scenario".to_string(),
            vm_name: "vm".to_string(),
            parent_prefix: "base".to_string(),
            stage_bytes: b"stage".to_vec(),
            base_sha256: "a".repeat(64),
            kernel_sha256: "b".repeat(64),
            initrd_sha256: "c".repeat(64),
            disk_geometry_bytes: 1,
            qemu_version: "qemu".to_string(),
            qemu_cpu: "host".to_string(),
            qemu_devices,
            provisioning_abi: PROVISIONING_ABI.to_string(),
        };
        let without_balloon = vec!["-device".to_string(), "vmgenid,guid=auto".to_string()];
        assert_ne!(
            identity(devices).cache_key().unwrap(),
            identity(without_balloon).cache_key().unwrap()
        );
    }

    #[test]
    fn balloon_guest_commands_keep_reporting_treatment_bounded() {
        assert!(VIRTIO_BALLOON_VERIFY_COMMAND.contains("modprobe virtio_balloon"));
        assert!(VIRTIO_BALLOON_VERIFY_COMMAND.contains("/sys/bus/virtio/drivers/virtio_balloon"));
        assert!(VIRTIO_BALLOON_VERIFY_COMMAND.contains(
            "page_reporting_order=/sys/module/page_reporting/parameters/page_reporting_order"
        ));
        assert!(VIRTIO_BALLOON_VERIFY_COMMAND.contains("test -w \"$page_reporting_order\""));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("fstrim / || true"));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("drop_caches"));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains(
            "page_reporting_order=/sys/module/page_reporting/parameters/page_reporting_order"
        ));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("trap restore_order EXIT"));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("sleep 3"));
        assert!(CHECKPOINT_MEMORY_RELEASE_COMMAND.contains("trap - EXIT"));
    }

    #[test]
    fn restore_clock_command_uses_the_trusted_host_epoch() {
        assert_eq!(
            render_clock_set_command(1_789_000_123),
            "sudo date -u -s @1789000123"
        );
    }

    #[test]
    fn timeout_helper_constructs_the_timer_inside_the_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        timeout_in_runtime(&runtime, Duration::from_millis(10), "test timer", async {
            Ok::<_, anyhow::Error>(())
        })
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_kills_and_reaps_the_child() {
        let work_root = tempfile::tempdir().unwrap();
        let command = {
            let mut command = Command::new("/bin/sleep");
            command.arg("60");
            command
        };

        let error = run_command_output_until(
            command,
            work_root.path(),
            Instant::now() + Duration::from_millis(10),
            "test command",
        )
        .unwrap_err();

        assert!(error.to_string().contains("test command timed out"));
    }
}
