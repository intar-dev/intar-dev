//! A capture boot (#348): once the lab is up and quiet the guest drops what
//! belongs to a run and parks. The host snapshots the parked guest; every VM
//! restored from that snapshot gets a `Wake` and starts the run on its own
//! run disk through the guest loader, as a cold boot does.

#![cfg_attr(
    not(target_os = "linux"),
    allow(
        dead_code,
        unused_imports,
        reason = "a guest is Linux; elsewhere this builds for its tests"
    )
)]

use super::boot::{self, IP, SYSTEMCTL};
use super::{GUEST_CONTRACT, Phase, Report, wire};
use intar_contracts::guest::{GUEST_LOADER_PATH, GuestBootV3, RUN_DISK_MOUNT};
use intar_kino_proto::kino_v2::Wake;
use std::convert::Infallible;
use std::time::Duration;

pub(crate) const UMOUNT: &str = "/usr/bin/umount";
pub(crate) const BLOCKDEV: &str = "/usr/sbin/blockdev";
const RUN_DEVICE: &str = "/dev/vdb";
const RECORDING_DEVICE: &str = "/dev/vdc";

pub(crate) const PERL: &str = "/usr/bin/perl";
/// `RNDRESEEDCRNG` on `/dev/urandom`. Without it the kernel keeps handing
/// out the snapshot's random stream for up to a minute, and two restores
/// made the same SSH host key (measured in #348). perl-base is essential in
/// Debian, and the workspace forbids the `unsafe` a direct ioctl needs.
const RESEED: &str =
    r#"open(my $pool, ">", "/dev/urandom") or die; ioctl($pool, 0x5207, 0) or die"#;

/// Settled is no unit starting or waiting to restart, and at most a quarter
/// of one CPU busy, for ten seconds in a row. Quiet alone is not enough: a
/// service between two restarts is quiet too.
const QUIET_BUSY_CPUS: f64 = 0.25;
const QUIET_SECONDS: u32 = 10;
/// A lab that never settles is parked as it is.
const QUIET_LIMIT: Duration = Duration::from_secs(90);
const PARKED_LIMIT: Duration = Duration::from_secs(120);
const PROBE_INTERVAL: Duration = Duration::from_millis(25);
const WAKE_WAIT: Duration = Duration::from_millis(100);

/// Wait for quiet, keep the address as a local one only, and continue as
/// `kino parked` from memory, so the run disk can be unmounted.
pub(super) async fn park(boot: &GuestBootV3) -> Result<Infallible, String> {
    quiet().await;
    local_only(&boot.network.ip_cidr).await?;
    reexec_from_memory()
}

async fn quiet() {
    let deadline = tokio::time::Instant::now() + QUIET_LIMIT;
    let mut quiet_for = 0;
    let mut before = std::fs::read_to_string("/proc/stat").unwrap_or_default();
    while quiet_for < QUIET_SECONDS && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let after = std::fs::read_to_string("/proc/stat").unwrap_or_default();
        let busy = busy_cpus(&before, &after);
        quiet_for = if busy.is_some_and(|busy| busy <= QUIET_BUSY_CPUS) && units_settled().await {
            quiet_for + 1
        } else {
            0
        };
        before = after;
    }
}

/// No unit is starting, reloading or waiting for its restart.
async fn units_settled() -> bool {
    tokio::process::Command::new(SYSTEMCTL)
        .args([
            "list-units",
            "--state=activating,reloading",
            "--no-legend",
            "--plain",
        ])
        .output()
        .await
        .is_ok_and(|output| output.status.success() && output.stdout.trim_ascii().is_empty())
}

/// How many CPUs were busy between two readings of `/proc/stat`.
pub(super) fn busy_cpus(before: &str, after: &str) -> Option<f64> {
    // user nice system idle iowait irq softirq steal
    let totals = |stat: &str| -> Option<(u64, u64)> {
        let fields: Vec<u64> = stat
            .lines()
            .next()?
            .strip_prefix("cpu ")?
            .split_whitespace()
            .take(8)
            .filter_map(|field| field.parse().ok())
            .collect();
        let idle = fields.get(3)? + fields.get(4)?;
        Some((fields.iter().sum(), idle))
    };
    let cpus = after
        .lines()
        .filter(|line| line.starts_with("cpu") && !line.starts_with("cpu "))
        .count();
    let ((total_before, idle_before), (total_after, idle_after)) =
        (totals(before)?, totals(after)?);
    let total = total_after
        .checked_sub(total_before)
        .filter(|ticks| *ticks > 0)?;
    let idle = idle_after.checked_sub(idle_before)?.min(total);
    Some((total - idle) as f64 / total as f64 * cpus as f64)
}

/// The address stays on the guest as a host-only /32, so whatever is bound
/// to it (a Kubernetes node address) keeps working; its network, routes and
/// neighbours go. The run's own address is added by the run's boot.
async fn local_only(ip_cidr: &str) -> Result<(), String> {
    let iface = boot::interface().ok_or("no network interface")?;
    let address = ip_cidr.split('/').next().unwrap_or_default();
    let local = format!("{address}/32");
    boot::run(IP, &["addr", "add", &local, "scope", "host", "dev", &iface]).await?;
    boot::run(IP, &["addr", "del", ip_cidr, "dev", &iface]).await?;
    boot::run(IP, &["neigh", "flush", "dev", &iface]).await
}

#[cfg(target_os = "linux")]
fn reexec_from_memory() -> Result<Infallible, String> {
    use rustix::fs::{MemfdFlags, memfd_create};
    use std::os::fd::AsRawFd as _;
    use std::os::unix::process::CommandExt as _;

    let memory =
        memfd_create("kino", MemfdFlags::CLOEXEC).map_err(|error| format!("memfd: {error}"))?;
    let mut memory = std::fs::File::from(memory);
    let mut exe = std::fs::File::open("/proc/self/exe").map_err(|error| format!("exe: {error}"))?;
    std::io::copy(&mut exe, &mut memory).map_err(|error| format!("copy kino: {error}"))?;
    let error = std::process::Command::new(format!("/proc/self/fd/{}", memory.as_raw_fd()))
        .arg0("kino")
        .arg("parked")
        .exec();
    Err(format!("exec kino from memory: {error}"))
}

#[cfg(not(target_os = "linux"))]
fn reexec_from_memory() -> Result<Infallible, String> {
    Err("a guest parks on Linux only".to_owned())
}

/// `kino parked`: nothing of the run disk is in use any more. Unmount it,
/// tell the host, and wait for the `Wake` of a restored VM.
#[cfg(target_os = "linux")]
pub(crate) async fn parked() -> anyhow::Result<()> {
    use std::os::unix::process::CommandExt as _;

    let step = |error: String| anyhow::anyhow!("kino parked: {error}");
    boot::run(UMOUNT, &[RUN_DISK_MOUNT]).await.map_err(step)?;
    flush_disks().await.map_err(step)?;
    tokio::time::timeout(PARKED_LIMIT, announce())
        .await
        .map_err(|_| step("the host did not take PARKED".to_owned()))?;
    let wake = wait_for_wake().await;
    apply(&wake);
    boot::run(PERL, &["-e", RESEED]).await.map_err(step)?;
    // The run disk under the device is another one now.
    flush_disks().await.map_err(step)?;
    let error = std::process::Command::new(GUEST_LOADER_PATH).exec();
    Err(step(format!("exec {GUEST_LOADER_PATH}: {error}")))
}

#[cfg(not(target_os = "linux"))]
pub(crate) async fn parked() -> anyhow::Result<()> {
    anyhow::bail!("a guest parks on Linux only")
}

async fn flush_disks() -> Result<(), String> {
    boot::run(BLOCKDEV, &["--flushbufs", RUN_DEVICE]).await?;
    // A capture boot has no recording disk mounted; the device is there.
    boot::run(BLOCKDEV, &["--flushbufs", RECORDING_DEVICE]).await
}

#[cfg(target_os = "linux")]
async fn host() -> Option<tokio_vsock::VsockStream> {
    use intar_contracts::guest::REPORT_PORT;
    use tokio_vsock::{VMADDR_CID_HOST, VsockAddr, VsockStream};
    let connect = VsockStream::connect(VsockAddr::new(VMADDR_CID_HOST, REPORT_PORT));
    tokio::time::timeout(Duration::from_millis(200), connect)
        .await
        .ok()?
        .ok()
}

/// One `PARKED` report, then wait until the host closes the stream: it has
/// stopped listening, so until a restore no probe below can connect.
#[cfg(target_os = "linux")]
async fn announce() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut report = Report {
        contract: GUEST_CONTRACT,
        kino_version: env!("CARGO_PKG_VERSION").to_owned(),
        seq: 1,
        ..Report::default()
    };
    report.set_phase(Phase::Parked);
    let frame = wire::encode(report);
    loop {
        if let Some(mut stream) = host().await
            && stream.write_all(&frame).await.is_ok()
            && stream.flush().await.is_ok()
        {
            let mut rest = Vec::new();
            let _ = stream.read_to_end(&mut rest).await;
            return;
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }
}

#[cfg(target_os = "linux")]
async fn wait_for_wake() -> Wake {
    loop {
        if let Some(mut stream) = host().await
            && let Ok(Some(wake)) = tokio::time::timeout(WAKE_WAIT, read_wake(&mut stream)).await
        {
            return wake;
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }
}

/// The first host frame of a stream, when it is a `Wake`.
pub(super) async fn read_wake(mut read: impl tokio::io::AsyncRead + Unpin) -> Option<Wake> {
    use intar_kino_proto::kino_v2::{HostFrame, MAX_FRAME_BYTES, host_frame};
    use prost::Message as _;
    use tokio::io::AsyncReadExt as _;
    let length = read.read_u32().await.ok()? as usize;
    if length > MAX_FRAME_BYTES {
        return None;
    }
    let mut bytes = vec![0; length];
    read.read_exact(&mut bytes).await.ok()?;
    match HostFrame::decode(bytes.as_slice()).ok()?.frame? {
        host_frame::Frame::Wake(wake) => Some(wake),
        host_frame::Frame::PeerTasks(_) => None,
    }
}

/// The snapshot's clock stood still since the capture: step it forward to
/// the host's, never back. The seed makes this restore's random pool its own.
fn apply(wake: &Wake) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    if u128::from(wake.unix_ms) > now {
        set_clock(wake.unix_ms);
    }
    if let Err(error) = std::fs::write("/dev/urandom", &wake.seed) {
        eprintln!("kino parked: seed: {error}");
    }
}

#[cfg(target_os = "linux")]
fn set_clock(unix_ms: u64) {
    use rustix::time::{ClockId, Timespec, clock_settime};
    let time = Timespec {
        tv_sec: i64::try_from(unix_ms / 1000).unwrap_or(i64::MAX),
        tv_nsec: i64::try_from(unix_ms % 1000 * 1_000_000).unwrap_or(0),
    };
    if let Err(error) = clock_settime(ClockId::Realtime, time) {
        eprintln!("kino parked: clock: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
fn set_clock(_unix_ms: u64) {}
