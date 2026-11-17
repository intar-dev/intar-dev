//! The VM config of an Intar machine.

use crate::{
    ConsoleConfig, CpusConfig, DiskConfig, DiskImageType, MemoryConfig, NetConfig, PayloadConfig,
    SerialConfig, VmConfig, VsockConfig,
};

/// The id suffix of the read-only run disk.
pub const RUNTIME_DISK_ID_SUFFIX: &str = "runtime";

/// One machine VM, with every path as the VMM sees it.
pub struct MachineVmInput<'a> {
    pub name: &'a str,
    pub cpu_millis: u32,
    pub memory_mib: u32,
    pub kernel: &'a str,
    pub initramfs: Option<&'a str>,
    pub cmdline: &'a str,
    pub root_disk: &'a str,
    pub runtime_disk: &'a str,
    pub recording_disk: &'a str,
    pub serial_log: &'a str,
    pub console_log: &'a str,
    pub tap: &'a str,
    pub mac: &'a str,
    pub vsock_socket: &'a str,
    pub vsock_cid: u32,
}

/// A cold boot: root, run and recording disk, one NIC, Kino's vsock, serial
/// and console to files.
#[must_use]
pub fn machine_vm_config(input: &MachineVmInput<'_>) -> VmConfig {
    let disk = |path: &str, readonly: bool, suffix: &str| DiskConfig {
        path: path.to_owned(),
        readonly,
        id: Some(format!("{}-{suffix}", input.name)),
        image_type: Some(DiskImageType::Raw),
    };
    let vcpus = input.cpu_millis.div_ceil(1_000);
    VmConfig {
        cpus: (input.cpu_millis > 1_000).then_some(CpusConfig {
            boot_vcpus: vcpus,
            max_vcpus: vcpus,
        }),
        memory: Some(MemoryConfig {
            size: i64::from(input.memory_mib) * 1024 * 1024,
        }),
        payload: PayloadConfig {
            kernel: Some(input.kernel.to_owned()),
            initramfs: input.initramfs.map(str::to_owned),
            cmdline: Some(input.cmdline.to_owned()),
            ..PayloadConfig::default()
        },
        serial: Some(SerialConfig {
            file: Some(input.serial_log.to_owned()),
            mode: "File".to_owned(),
            iommu: false,
            socket: None,
        }),
        console: Some(ConsoleConfig {
            file: Some(input.console_log.to_owned()),
            mode: "File".to_owned(),
            iommu: false,
            socket: None,
        }),
        disks: Some(vec![
            disk(input.root_disk, false, "root"),
            disk(input.runtime_disk, true, RUNTIME_DISK_ID_SUFFIX),
            disk(input.recording_disk, false, "recordings"),
        ]),
        net: Some(vec![NetConfig {
            tap: input.tap.to_owned(),
            mac: Some(input.mac.to_owned()),
            ip: None,
            mask: None,
        }]),
        vsock: Some(VsockConfig {
            cid: u64::from(input.vsock_cid),
            socket: input.vsock_socket.to_owned(),
            iommu: false,
            pci_segment: None,
            id: Some(format!("{}-kino-vsock", input.name)),
        }),
        landlock_enable: Some(true),
        landlock_rules: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> MachineVmInput<'static> {
        MachineVmInput {
            name: "vm",
            cpu_millis: 2_000,
            memory_mib: 1024,
            kernel: "/boot/kernel",
            initramfs: Some("/boot/initrd"),
            cmdline: "console=ttyS0",
            root_disk: "/disks/root.raw",
            runtime_disk: "/disks/runtime.vfat",
            recording_disk: "/disks/recordings.vfat",
            serial_log: "/logs/serial.log",
            console_log: "/logs/console.log",
            tap: "tap0",
            mac: "02:00:00:00:00:01",
            vsock_socket: "/run/kino.vsock",
            vsock_cid: 10_000,
        }
    }

    #[test]
    fn a_cold_boot_serializes_as_it_always_has() {
        let value = serde_json::to_value(machine_vm_config(&input())).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "cpus": {"boot_vcpus": 2, "max_vcpus": 2},
                "memory": {"size": 1_073_741_824_i64},
                "payload": {"kernel": "/boot/kernel", "cmdline": "console=ttyS0", "initramfs": "/boot/initrd"},
                "disks": [
                    {"path": "/disks/root.raw", "readonly": false, "id": "vm-root", "image_type": "Raw"},
                    {"path": "/disks/runtime.vfat", "readonly": true, "id": "vm-runtime", "image_type": "Raw"},
                    {"path": "/disks/recordings.vfat", "readonly": false, "id": "vm-recordings", "image_type": "Raw"}
                ],
                "net": [{"tap": "tap0", "mac": "02:00:00:00:00:01"}],
                "serial": {"file": "/logs/serial.log", "mode": "File", "iommu": false},
                "console": {"file": "/logs/console.log", "mode": "File", "iommu": false},
                "vsock": {"cid": 10_000, "socket": "/run/kino.vsock", "iommu": false, "id": "vm-kino-vsock"},
                "landlock_enable": true
            })
        );
    }
}
