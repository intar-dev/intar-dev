//! `kino init`: the guest supervisor of guest contract 3 (#309).
//!
//! The image's one unit mounts the run disk and executes this from it. It
//! applies `boot.json`, reports over `kino.v2`, releases the lab, runs the
//! `ready` scripts and then the tasks (learn) or verify.
//!
//! The state is the `kino.v2` `Report` itself; every change is sent to the
//! host, and the latest report again every 10 s.

mod boot;
mod exec;
mod verify;
mod wire;

#[cfg(test)]
mod tests;

use intar_contracts::guest::{
    APPLIED_BOOT_PATH, BOOT_JSON_FILENAME, GUEST_CONTRACT, GuestBootV3, RUN_DISK_MOUNT,
};
use intar_contracts::scenario::{MachineSpecV1, ScriptV1, SpecMode, SpecTaskV1};
use intar_kino_proto::kino_v2::{Phase, Ready, Report, Status, Task, Verify};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::watch;

/// Root-only, on tmpfs: the run disk is noexec.
const SCRIPT_DIR: &str = "/run/intar/scripts";

const READY_INTERVAL: Duration = Duration::from_secs(2);
/// One second under test, where a failing script should not take 300.
const READY_TOTAL: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 300 });
const TASK_INTERVAL: Duration = Duration::from_secs(5);
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a failure report gets to reach the host before the guest powers
/// off.
const FAILURE_LINGER: Duration = Duration::from_secs(3);
/// `Ready.tail` and `Report.failure` caps in `kino.v2`.
const READY_TAIL_BYTES: usize = 2048;
const FAILURE_BYTES: usize = 1024;

pub(crate) async fn main() -> anyhow::Result<()> {
    let (report, changes) = watch::channel(Report {
        contract: GUEST_CONTRACT,
        kino_version: env!("CARGO_PKG_VERSION").to_owned(),
        ..Report::default()
    });
    boot::mark(&report, Phase::Booting, "kino_started");
    tokio::spawn(wire::publish(changes));
    #[cfg(target_os = "linux")]
    resume_watch(report.clone());

    let (boot, digest) = match read_boot() {
        Ok(read) => read,
        Err(error) => return fail(&report, error).await,
    };
    // A guest woken from an image holds the marker of the boot.json the
    // build's Kino applied; a cold boot has none.
    let woken = std::fs::read_to_string(APPLIED_BOOT_PATH).is_ok_and(|applied| applied != digest);
    // The digest first: the host drops every report without it.
    report.send_modify(|report| report.boot_sha256.clone_from(&digest));
    if woken {
        boot::mark(&report, Phase::Booting, "woken");
    }
    if let Err(error) = boot::bring_up(&boot, woken, &report).await {
        return fail(&report, error).await;
    }
    if let Err(error) = std::fs::write(APPLIED_BOOT_PATH, &digest) {
        return fail(&report, format!("{APPLIED_BOOT_PATH}: {error}")).await;
    }
    boot::release_lab(&boot.spec, &report).await;
    run(
        &boot.spec,
        boot.mode,
        &peers_of(&boot),
        Path::new(SCRIPT_DIR),
        &report,
    )
    .await;
    // The supervisor stays up after its work: the report stream is the VM's
    // heartbeat.
    std::future::pending::<()>().await;
    Ok(())
}

/// The other machines of the run, for verify's barrier.
fn peers_of(boot: &GuestBootV3) -> Vec<String> {
    boot.peers.keys().cloned().collect()
}

/// A failure before `SSH_READY`: report it, then exit so the unit's
/// `FailureAction` powers the guest off.
async fn fail(report: &watch::Sender<Report>, error: String) -> anyhow::Result<()> {
    eprintln!("kino init: {error}");
    report.send_modify(|report| {
        report.set_phase(Phase::Failed);
        report.failure = head(&error, FAILURE_BYTES).to_owned();
    });
    tokio::time::sleep(FAILURE_LINGER).await;
    anyhow::bail!("{error}")
}

/// `boot.json` and the SHA-256 of its bytes.
fn read_boot() -> Result<(GuestBootV3, String), String> {
    let path = Path::new(RUN_DISK_MOUNT).join(BOOT_JSON_FILENAME);
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let boot: GuestBootV3 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is invalid: {error}", path.display()))?;
    if boot.contract != GUEST_CONTRACT {
        return Err(format!(
            "boot.json is guest contract {}, this Kino speaks {GUEST_CONTRACT}",
            boot.contract
        ));
    }
    let digest = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((boot, digest))
}

pub(crate) async fn run(
    spec: &MachineSpecV1,
    mode: SpecMode,
    peers: &[String],
    dir: &Path,
    report: &watch::Sender<Report>,
) {
    report.send_modify(|report| {
        report.ready = spec
            .ready
            .iter()
            .map(|ready| Ready {
                name: ready.name.clone(),
                ..Ready::default()
            })
            .collect();
        report.tasks = spec
            .tasks
            .iter()
            .map(|task| Task {
                id: task.id.clone(),
                ..Task::default()
            })
            .collect();
    });
    if !run_ready(&spec.ready, &spec.env, dir, report).await {
        // After SSH_READY this is a lab failure: the VM stays up.
        report.send_modify(|report| {
            report.set_phase(Phase::Failed);
            if mode == SpecMode::Verify {
                report.verify = Some(Verify {
                    done: true,
                    ..Verify::default()
                });
            }
        });
        return;
    }
    // Tasks start only after READY.
    boot::mark(report, Phase::Ready, "ready");
    match mode {
        SpecMode::Learn => run_tasks(&spec.tasks, &spec.env, dir, report).await,
        SpecMode::Verify => verify::run(spec, peers, dir, report).await,
    }
}

/// Each script every 2 s until it exits 0, all within 300 s.
async fn run_ready(
    scripts: &[ScriptV1],
    env: &BTreeMap<String, String>,
    dir: &Path,
    report: &watch::Sender<Report>,
) -> bool {
    let deadline = Instant::now() + READY_TOTAL;
    for (index, script) in scripts.iter().enumerate() {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let outcome =
                exec::run(dir, &format!("ready-{index}"), &script.script, env, left).await;
            let passed = outcome.status == Status::Pass;
            let out_of_time = Instant::now() + READY_INTERVAL >= deadline;
            report.send_modify(|report| {
                let state = &mut report.ready[index];
                state.set_status(if passed || out_of_time {
                    outcome.status
                } else {
                    Status::Pending
                });
                state.tail = tail(&outcome.tail, READY_TAIL_BYTES).to_owned();
                if !passed && out_of_time {
                    report.failure = format!("ready '{}' did not pass", script.name);
                }
            });
            if passed {
                break;
            }
            if out_of_time {
                return false;
            }
            tokio::time::sleep(READY_INTERVAL).await;
        }
    }
    true
}

/// Run each unlatched task every 5 s; the first pass latches it. Returns once
/// every task is latched.
///
/// ponytail: tasks run one after another, so many slow checks stretch the 5 s
/// round; run them concurrently if a scenario needs that.
async fn run_tasks(
    tasks: &[SpecTaskV1],
    env: &BTreeMap<String, String>,
    dir: &Path,
    report: &watch::Sender<Report>,
) {
    let mut latched = vec![false; tasks.len()];
    while latched.contains(&false) {
        for (index, task) in tasks.iter().enumerate() {
            if latched[index] {
                continue;
            }
            let outcome = exec::run(
                dir,
                &format!("task-{index}"),
                &task.check,
                env,
                CHECK_TIMEOUT,
            )
            .await;
            latched[index] = outcome.status == Status::Pass;
            let mut next = Task {
                id: task.id.clone(),
                message: outcome.message,
                passed_at_unix_ms: if latched[index] { unix_ms() } else { 0 },
                ..Task::default()
            };
            next.set_status(outcome.status);
            report.send_if_modified(|report| {
                let changed = report.tasks[index] != next;
                report.tasks[index] = next;
                changed
            });
        }
        if latched.contains(&false) {
            tokio::time::sleep(TASK_INTERVAL).await;
        }
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// The first `limit` bytes of `value`, cut at a character boundary.
pub(crate) fn head(value: &str, limit: usize) -> &str {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// The last `limit` bytes of `value`, cut at a character boundary.
pub(crate) fn tail(value: &str, limit: usize) -> &str {
    let mut start = value.len().saturating_sub(limit);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

/// Notice a resume from suspend at once. A `CLOCK_REALTIME` timerfd armed
/// with `TFD_TIMER_CANCEL_ON_SET` is cancelled at every resume and at every
/// wall-clock step. A resume shows as a jump of `CLOCK_BOOTTIME` against
/// `CLOCK_MONOTONIC`; then the guest was woken from an image and this
/// process is the build's Kino, so it hands over to the run's. A plain clock
/// step only touches the report, so a dead connection is noticed now.
#[cfg(target_os = "linux")]
fn resume_watch(report: watch::Sender<Report>) {
    use rustix::time::{
        Itimerspec, TimerfdClockId, TimerfdFlags, TimerfdTimerFlags, Timespec, timerfd_create,
        timerfd_settime,
    };
    let spawned = std::thread::Builder::new()
        .name("resume-watch".into())
        .spawn(move || {
            let Ok(fd) = timerfd_create(TimerfdClockId::Realtime, TimerfdFlags::CLOEXEC) else {
                return;
            };
            let never = Itimerspec {
                it_interval: Timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                },
                it_value: Timespec {
                    tv_sec: 7_258_118_400,
                    tv_nsec: 0,
                },
            };
            let mut buf = [0_u8; 8];
            let mut last_gap = suspend_gap_ms();
            loop {
                let flags = TimerfdTimerFlags::ABSTIME | TimerfdTimerFlags::CANCEL_ON_SET;
                if timerfd_settime(&fd, flags, &never).is_err() {
                    return;
                }
                match rustix::io::read(&fd, &mut buf) {
                    Err(rustix::io::Errno::CANCELED) => {
                        let gap = suspend_gap_ms();
                        if gap > last_gap + 100 {
                            hand_over();
                        }
                        last_gap = gap;
                        report.send_modify(|_| {});
                    }
                    Ok(_) | Err(rustix::io::Errno::INTR) => {}
                    Err(_) => return,
                }
            }
        });
    if let Err(error) = spawned {
        eprintln!("kino init: no resume watcher: {error}");
    }
}

/// Milliseconds this guest has spent suspended: `CLOCK_BOOTTIME` counts
/// them, `CLOCK_MONOTONIC` does not.
#[cfg(target_os = "linux")]
fn suspend_gap_ms() -> i64 {
    use rustix::time::{ClockId, clock_gettime};
    let boot = clock_gettime(ClockId::Boottime);
    let mono = clock_gettime(ClockId::Monotonic);
    (boot.tv_sec - mono.tv_sec) * 1000 + (boot.tv_nsec - mono.tv_nsec) / 1_000_000
}

/// The hand-over of guest contract 3 (`intar_contracts::guest`). After a
/// wake the run disk and the recording disk are other files than the ones
/// this guest was suspended with. Replace this process, drop both file
/// systems and their cached blocks, and let the loader mount the run disk
/// and execute the Kino on it. Returns only when the exec failed.
#[cfg(target_os = "linux")]
fn hand_over() {
    use intar_contracts::guest::GUEST_LOADER_PATH;
    use std::os::unix::process::CommandExt as _;
    eprintln!("kino init: resumed from suspend; handing over to the run disk's Kino");
    // A shell, because the mount is busy while this binary runs from it.
    let script = format!(
        "umount {recordings} 2>/dev/null; umount {RUN_DISK_MOUNT} || umount -l {RUN_DISK_MOUNT}; \
         blockdev --flushbufs {run} {rec}; exec {GUEST_LOADER_PATH}",
        recordings = boot::RECORDING_DIR,
        run = boot::RUN_DEVICE,
        rec = boot::RECORDING_DEVICE,
    );
    let error = std::process::Command::new("/bin/sh")
        .args(["-c", &script])
        .exec();
    eprintln!("kino init: hand-over failed: {error}");
}
