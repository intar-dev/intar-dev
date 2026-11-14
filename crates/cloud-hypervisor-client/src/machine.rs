//! The VM config of an Intar machine, shared by the agent and the image
//! builder: a wake image is woken with the device set it was suspended with,
//! so both sides build it here.

use std::num::TryFromIntError;

use crate::{
    BalloonConfig, ConsoleConfig, CpuProfile, CpusConfig, DiskConfig, DiskImageType, MemoryConfig,
    MemoryZoneConfig, NetConfig, PayloadConfig, SerialConfig, VmConfig, VsockConfig,
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
            profile: None,
            max_phys_bits: None,
        }),
        memory: Some(MemoryConfig {
            size: i64::from(input.memory_mib) * 1024 * 1024,
            zones: None,
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
            offload_tso: None,
            offload_ufo: None,
            offload_csum: None,
        }]),
        vsock: Some(VsockConfig {
            cid: u64::from(input.vsock_cid),
            socket: input.vsock_socket.to_owned(),
            iommu: false,
            pci_segment: None,
            id: Some(format!("{}-kino-vsock", input.name)),
        }),
        balloon: None,
        landlock_enable: Some(true),
    }
}

/// The one shape a wake image is suspended in and woken with.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WakeShape {
    pub memory_bytes: u64,
    pub boot_vcpus: u32,
    pub max_vcpus: u32,
    pub balloon: bool,
    pub max_phys_bits: u8,
}

/// `cold` in a wake shape: the vCPUs, address width and CPU profile, the
/// RAM as the one memory zone (`shared` at the build, so the file is the
/// guest's memory; private at a wake), the NIC offloads, and on a balloon
/// shape a balloon taking what the VM was not given (`memory_mib`).
///
/// # Errors
/// Returns an error when the shape's memory does not fit the VMM's sizes.
pub fn wake_vm_config(
    mut cold: VmConfig,
    shape: &WakeShape,
    cpu_profile: &str,
    ram: &str,
    shared: bool,
    memory_mib: u32,
) -> Result<VmConfig, TryFromIntError> {
    let memory_bytes = i64::try_from(shape.memory_bytes)?;
    cold.cpus = Some(CpusConfig {
        boot_vcpus: shape.boot_vcpus,
        max_vcpus: shape.max_vcpus,
        profile: Some(CpuProfile::File(cpu_profile.to_owned())),
        max_phys_bits: Some(shape.max_phys_bits),
    });
    cold.memory = Some(MemoryConfig {
        size: 0,
        zones: Some(vec![MemoryZoneConfig {
            id: "mem0".to_owned(),
            size: memory_bytes,
            file: Some(ram.to_owned()),
            shared,
        }]),
    });
    for net in cold.net.iter_mut().flatten() {
        net.offload_tso = Some(true);
        net.offload_ufo = Some(true);
        net.offload_csum = Some(true);
    }
    if shape.balloon {
        cold.balloon = Some(BalloonConfig {
            size: memory_bytes - i64::from(memory_mib) * 1024 * 1024,
        });
    }
    Ok(cold)
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

    #[test]
    fn the_build_and_the_wake_differ_only_in_sharing_and_the_balloon() {
        let shape = WakeShape {
            memory_bytes: 4 << 30,
            boot_vcpus: 2,
            max_vcpus: 4,
            balloon: true,
            max_phys_bits: 36,
        };
        let build = wake_vm_config(
            machine_vm_config(&input()),
            &shape,
            "/p",
            "/ram",
            true,
            4096,
        )
        .expect("build");
        let wake = wake_vm_config(
            machine_vm_config(&input()),
            &shape,
            "/p",
            "/ram",
            false,
            1024,
        )
        .expect("wake");
        let (mut build, mut wake) = (
            serde_json::to_value(build).expect("serialize"),
            serde_json::to_value(wake).expect("serialize"),
        );
        assert_eq!(
            build["cpus"],
            serde_json::json!({"boot_vcpus": 2, "max_vcpus": 4, "profile": {"File": "/p"}, "max_phys_bits": 36})
        );
        assert_eq!(build["memory"]["zones"][0]["shared"], true);
        assert_eq!(build["balloon"], serde_json::json!({"size": 0}));
        assert_eq!(
            wake["balloon"],
            serde_json::json!({"size": 3_221_225_472_i64})
        );
        assert_eq!(
            build["net"][0],
            serde_json::json!({"tap": "tap0", "mac": "02:00:00:00:00:01", "offload_tso": true, "offload_ufo": true, "offload_csum": true})
        );
        for value in [&mut build, &mut wake] {
            value["memory"]["zones"][0]["shared"] = false.into();
            value["balloon"] = serde_json::Value::Null;
        }
        assert_eq!(build, wake);
    }
}
