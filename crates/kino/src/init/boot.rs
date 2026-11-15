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

/// Every program PID 1 runs, by absolute path where usr-merged Debian
/// installs it: PATH puts /usr/local first, so a bare name could run a
/// binary the scenario's own content put there.
pub(crate) const SYSTEMCTL: &str = "/usr/bin/systemctl";
pub(crate) const IP: &str = "/usr/bin/ip";
pub(crate) const HOSTNAME: &str = "/usr/bin/hostname";
pub(crate) const INSTALL: &str = "/usr/bin/install";
pub(crate) const CHOWN: &str = "/usr/bin/chown";
pub(crate) const CHMOD: &str = "/usr/bin/chmod";
pub(crate) const ID: &str = "/usr/bin/id";
pub(crate) const SSH_KEYGEN: &str = "/usr/bin/ssh-keygen";
pub(crate) const SSHD: &str = "/usr/sbin/sshd";
pub(crate) const RESIZE2FS: &str = "/usr/sbin/resize2fs";
pub(crate) const MOUNT: &str = "/usr/bin/mount";
pub(crate) const SETPRIV: &str = "/usr/bin/setpriv";
#[cfg(test)]
pub(crate) const PROGRAMS: &[&str] = &[
    SYSTEMCTL, IP, HOSTNAME, INSTALL, CHOWN, CHMOD, ID, SSH_KEYGEN, SSHD, RESIZE2FS, MOUNT, SETPRIV,
];

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
    // First and alone: nothing the run sets up may race the restarts.
    if woken {
        renew_machine_id(boot_sha256, report).await?;
    }
    let (network, prepared, recording) = tokio::join!(
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
    network?;
    prepared?;
    recording?;
    mark(report, Phase::Booting, "network_ssh_prepared");
    if boot.root_resize {
        run(RESIZE2FS, &[ROOT_DEVICE]).await?;
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

/// Start the deferred units, once `pid1` says PID 1 is past a woken guest's
/// re-exec: the lab release, and the ready scripts and tasks after it, are
/// what Kino asks of PID 1 after `SSH_READY`, and a call into a manager that
/// is re-executing fails. An error of `pid1` is the lab's failure.
///
/// ponytail: waits the 5 s fallback whenever units are deferred; the
/// recorder's `recording_started` over the control socket releases earlier
/// once the run CLI of guest contract 3 lands.
pub(crate) async fn release_lab(
    spec: &MachineSpecV1,
    report: &watch::Sender<Report>,
    pid1: impl Future<Output = Result<(), String>>,
) -> Result<(), String> {
    mark(report, Phase::Preparing, "preparing");
    let fallback = async {
        if !spec.defer.is_empty() {
            tokio::time::sleep(LAB_RELEASE_FALLBACK).await;
        }
    };
    let (pid1, ()) = tokio::join!(pid1, fallback);
    pid1?;
    // Not waiting for the units: the ready scripts say when the lab is up.
    if let Err(error) = run(SYSTEMCTL, &["start", "--no-block", "intar-lab.target"]).await {
        eprintln!("kino init: lab release: {error}");
    }
    mark(report, Phase::Preparing, "lab_released");
    Ok(())
}

/// How long a woken guest's PID 1 re-exec may take: about 2.6 s right after
/// a wake, and 0.9 s in a settled guest.
pub(crate) const REEXEC_BOUND: Duration = Duration::from_secs(30);

/// The re-exec that makes PID 1 read the run's machine id; until it is done
/// its `%m` and its `GetMachineId` are the image's. Run after `SSH_READY`, so
/// the learner does not wait for it.
pub(crate) async fn reexec_pid1(report: watch::Sender<Report>) -> Result<(), String> {
    let done = tokio::time::timeout(REEXEC_BOUND, run(SYSTEMCTL, &["daemon-reexec"]))
        .await
        .ok();
    reexec_outcome(done)?;
    let now = uptime_ms();
    report.send_modify(|report| {
        report
            .timings_ms
            .insert("machine_id_reexec_done".to_owned(), now);
    });
    Ok(())
}

/// The re-exec's result, or `None` when it ran past [`REEXEC_BOUND`].
pub(crate) fn reexec_outcome(done: Option<Result<(), String>>) -> Result<(), String> {
    match done {
        Some(Ok(())) => Ok(()),
        Some(Err(error)) => Err(format!("PID 1 did not take the run's machine id: {error}")),
        None => Err(format!(
            "PID 1 did not take the run's machine id: its re-exec ran past {} s",
            REEXEC_BOUND.as_secs()
        )),
    }
}

const MACHINE_ID: &str = "/etc/machine-id";
const DBUS_MACHINE_ID: &str = "/var/lib/dbus/machine-id";
/// The bind source systemd mounts read-only over [`MACHINE_ID`] when it
/// could not write that file at boot.
const RUN_MACHINE_ID: &str = "/run/machine-id";
/// The daemons that read the machine id once, at their start, and are safe
/// to restart; only the active ones restart. Left running with the image's
/// id: the system bus (a restart is unsupported and cuts every client), and
/// logind and networkd, which use it for nothing a run sees (networkd only
/// for a DHCPv6 DUID; this guest's address is static) and whose restart
/// risks sessions or the routes Kino sets.
const MACHINE_ID_READERS: &[&str] = &[
    // Stamps `_MACHINE_ID` on every entry and names its directory by it.
    "systemd-journald.service",
    // What `hostnamectl` shows; it holds no state and starts on demand.
    "systemd-hostnamed.service",
];

/// One step of [`machine_id_steps`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdStep {
    Write(&'static str),
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

/// What makes a woken guest take a new id before SSH: the files, the daemons
/// that read it at start, and the journals of earlier ids.
pub(crate) fn machine_id_steps(dbus_file: bool) -> Vec<IdStep> {
    let mut steps = vec![IdStep::Write(MACHINE_ID)];
    if dbus_file {
        steps.push(IdStep::Write(DBUS_MACHINE_ID));
    }
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
            IdStep::Write(path) => write_id(path, &id)?,
            IdStep::RestartIfActive(unit) => {
                let code = exit_code(SYSTEMCTL, &["is-active", "--quiet", unit]).await?;
                if is_active(unit, code)? {
                    run(SYSTEMCTL, &["restart", unit]).await?;
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

/// `systemctl is-active`: 0 active, 3 inactive, 4 no such unit. Any other
/// answer means the manager could not tell, and the renewal fails.
pub(crate) fn is_active(unit: &str, code: Option<i32>) -> Result<bool, String> {
    match code {
        Some(0) => Ok(true),
        Some(3 | 4) => Ok(false),
        other => Err(format!("systemctl is-active {unit}: {other:?}")),
    }
}

async fn exit_code(program: &str, args: &[&str]) -> Result<Option<i32>, String> {
    let status = Command::new(program)
        .args(args)
        .status()
        .await
        .map_err(|error| format!("{program}: {error}"))?;
    Ok(status.code())
}

/// Write the id into `path` in place, as systemd does: a file of the root, or
/// a mount over it. systemd's transient id is a read-only bind of
/// [`RUN_MACHINE_ID`]; then that file takes the id, and readers of `path`
/// see it while the file below stays empty.
fn write_id(path: &str, id: &str) -> Result<(), String> {
    match write_in_place(path, id) {
        Err(error) if error.raw_os_error() == Some(30) && path == MACHINE_ID => {
            write_in_place(RUN_MACHINE_ID, id).map_err(|error| format!("{RUN_MACHINE_ID}: {error}"))
        }
        written => written.map_err(|error| format!("{path}: {error}")),
    }
}

/// Truncate and write `path`, created 0444 if missing, and sync it.
pub(crate) fn write_in_place(path: &str, id: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .create(true)
        .mode(0o444)
        .open(path)?;
    file.write_all(format!("{id}\n").as_bytes())?;
    file.sync_all()
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
    run(HOSTNAME, &[hostname]).await?;
    let deadline = tokio::time::Instant::now() + NETWORK_TIMEOUT;
    loop {
        let attempt = async {
            let iface = interface().ok_or("no network interface")?;
            run(IP, &["link", "set", "dev", &iface, "up"]).await?;
            if woken {
                // The build's address is still on the interface.
                run(IP, &["addr", "flush", "dev", &iface, "scope", "global"]).await?;
            }
            run(IP, &["addr", "replace", &net.ip_cidr, "dev", &iface]).await?;
            run(
                IP,
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
        INSTALL,
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
        CHOWN,
        &[&format!("{GUEST_USERNAME}:{GUEST_USERNAME}"), &keys_path],
    )
    .await?;
    run(CHMOD, &["0600", &keys_path]).await?;
    if woken {
        // Every run gets its own host key; this one is the image's.
        let _ = std::fs::remove_file(HOST_KEY);
        let _ = std::fs::remove_file(format!("{HOST_KEY}.pub"));
    }
    if !Path::new(HOST_KEY).exists() {
        run(
            SSH_KEYGEN,
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
    run(SSHD, &["-t"]).await?;
    write("/run/intar/ssh-ready", "")?;
    // A woken guest's sshd runs with the image's host key.
    let verb = if woken { "restart" } else { "start" };
    tokio::time::timeout(SSH_START_TIMEOUT, run(SYSTEMCTL, &[verb, "ssh.service"]))
        .await
        .map_err(|_| "ssh.service did not start in time".to_owned())??;
    run(SYSTEMCTL, &["is-active", "--quiet", "ssh.service"]).await
}

async fn recording_disk() -> Result<(), String> {
    let uid = id(&["-u", GUEST_USERNAME]).await?;
    let gid = id(&["-g", GUEST_USERNAME]).await?;
    std::fs::create_dir_all(RECORDING_DIR).map_err(|error| format!("{RECORDING_DIR}: {error}"))?;
    let options =
        format!("rw,sync,dirsync,uid={uid},gid={gid},utf8=1,fmask=0117,dmask=0007,shortname=mixed");
    run(
        MOUNT,
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
        SETPRIV,
        &[&reuid, &regid, "--clear-groups", "/bin/sh", "-c", &canary],
    )
    .await
}

async fn id(args: &[&str]) -> Result<String, String> {
    let output = Command::new(ID)
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
