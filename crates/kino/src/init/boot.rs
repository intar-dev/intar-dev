//! Applying `boot.json` (§4.2 in #309): network, SSH, the recording disk and
//! the lab release. The same steps run at a cold boot and after a wake,
//! where the guest still has the build's values.

use super::{Phase, Report};
use intar_contracts::guest::{GUEST_USERNAME, GuestBootV3, RUN_CLI_PORT};
use intar_contracts::scenario::MachineSpecV1;
use sha2::{Digest as _, Sha256};
use std::io::Read as _;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::watch;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_START_TIMEOUT: Duration = Duration::from_secs(30);
const LAB_RELEASE_FALLBACK: Duration = Duration::from_secs(5);
/// The disk order is fixed: root, run disk, recording disk.
const ROOT_DEVICE: &str = "/dev/vda";
#[cfg_attr(
    not(target_os = "linux"),
    allow(dead_code, reason = "used by the Linux guest only")
)]
pub(crate) const RUN_DEVICE: &str = "/dev/vdb";
pub(crate) const RECORDING_DEVICE: &str = "/dev/vdc";
pub(crate) const RECORDING_DIR: &str = "/var/lib/kino-recordings";
const RUN_CLI_BROKER: &str = "/run/intar/run-cli-broker";
const HOST_KEY: &str = "/etc/ssh/ssh_host_ed25519_key";

/// Uptime in ms, the guest-side clock for `timings_ms`.
fn uptime_ms() -> u64 {
    std::fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|text| text.split_whitespace().next()?.parse::<f64>().ok())
        .map_or(0, |seconds| (seconds * 1000.0) as u64)
}

pub(crate) fn mark(report: &watch::Sender<Report>, phase: Phase, timing: &str) {
    let now = uptime_ms();
    report.send_modify(|report| {
        report.set_phase(phase);
        report.timings_ms.insert(timing.to_owned(), now);
    });
}

/// Network, SSH and the recording disk, then `SSH_READY`. Each step's failure
/// is the returned message.
pub(crate) async fn bring_up(
    boot: &GuestBootV3,
    boot_sha256: &str,
    woken: bool,
    report: &watch::Sender<Report>,
) -> Result<(), String> {
    let ssh = boot.ssh.enabled;
    let (renewed, network, prepared, recording) = tokio::join!(
        async {
            if woken {
                renew_machine_id(boot_sha256, report).await
            } else {
                Ok(())
            }
        },
        network(boot, woken),
        async {
            if ssh {
                prepare_ssh(boot, woken).await
            } else {
                Ok(())
            }
        },
        async { if ssh { recording_disk().await } else { Ok(()) } },
    );
    renewed?;
    network?;
    prepared?;
    recording?;
    mark(report, Phase::Booting, "network_ssh_prepared");
    if boot.root_resize {
        run("resize2fs", &[ROOT_DEVICE]).await?;
    }
    write(RUN_CLI_BROKER, &format!("vsock://2:{RUN_CLI_PORT}\n"))?;
    if ssh {
        start_sshd(woken).await?;
        let key = std::fs::read_to_string(format!("{HOST_KEY}.pub"))
            .map_err(|error| format!("host key: {error}"))?;
        report.send_modify(|report| report.ssh_host_keys_openssh = vec![key.trim().to_owned()]);
    }
    mark(report, Phase::SshReady, "ssh_ready");
    Ok(())
}

/// Start the deferred units.
///
/// ponytail: waits the 5 s fallback whenever units are deferred; the
/// recorder's `recording_started` over the control socket releases earlier
/// once the run CLI of guest contract 3 lands.
pub(crate) async fn release_lab(spec: &MachineSpecV1, report: &watch::Sender<Report>) {
    mark(report, Phase::Preparing, "preparing");
    if !spec.defer.is_empty() {
        tokio::time::sleep(LAB_RELEASE_FALLBACK).await;
    }
    // Not waiting for the units: the ready scripts say when the lab is up.
    if let Err(error) = run("systemctl", &["start", "--no-block", "intar-lab.target"]).await {
        eprintln!("kino init: lab release: {error}");
    }
    mark(report, Phase::Preparing, "lab_released");
}

const MACHINE_ID: &str = "/etc/machine-id";
const DBUS_MACHINE_ID: &str = "/var/lib/dbus/machine-id";
/// The daemons of the base that read the machine id once, at their start, in
/// the order they restart: the journal first, the bus before its clients.
/// Only the active ones restart; content's own units are not among them.
const MACHINE_ID_READERS: &[&str] = &[
    "systemd-journald.service",
    "dbus.service",
    "dbus-broker.service",
    "systemd-logind.service",
    "systemd-networkd.service",
    "systemd-hostnamed.service",
];

/// One step of [`machine_id_steps`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdStep {
    Write(&'static str),
    /// PID 1 caches the id; a re-executed manager reads the file again.
    Reexec,
    RestartIfActive(&'static str),
    /// Remove every volatile journal but the new id's: the file of a woken
    /// guest is empty, so the old id is known only by its directory.
    PruneJournals,
}

/// The run's machine id: 128 bits of the kernel's RNG, which reseeds on the
/// resume, hashed with the run's `boot.json` digest, shaped as a v4 UUID
/// like the ids systemd generates.
pub(crate) fn machine_id(random: &[u8; 32], boot_sha256: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"intar machine-id\0");
    hash.update(random);
    hash.update(boot_sha256.as_bytes());
    let mut id: [u8; 16] = [0; 16];
    id.copy_from_slice(&hash.finalize()[..16]);
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
    id.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What makes a woken guest take a new id: the files, PID 1, the daemons
/// that read it at start, and the journals of earlier ids.
pub(crate) fn machine_id_steps(dbus_file: bool) -> Vec<IdStep> {
    let mut steps = vec![IdStep::Write(MACHINE_ID)];
    if dbus_file {
        steps.push(IdStep::Write(DBUS_MACHINE_ID));
    }
    steps.push(IdStep::Reexec);
    steps.extend(
        MACHINE_ID_READERS
            .iter()
            .copied()
            .map(IdStep::RestartIfActive),
    );
    steps.push(IdStep::PruneJournals);
    steps
}

/// A woken guest holds the image's machine id, the same in every run woken
/// from it: give this run its own, before anything of the run reads it.
async fn renew_machine_id(boot_sha256: &str, report: &watch::Sender<Report>) -> Result<(), String> {
    let mut random = [0_u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut urandom| urandom.read_exact(&mut random))
        .map_err(|error| format!("/dev/urandom: {error}"))?;
    let id = machine_id(&random, boot_sha256);
    // A symlink (Debian's) points at /etc/machine-id already.
    let dbus_file = std::fs::symlink_metadata(DBUS_MACHINE_ID).is_ok_and(|meta| meta.is_file());
    for step in machine_id_steps(dbus_file) {
        match step {
            IdStep::Write(path) => replace(path, &format!("{id}\n"))?,
            IdStep::Reexec => run("systemctl", &["daemon-reexec"]).await?,
            IdStep::RestartIfActive(unit) => {
                if run("systemctl", &["is-active", "--quiet", unit])
                    .await
                    .is_ok()
                {
                    run("systemctl", &["restart", unit]).await?;
                }
            }
            IdStep::PruneJournals => prune_journals(&id)?,
        }
    }
    mark(report, Phase::Booting, "machine_id_renewed");
    Ok(())
}

fn prune_journals(id: &str) -> Result<(), String> {
    const JOURNALS: &str = "/run/log/journal";
    let entries = match std::fs::read_dir(JOURNALS) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        entries => entries.map_err(|error| format!("{JOURNALS}: {error}"))?,
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if entry.file_name() != id && path.is_dir() {
            std::fs::remove_dir_all(&path)
                .map_err(|error| format!("{}: {error}", path.display()))?;
        }
    }
    Ok(())
}

/// Write `path` whole through a rename, mode 0444 as systemd makes it.
fn replace(path: &str, content: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    let next = format!("{path}.intar-new");
    std::fs::write(&next, content)
        .and_then(|()| std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o444)))
        .and_then(|()| std::fs::rename(&next, path))
        .map_err(|error| format!("{path}: {error}"))
}

async fn network(boot: &GuestBootV3, woken: bool) -> Result<(), String> {
    let (hostname, net) = (&boot.hostname, &boot.network);
    write("/etc/hostname", &format!("{hostname}\n"))?;
    let address = net.ip_cidr.split('/').next().unwrap_or_default();
    let mut hosts = format!(
        "127.0.0.1 localhost\n{address} {hostname}\n::1 localhost ip6-localhost ip6-loopback\n"
    );
    for (peer, ip) in &boot.peers {
        hosts.push_str(&format!("{ip} {peer}\n"));
    }
    write("/etc/hosts", &hosts)?;
    // No `nameserver` line without egress: peers resolve from /etc/hosts.
    let resolv: String = net
        .dns
        .iter()
        .map(|server| format!("nameserver {server}\n"))
        .collect();
    let _ = std::fs::remove_file("/etc/resolv.conf");
    write("/etc/resolv.conf", &resolv)?;
    run("hostname", &[hostname]).await?;
    let deadline = tokio::time::Instant::now() + NETWORK_TIMEOUT;
    loop {
        let attempt = async {
            let iface = interface().ok_or("no network interface")?;
            run("ip", &["link", "set", "dev", &iface, "up"]).await?;
            if woken {
                // The build's address is still on the interface.
                run("ip", &["addr", "flush", "dev", &iface, "scope", "global"]).await?;
            }
            run("ip", &["addr", "replace", &net.ip_cidr, "dev", &iface]).await?;
            run(
                "ip",
                &[
                    "route",
                    "replace",
                    "default",
                    "via",
                    &net.gateway,
                    "dev",
                    &iface,
                ],
            )
            .await
        };
        match attempt.await {
            Ok(()) => return Ok(()),
            Err(error) if tokio::time::Instant::now() >= deadline => {
                return Err(format!("network: {error}"));
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

/// The NIC is the entry with a `device` link and ARP type 1; `sit0` and `lo`
/// have neither. Sorted, so the choice does not depend on kernfs hash order.
fn interface() -> Option<String> {
    let mut nics: Vec<String> = std::fs::read_dir("/sys/class/net")
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join("device").exists())
        .filter(|entry| {
            std::fs::read_to_string(entry.path().join("type")).is_ok_and(|kind| kind.trim() == "1")
        })
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    nics.sort();
    nics.into_iter().next()
}

async fn prepare_ssh(boot: &GuestBootV3, woken: bool) -> Result<(), String> {
    let ssh_dir = format!("/home/{GUEST_USERNAME}/.ssh");
    run(
        "install",
        &[
            "-d",
            "-m",
            "0700",
            "-o",
            GUEST_USERNAME,
            "-g",
            GUEST_USERNAME,
            &ssh_dir,
        ],
    )
    .await?;
    let keys_path = format!("{ssh_dir}/authorized_keys");
    write(
        &keys_path,
        &format!("{}\n", boot.ssh.authorized_keys.join("\n")),
    )?;
    run(
        "chown",
        &[&format!("{GUEST_USERNAME}:{GUEST_USERNAME}"), &keys_path],
    )
    .await?;
    run("chmod", &["0600", &keys_path]).await?;
    if woken {
        // Every run gets its own host key; this one is the image's.
        let _ = std::fs::remove_file(HOST_KEY);
        let _ = std::fs::remove_file(format!("{HOST_KEY}.pub"));
    }
    if !Path::new(HOST_KEY).exists() {
        run(
            "ssh-keygen",
            &["-q", "-t", "ed25519", "-N", "", "-f", HOST_KEY],
        )
        .await?;
    }
    Ok(())
}

/// The base's `ssh.service` starts only behind the gate marker, so a plain
/// start could be skipped and still exit 0: check the config, set the
/// marker, start, and require the unit to be active.
async fn start_sshd(woken: bool) -> Result<(), String> {
    std::fs::create_dir_all("/run/sshd").map_err(|error| format!("/run/sshd: {error}"))?;
    run("/usr/sbin/sshd", &["-t"]).await?;
    write("/run/intar/ssh-ready", "")?;
    // A woken guest's sshd runs with the image's host key.
    let verb = if woken { "restart" } else { "start" };
    tokio::time::timeout(SSH_START_TIMEOUT, run("systemctl", &[verb, "ssh.service"]))
        .await
        .map_err(|_| "ssh.service did not start in time".to_owned())??;
    run("systemctl", &["is-active", "--quiet", "ssh.service"]).await
}

async fn recording_disk() -> Result<(), String> {
    let uid = id(&["-u", GUEST_USERNAME]).await?;
    let gid = id(&["-g", GUEST_USERNAME]).await?;
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
    let (reuid, regid) = (format!("--reuid={uid}"), format!("--regid={gid}"));
    run(
        "setpriv",
        &[&reuid, &regid, "--clear-groups", "/bin/sh", "-c", &canary],
    )
    .await
}

async fn id(args: &[&str]) -> Result<String, String> {
    let output = Command::new("id")
        .args(args)
        .output()
        .await
        .map_err(|error| format!("id: {error}"))?;
    if !output.status.success() {
        return Err(format!("id {}: {}", args.join(" "), output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn run(program: &str, args: &[&str]) -> Result<(), String> {
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
