#![allow(clippy::missing_errors_doc)]

//! The single Intar kernel profile.
//!
//! There is one profile. There is no toggle, no variant, and no fallback to a
//! distribution kernel package. The image pipeline compiles this kernel inside
//! the normal OCI base-image build, so no step copies a kernel by hand.
//!
//! Four properties matter, and each one is checked here rather than assumed:
//!
//! 1. Pinned source. The Debian source version and every source hash are
//!    constants in this file. The build script downloads those files and
//!    verifies every hash before it unpacks them.
//! 2. Pinned toolchain. The kernel stage installs every package from one dated
//!    Debian snapshot, and the two binaries that reach the initramfs are pinned
//!    to an exact version on top of that. A floating compiler cannot be
//!    reproducible.
//! 3. Reproducible output. The build fixes the compile timestamp, user, and
//!    host, sets the timestamp of every initramfs entry, and writes a
//!    deterministic cpio archive. The same inputs give the same bytes.
//! 4. A verified feature set. KERNEL_REQUIRED_BUILTINS lists every symbol that
//!    the guest contract needs. The build reads the final .config and fails
//!    when one of those symbols is not built in.
//!
//! The initramfs is a standard busybox image: a pinned static busybox, a pinned
//! static e2fsck, and one shell script. It does not try to pivot_root. The
//! initramfs rootfs may not pivot_root, so the script moves its mounts into the
//! new root and hands over with busybox switch_root.

use crate::config::QemuBuildConfig;

/// Debian source package version. The source package name is linux.
pub const KERNEL_SOURCE_VERSION: &str = "6.12.96-1";

/// Upstream version that the Debian source package is based on.
pub const KERNEL_UPSTREAM_VERSION: &str = "6.12.96";

/// Value of CONFIG_LOCALVERSION. The compile unit keeps the upstream 6.12 ABI,
/// so the release string stays inside the shape guests expect from uname -r.
pub const KERNEL_LOCALVERSION: &str = "-intar-cutover";

/// Upstream directory that holds the source files.
pub const KERNEL_SOURCE_BASE_URL: &str = "https://deb.debian.org/debian/pool/main/l/linux";

/// Dated Debian snapshot that the kernel stage installs its toolchain from.
/// A floating compiler would break the reproducibility claim, so the stage
/// points apt at exactly this date instead of at the moving stable suite.
pub const KERNEL_APT_SNAPSHOT: &str = "20260912T000000Z";

/// Snapshot service root. `{root}/{snapshot}/` is an apt suite.
pub const KERNEL_APT_SNAPSHOT_URL: &str = "https://snapshot.debian.org/archive/debian";

/// Apt version of the static busybox that the initramfs runs.
///
/// This is the version in the snapshot suite index at KERNEL_APT_SNAPSHOT, read
/// from dists/trixie/main/binary-amd64/Packages. A newer build in the Debian
/// pool is not installable from that snapshot, so a pool version is not a valid
/// pin here.
pub const KERNEL_BUSYBOX_STATIC_VERSION: &str = "1:1.37.0-6+b8";

/// Apt version of the static e2fsck that the initramfs runs.
///
/// Same rule as the busybox pin: it is the snapshot suite version.
pub const KERNEL_E2FSCK_STATIC_VERSION: &str = "1.47.2-3+b11";

/// Build timestamp for the kernel compile. A fixed value makes the build
/// reproducible. It also stamps every initramfs entry.
pub const KERNEL_SOURCE_DATE_EPOCH: u64 = 1_700_000_000;

/// The compiler identity stamped into the kernel.
pub const KERNEL_BUILD_USER: &str = "intar";
pub const KERNEL_BUILD_HOST: &str = "intar-builder";

/// Kernel configuration fragment. The build merges this over
/// x86_64_defconfig and then resolves the result with olddefconfig.
pub const KERNEL_CONFIG_FRAGMENT: &str = include_str!("../kernel/intar-kernel.config");

/// The initramfs init. A POSIX shell script that the pinned busybox runs.
pub const KERNEL_INITRAMFS_INIT_SCRIPT: &str = include_str!("../kernel/intar-initramfs-init.sh");

/// Path of the kernel provenance record inside the built image.
pub const KERNEL_PROVENANCE_PATH: &str = "/usr/lib/intar/kernel/kernel-build.json";

/// One pinned source file of the kernel build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KernelSourceFile {
    pub name: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

/// The three files that dpkg-source needs, with the sha256 the build verifies
/// before it unpacks them. The .dsc comes first; its own signed body lists the
/// sha256 of the two tarballs, and the build checks all three independently.
pub const KERNEL_SOURCE_FILES: &[KernelSourceFile] = &[
    KernelSourceFile {
        name: "linux_6.12.96-1.dsc",
        sha256: "4fca3ebc4d2c1c2c7b88e05dc67fef7a7f539f03b19b4308f61d7ee3e2f1b738",
        size_bytes: 288_306,
    },
    KernelSourceFile {
        name: "linux_6.12.96.orig.tar.xz",
        sha256: "59f9548e0384dbafd08eaf05872576de8de50206f972b091c567a9fc91867ca7",
        size_bytes: 151_315_096,
    },
    KernelSourceFile {
        name: "linux_6.12.96-1.debian.tar.xz",
        sha256: "6052af0c3d43d5676853e25d1a52521d09440fa000dd73c30350783d47271918",
        size_bytes: 1_845_940,
    },
];

/// Every symbol that the guest contract needs built in (value y).
///
/// A missing symbol fails the build. Do not trim this list without checking the
/// guest contract in docs/src/content/docs/operations/scenario-host-jailer.md.
pub const KERNEL_REQUIRED_BUILTINS: &[&str] = &[
    // Cloud Hypervisor CPU enumeration uses x2APIC MADT entries.
    "CONFIG_SMP",
    "CONFIG_HYPERVISOR_GUEST",
    "CONFIG_X86_X2APIC",
    // virtio and vsock, for disks, network, console, and Kino.
    "CONFIG_VIRTIO_PCI",
    "CONFIG_VIRTIO_BLK",
    "CONFIG_VIRTIO_NET",
    "CONFIG_VIRTIO_CONSOLE",
    "CONFIG_VSOCKETS",
    "CONFIG_VIRTIO_VSOCKETS",
    // root and data filesystems.
    "CONFIG_EXT4_FS",
    "CONFIG_VFAT_FS",
    "CONFIG_NLS_UTF8",
    "CONFIG_OVERLAY_FS",
    // boot plumbing.
    "CONFIG_BLK_DEV_INITRD",
    "CONFIG_RD_GZIP",
    "CONFIG_DEVTMPFS",
    "CONFIG_DEVTMPFS_MOUNT",
    "CONFIG_SERIAL_8250",
    "CONFIG_SERIAL_8250_CONSOLE",
    "CONFIG_UNIX98_PTYS",
    // isolation, scheduling, and security.
    "CONFIG_CGROUPS",
    "CONFIG_CFS_BANDWIDTH",
    "CONFIG_MEMCG",
    "CONFIG_CPUSETS",
    "CONFIG_CGROUP_PIDS",
    "CONFIG_CGROUP_BPF",
    "CONFIG_NAMESPACES",
    "CONFIG_USER_NS",
    "CONFIG_NET_NS",
    "CONFIG_PID_NS",
    "CONFIG_IPC_NS",
    "CONFIG_UTS_NS",
    "CONFIG_SECCOMP",
    "CONFIG_SECCOMP_FILTER",
    "CONFIG_SECURITY_APPARMOR",
    "CONFIG_SECURITY_YAMA",
    "CONFIG_BPF_SYSCALL",
    // networking and the Kubernetes data paths.
    "CONFIG_NETFILTER_ADVANCED",
    "CONFIG_NF_TABLES",
    // xtables extensions over nf_tables. Debian's iptables defaults to the nft
    // backend, so k3s rule programming needs this or every rule with an xt
    // extension fails on the guest.
    "CONFIG_NFT_COMPAT",
    "CONFIG_NFT_NAT",
    "CONFIG_NFT_MASQ",
    "CONFIG_NFT_REDIR",
    "CONFIG_NFT_CT",
    "CONFIG_NFT_REJECT",
    "CONFIG_NFT_REJECT_INET",
    "CONFIG_NF_CONNTRACK",
    "CONFIG_NF_NAT",
    "CONFIG_IP_NF_IPTABLES",
    "CONFIG_IP_NF_NAT",
    "CONFIG_NETFILTER_XT_NAT",
    "CONFIG_NETFILTER_XT_MATCH_ADDRTYPE",
    "CONFIG_NETFILTER_XT_MATCH_STATISTIC",
    "CONFIG_NETFILTER_XT_MATCH_RECENT",
    // The default k3s network policy drops with a logged rate limit.
    "CONFIG_NETFILTER_XT_MATCH_LIMIT",
    "CONFIG_NETFILTER_XT_TARGET_NFLOG",
    "CONFIG_NETFILTER_NETLINK_LOG",
    "CONFIG_NETFILTER_XT_TARGET_LOG",
    "CONFIG_NF_LOG_SYSLOG",
    // IP sets for the default k3s network policy. kube-router 2.6.3-k3s1
    // creates hash:ip and hash:net sets only.
    "CONFIG_IP_SET",
    "CONFIG_IP_SET_HASH_IP",
    "CONFIG_IP_SET_HASH_NET",
    "CONFIG_NETFILTER_XT_SET",
    "CONFIG_BRIDGE",
    "CONFIG_BRIDGE_NETFILTER",
    "CONFIG_VXLAN",
    "CONFIG_VETH",
    "CONFIG_TUN",
    "CONFIG_PACKET",
];

/// The build script template, with the @TOKEN@ fields that
/// [`render_kernel_build_script`] fills from the pins in this module.
pub const KERNEL_BUILD_SCRIPT_SOURCE: &str = include_str!("../kernel/intar-kernel-build.sh");

/// The exact kernel release string: upstream version plus local version.
#[must_use]
pub fn kernel_release() -> String {
    format!("{KERNEL_UPSTREAM_VERSION}{KERNEL_LOCALVERSION}")
}

/// The three numbers of the upstream version, for the unpack check.
///
/// The build asserts that the unpacked tree declares exactly these values in
/// its top-level Makefile, so a wrong or stale tree fails the build instead of
/// reaching the compile.
#[must_use]
pub fn upstream_version_parts() -> (&'static str, &'static str, &'static str) {
    let mut parts = KERNEL_UPSTREAM_VERSION.split('.');
    (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    )
}

/// Name of the kernel image inside the image /boot directory.
#[must_use]
pub fn kernel_image_file_name() -> String {
    format!("vmlinuz-{}", kernel_release())
}

/// Name of the initramfs inside the image /boot directory.
#[must_use]
pub fn kernel_initrd_file_name() -> String {
    format!("initrd.img-{}", kernel_release())
}

/// Absolute path of the kernel inside the built image.
///
/// The Dockerfile copies the compiled kernel to this path, and the host-side
/// assembly reads it back from the unpacked image. Both sides call this
/// function, so the two can not drift apart.
#[must_use]
pub fn kernel_image_path_in_image() -> String {
    format!("/boot/{}", kernel_image_file_name())
}

/// Absolute path of the initramfs inside the built image.
#[must_use]
pub fn kernel_initrd_path_in_image() -> String {
    format!("/boot/{}", kernel_initrd_file_name())
}

/// Token fields that the build script template declares.
#[must_use]
pub fn kernel_build_script_tokens() -> Vec<&'static str> {
    let bytes = KERNEL_BUILD_SCRIPT_SOURCE.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'@' {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        while index < bytes.len()
            && (bytes[index].is_ascii_uppercase()
                || bytes[index].is_ascii_digit()
                || bytes[index] == b'_')
        {
            index += 1;
        }
        if index > start + 1 && index < bytes.len() && bytes[index] == b'@' {
            tokens.push(&KERNEL_BUILD_SCRIPT_SOURCE[start..=index]);
            index += 1;
        }
    }
    tokens
}

/// Render the kernel build script that the OCI build stage runs.
///
/// The script runs as root inside the build container with `/build` as its
/// working directory, and writes `vmlinuz`, `initrd.img`, the module tree, and
/// the provenance record into the output directory it receives.
#[must_use]
pub fn render_kernel_build_script(config: &QemuBuildConfig) -> String {
    let source_files = KERNEL_SOURCE_FILES
        .iter()
        .map(|file| format!("{} {}", file.sha256, file.name))
        .collect::<Vec<_>>()
        .join("\n");
    let required = KERNEL_REQUIRED_BUILTINS.join("\n");
    let (major, minor, patch) = upstream_version_parts();
    KERNEL_BUILD_SCRIPT_SOURCE
        .replace("@SOURCE_VERSION@", KERNEL_SOURCE_VERSION)
        .replace("@UPSTREAM_MAJOR@", major)
        .replace("@UPSTREAM_MINOR@", minor)
        .replace("@UPSTREAM_PATCH@", patch)
        .replace("@RELEASE@", &kernel_release())
        .replace("@JOBS@", &config.layered.kernel_build_jobs.to_string())
        .replace("@SOURCE_DATE_EPOCH@", &KERNEL_SOURCE_DATE_EPOCH.to_string())
        .replace("@BASE_URL@", KERNEL_SOURCE_BASE_URL)
        .replace("@SNAPSHOT@", KERNEL_APT_SNAPSHOT)
        .replace("@SNAPSHOT_URL@", KERNEL_APT_SNAPSHOT_URL)
        .replace("@BUSYBOX_VERSION@", KERNEL_BUSYBOX_STATIC_VERSION)
        .replace("@E2FSCK_VERSION@", KERNEL_E2FSCK_STATIC_VERSION)
        .replace("@BUILD_USER@", KERNEL_BUILD_USER)
        .replace("@BUILD_HOST@", KERNEL_BUILD_HOST)
        .replace("@SOURCE_FILES@", &source_files)
        .replace("@REQUIRED_BUILTINS@", &required)
}

/// Digest of every input that changes the compiled kernel.
///
/// The OCI base-image cache key includes this value, so a changed pin, config,
/// toolchain, or init script always invalidates the cached base image.
#[must_use]
pub fn kernel_profile_digest() -> String {
    let mut identity = String::new();
    identity.push_str("intar-kernel-profile-v2\n");
    identity.push_str(&format!("source_version={KERNEL_SOURCE_VERSION}\n"));
    identity.push_str(&format!("upstream_version={KERNEL_UPSTREAM_VERSION}\n"));
    identity.push_str(&format!("localversion={KERNEL_LOCALVERSION}\n"));
    identity.push_str(&format!("base_url={KERNEL_SOURCE_BASE_URL}\n"));
    identity.push_str(&format!("apt_snapshot={KERNEL_APT_SNAPSHOT}\n"));
    identity.push_str(&format!("apt_snapshot_url={KERNEL_APT_SNAPSHOT_URL}\n"));
    identity.push_str(&format!("busybox={KERNEL_BUSYBOX_STATIC_VERSION}\n"));
    identity.push_str(&format!("e2fsck={KERNEL_E2FSCK_STATIC_VERSION}\n"));
    identity.push_str(&format!("source_date_epoch={KERNEL_SOURCE_DATE_EPOCH}\n"));
    for file in KERNEL_SOURCE_FILES {
        identity.push_str(&format!(
            "source_file={} sha256={} size={}\n",
            file.name, file.sha256, file.size_bytes
        ));
    }
    identity.push_str("--required-builtins--\n");
    identity.push_str(&KERNEL_REQUIRED_BUILTINS.join("\n"));
    identity.push_str("\n--config-fragment--\n");
    identity.push_str(KERNEL_CONFIG_FRAGMENT);
    identity.push_str("--init-script--\n");
    identity.push_str(KERNEL_INITRAMFS_INIT_SCRIPT);
    crate::content_hash::sha256_bytes_hex(identity.as_bytes())
}

/// Return required symbols that are not built in (value y) in a kernel .config.
#[must_use]
pub fn missing_required_builtins(config: &str) -> Vec<&'static str> {
    KERNEL_REQUIRED_BUILTINS
        .iter()
        .copied()
        .filter(|symbol| !config_line_is_builtin(config, symbol))
        .collect()
}

fn config_line_is_builtin(config: &str, symbol: &str) -> bool {
    let expected = format!("{symbol}=y");
    config.lines().any(|line| line.trim() == expected)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::{
        KERNEL_APT_SNAPSHOT, KERNEL_BUSYBOX_STATIC_VERSION, KERNEL_CONFIG_FRAGMENT,
        KERNEL_E2FSCK_STATIC_VERSION, KERNEL_INITRAMFS_INIT_SCRIPT, KERNEL_REQUIRED_BUILTINS,
        kernel_build_script_tokens, kernel_image_file_name, kernel_initrd_file_name,
        kernel_profile_digest, kernel_release, missing_required_builtins,
        render_kernel_build_script,
    };
    use crate::config::QemuBuildConfig;

    fn jobs_config(jobs: u32) -> QemuBuildConfig {
        QemuBuildConfig {
            layered: crate::config::LayeredBuildConfig {
                kernel_build_jobs: jobs,
                ..crate::config::LayeredBuildConfig::default()
            },
            ..QemuBuildConfig::default()
        }
    }

    fn shell_syntax(source: &str, name: &str) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(name);
        std::fs::write(&path, source).unwrap();
        let output = std::process::Command::new("sh")
            .arg("-n")
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn the_script_template_declares_tokens_and_renders_without_any_left() {
        let tokens = kernel_build_script_tokens();
        assert!(tokens.contains(&"@SOURCE_VERSION@"));
        assert!(tokens.contains(&"@REQUIRED_BUILTINS@"));
        assert!(tokens.contains(&"@SNAPSHOT@"));
        assert!(tokens.contains(&"@BUSYBOX_VERSION@"));
        assert!(tokens.contains(&"@UPSTREAM_MAJOR@"));
        assert!(tokens.contains(&"@UPSTREAM_MINOR@"));
        assert!(tokens.contains(&"@UPSTREAM_PATCH@"));
        assert!(tokens.len() >= 16, "unexpected token set: {tokens:?}");

        let rendered = render_kernel_build_script(&jobs_config(4));
        for token in tokens {
            assert!(!rendered.contains(token), "{token} survived rendering");
        }
    }

    #[test]
    fn the_profile_builds_every_required_symbol_into_the_fragment() {
        // The fragment is the only source of the built-in feature set. A
        // symbol that the build verifies must also be a line in the fragment,
        // so the check and the profile cannot drift apart.
        for symbol in KERNEL_REQUIRED_BUILTINS {
            assert!(
                KERNEL_CONFIG_FRAGMENT.contains(&format!("\n{symbol}=y")),
                "{symbol} is verified but the profile does not build it in"
            );
        }
        assert!(
            !KERNEL_CONFIG_FRAGMENT.contains("CONFIG_MODULES=n"),
            "modprobe must succeed for a built-in name"
        );
    }

    #[test]
    fn missing_required_builtins_reports_each_absent_symbol() {
        let mut config = String::new();
        for symbol in KERNEL_REQUIRED_BUILTINS {
            config.push_str(&format!("{symbol}=y\n"));
        }
        assert!(missing_required_builtins(&config).is_empty());

        let absent = config.replace("CONFIG_VXLAN=y\n", "# CONFIG_VXLAN is not set\n");
        assert_eq!(missing_required_builtins(&absent), vec!["CONFIG_VXLAN"]);

        // Without x2APIC, Linux ignores Cloud Hypervisor's CPU entries and
        // boots only the bootstrap CPU even when the VMM configures more.
        let single_cpu =
            config.replace("CONFIG_X86_X2APIC=y\n", "# CONFIG_X86_X2APIC is not set\n");
        assert_eq!(
            missing_required_builtins(&single_cpu),
            vec!["CONFIG_X86_X2APIC"]
        );

        let as_module = config.replace("CONFIG_VFAT_FS=y\n", "CONFIG_VFAT_FS=m\n");
        assert_eq!(
            missing_required_builtins(&as_module),
            vec!["CONFIG_VFAT_FS"]
        );
    }

    #[test]
    fn kernel_release_and_boot_artifact_names_are_stable() {
        assert_eq!(kernel_release(), "6.12.96-intar-cutover");
        assert_eq!(kernel_image_file_name(), "vmlinuz-6.12.96-intar-cutover");
        assert_eq!(
            kernel_initrd_file_name(),
            "initrd.img-6.12.96-intar-cutover"
        );
    }

    #[test]
    fn the_build_script_pins_the_source_the_toolchain_and_the_job_count() {
        let script = render_kernel_build_script(&jobs_config(3));

        // Pinned source, verified before unpacking.
        assert!(script.contains("linux_6.12.96-1.dsc"));
        assert!(script.contains("linux_6.12.96.orig.tar.xz"));
        assert!(script.contains("linux_6.12.96-1.debian.tar.xz"));
        assert!(script.contains("sha256sum --check --strict --quiet"));
        // Pinned toolchain, from one dated snapshot, with the two runtime
        // binaries pinned to an exact version.
        assert!(script.contains(KERNEL_APT_SNAPSHOT));
        assert!(script.contains("busybox-static=\"$busybox_version\""));
        assert!(script.contains("e2fsck-static=\"$e2fsck_version\""));
        assert!(script.contains(&format!(
            "busybox_version='{KERNEL_BUSYBOX_STATIC_VERSION}'"
        )));
        assert!(script.contains(&format!("e2fsck_version='{KERNEL_E2FSCK_STATIC_VERSION}'")));
        assert!(script.contains("check-valid-until=no"));
        // The unpack target is explicit and is never created before the call.
        // dpkg-source refuses an existing target and creates the target itself.
        assert!(script.contains("dpkg-source --no-check --extract"));
        assert!(script.contains("src=\"$work/unpacked\""));
        assert!(!script.contains("mkdir -p unpacked"));
        assert!(!script.contains("find unpacked"));
        // The clean step is scoped to the build directory, so a stray value can
        // never turn it into a wider removal.
        assert!(script.contains("refusing to clean"));
        // The unpack step must not look for the tree by its contents, even
        // though the compile step legitimately names arch/x86/boot/bzImage.
        let unpack_start = script
            .find("log \"unpacking the Debian patch series\"")
            .unwrap();
        let unpack_end = script.find("cd \"$src\"").unwrap();
        assert!(!script[unpack_start..unpack_end].contains("arch/x86"));
        // The unpacked tree must declare the pinned upstream version.
        assert!(script.contains("require_makefile_version VERSION \"$upstream_major\""));
        assert!(script.contains("require_makefile_version PATCHLEVEL \"$upstream_minor\""));
        assert!(script.contains("require_makefile_version SUBLEVEL \"$upstream_patch\""));
        assert!(script.contains("upstream_major='6'"));
        assert!(script.contains("upstream_minor='12'"));
        assert!(script.contains("upstream_patch='96'"));
        // Reproducible inputs.
        assert!(script.contains("KBUILD_BUILD_TIMESTAMP="));
        assert!(script.contains("SOURCE_DATE_EPOCH="));
        assert!(script.contains("sort -z"));
        assert!(script.contains("cpio --quiet --reproducible --null"));
        assert!(script.contains("touch -h -d"));
        // Capped parallelism and no host-specific code generation.
        assert!(script.contains("jobs='3'"));
        assert!(script.contains("make -j\"$jobs\" bzImage"));
        assert!(!script.contains("-march=native"));
        assert!(!script.contains("-mtune=native"));
        // Profile merge, the feature-set gate, and the module tree.
        assert!(script.contains("merge_config.sh -m .config"));
        assert!(script.contains("make olddefconfig"));
        assert!(script.contains("the kernel profile is not built in"));
        // No loadable module exists in a bzImage-only profile.
        assert!(!script.contains("modules_install"));
        // A built-in name must still resolve through modprobe at boot.
        assert!(script.contains("modules.builtin"));
        assert!(script.contains("depmod -b"));
        // The =m gate proves the kernel has nothing to load, so the module
        // step has no compatibility branch and the provenance has no module
        // fields to carry.
        assert!(script.contains("no symbol resolved to =m"));
        assert!(!script.contains("modules_install"));
        assert!(!script.contains("ko_count"));
        assert!(!script.contains("modules_written"));
        // The initramfs is a pinned busybox image.
        assert!(script.contains("/bin/busybox"));
        assert!(script.contains("/sbin/e2fsck.static"));
        assert!(script.contains("\"$initramfs/init\""));
    }

    #[test]
    fn the_build_script_rejects_an_out_of_range_job_count() {
        assert!(render_kernel_build_script(&jobs_config(0)).contains("outside 1..=64"));
        let high = render_kernel_build_script(&jobs_config(65));
        assert!(high.contains("outside 1..=64"));
        assert!(high.contains("jobs='65'"));
    }

    #[test]
    fn the_build_script_and_the_initramfs_init_are_valid_posix_shell() {
        shell_syntax(
            &render_kernel_build_script(&jobs_config(4)),
            "intar-kernel-build.sh",
        );
        shell_syntax(KERNEL_INITRAMFS_INIT_SCRIPT, "intar-initramfs-init.sh");
    }

    #[test]
    fn the_initramfs_init_hands_over_with_switch_root_and_never_pivots() {
        // The initramfs rootfs may not pivot_root, so the init must use the
        // standard busybox switch_root instead.
        assert!(!KERNEL_INITRAMFS_INIT_SCRIPT.contains("pivot_root"));
        assert!(KERNEL_INITRAMFS_INIT_SCRIPT.contains("switch_root /sysroot /sbin/init"));
        assert!(KERNEL_INITRAMFS_INIT_SCRIPT.contains("mount --move /dev /sysroot/dev"));
        assert!(KERNEL_INITRAMFS_INIT_SCRIPT.contains("e2fsck.static -p"));
        // e2fsck exit 2 means the filesystem needs a reboot, never a boot.
        assert!(KERNEL_INITRAMFS_INIT_SCRIPT.contains("requires a reboot; rebuild the image"));
        // The root device comes from the kernel command line, and a resolver
        // style or network root is rejected instead of guessed.
        assert!(KERNEL_INITRAMFS_INIT_SCRIPT.contains("/proc/cmdline"));
        assert!(KERNEL_INITRAMFS_INIT_SCRIPT.contains("needs a device resolver"));
        assert!(KERNEL_INITRAMFS_INIT_SCRIPT.contains("looks like a network root"));
    }

    #[test]
    fn the_kernel_profile_digest_covers_every_pinned_input() {
        let digest = kernel_profile_digest();
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|value| value.is_ascii_hexdigit()));
        assert_eq!(digest, kernel_profile_digest());
    }

    #[test]
    fn the_initramfs_wait_polls_below_a_second_and_stays_bounded() {
        let script = KERNEL_INITRAMFS_INIT_SCRIPT;

        // A whole-second sleep would add up to a second of boot time when the
        // disk appears a few milliseconds late.
        assert!(script.contains("$BB sleep 0.02"));
        // The only whole-second sleep is the bounded fallback inside fatal(),
        // which runs after the machine has already been powered off.
        assert_eq!(script.matches("$BB sleep 1").count(), 1);
        assert!(script.contains("while true; do $BB sleep 1; done"));
        // The iteration count is the only bound, so the wait cannot run past
        // intar.root_wait_ms.
        assert!(script.contains("iterations=$(( (wait_ms + 19) / 20 ))"));
        assert!(script.contains("iterations=$((iterations - 1))"));
        assert!(script.contains("-gt 30000"));
    }

    #[test]
    fn the_initramfs_never_offers_a_filesystem_check_bypass() {
        let script = KERNEL_INITRAMFS_INIT_SCRIPT;

        // A clean filesystem skips e2fsck. There is no knob that skips the
        // check for any other state, and no knob that forces it either.
        assert!(!script.contains("intar.root_fsck"));
        assert!(!script.contains("fsck=skip"));
        assert!(!script.contains("check_mode"));
        assert!(script.contains("01) needs_check=0 ;;"));
        assert!(script.contains("needs_check=1"));
    }

    #[test]
    fn the_initramfs_superblock_check_avoids_host_specific_arithmetic() {
        let script = KERNEL_INITRAMFS_INIT_SCRIPT;

        // busybox ash rejects the bash-only 16# form, so the check compares
        // the two state bytes as text.
        assert!(!script.contains("16#"));
        assert!(!script.contains("0x$"));
        assert!(script.contains("skip=1082 count=1"));
        assert!(script.contains("od -An -tx1"));
        // s_state is __le16 at 1082, so the low byte alone carries the clean
        // flag. Reading two bytes would render "0100" and never match.
        assert!(script.contains("01) needs_check=0 ;;"));
    }

    /// Read the ext4 state byte exactly as the initramfs reads it, with the
    /// host copies of dd, od, and tr. This proves the pipeline and the string
    /// the script compares against, without a Linux guest.
    fn read_state_byte(superblock_state: &[u8]) -> String {
        let directory = tempfile::tempdir().unwrap();
        let disk = directory.path().join("root.ext4");
        let mut image = vec![0_u8; 4096];
        // s_magic, __le16 at 1024 + 0x38.
        image[1080] = 0x53;
        image[1081] = 0xEF;
        image[1082..1082 + superblock_state.len()].copy_from_slice(superblock_state);
        std::fs::write(&disk, &image).unwrap();
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "dd if={} bs=1 skip=1082 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'",
                disk.display()
            ))
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap()
    }

    #[test]
    fn the_state_byte_read_matches_the_scripts_clean_expectation() {
        // A clean ext4 filesystem has s_state == EXT4_VALID_FS == 0x0001, which
        // is the bytes 01 00. The low byte is 01, and that is what the script
        // treats as clean.
        assert_eq!(read_state_byte(&[0x01, 0x00]), "01");
        // In use without a clean unmount, recorded errors, and both together.
        // Every one of these must reach the check branch.
        assert_eq!(read_state_byte(&[0x00, 0x00]), "00");
        assert_eq!(read_state_byte(&[0x02, 0x00]), "02");
        assert_eq!(read_state_byte(&[0x03, 0x00]), "03");
        // The script skips the check for exactly one string.
        let script = KERNEL_INITRAMFS_INIT_SCRIPT;
        assert_eq!(script.matches("needs_check=0").count(), 1);
        assert!(script.contains("01) needs_check=0 ;;"));
        // A read that produced no output needs the check.
        assert!(script.contains("'') log 'cannot read the ext4 superblock state"));
    }

    /// Extract the rendered unpack step and the helpers it needs, then run it
    /// against a stub that reproduces the real dpkg-source contract.
    fn run_unpack_step(pre_existing_target: bool, sublevel: &str) -> (bool, String, String) {
        let script = render_kernel_build_script(&jobs_config(4));
        let start = script
            .find("log \"unpacking the Debian patch series\"")
            .expect("the script logs the unpack step");
        let end = script
            .find("cd \"$src\"")
            .expect("the script enters the tree");
        let fragment = &script[start..end];
        let mut harness = String::from("set -eu\nwork=\"$INTAR_UNPACK_WORK\"\ncd \"$work\"\n");
        for name in ["log", "fail", "require_makefile_version"] {
            let marker = format!("{name}() {{");
            let body_start = script.find(&marker).expect("helper is defined");
            let rest = &script[body_start..];
            let body_end = rest.find("\n}\n").expect("helper is closed") + 3;
            harness.push_str(&rest[..body_end]);
            harness.push('\n');
        }
        for line in script.lines() {
            if line.starts_with("upstream_") || line.starts_with("source_version=") {
                harness.push_str(line);
                harness.push('\n');
            }
        }
        harness.push_str(fragment);

        let state = tempfile::tempdir().unwrap();
        std::fs::write(state.path().join("linux_6.12.96-1.dsc"), "dsc\n").unwrap();
        if pre_existing_target {
            let stale = state.path().join("unpacked");
            std::fs::create_dir_all(&stale).unwrap();
            std::fs::write(stale.join("stale"), "leftover\n").unwrap();
        }
        let stub_dir = state.path().join("stub");
        std::fs::create_dir_all(&stub_dir).unwrap();
        // The real dpkg-source refuses an existing target and creates the target
        // itself, with the source tree root at the target. Verified against the
        // pinned Debian image: unpacked/Makefile holds VERSION/PATCHLEVEL/SUBLEVEL
        // and there is no nested linux-* directory.
        let stub = format!(
            "#!/bin/sh\nset -eu\ntarget=\"$4\"\nif [ -e \"$target\" ]; then\n  echo 'dpkg-source: error: unpack target exists' >&2\n  printf 'existed=yes\\n' >> \"$INTAR_STUB_LOG\"\n  exit 1\nfi\nprintf 'existed=no\\n' >> \"$INTAR_STUB_LOG\"\nmkdir -p \"$target\"\nprintf 'VERSION = 6\\nPATCHLEVEL = 12\\nSUBLEVEL = {sublevel}\\n' > \"$target/Makefile\"\nmkdir -p \"$target/debian\"\n"
        );
        let stub_path = stub_dir.join("dpkg-source");
        std::fs::write(&stub_path, stub).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&stub_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let harness_path = state.path().join("harness.sh");
        std::fs::write(&harness_path, harness).unwrap();
        let log_path = state.path().join("stub.log");
        let path = std::env::var("PATH").unwrap_or_default();
        let output = std::process::Command::new("sh")
            .arg(&harness_path)
            .env("PATH", format!("{}:{path}", stub_dir.display()))
            .env("INTAR_UNPACK_WORK", state.path())
            .env("INTAR_STUB_LOG", &log_path)
            .output()
            .unwrap();
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        let tree_makefile = state.path().join("unpacked/Makefile");
        let tree = if tree_makefile.is_file() {
            std::fs::read_to_string(&tree_makefile).unwrap_or_default()
        } else {
            String::new()
        };
        (
            output.status.success(),
            log,
            format!("{}{}", tree, String::from_utf8_lossy(&output.stderr)),
        )
    }

    #[test]
    fn the_unpack_step_leaves_no_existing_target_for_dpkg_source() {
        // dpkg-source fails on an existing target, so the step must remove a
        // stale one and must not create the target itself.
        let (ok, log, _) = run_unpack_step(false, "96");
        assert!(ok, "a clean state directory must work");
        assert_eq!(log, "existed=no\n");

        let (ok, log, _) = run_unpack_step(true, "96");
        assert!(ok, "a stale target from an earlier run must be removed");
        assert_eq!(log, "existed=no\n", "dpkg-source must never see the target");
    }

    #[test]
    fn the_unpack_step_rejects_a_tree_that_is_not_the_pinned_version() {
        let (ok, _, stderr) = run_unpack_step(false, "95");
        assert!(!ok, "a mismatched upstream version must fail the build");
        assert!(
            stderr.contains("does not declare SUBLEVEL = 96"),
            "the failure must name the missing version line: {stderr}"
        );
    }

    #[test]
    fn the_build_hard_fails_when_any_symbol_resolves_to_a_module() {
        let script = render_kernel_build_script(&jobs_config(4));

        // This build produces bzImage only, so a =m symbol is not in the
        // kernel. The build must stop and name every such symbol instead of
        // shipping the gap.
        assert!(script.contains("grep -cE '^CONFIG_[A-Z0-9_]*=m$' .config"));
        assert!(script.contains("resolved to =m, and this build produces bzImage only"));
        assert!(script.contains("grep -E '^CONFIG_[A-Z0-9_]*=m$' .config >&2"));
        assert!(script.contains("set these to =y or turn them off"));
        assert!(script.contains("no symbol resolved to =m"));
    }

    #[test]
    fn the_module_tree_always_carries_the_files_depmod_reads() {
        let script = render_kernel_build_script(&jobs_config(4));

        // depmod warns when modules.order is absent, and a fully built-in
        // profile never writes it.
        assert!(script.contains("modules.builtin modules.builtin.modinfo modules.order"));
        assert!(script.contains("if [ ! -f \"$modules_dir/modules.order\" ]; then"));
        assert!(script.contains(": > \"$modules_dir/modules.order\""));
    }

    #[test]
    fn every_required_symbol_is_a_built_in_line_in_the_fragment() {
        // The fragment is the only source of the built-in feature set, and the
        // ADDRTYPE, LOG, and NAT entries are required by the guest contract:
        // kube-proxy uses dst-type LOCAL matching, and the lab needs the nft
        // nat, ct, and reject expressions.
        let script = render_kernel_build_script(&jobs_config(4));
        for symbol in [
            "CONFIG_NETFILTER_XT_MATCH_ADDRTYPE",
            "CONFIG_NETFILTER_XT_TARGET_LOG",
            "CONFIG_NF_LOG_SYSLOG",
            "CONFIG_NF_NAT",
            "CONFIG_NFT_CT",
            "CONFIG_NFT_REJECT",
            "CONFIG_NFT_REJECT_INET",
            "CONFIG_NFT_NAT",
            "CONFIG_IP_NF_NAT",
            "CONFIG_NETFILTER_XT_NAT",
        ] {
            assert!(
                KERNEL_REQUIRED_BUILTINS.contains(&symbol),
                "{symbol} must be gated"
            );
            assert!(
                script.contains(&format!("\n{symbol}\n")),
                "{symbol} must reach the required list in the rendered script"
            );
        }
    }
    /// The k3s netfilter surface must be built in, or the guest programs no
    /// rules at all.
    ///
    /// This is the regression for the CoreDNS timeout: Debian's iptables
    /// defaults to the nft backend, k3s programs rules through plain
    /// "iptables", and every xt extension needs nft_compat to travel over
    /// nf_tables. The guest reported "Extension comment ... not supported" and
    /// RULE_APPEND failed on KUBE-FIREWALL, so the KUBE-* chains were empty and
    /// service VIPs never translated. Each line below is one rule class the
    /// cluster needs, so a missing one fails the build instead of the cluster.
    #[test]
    fn the_k3s_netfilter_surface_is_required_and_built_in() {
        let needed = [
            // xtables extensions over nf_tables: the root cause.
            "CONFIG_NFT_COMPAT",
            // endpoint randomisation and session affinity.
            "CONFIG_NETFILTER_XT_MATCH_STATISTIC",
            "CONFIG_NETFILTER_XT_MATCH_RECENT",
            // The default k3s network policy drops with a logged rate limit.
            "CONFIG_NETFILTER_XT_MATCH_LIMIT",
            "CONFIG_NETFILTER_XT_TARGET_NFLOG",
            // IP sets for the default k3s network policy. kube-router
            // 2.6.3-k3s1 creates hash:ip and hash:net sets only.
            "CONFIG_IP_SET",
            "CONFIG_IP_SET_HASH_IP",
            "CONFIG_IP_SET_HASH_NET",
            "CONFIG_NETFILTER_XT_SET",
        ];
        for symbol in needed {
            assert!(
                KERNEL_REQUIRED_BUILTINS.contains(&symbol),
                "{symbol} must be gated: the build must fail when it is not built in"
            );
            assert!(
                KERNEL_CONFIG_FRAGMENT.contains(&format!("\n{symbol}=y")),
                "{symbol} must be built in by the profile"
            );
        }

        // The gate itself must see them as present. A config that lacks one
        // must report it, and a config that has every one must report nothing.
        let mut config = String::new();
        for symbol in KERNEL_REQUIRED_BUILTINS {
            config.push_str(&format!("{symbol}=y\n"));
        }
        assert!(missing_required_builtins(&config).is_empty());
        for symbol in needed {
            let without = config.replace(&format!("{symbol}=y\n"), &format!("{symbol}=m\n"));
            assert!(
                missing_required_builtins(&without).contains(&symbol),
                "a resolved-but-modular {symbol} must fail the build"
            );
        }
    }
}
