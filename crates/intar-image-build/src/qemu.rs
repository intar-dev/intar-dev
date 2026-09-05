use std::path::{Path, PathBuf};

use crate::config::QemuBuildConfig;

pub const BUILD_BOOT_CMDLINE: &str = "root=/dev/vda rw console=ttyS0";
pub const PUBLISHED_BOOT_CMDLINE: &str =
    "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false";

#[derive(Debug, Clone)]
pub struct DirectBootQemuInput<'a> {
    pub config: &'a QemuBuildConfig,
    pub root_disk_path: &'a Path,
    pub seed_disk_path: &'a Path,
    pub kernel_path: &'a Path,
    pub initrd_path: &'a Path,
    pub serial_log_path: &'a Path,
    pub qmp_socket_path: &'a Path,
    pub ssh_host_port: u16,
    pub memory_mib: u32,
    pub cpu_count: u32,
    /// Trusted kernel command line for this direct boot. Callers must source
    /// this from builder configuration, never from an untrusted bundle.
    pub boot_cmdline: &'a str,
}

#[derive(Debug, Clone)]
pub struct DirectBootQemuCommand {
    pub binary: PathBuf,
    pub args: Vec<String>,
}

#[must_use]
pub fn render_direct_boot_qemu_command(input: &DirectBootQemuInput<'_>) -> DirectBootQemuCommand {
    let accelerator = input.config.accelerator.trim();
    let args = vec![
        "-display".to_string(),
        "none".to_string(),
        "-nodefaults".to_string(),
        "-no-reboot".to_string(),
        "-machine".to_string(),
        format!("q35,accel={accelerator}"),
        "-cpu".to_string(),
        "host".to_string(),
        "-smp".to_string(),
        input.cpu_count.to_string(),
        "-m".to_string(),
        input.memory_mib.to_string(),
        "-kernel".to_string(),
        input.kernel_path.display().to_string(),
        "-initrd".to_string(),
        input.initrd_path.display().to_string(),
        "-append".to_string(),
        input.boot_cmdline.to_string(),
        "-drive".to_string(),
        format!(
            "if=virtio,format=raw,discard=unmap,detect-zeroes=unmap,file={}",
            input.root_disk_path.display()
        ),
        "-drive".to_string(),
        format!(
            "if=virtio,format=raw,readonly=on,file={}",
            input.seed_disk_path.display()
        ),
        "-netdev".to_string(),
        format!(
            "user,id=net0,hostfwd=tcp:127.0.0.1:{}-:22",
            input.ssh_host_port
        ),
        "-device".to_string(),
        "virtio-net-pci,netdev=net0".to_string(),
        "-serial".to_string(),
        format!("file:{}", input.serial_log_path.display()),
        "-qmp".to_string(),
        format!(
            "unix:{},server=on,wait=off",
            input.qmp_socket_path.display()
        ),
    ];

    DirectBootQemuCommand {
        binary: input.config.qemu_binary.clone(),
        args,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::Path;

    use super::{
        BUILD_BOOT_CMDLINE, DirectBootQemuInput, PUBLISHED_BOOT_CMDLINE,
        render_direct_boot_qemu_command,
    };
    use crate::config::QemuBuildConfig;

    #[test]
    fn renders_direct_kernel_boot_qemu_args() {
        const TRUSTED_BOOT_CMDLINE: &str = "root=/dev/vda rw console=ttyS0 intar.build=1";
        let config = QemuBuildConfig {
            accelerator: "kvm".to_string(),
            ..QemuBuildConfig::default()
        };
        let command = render_direct_boot_qemu_command(&DirectBootQemuInput {
            config: &config,
            root_disk_path: Path::new("/work/root.raw"),
            seed_disk_path: Path::new("/work/intarbuild.img"),
            kernel_path: Path::new("/cache/vmlinuz"),
            initrd_path: Path::new("/cache/initrd.img"),
            serial_log_path: Path::new("/work/serial.log"),
            qmp_socket_path: Path::new("/work/qmp.sock"),
            ssh_host_port: 22_222,
            memory_mib: 2048,
            cpu_count: 2,
            boot_cmdline: TRUSTED_BOOT_CMDLINE,
        });

        assert_eq!(command.binary, Path::new("qemu-system-x86_64"));
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-display", "none"])
        );
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-machine", "q35,accel=kvm"])
        );
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-kernel", "/cache/vmlinuz"])
        );
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-initrd", "/cache/initrd.img"])
        );
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-append", TRUSTED_BOOT_CMDLINE])
        );
        assert!(command.args.iter().any(|arg| {
            arg == "if=virtio,format=raw,discard=unmap,detect-zeroes=unmap,file=/work/root.raw"
        }));
        assert!(
            command
                .args
                .iter()
                .any(|arg| arg == "if=virtio,format=raw,readonly=on,file=/work/intarbuild.img")
        );
        assert!(
            command
                .args
                .iter()
                .any(|arg| arg == "user,id=net0,hostfwd=tcp:127.0.0.1:22222-:22")
        );
        assert!(
            command
                .args
                .iter()
                .any(|arg| arg == "unix:/work/qmp.sock,server=on,wait=off")
        );
    }

    #[test]
    fn defaults_to_kvm_and_keeps_published_cmdline_quiet() {
        let config = QemuBuildConfig::default();
        let command = render_direct_boot_qemu_command(&DirectBootQemuInput {
            config: &config,
            root_disk_path: Path::new("/work/root.raw"),
            seed_disk_path: Path::new("/work/intarbuild.img"),
            kernel_path: Path::new("/cache/vmlinuz"),
            initrd_path: Path::new("/cache/initrd.img"),
            serial_log_path: Path::new("/work/serial.log"),
            qmp_socket_path: Path::new("/work/qmp.sock"),
            ssh_host_port: 22_222,
            memory_mib: 2048,
            cpu_count: 2,
            boot_cmdline: BUILD_BOOT_CMDLINE,
        });

        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-machine", "q35,accel=kvm"])
        );
        assert!(command.args.windows(2).any(|pair| pair == ["-cpu", "host"]));
        assert!(PUBLISHED_BOOT_CMDLINE.contains("quiet loglevel=4"));
        assert!(!BUILD_BOOT_CMDLINE.contains("quiet"));
    }
}
