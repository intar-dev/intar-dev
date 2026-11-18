//! One machine as a QEMU process: its command line and its life.

use std::ffi::OsString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::{Accel, Arch, Error};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiskFormat {
    Raw,
    Qcow2,
}

/// A virtio block device. The guest sees the disks in their order here:
/// `/dev/vda`, `/dev/vdb`, …
#[derive(Clone, Debug)]
pub struct Disk {
    pub path: PathBuf,
    pub format: DiskFormat,
    pub read_only: bool,
}

/// Everything QEMU needs to run one machine of a lab.
#[derive(Clone, Debug)]
pub struct Machine {
    pub arch: Arch,
    pub accel: Accel,
    pub cpus: u32,
    pub memory_mib: u64,
    pub kernel: PathBuf,
    pub initrd: Option<PathBuf>,
    pub cmdline: String,
    /// The root disk first, then the run disk, then any others.
    pub disks: Vec<Disk>,
    /// The guest's address and the gateway QEMU plays; the run disk's
    /// `boot.json` has to name the same ones.
    pub network: UserNetwork,
    /// SSH to the guest is reachable on this port of 127.0.0.1 only.
    pub ssh_port: u16,
    /// The guest's AF_VSOCK id, for Kino's reports. Linux hosts only.
    pub vsock_cid: Option<u32>,
    /// The guest's serial console is written here.
    pub serial_log: PathBuf,
    /// QEMU's control socket.
    pub qmp_socket: PathBuf,
}

/// QEMU's user-mode network: no privileges, no host interface.
#[derive(Clone, Debug)]
pub struct UserNetwork {
    /// For example `10.77.52.0/28`.
    pub network: String,
    pub gateway: String,
    pub dns: String,
    pub guest: String,
    pub mac: String,
}

/// QEMU's arguments for `machine`.
pub fn qemu_args(machine: &Machine) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    let mut arg = |value: &str| args.push(value.into());
    let emulated = machine.accel == Accel::Tcg;

    arg("-M");
    arg(match machine.arch {
        Arch::X86_64 => "q35",
        Arch::Aarch64 => "virt,highmem=on",
    });
    arg("-accel");
    arg(machine.accel.qemu_name());
    arg("-cpu");
    arg(if emulated { "max" } else { "host" });
    arg("-smp");
    arg(&machine.cpus.to_string());
    arg("-m");
    arg(&machine.memory_mib.to_string());
    // No default devices, no window, and a guest reboot ends the process.
    for flag in ["-nodefaults", "-display", "none", "-no-reboot"] {
        arg(flag);
    }

    arg("-kernel");
    arg(&machine.kernel.to_string_lossy());
    if let Some(initrd) = &machine.initrd {
        arg("-initrd");
        arg(&initrd.to_string_lossy());
    }
    arg("-append");
    arg(&machine.cmdline);

    // Fixed PCI slots keep the guest's device names stable.
    let mut slot = 3;
    for (index, disk) in machine.disks.iter().enumerate() {
        let format = match disk.format {
            DiskFormat::Raw => "raw",
            DiskFormat::Qcow2 => "qcow2",
        };
        let read_only = if disk.read_only { ",readonly=on" } else { "" };
        arg("-drive");
        // A comma in a path would end the option: QEMU reads `,,` as one.
        let path = disk.path.to_string_lossy().replace(',', ",,");
        arg(&format!(
            "if=none,id=disk{index},file={path},format={format}{read_only}"
        ));
        arg("-device");
        arg(&format!("virtio-blk-pci,drive=disk{index},addr={slot:#x}"));
        slot += 1;
    }

    let net = &machine.network;
    arg("-netdev");
    arg(&format!(
        "user,id=net0,net={},host={},dns={},hostfwd=tcp:127.0.0.1:{}-{}:22",
        net.network, net.gateway, net.dns, machine.ssh_port, net.guest
    ));
    arg("-device");
    arg(&format!(
        "virtio-net-pci,netdev=net0,mac={},addr={slot:#x}",
        net.mac
    ));
    slot += 1;

    if let Some(cid) = machine.vsock_cid {
        arg("-device");
        arg(&format!("vhost-vsock-pci,guest-cid={cid},addr={slot:#x}"));
    }

    arg("-serial");
    arg(&format!(
        "file:{}",
        machine.serial_log.to_string_lossy().replace(',', ",,")
    ));
    arg("-qmp");
    arg(&format!(
        "unix:{},server=on,wait=off",
        machine.qmp_socket.to_string_lossy().replace(',', ",,")
    ));
    args
}

/// Creates `overlay`, a copy-on-write disk over the cached `base` image, so a
/// run never changes the image it started from.
pub fn create_overlay(qemu_img: &Path, base: &Path, overlay: &Path) -> Result<(), Error> {
    let output = Command::new(qemu_img)
        .args(["create", "-q", "-f", "qcow2", "-F", "raw", "-b"])
        .arg(base)
        .arg(overlay)
        .output()
        .map_err(|error| Error::Qemu(format!("could not run {}: {error}", qemu_img.display())))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(Error::Qemu(format!(
            "qemu-img could not create the run's disk: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

/// A running machine. Dropping it kills QEMU.
// ponytail: an app that is killed outright leaves QEMU running; find and stop
// such leftovers at the next start, by the run directory in their arguments.
pub struct Vm {
    process: Option<Child>,
    qmp_socket: PathBuf,
}

impl Vm {
    /// Starts `qemu` for `machine`, with its own output in `log`. QEMU that
    /// stops within the first second, such as on missing acceleration, is an
    /// error carrying what it printed; nothing is retried another way.
    pub fn start(qemu: &Path, machine: &Machine, log: &Path) -> Result<Self, Error> {
        let out = File::create(log)?;
        let mut process = Command::new(qemu)
            .args(qemu_args(machine))
            .stdin(Stdio::null())
            .stdout(out.try_clone()?)
            .stderr(out)
            .spawn()
            .map_err(|error| Error::Qemu(format!("could not start {}: {error}", qemu.display())))?;
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            if let Some(status) = process.try_wait()? {
                let printed = std::fs::read_to_string(log).unwrap_or_default();
                let reason = match printed.trim() {
                    "" => format!("QEMU stopped at once ({status})"),
                    printed => printed.to_owned(),
                };
                return Err(Error::Qemu(reason));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(Self {
            process: Some(process),
            qmp_socket: machine.qmp_socket.clone(),
        })
    }

    /// Whether QEMU is still running.
    pub fn is_running(&mut self) -> bool {
        self.process
            .as_mut()
            .is_some_and(|process| matches!(process.try_wait(), Ok(None)))
    }

    /// Asks QEMU to quit and waits up to `grace`; then kills it.
    pub fn stop(mut self, grace: Duration) {
        let _ = qmp_quit(&self.qmp_socket);
        let deadline = Instant::now() + grace;
        while self.is_running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        // Drop kills what is left and removes the socket.
    }
}

impl Drop for Vm {
    fn drop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
        let _ = std::fs::remove_file(&self.qmp_socket);
    }
}

/// `quit` over QMP: greeting, capabilities, command.
#[cfg(unix)]
fn qmp_quit(socket: &Path) -> std::io::Result<()> {
    use std::io::{BufRead as _, BufReader, Write as _};
    let stream = std::os::unix::net::UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;
    let mut line = String::new();
    reader.read_line(&mut line)?;
    for command in ["qmp_capabilities", "quit"] {
        writer.write_all(
            serde_json::json!({ "execute": command })
                .to_string()
                .as_bytes(),
        )?;
        writer.write_all(b"\n")?;
        line.clear();
        reader.read_line(&mut line)?;
    }
    Ok(())
}

// ponytail: no QMP on Windows yet, so a stop there is a kill; named pipes in #405.
#[cfg(not(unix))]
fn qmp_quit(_socket: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("QMP needs a Unix socket"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine() -> Machine {
        Machine {
            arch: Arch::X86_64,
            accel: Accel::Kvm,
            cpus: 1,
            memory_mib: 512,
            kernel: "/img/kernel".into(),
            initrd: Some("/img/initrd".into()),
            cmdline: "root=/dev/vda rw console=ttyS0".into(),
            disks: vec![
                Disk {
                    path: "/run/root.qcow2".into(),
                    format: DiskFormat::Qcow2,
                    read_only: false,
                },
                Disk {
                    path: "/run/a,b/run.raw".into(),
                    format: DiskFormat::Raw,
                    read_only: true,
                },
            ],
            network: UserNetwork {
                network: "10.77.52.0/28".into(),
                gateway: "10.77.52.1".into(),
                dns: "10.77.52.3".into(),
                guest: "10.77.52.2".into(),
                mac: "02:00:00:00:34:02".into(),
            },
            ssh_port: 2252,
            vsock_cid: Some(10052),
            serial_log: "/run/serial.log".into(),
            qmp_socket: "/run/qmp.sock".into(),
        }
    }

    fn joined(machine: &Machine) -> String {
        qemu_args(machine)
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn builds_the_command_line_the_boot_spike_measured() {
        assert_eq!(
            joined(&machine()),
            "-M q35 -accel kvm -cpu host -smp 1 -m 512 -nodefaults -display none -no-reboot \
             -kernel /img/kernel -initrd /img/initrd -append root=/dev/vda rw console=ttyS0 \
             -drive if=none,id=disk0,file=/run/root.qcow2,format=qcow2 -device virtio-blk-pci,drive=disk0,addr=0x3 \
             -drive if=none,id=disk1,file=/run/a,,b/run.raw,format=raw,readonly=on -device virtio-blk-pci,drive=disk1,addr=0x4 \
             -netdev user,id=net0,net=10.77.52.0/28,host=10.77.52.1,dns=10.77.52.3,hostfwd=tcp:127.0.0.1:2252-10.77.52.2:22 \
             -device virtio-net-pci,netdev=net0,mac=02:00:00:00:34:02,addr=0x5 \
             -device vhost-vsock-pci,guest-cid=10052,addr=0x6 \
             -serial file:/run/serial.log -qmp unix:/run/qmp.sock,server=on,wait=off"
        );
    }

    #[test]
    fn emulation_and_arm_change_only_what_they_must() {
        let mut machine = machine();
        machine.accel = Accel::Tcg;
        machine.arch = Arch::Aarch64;
        machine.initrd = None;
        machine.vsock_cid = None;
        let line = joined(&machine);
        assert!(
            line.starts_with("-M virt,highmem=on -accel tcg,thread=multi -cpu max "),
            "{line}"
        );
        assert!(
            !line.contains("-initrd") && !line.contains("vsock"),
            "{line}"
        );
    }

    #[test]
    fn a_qemu_that_stops_at_once_is_an_error_with_what_it_printed() {
        let dir = tempfile::tempdir().expect("dir");
        let log = dir.path().join("qemu.log");
        let mut machine = machine();
        machine.qmp_socket = dir.path().join("qmp.sock");
        // `false` stands in for a QEMU that refuses its arguments.
        let refused = Vm::start(Path::new("false"), &machine, &log);
        assert!(matches!(refused, Err(Error::Qemu(reason)) if reason.contains("stopped at once")));
        let missing = Vm::start(Path::new("/nonexistent/qemu"), &machine, &log);
        assert!(matches!(missing, Err(Error::Qemu(reason)) if reason.contains("could not start")));
    }

    #[cfg(unix)]
    #[test]
    fn dropping_a_vm_kills_its_process() {
        let dir = tempfile::tempdir().expect("dir");
        let log = dir.path().join("qemu.log");
        let mut machine = machine();
        machine.qmp_socket = dir.path().join("qmp.sock");
        // `sleep` ignores what it cannot parse as a number only on some systems,
        // so a script that sleeps stands in for a QEMU that keeps running.
        let script = dir.path().join("qemu");
        std::fs::write(&script, "#!/bin/sh\nexec sleep 60\n").expect("script");
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .expect("mode");
        let mut vm = Vm::start(&script, &machine, &log).expect("start");
        assert!(vm.is_running());
        let pid = vm.process.as_ref().expect("process").id();
        // No QMP socket exists, so the stop falls through to the kill.
        vm.stop(Duration::from_millis(100));
        let alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .expect("kill -0");
        assert!(!alive.success(), "the process outlived its Vm");
    }
}
