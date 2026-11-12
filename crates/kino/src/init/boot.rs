//! Steps 1–6 of `kino init` (§4.2 in #309), spike cut for T11: the report
//! channel, network, SSH, the recording disk, `SSH_READY` and the lab release.
//!
//! The report channel speaks newline-delimited JSON, not `kino.v2` protobuf:
//! the proto does not exist yet. Host frames (`PeerTasks`) come back on the
//! same connection, one JSON object per line.

use super::{Phase, Report};
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::watch;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_START_TIMEOUT: Duration = Duration::from_secs(30);
const LAB_RELEASE_FALLBACK: Duration = Duration::from_secs(5);
const RECORDING_DEVICE: &str = "/dev/vdc";
const RECORDING_DIR: &str = "/var/lib/kino-recordings";
const RECORDING_USER: &str = "ubuntu";
const RUN_CLI_BROKER: &str = "/run/intar/run-cli-broker";
const RUN_CLI_PORT: u32 = 18082;
/// T35: written by the old Kino right before it hands over after a wake.
pub(crate) const WOKEN: &str = "/run/intar/woken";

/// The run's network and access settings: the spike's stand-in for the
/// `GuestBootV3` fields of §3 in #307.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Guest {
    pub(crate) hostname: String,
    pub(crate) ip_cidr: String,
    pub(crate) gateway: String,
    #[serde(default)]
    pub(crate) dns: Vec<String>,
    /// Extra `/etc/hosts` lines (peers).
    #[serde(default)]
    pub(crate) hosts: Vec<String>,
    #[serde(default)]
    pub(crate) authorized_keys: Vec<String>,
    #[serde(default)]
    pub(crate) root_resize: bool,
    /// The lab has units deferred to `intar-lab.target`.
    #[serde(default)]
    pub(crate) lab_defer: bool,
}

/// Uptime in ms, the guest-side clock for `timings_ms`.
pub(crate) fn uptime_ms() -> u64 {
    std::fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|text| text.split_whitespace().next()?.parse::<f64>().ok())
        .map_or(0, |seconds| (seconds * 1000.0) as u64)
}

pub(crate) fn mark(report: &watch::Sender<Report>, phase: Phase, timing: &str) {
    let now = uptime_ms();
    report.send_modify(|report| {
        report.phase = phase;
        report.timings_ms.insert(timing.to_owned(), now);
    });
}

/// Network, SSH and the recording disk, then `SSH_READY`. Each step's failure
/// is the returned message.
pub(crate) async fn bring_up(guest: &Guest, report: &watch::Sender<Report>) -> Result<(), String> {
    let (network, ssh, recording) =
        tokio::join!(network(guest), prepare_ssh(guest), recording_disk());
    network?;
    ssh?;
    recording?;
    mark(report, Phase::Booting, "network_ssh_prepared");
    if guest.root_resize {
        run("resize2fs", &["/dev/vda"]).await?;
    }
    write(RUN_CLI_BROKER, &format!("vsock://2:{RUN_CLI_PORT}\n"))?;
    start_sshd().await?;
    let keys = std::fs::read_to_string("/etc/ssh/ssh_host_ed25519_key.pub")
        .map_err(|error| format!("host key: {error}"))?;
    report.send_modify(|report| report.ssh_host_keys = vec![keys.trim().to_owned()]);
    mark(report, Phase::SshReady, "ssh_ready");
    Ok(())
}

/// The lab release: today only the 5 s fallback when units are deferred
/// (no control socket for `recording_started` in this spike).
pub(crate) async fn release_lab(guest: &Guest, report: &watch::Sender<Report>) {
    mark(report, Phase::Preparing, "preparing");
    if guest.lab_defer {
        tokio::time::sleep(LAB_RELEASE_FALLBACK).await;
    }
    if let Err(error) = run("systemctl", &["start", "intar-lab.target"]).await {
        eprintln!("kino init: lab release: {error}");
    }
    mark(report, Phase::Preparing, "lab_released");
}

async fn network(guest: &Guest) -> Result<(), String> {
    write("/etc/hostname", &format!("{}\n", guest.hostname))?;
    let address = guest.ip_cidr.split('/').next().unwrap_or_default();
    let mut hosts = format!(
        "127.0.0.1 localhost\n{address} {}\n::1 localhost ip6-localhost ip6-loopback\n",
        guest.hostname
    );
    for line in &guest.hosts {
        hosts.push_str(line);
        hosts.push('\n');
    }
    write("/etc/hosts", &hosts)?;
    let resolv: String = guest
        .dns
        .iter()
        .map(|server| format!("nameserver {server}\n"))
        .collect();
    let _ = std::fs::remove_file("/etc/resolv.conf");
    write("/etc/resolv.conf", &resolv)?;
    run("hostname", &[&guest.hostname]).await?;
    let deadline = tokio::time::Instant::now() + NETWORK_TIMEOUT;
    loop {
        let attempt = async {
            let iface = interface().ok_or("no non-loopback interface")?;
            run("ip", &["link", "set", "dev", &iface, "up"]).await?;
            run("ip", &["addr", "replace", &guest.ip_cidr, "dev", &iface]).await?;
            run(
                "ip",
                &[
                    "route",
                    "replace",
                    "default",
                    "via",
                    &guest.gateway,
                    "dev",
                    &iface,
                ],
            )
            .await
        };
        match attempt.await {
            Ok(()) => {
                if Path::new(WOKEN).exists() {
                    // T35: a woken guest still has the build's address; remove every other global one.
                    let drop_others = format!(
                        "for a in $(ip -4 -o addr show dev \"$1\" scope global | awk '{{print $4}}'); do [ \"$a\" = \"{}\" ] || ip addr del \"$a\" dev \"$1\"; done",
                        guest.ip_cidr
                    );
                    let iface = interface().ok_or("no non-loopback interface")?;
                    run("sh", &["-c", &drop_others, "sh", &iface]).await?;
                    run(
                        "ip",
                        &[
                            "route",
                            "replace",
                            "default",
                            "via",
                            &guest.gateway,
                            "dev",
                            &iface,
                        ],
                    )
                    .await?;
                }
                return Ok(());
            }
            Err(error) if tokio::time::Instant::now() >= deadline => {
                return Err(format!("network: {error}"));
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

/// T20 (#331): the NIC is the entry with a `device` link and ARP type 1;
/// `sit0` and `lo` have neither. Sorted, so the choice does not depend on
/// kernfs hash order.
pub(crate) fn interface() -> Option<String> {
    let mut nics: Vec<String> = std::fs::read_dir("/sys/class/net")
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join("device").exists())
        .filter(|entry| {
            std::fs::read_to_string(entry.path().join("type")).is_ok_and(|t| t.trim() == "1")
        })
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    nics.sort();
    nics.into_iter().next()
}

async fn prepare_ssh(guest: &Guest) -> Result<(), String> {
    let ssh_dir = format!("/home/{RECORDING_USER}/.ssh");
    run(
        "install",
        &[
            "-d",
            "-m",
            "0700",
            "-o",
            RECORDING_USER,
            "-g",
            RECORDING_USER,
            &ssh_dir,
        ],
    )
    .await?;
    let keys_path = format!("{ssh_dir}/authorized_keys");
    write(
        &keys_path,
        &format!("{}\n", guest.authorized_keys.join("\n")),
    )?;
    run(
        "chown",
        &[&format!("{RECORDING_USER}:{RECORDING_USER}"), &keys_path],
    )
    .await?;
    run("chmod", &["0600", &keys_path]).await?;
    if Path::new(WOKEN).exists() {
        // T35: every run gets its own host key, also after a wake.
        let _ = std::fs::remove_file("/etc/ssh/ssh_host_ed25519_key");
        let _ = std::fs::remove_file("/etc/ssh/ssh_host_ed25519_key.pub");
    }
    if !Path::new("/etc/ssh/ssh_host_ed25519_key").exists() {
        run(
            "ssh-keygen",
            &[
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-f",
                "/etc/ssh/ssh_host_ed25519_key",
            ],
        )
        .await?;
    }
    Ok(())
}

/// A port of `start_sshd`: the gate marker, `sshd -t`, start, `is-active`.
async fn start_sshd() -> Result<(), String> {
    std::fs::create_dir_all("/run/sshd").map_err(|error| format!("/run/sshd: {error}"))?;
    run("/usr/sbin/sshd", &["-t"]).await?;
    write("/run/intar/ssh-ready", "")?;
    tokio::time::timeout(
        SSH_START_TIMEOUT,
        run(
            "systemctl",
            &[
                if Path::new(WOKEN).exists() {
                    "restart"
                } else {
                    "start"
                },
                "ssh.service",
            ],
        ),
    )
    .await
    .map_err(|_| "ssh.service did not start in time".to_owned())??;
    run("systemctl", &["is-active", "--quiet", "ssh.service"]).await
}

async fn recording_disk() -> Result<(), String> {
    let uid = id(&["-u", RECORDING_USER]).await?;
    let gid = id(&["-g", RECORDING_USER]).await?;
    std::fs::create_dir_all(RECORDING_DIR).map_err(|error| format!("{RECORDING_DIR}: {error}"))?;
    let options =
        format!("rw,sync,dirsync,uid={uid},gid={gid},utf8=1,fmask=0117,dmask=0007,shortname=mixed");
    run(
        "mount",
        &[
            "-t",
            "vfat",
            "-o",
            &options,
            RECORDING_DEVICE,
            RECORDING_DIR,
        ],
    )
    .await?;
    let canary = format!(
        "umask 077; printf 'ok\\n' >{RECORDING_DIR}/.intar-kino-write-check && rm -f {RECORDING_DIR}/.intar-kino-write-check"
    );
    run(
        "setpriv",
        &[
            &format!("--reuid={uid}"),
            &format!("--regid={gid}"),
            "--clear-groups",
            "/bin/sh",
            "-c",
            &canary,
        ],
    )
    .await
}

async fn id(args: &[&str]) -> Result<String, String> {
    let output = Command::new("id")
        .args(args)
        .output()
        .await
        .map_err(|error| format!("id: {error}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub(crate) async fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .await
        .map_err(|error| format!("{program}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{program} {}: {} {}",
            args.join(" "),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn write(path: &str, content: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("{path}: {error}"))?;
    }
    std::fs::write(path, content).map_err(|error| format!("{path}: {error}"))
}

/// `VmRSS` of this process in KiB.
pub(crate) fn rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("VmRSS:"))?
                .split_whitespace()
                .next()?
                .parse()
                .ok()
        })
        .unwrap_or(0)
}
