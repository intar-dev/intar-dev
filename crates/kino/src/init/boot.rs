//! Applying `boot.json` (§4.2 in #309): network, SSH, the recording disk and
//! the lab release.

use super::{Phase, Report};
use intar_contracts::guest::{GUEST_USERNAME, GuestBootV3, RUN_CLI_PORT};
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::watch;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_START_TIMEOUT: Duration = Duration::from_secs(30);
/// The disk order is fixed: root, run disk, recording disk.
const ROOT_DEVICE: &str = "/dev/vda";
const RECORDING_DEVICE: &str = "/dev/vdc";
const RECORDING_DIR: &str = "/var/lib/kino-recordings";
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
    SYSTEMCTL,
    IP,
    HOSTNAME,
    INSTALL,
    CHOWN,
    CHMOD,
    ID,
    SSH_KEYGEN,
    SSHD,
    RESIZE2FS,
    MOUNT,
    SETPRIV,
    super::park::UMOUNT,
    super::park::BLOCKDEV,
    super::park::PERL,
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
    report: &watch::Sender<Report>,
) -> Result<(), String> {
    let ssh = boot.ssh.enabled;
    let (network, prepared, recording) = tokio::join!(
        network(boot),
        async { if ssh { prepare_ssh(boot).await } else { Ok(()) } },
        async { if ssh { recording_disk().await } else { Ok(()) } },
    );
    network?;
    prepared?;
    recording?;
    mark(report, Phase::Booting, "network_ssh_prepared");
    if boot.root_resize {
        run(RESIZE2FS, &[ROOT_DEVICE]).await?;
    }
    let broker = match super::wire::Host::of(boot)? {
        super::wire::Host::Vsock => format!("vsock://2:{RUN_CLI_PORT}\n"),
        super::wire::Host::Tcp { run_cli, .. } => format!("tcp://{run_cli}\n"),
    };
    write(RUN_CLI_BROKER, &broker)?;
    if ssh {
        start_sshd().await?;
        let key = std::fs::read_to_string(format!("{HOST_KEY}.pub"))
            .map_err(|error| format!("host key: {error}"))?;
        report.send_modify(|report| report.ssh_host_keys_openssh = vec![key.trim().to_owned()]);
    }
    mark(report, Phase::SshReady, "ssh_ready");
    Ok(())
}

/// Start the deferred units, at once: the terminal opens only when the lab
/// is ready, so nothing is gained by holding the lab back for it.
pub(crate) async fn release_lab(report: &watch::Sender<Report>) {
    mark(report, Phase::Preparing, "preparing");
    // Not waiting for the units: the ready scripts say when the lab is up.
    if let Err(error) = run(SYSTEMCTL, &["start", "--no-block", "intar-lab.target"]).await {
        eprintln!("kino init: lab release: {error}");
    }
    mark(report, Phase::Preparing, "lab_released");
}

async fn network(boot: &GuestBootV3) -> Result<(), String> {
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
pub(super) fn interface() -> Option<String> {
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

async fn prepare_ssh(boot: &GuestBootV3) -> Result<(), String> {
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
async fn start_sshd() -> Result<(), String> {
    std::fs::create_dir_all("/run/sshd").map_err(|error| format!("/run/sshd: {error}"))?;
    run(SSHD, &["-t"]).await?;
    write("/run/intar/ssh-ready", "")?;
    tokio::time::timeout(SSH_START_TIMEOUT, run(SYSTEMCTL, &["start", "ssh.service"]))
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

pub(super) async fn run(program: &str, args: &[&str]) -> Result<(), String> {
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
