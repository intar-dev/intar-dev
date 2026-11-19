use std::path::Path;

use crate::config::{BuildArch, QemuBuildConfig};

// The amd64 lines as they have always been; the tests hold the functions
// below to them.
#[cfg(test)]
pub const BUILD_BOOT_CMDLINE: &str = "root=/dev/vda rw console=ttyS0";
#[cfg(test)]
pub const PUBLISHED_BOOT_CMDLINE: &str =
    "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false";

/// The kernel command line the build VM of `arch` boots with.
#[must_use]
pub fn build_boot_cmdline(arch: BuildArch) -> String {
    format!("root=/dev/vda rw console={}", arch.console())
}

/// The kernel command line an image of `arch` is published with; the amd64
/// one is [`PUBLISHED_BOOT_CMDLINE`].
#[must_use]
pub fn published_boot_cmdline(arch: BuildArch) -> String {
    format!(
        "root=/dev/vda rw console={} quiet loglevel=4 systemd.show_status=false",
        arch.console()
    )
}

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
    pub args: Vec<String>,
}

#[must_use]
pub fn render_direct_boot_qemu_command(input: &DirectBootQemuInput<'_>) -> DirectBootQemuCommand {
    let accelerator = input.config.accelerator.trim();
    // A PC for amd64, QEMU's own board for arm64. Under emulation there is no
    // host processor to pass through; `max` is every feature QEMU emulates,
    // with the cheap form of pointer authentication, whose default form
    // makes emulation several times slower.
    let machine = match input.config.arch() {
        BuildArch::Amd64 => "q35",
        BuildArch::Arm64 => "virt",
    };
    let cpu = match (accelerator, input.config.arch()) {
        ("tcg", BuildArch::Arm64) => "max,pauth-impdef=on",
        ("tcg", BuildArch::Amd64) => "max",
        _ => "host",
    };
    let args = vec![
        "-display".to_string(),
        "none".to_string(),
        "-nodefaults".to_string(),
        "-no-reboot".to_string(),
        "-machine".to_string(),
        format!("{machine},accel={accelerator}"),
        "-cpu".to_string(),
        cpu.to_string(),
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

    DirectBootQemuCommand { args }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::Path;

    use super::{
        BUILD_BOOT_CMDLINE, DirectBootQemuInput, PUBLISHED_BOOT_CMDLINE, build_boot_cmdline,
        published_boot_cmdline, render_direct_boot_qemu_command,
    };
    use crate::config::{BuildArch, QemuBuildConfig};

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

    #[test]
    fn an_arm64_build_vm_is_qemus_own_board_emulated() {
        // What an x86 builder derives for arm64: the other QEMU, no KVM, more time.
        let host = QemuBuildConfig {
            qemu_binary: "/usr/bin/qemu-system-x86_64".into(),
            ..QemuBuildConfig::default()
        };
        let config = host.for_arch(BuildArch::Arm64);
        assert_eq!(config.target_arch, "arm64");
        assert_eq!(
            config.qemu_binary,
            Path::new("/usr/bin/qemu-system-aarch64")
        );
        assert!(config.debian_image().ends_with("09ef4a5232"));
        assert_eq!(
            host.for_arch(BuildArch::Amd64).debian_image(),
            host.debian_image()
        );
        if BuildArch::host() != Some(BuildArch::Arm64) {
            assert_eq!(config.accelerator, "tcg");
            assert!(config.provision_timeout_seconds > host.provision_timeout_seconds);
        }

        let emulated = QemuBuildConfig {
            accelerator: "tcg".to_owned(),
            ..config
        };
        let cmdline = build_boot_cmdline(BuildArch::Arm64);
        let command = render_direct_boot_qemu_command(&DirectBootQemuInput {
            config: &emulated,
            root_disk_path: Path::new("/work/root.raw"),
            seed_disk_path: Path::new("/work/intarbuild.img"),
            kernel_path: Path::new("/cache/vmlinuz"),
            initrd_path: Path::new("/cache/initrd.img"),
            serial_log_path: Path::new("/work/serial.log"),
            qmp_socket_path: Path::new("/work/qmp.sock"),
            ssh_host_port: 22_222,
            memory_mib: 2048,
            cpu_count: 2,
            boot_cmdline: &cmdline,
        });
        let has =
            |flag: &str, value: &str| command.args.windows(2).any(|pair| pair == [flag, value]);
        assert!(has("-machine", "virt,accel=tcg"), "{:?}", command.args);
        assert!(has("-cpu", "max,pauth-impdef=on"));
        assert!(has("-append", "root=/dev/vda rw console=ttyAMA0"));
        assert_eq!(
            published_boot_cmdline(BuildArch::Arm64),
            "root=/dev/vda rw console=ttyAMA0 quiet loglevel=4 systemd.show_status=false"
        );
        assert_eq!(
            published_boot_cmdline(BuildArch::Amd64),
            PUBLISHED_BOOT_CMDLINE
        );
        assert_eq!(build_boot_cmdline(BuildArch::Amd64), BUILD_BOOT_CMDLINE);
    }
}
