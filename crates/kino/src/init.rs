//! `kino init`, first cut (#309, re-cut from the T4 spike in #290): run the
//! lab's `ready` scripts, report `READY`, then run tasks (learn) or verify.
//!
//! The T11 spike adds steps 1–6 (`boot.rs`): a JSON-lines report channel on
//! vsock (no `kino.v2` yet), network, SSH, the recording disk and the lab
//! release on its fallback timer.

mod boot;
mod exec;
mod verify;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::watch;

/// `boot.json` on the run disk the guest loader mounted.
const BOOT_PATH: &str = "/run/intar/run/boot.json";
/// Root-only, on tmpfs: the run disk is noexec.
const SCRIPT_DIR: &str = "/run/intar/scripts";

const READY_INTERVAL: Duration = Duration::from_secs(2);
const READY_TOTAL: Duration = Duration::from_secs(300);
const TASK_INTERVAL: Duration = Duration::from_secs(5);
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// The contract's report port; the host listens on CID 2.
const REPORT_PORT: u32 = 18081;
const KEEPALIVE: Duration = Duration::from_secs(10);

/// The part of `GuestBootV3` (#307) that `kino init` reads so far. The
/// compiler has already lowered sugar (`http`, files, ...) into `run` scripts,
/// so Kino knows no check kinds.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Boot {
    pub(crate) machine: String,
    pub(crate) mode: Mode,
    /// Absent in unit tests: then steps 1–6 are skipped.
    #[serde(default)]
    pub(crate) guest: Option<boot::Guest>,
    /// Verify only: the other machines of the run, for the pre barrier.
    #[serde(default)]
    pub(crate) peers: Vec<String>,
    #[serde(default)]
    pub(crate) ready: Vec<ReadyScript>,
    #[serde(default)]
    pub(crate) tasks: Vec<Task>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Mode {
    Learn,
    Verify,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReadyScript {
    pub(crate) name: String,
    pub(crate) run: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Task {
    pub(crate) id: String,
    /// The check: exit 0 passes; otherwise the first `FAIL:` line is the
    /// learner message.
    pub(crate) run: String,
    /// `task` on this machine, `machine/task` on a peer.
    #[serde(default)]
    pub(crate) needs: Vec<String>,
    /// Verify only. Without it the task is implied: it must pass once its
    /// `needs` are solved (T4 finding 1).
    #[serde(default)]
    pub(crate) solve: Option<String>,
}

/// Mirrors `kino.v2`'s enums and messages; the learner path is `Task` only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum Phase {
    #[default]
    Booting,
    SshReady,
    Preparing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum Status {
    #[default]
    Pending,
    Pass,
    Fail,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct Report {
    pub(crate) phase: Phase,
    pub(crate) ssh_host_keys: Vec<String>,
    /// Guest uptime in ms when each step finished.
    pub(crate) timings_ms: BTreeMap<String, u64>,
    pub(crate) rss_kib: u64,
    pub(crate) ready: Vec<ReadyState>,
    pub(crate) tasks: Vec<TaskState>,
    pub(crate) verify: Option<verify::Verify>,
    pub(crate) failure: String,
    /// T19 spike: the last resume frame's outcome.
    pub(crate) resume: Option<ResumeReport>,
    /// T20 spike: 16 bytes of /dev/urandom read right after the thaw.
    pub(crate) thaw_rand: String,
}

/// T19 spike: what the host sends after a snapshot restore.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Resume {
    /// Host wall clock when the frame was sent.
    unix_ns: u64,
    #[serde(default)]
    step_clock: bool,
    #[serde(default)]
    rekey_ssh: bool,
    /// T20: per-run network identity applied after a resume.
    #[serde(default)]
    mac: Option<String>,
    #[serde(default)]
    ip_cidr: Option<String>,
    #[serde(default)]
    gateway: Option<String>,
    /// T20: host entropy, mixed in before a forced CRNG reseed.
    #[serde(default)]
    seed_hex: Option<String>,
}

/// T20 spike: what the host sends to make the guest hibernate.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Hibernate {
    device: String,
    #[serde(default)]
    image_size: Option<u64>,
    #[serde(default)]
    compressor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct ResumeReport {
    /// Guest wall clock minus the host's, before any step.
    pub(crate) skew_ms: i64,
    pub(crate) step_ms: u64,
    pub(crate) neigh_ms: u64,
    pub(crate) rekey_ms: u64,
    pub(crate) net_ms: u64,
    pub(crate) reseed_ms: u64,
    pub(crate) rand_after: String,
    pub(crate) error: String,
}

fn rand_hex() -> String {
    use std::io::Read as _;
    let mut buf = [0u8; 16];
    match std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)) {
        Ok(()) => buf.iter().map(|b| format!("{b:02x}")).collect(),
        Err(error) => format!("error: {error}"),
    }
}

fn sysfs(path: &str, value: &str) -> Result<(), String> {
    std::fs::write(path, value).map_err(|error| format!("{path} <- {value}: {error}"))
}

/// T20 spike: swapon the image device, point the kernel at it and write
/// `disk` to /sys/power/state. In the build VM the kernel then writes the
/// image and powers off; in a resumed VM the write returns here.
pub(crate) async fn hibernate(hibernate: Hibernate, report: watch::Sender<Report>) {
    let prepare = async {
        boot::run("swapon", &[&hibernate.device]).await?;
        sysfs("/sys/power/resume", &hibernate.device)?;
        sysfs("/sys/power/disk", "shutdown")?;
        if let Some(size) = hibernate.image_size {
            sysfs("/sys/power/image_size", &size.to_string())?;
        }
        if let Some(name) = &hibernate.compressor {
            sysfs("/sys/module/hibernate/parameters/compressor", name)?;
        }
        boot::run("sync", &[]).await
    };
    if let Err(error) = prepare.await {
        report.send_modify(|report| report.failure = format!("hibernate: {error}"));
        return;
    }
    let now = boot::uptime_ms();
    report.send_modify(|report| {
        report.timings_ms.insert("hibernating".to_owned(), now);
    });
    // Let the publisher send the frame before the freezer stops it.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let result = tokio::task::spawn_blocking(|| sysfs("/sys/power/state", "disk")).await;
    let rand = rand_hex();
    let now = boot::uptime_ms();
    report.send_modify(|report| {
        report.timings_ms.insert("thawed".to_owned(), now);
        report.thaw_rand = rand;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => report.failure = format!("hibernate: {error}"),
            Err(error) => report.failure = format!("hibernate: {error}"),
        }
    });
}

fn unix_ns() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_nanos()).unwrap_or(u64::MAX)
        })
}

/// T19 spike: step the clock to the host's, flush the neighbour cache and
/// optionally replace the SSH host key, then report `resumed`.
pub(crate) async fn resume(resume: Resume, report: watch::Sender<Report>) {
    let skew_ms = (i128::from(unix_ns()) - i128::from(resume.unix_ns)) / 1_000_000;
    let mut out = ResumeReport {
        skew_ms: i64::try_from(skew_ms).unwrap_or(i64::MAX),
        ..ResumeReport::default()
    };
    let mut errors = Vec::new();
    let started = Instant::now();
    if resume.step_clock {
        // ponytail: steps to the send time; the frame's age is the vsock
        // latency, well under a millisecond.
        let host = resume.unix_ns;
        let stamp = format!("@{}.{:09}", host / 1_000_000_000, host % 1_000_000_000);
        if let Err(error) = boot::run("date", &["-s", &stamp]).await {
            errors.push(error);
        }
    }
    out.step_ms = elapsed_ms(started);
    if resume.mac.is_some() || resume.ip_cidr.is_some() {
        let started = Instant::now();
        let net = async {
            let iface = boot::interface().ok_or("no NIC")?;
            if let Some(mac) = &resume.mac {
                boot::run("ip", &["link", "set", "dev", &iface, "address", mac]).await?;
            }
            if let Some(cidr) = &resume.ip_cidr {
                boot::run("ip", &["addr", "flush", "dev", &iface]).await?;
                boot::run("ip", &["addr", "replace", cidr, "dev", &iface]).await?;
                if let Some(gateway) = &resume.gateway {
                    boot::run(
                        "ip",
                        &["route", "replace", "default", "via", gateway, "dev", &iface],
                    )
                    .await?;
                }
            }
            Ok::<(), String>(())
        };
        if let Err(error) = net.await {
            errors.push(error);
        }
        out.net_ms = elapsed_ms(started);
    }
    if let Some(seed) = &resume.seed_hex {
        // ponytail: perl (Essential in Debian) does the RNDRESEEDCRNG ioctl
        // (0x5207), since the workspace forbids unsafe.
        let started = Instant::now();
        let script = r#"open(F,">","/dev/urandom") or die "$!"; print F pack("H*",$ARGV[0]); close F; open(F,">","/dev/urandom") or die "$!"; ioctl(F,0x5207,0) or die "ioctl: $!""#;
        if let Err(error) = boot::run("perl", &["-e", script, seed]).await {
            errors.push(error);
        }
        out.reseed_ms = elapsed_ms(started);
    }
    out.rand_after = rand_hex();
    let started = Instant::now();
    if let Err(error) = boot::run("ip", &["neigh", "flush", "all"]).await {
        errors.push(error);
    }
    out.neigh_ms = elapsed_ms(started);
    if resume.rekey_ssh {
        let started = Instant::now();
        let key = "/etc/ssh/ssh_host_ed25519_key";
        let _ = std::fs::remove_file(key);
        let _ = std::fs::remove_file(format!("{key}.pub"));
        let rekey = async {
            boot::run("ssh-keygen", &["-q", "-t", "ed25519", "-N", "", "-f", key]).await?;
            boot::run("systemctl", &["reload", "ssh.service"]).await
        };
        if let Err(error) = rekey.await {
            errors.push(error);
        }
        out.rekey_ms = elapsed_ms(started);
        if let Ok(keys) = std::fs::read_to_string(format!("{key}.pub")) {
            report.send_modify(|report| report.ssh_host_keys = vec![keys.trim().to_owned()]);
        }
    }
    out.error = errors.join("; ");
    let now = boot::uptime_ms();
    report.send_modify(|report| {
        report.timings_ms.insert("resumed".to_owned(), now);
        report.resume = Some(out);
    });
}

fn elapsed_ms(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct ReadyState {
    pub(crate) name: String,
    pub(crate) status: Status,
    pub(crate) tail: String,
}

/// No `observed` field: a learner sees the status and the message only
/// (T4 finding 2).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub(crate) struct TaskState {
    pub(crate) id: String,
    pub(crate) status: Status,
    pub(crate) message: String,
    pub(crate) passed_at_unix_ms: u64,
}

pub(crate) async fn main() -> anyhow::Result<()> {
    let (report, changes) = watch::channel(Report::default());
    boot::mark(&report, Phase::Booting, "kino_started");
    if std::path::Path::new(boot::WOKEN).exists() {
        boot::mark(&report, Phase::Booting, "woken");
    }
    tokio::spawn(publish(changes, report.clone()));
    let boot = match read_boot() {
        Ok(boot) => boot,
        Err(error) => return fail(&report, error).await,
    };
    if let Some(guest) = &boot.guest {
        if let Err(error) = boot::bring_up(guest, &report).await {
            return fail(&report, error).await;
        }
        boot::release_lab(guest, &report).await;
    }
    let keepalive = report.clone();
    tokio::spawn(async move {
        loop {
            keepalive.send_modify(|report| report.rss_kib = boot::rss_kib());
            tokio::time::sleep(KEEPALIVE).await;
        }
    });
    #[cfg(target_os = "linux")]
    resume_watch(report.clone());
    run(&boot, Path::new(SCRIPT_DIR), &report).await;
    // `kino init` is the guest supervisor: it stays up after its work.
    std::future::pending::<()>().await;
    Ok(())
}

async fn fail(report: &watch::Sender<Report>, error: String) -> anyhow::Result<()> {
    eprintln!("kino init: {error}");
    report.send_modify(|report| {
        report.phase = Phase::Failed;
        report.failure = error;
    });
    std::future::pending::<()>().await;
    Ok(())
}

fn read_boot() -> Result<Boot, String> {
    let bytes =
        std::fs::read(BOOT_PATH).map_err(|error| format!("failed to read {BOOT_PATH}: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{BOOT_PATH} is invalid: {error}"))
}

type Sink = Box<dyn tokio::io::AsyncWrite + Unpin + Send>;

/// Write every report change as one JSON line to the host, or to stdout when
/// the vsock channel cannot be opened.
async fn publish(mut changes: watch::Receiver<Report>, report: watch::Sender<Report>) {
    use tokio::io::AsyncWriteExt as _;
    let mut link = connect(&report, 50).await;
    loop {
        let mut line = serde_json::to_string(&*changes.borrow_and_update()).unwrap_or_default();
        line.push('\n');
        let sent = match link.as_mut() {
            Some((stream, _)) => {
                stream.write_all(line.as_bytes()).await.is_ok() && stream.flush().await.is_ok()
            }
            None => false,
        };
        if !sent {
            if link.is_some() {
                // T20: the connection is gone (hibernation resume); reconnect
                // and resend the latest report.
                link = connect(&report, u32::MAX).await;
                continue;
            }
            print!("{line}");
        }
        // T19 spike: a snapshot restore resets vsock, which closes the host
        // frame reader. Reconnect then and resend the latest report.
        let closed = tokio::select! {
            changed = changes.changed() => {
                if changed.is_err() {
                    return;
                }
                false
            }
            () = wait_closed(&mut link) => true,
        };
        if closed {
            link = connect(&report, u32::MAX).await;
        }
    }
}

type Link = (Sink, tokio::sync::oneshot::Receiver<()>);

async fn wait_closed(link: &mut Option<Link>) {
    match link {
        Some((_, closed)) => {
            let _ = closed.await;
        }
        None => std::future::pending().await,
    }
}

#[cfg(target_os = "linux")]
async fn connect(report: &watch::Sender<Report>, tries: u32) -> Option<Link> {
    use tokio_vsock::{VMADDR_CID_HOST, VsockAddr, VsockStream};
    for _ in 0..tries {
        if let Ok(stream) = VsockStream::connect(VsockAddr::new(VMADDR_CID_HOST, REPORT_PORT)).await
        {
            let (read, write) = tokio::io::split(stream);
            let (done, closed) = tokio::sync::oneshot::channel();
            let report = report.clone();
            tokio::spawn(async move {
                verify::read_host_frames(read, &report).await;
                let _ = done.send(());
            });
            return Some((Box::new(write), closed));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

#[cfg(not(target_os = "linux"))]
async fn connect(_report: &watch::Sender<Report>, _tries: u32) -> Option<Link> {
    None
}

pub(crate) async fn run(boot: &Boot, dir: &Path, report: &watch::Sender<Report>) {
    report.send_modify(|report| {
        report.ready = boot
            .ready
            .iter()
            .map(|ready| ReadyState {
                name: ready.name.clone(),
                ..ReadyState::default()
            })
            .collect();
        report.tasks = boot
            .tasks
            .iter()
            .map(|task| TaskState {
                id: task.id.clone(),
                ..TaskState::default()
            })
            .collect();
    });
    if !run_ready(&boot.ready, dir, report).await {
        report.send_modify(|report| {
            report.phase = Phase::Failed;
            if boot.mode == Mode::Verify {
                report.verify = Some(verify::Verify::failed());
            }
        });
        return;
    }
    // Tasks start only after READY (T4 finding 5).
    boot::mark(report, Phase::Ready, "ready");
    match boot.mode {
        Mode::Learn => run_tasks(&boot.tasks, dir, report).await,
        Mode::Verify => verify::run(boot, dir, report).await,
    }
}

/// Each script every 2 s until it exits 0, all within 300 s.
async fn run_ready(scripts: &[ReadyScript], dir: &Path, report: &watch::Sender<Report>) -> bool {
    let deadline = Instant::now() + READY_TOTAL;
    for (index, script) in scripts.iter().enumerate() {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let outcome = exec::run(dir, &format!("ready-{index}"), &script.run, left).await;
            let passed = outcome.status == Status::Pass;
            let out_of_time = Instant::now() + READY_INTERVAL >= deadline;
            report.send_modify(|report| {
                let state = &mut report.ready[index];
                state.status = if passed || out_of_time {
                    outcome.status
                } else {
                    Status::Pending
                };
                state.tail = outcome.tail;
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
async fn run_tasks(tasks: &[Task], dir: &Path, report: &watch::Sender<Report>) {
    let mut latched = vec![false; tasks.len()];
    while latched.contains(&false) {
        for (index, task) in tasks.iter().enumerate() {
            if latched[index] {
                continue;
            }
            let outcome = exec::run(dir, &format!("task-{index}"), &task.run, CHECK_TIMEOUT).await;
            latched[index] = outcome.status == Status::Pass;
            let next = TaskState {
                id: task.id.clone(),
                status: outcome.status,
                message: outcome.message,
                passed_at_unix_ms: if latched[index] { unix_ms() } else { 0 },
            };
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

/// T33: wake the report writer as soon as the guest resumes. A CLOCK_REALTIME timerfd armed with
/// TFD_TIMER_ABSTIME | TFD_TIMER_CANCEL_ON_SET is cancelled on every resume and on every wall-clock step; on each
/// cancel the report is touched as by the keepalive tick, so `publish` writes at once and a connection that died
/// during the sleep is noticed now instead of at the next keepalive.
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
            let far = Itimerspec {
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
                if timerfd_settime(&fd, flags, &far).is_err() {
                    return;
                }
                match rustix::io::read(&fd, &mut buf) {
                    Err(rustix::io::Errno::CANCELED) => {
                        let gap = suspend_gap_ms();
                        if gap > last_gap + 100 {
                            eprintln!(
                                "kino init: woken after a suspend; restarting from the run disk"
                            );
                            woken_restart();
                        }
                        last_gap = gap;
                        eprintln!("kino init: clock set or resume; report touched");
                        report.send_modify(|report| report.rss_kib = boot::rss_kib());
                    }
                    Ok(_) | Err(rustix::io::Errno::INTR) => {}
                    Err(_) => return,
                }
            }
        });
    drop(spawned);
}

/// T35: milliseconds this guest has spent suspended (CLOCK_BOOTTIME counts them, CLOCK_MONOTONIC does not).
#[cfg(target_os = "linux")]
fn suspend_gap_ms() -> i64 {
    use rustix::time::{ClockId, clock_gettime};
    let boot = clock_gettime(ClockId::Boottime);
    let mono = clock_gettime(ClockId::Monotonic);
    (boot.tv_sec - mono.tv_sec) * 1000 + (boot.tv_nsec - mono.tv_nsec) / 1_000_000
}

/// T35: after a wake the run disk and the recording disk are other files than the ones this guest was suspended
/// with, and this process is the build's Kino. Drop both file systems and their cached blocks, then let the guest
/// loader mount the run disk again and execute the Kino on it. Returns only when the exec failed.
#[cfg(target_os = "linux")]
fn woken_restart() {
    use std::os::unix::process::CommandExt as _;
    let script = "mkdir -p /run/intar; : >/run/intar/woken; umount /var/lib/kino-recordings; \
umount /run/intar/run || umount -l /run/intar/run; \
blockdev --flushbufs /dev/vdb; blockdev --flushbufs /dev/vdc; exec /usr/lib/intar/guest-loader";
    let error = std::process::Command::new("/bin/sh")
        .args(["-c", script])
        .exec();
    eprintln!("kino init: restart after the wake failed: {error}");
}
