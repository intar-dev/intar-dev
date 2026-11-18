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

/// A running machine. Dropping it kills QEMU. An app that is killed outright
/// cannot do that; [`stop_leftover`] finds what it left by the pid file kept
/// beside the control socket.
pub struct Vm {
    process: Option<Child>,
    qmp_socket: PathBuf,
}

impl Vm {
    /// Starts `qemu` for `machine`, with its own output in `log`. QEMU that
    /// stops within the first second, such as on missing acceleration, is an
    /// error carrying what it printed; nothing is retried another way.
    pub fn start(qemu: &Path, machine: &Machine, log: &Path) -> Result<Self, Error> {
        // A QEMU of this run that outlived its app holds the run's disk.
        stop_leftover(&machine.qmp_socket)?;
        let out = File::create(log)?;
        let mut process = Command::new(qemu)
            .args(qemu_args(machine))
            .stdin(Stdio::null())
            .stdout(out.try_clone()?)
            .stderr(out)
            .spawn()
            .map_err(|error| Error::Qemu(format!("could not start {}: {error}", qemu.display())))?;
        let pid_file = pid_file(&machine.qmp_socket);
        std::fs::write(&pid_file, process.id().to_string())?;
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            if let Some(status) = process.try_wait()? {
                let _ = std::fs::remove_file(&pid_file);
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
        let _ = std::fs::remove_file(pid_file(&self.qmp_socket));
        let _ = std::fs::remove_file(&self.qmp_socket);
    }
}

fn pid_file(qmp_socket: &Path) -> PathBuf {
    qmp_socket.with_extension("pid")
}

/// Stops the QEMU an earlier, killed app left running for the run whose
/// control socket is `qmp_socket`. True when there was one.
///
/// Only a process whose command line names this very socket is touched: a
/// pid file can outlive its process, and the number can belong to something
/// else by now.
#[cfg(unix)]
pub fn stop_leftover(qmp_socket: &Path) -> Result<bool, Error> {
    let pid_file = pid_file(qmp_socket);
    let Ok(recorded) = std::fs::read_to_string(&pid_file) else {
        return Ok(false);
    };
    let pid = recorded.trim().to_owned();
    let marker = format!("unix:{}", qmp_socket.to_string_lossy().replace(',', ",,"));
    let ours = || {
        pid.bytes().all(|byte| byte.is_ascii_digit())
            && !pid.is_empty()
            && Command::new("ps")
                .args(["-o", "command=", "-p", &pid])
                .output()
                .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(&marker))
    };
    let found = ours();
    if found {
        // Ask first; a QEMU that did not take the request gets no grace.
        let grace = if qmp_quit(qmp_socket).is_ok() { 3 } else { 0 };
        let deadline = Instant::now() + Duration::from_secs(grace);
        while ours() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if ours() {
            let _ = Command::new("kill").args(["-KILL", &pid]).status();
            let deadline = Instant::now() + Duration::from_secs(2);
            while ours() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        if ours() {
            return Err(Error::Qemu(format!(
                "a machine of an earlier run is still running (process {pid}) and could not be stopped"
            )));
        }
        let _ = std::fs::remove_file(qmp_socket);
    }
    let _ = std::fs::remove_file(&pid_file);
    Ok(found)
}

// ponytail: Windows keeps no pid file check yet; a leftover there is found by
// QEMU failing to open the run's disk. Job objects in #405.
#[cfg(not(unix))]
pub fn stop_leftover(_qmp_socket: &Path) -> Result<bool, Error> {
    Ok(false)
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

    /// A script that keeps running with its arguments on its command line,
    /// as QEMU does, and ignores them.
    #[cfg(unix)]
    fn fake_qemu(dir: &Path) -> PathBuf {
        let script = dir.join("qemu");
        std::fs::write(&script, "#!/bin/sh\nwhile :; do sleep 1; done\n").expect("script");
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .expect("mode");
        script
    }

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
        let script = fake_qemu(dir.path());
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

    #[cfg(unix)]
    #[test]
    fn a_qemu_left_by_a_killed_app_is_stopped_and_nothing_else_is() {
        let dir = tempfile::tempdir().expect("dir");
        let log = dir.path().join("qemu.log");
        let mut machine = machine();
        machine.qmp_socket = dir.path().join("qmp.sock");
        let pid_file = pid_file(&machine.qmp_socket);
        let running = |pid: u32| {
            Command::new("ps")
                .args(["-o", "command=", "-p", &pid.to_string()])
                .output()
                .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains("qmp.sock"))
        };

        // Nothing was left: nothing to do.
        assert!(!stop_leftover(&machine.qmp_socket).expect("none"));

        // The app dies without dropping its Vm: QEMU and the pid file stay.
        let vm = Vm::start(&fake_qemu(dir.path()), &machine, &log).expect("start");
        let pid = vm.process.as_ref().expect("process").id();
        std::mem::forget(vm);
        assert!(pid_file.exists() && running(pid));
        assert!(stop_leftover(&machine.qmp_socket).expect("stopped"));
        assert!(!running(pid) && !pid_file.exists());

        // The next start of the same run stops a leftover by itself.
        let vm = Vm::start(&fake_qemu(dir.path()), &machine, &log).expect("start");
        let first = vm.process.as_ref().expect("process").id();
        std::mem::forget(vm);
        let again = Vm::start(&fake_qemu(dir.path()), &machine, &log).expect("start again");
        assert!(!running(first));
        drop(again);
        assert!(!pid_file.exists());

        // A pid file that names some other live process: that process is left alone.
        std::fs::write(&pid_file, std::process::id().to_string()).expect("write");
        assert!(!stop_leftover(&machine.qmp_socket).expect("not ours"));
        assert!(!pid_file.exists());
        std::fs::write(&pid_file, "1; rm -rf /").expect("write");
        assert!(!stop_leftover(&machine.qmp_socket).expect("garbage"));
    }
}
