use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use anyhow::{Context as _, Result, bail, ensure};

use crate::config::QemuBuildConfig;

pub(crate) const BASE_EXT4_LABEL: &str = "INTARROOT";

// QMP system_powerdown injects this ACPI event, but the minimal image has no
// D-Bus-backed logind consumer. Bash resolves the libc-relative RTMIN+4 name;
// Dash and procps kill do not. Systemd PID 1 maps that signal to poweroff.target.
pub(crate) const INTAR_ACPI_EVENT_PATH: &str = "/etc/acpi/events/90-intar-power-button";
pub(crate) const INTAR_ACPI_POWEROFF_PATH: &str = "/usr/local/sbin/intar-acpi-poweroff";
pub(crate) const INTAR_ACPI_EVENT_RULE: &str =
    "event=button[ /]power\naction=/usr/local/sbin/intar-acpi-poweroff\n";
pub(crate) const INTAR_ACPI_POWEROFF_SCRIPT: &str = "#!/bin/bash\nset -eu\nkill -s RTMIN+4 1\n";

pub(crate) const MASKED_UNITS: &[&str] = &[
    "apt-daily.service",
    "apt-daily.timer",
    "apt-daily-upgrade.service",
    "apt-daily-upgrade.timer",
    "man-db.timer",
    "e2scrub_all.timer",
    "dpkg-db-backup.timer",
    "e2scrub_reap.service",
    "systemd-pstore.service",
    "sshd-keygen.service",
    "fstrim.timer",
    "logrotate.timer",
    "getty@.service",
    "serial-getty@.service",
    "console-getty.service",
    "systemd-networkd-wait-online.service",
];

/// The Debian rootfs an OCI base build starts from.
#[derive(Debug, Clone)]
pub struct BaseImageSpec {
    pub name: String,
    pub suite: String,
    pub mirror: String,
    pub arch: String,
    pub packages: Vec<String>,
}

impl BaseImageSpec {
    pub(crate) fn content_identity(&self) -> String {
        [
            format!("suite={}", self.suite),
            format!("mirror={}", self.mirror),
            format!("arch={}", self.arch),
            format!("packages={}", self.packages.join(",")),
        ]
        .join("\n")
    }
}

#[derive(Debug, Clone)]
pub struct RootfsBuildPlan {
    pub definition_hash: String,
    pub paths: RootfsBuildPaths,
    pub essential_hook: String,
    pub customize_hook: String,
}

#[derive(Debug, Clone)]
pub struct RootfsBuildPaths {
    pub work_root: PathBuf,
    pub rootfs_dir: PathBuf,
    pub base_ext4_path: PathBuf,
    pub kernel_path: PathBuf,
    pub initrd_path: PathBuf,
}

#[derive(Debug)]
pub(crate) enum BaseRootfsLease {
    Cache { _lock: fs::File },
    Private { _directory: tempfile::TempDir },
}

#[derive(Debug, Clone)]
pub struct BaseRootfsArtifact {
    pub base_ext4_path: PathBuf,
    pub kernel_path: PathBuf,
    pub initrd_path: PathBuf,
    pub definition_hash: String,
    /// Held, never read: keeps the cache entry from eviction.
    pub(crate) _lease: Arc<BaseRootfsLease>,
}

pub(crate) fn base_rootfs_artifact_from_plan(
    plan: &RootfsBuildPlan,
    lease: Arc<BaseRootfsLease>,
) -> BaseRootfsArtifact {
    BaseRootfsArtifact {
        base_ext4_path: plan.paths.base_ext4_path.clone(),
        kernel_path: plan.paths.kernel_path.clone(),
        initrd_path: plan.paths.initrd_path.clone(),
        definition_hash: plan.definition_hash.clone(),
        _lease: lease,
    }
}

/// Move the compiled kernel artifacts from the unpacked image to the output paths.
///
/// The generated Dockerfile is the only writer. It copies the compiled kernel to
/// kernel_image_path_in_image, the initramfs to kernel_initrd_path_in_image, and
/// the provenance record to KERNEL_PROVENANCE_PATH. After the OCI import unpacks
/// that image, this function is the only reader: it takes the pair from those
/// paths and copies it to kernel_path and initrd_path for the harness to boot.
///
/// Every path comes from crate::kernel, so the writer and the reader use the
/// same values and can not drift apart.
///
/// The image keeps its own copies. They are part of the base image bytes, and
/// the guest reports and inspects them.
///
/// There is one kernel profile, so there is one expected artifact set. A missing
/// or empty artifact is a build failure, never a silent fallback.
pub(crate) fn install_kernel_boot_artifacts(plan: &RootfsBuildPlan) -> Result<()> {
    let rootfs = &plan.paths.rootfs_dir;
    let mut sources = Vec::new();
    for in_image in [
        crate::kernel::kernel_image_path_in_image(),
        crate::kernel::kernel_initrd_path_in_image(),
        crate::kernel::KERNEL_PROVENANCE_PATH.to_string(),
    ] {
        let source = rootfs.join(in_image.trim_start_matches('/'));
        let metadata = fs::symlink_metadata(&source).with_context(|| {
            format!(
                "the built image has no file at '{in_image}'; the kernel stage must copy it into the image before the base image is assembled"
            )
        })?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() > 0,
            "image artifact '{in_image}' is not a non-empty regular file"
        );
        sources.push((in_image, source));
    }

    for (in_image, source) in sources.iter().take(2) {
        let destination = if in_image == &crate::kernel::kernel_image_path_in_image() {
            &plan.paths.kernel_path
        } else {
            &plan.paths.initrd_path
        };
        fs::copy(source, destination).with_context(|| {
            format!(
                "failed to copy image artifact '{}' to '{}'",
                source.display(),
                destination.display()
            )
        })?;
    }
    Ok(())
}

pub(crate) fn create_base_ext4(plan: &RootfsBuildPlan, config: &QemuBuildConfig) -> Result<()> {
    let size_bytes = ext4_image_size_bytes(&plan.paths.rootfs_dir)?;
    let image = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&plan.paths.base_ext4_path)
        .with_context(|| format!("failed to create '{}'", plan.paths.base_ext4_path.display()))?;
    image
        .set_len(size_bytes)
        .with_context(|| format!("failed to size '{}'", plan.paths.base_ext4_path.display()))?;
    drop(image);

    run_command(
        &config.mke2fs_binary,
        &[
            "-q".to_string(),
            "-t".to_string(),
            "ext4".to_string(),
            "-L".to_string(),
            BASE_EXT4_LABEL.to_string(),
            "-d".to_string(),
            plan.paths.rootfs_dir.display().to_string(),
            plan.paths.base_ext4_path.display().to_string(),
        ],
        None,
    )
    .context("mke2fs base ext4 creation failed")
}

pub(crate) fn ext4_image_size_bytes(rootfs_dir: &Path) -> Result<u64> {
    let apparent_size = directory_apparent_size(rootfs_dir)?;
    let with_headroom = apparent_size
        .saturating_mul(13)
        .checked_div(10)
        .unwrap_or(apparent_size);
    let min_size = 384 * 1024 * 1024_u64;
    let rounded = with_headroom.max(min_size).div_ceil(1024 * 1024) * 1024 * 1024;
    Ok(rounded)
}

fn directory_apparent_size(path: &Path) -> Result<u64> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to stat '{}'", path.display()))?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if metadata.file_type().is_symlink() {
        return Ok(fs::read_link(path)
            .with_context(|| format!("failed to read symlink '{}'", path.display()))?
            .as_os_str()
            .len() as u64);
    }
    if !metadata.is_dir() {
        return Ok(0);
    }

    let mut total = 4096;
    for entry in
        fs::read_dir(path).with_context(|| format!("failed to read '{}'", path.display()))?
    {
        total += directory_apparent_size(&entry?.path())?;
    }
    Ok(total)
}

fn run_command(binary: &Path, args: &[String], current_dir: Option<&Path>) -> Result<()> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }
    let status = command
        .status()
        .with_context(|| format!("failed to execute '{}'", binary.display()))?;
    if status.success() {
        return Ok(());
    }
    bail!("command '{}' failed with status {status}", binary.display())
}

pub(crate) fn rootfs_build_paths(
    base: &BaseImageSpec,
    config: &QemuBuildConfig,
    definition_hash: &str,
) -> RootfsBuildPaths {
    let cache_key = &definition_hash[..16];
    let name = format!("{}-{}-{cache_key}", base.name, base.arch);
    let work_root = config.work_root.join("rootfs").join(&name);
    let output_root = config.output_root.join("base-images").join(&name);

    RootfsBuildPaths {
        rootfs_dir: work_root.join("rootfs"),
        work_root,
        base_ext4_path: output_root.join("root.ext4"),
        kernel_path: output_root.join("vmlinuz"),
        initrd_path: output_root.join("initrd.img"),
    }
}

pub(crate) fn render_essential_hook() -> String {
    r#"#!/bin/sh
set -eu
root="$1"
# BuildKit binds /etc/hostname and /etc/hosts read-only while this hook runs.
# The OCI importer writes the neutral VM files after umoci unpack.
mkdir -p "$root/etc/dpkg/dpkg.cfg.d"
cat > "$root/etc/dpkg/dpkg.cfg.d/01intar-path-excludes" <<'EOF'
path-exclude=/usr/share/doc/*
path-exclude=/usr/share/man/*
path-exclude=/usr/share/info/*
path-exclude=/usr/share/locale/*
EOF
# Conffiles pre-seeded by this hook must win over the package defaults; without
# this dpkg raises an interactive conffile prompt and non-interactive package
# configuration fails.
cat > "$root/etc/dpkg/dpkg.cfg.d/02intar-conffile-policy" <<'EOF'
force-confold
EOF
"#
    .to_string()
}

pub(crate) fn render_intar_build_service() -> String {
    r#"[Unit]
Description=Intar image build bootstrap
After=local-fs.target
Before=multi-user.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/intar-build-start
Restart=on-failure
RestartSec=1s
RuntimeDirectory=sshd
RuntimeDirectoryMode=0755
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
"#
    .to_string()
}

pub(crate) fn render_build_start_script(username: &str, extra_sshd_args: &str) -> String {
    r#"#!/bin/sh
set -eu

log_failure() {
  status="$?"
  echo "intar-build bootstrap failed with status $status" >&2
  ip -brief link >&2 2>/dev/null || true
  ip -brief address >&2 2>/dev/null || true
  ip route show >&2 2>/dev/null || true
  exit "$status"
}
trap log_failure EXIT

seed_device=""
for _ in $(seq 1 200); do
  seed_device="$(blkid -L INTARBUILD 2>/dev/null || true)"
  if [ -n "$seed_device" ]; then
    break
  fi
  sleep 0.1
done
if [ -z "$seed_device" ]; then
  echo "INTARBUILD seed device not found" >&2
  exit 1
fi

mkdir -p /run/intar-build
if mountpoint -q /run/intar-build; then
  mounted_source="$(findmnt -n -o SOURCE --target /run/intar-build 2>/dev/null || true)"
  if [ -z "$mounted_source" ] || [ "$(readlink -f "$mounted_source")" != "$(readlink -f "$seed_device")" ]; then
    echo "unexpected filesystem already mounted at /run/intar-build" >&2
    exit 1
  fi
else
  mount -t vfat -o ro "$seed_device" /run/intar-build
fi
. /run/intar-build/build.env

configure_network() {
  deadline=$(( $(cut -d. -f1 /proc/uptime) + 30 ))
  last_error="no non-loopback network interface found"
  while [ "$(cut -d. -f1 /proc/uptime)" -lt "$deadline" ]; do
    if [ -n "${INTAR_BUILD_IFACE:-}" ]; then
      candidates="/sys/class/net/$INTAR_BUILD_IFACE"
    else
      candidates="/sys/class/net/*"
    fi
    for candidate in $candidates; do
      [ -e "$candidate" ] || continue
      iface="${candidate##*/}"
      [ "$iface" = "lo" ] && continue
      if error="$(ip link set "$iface" up 2>&1)" &&
         error="$(ip addr replace "${INTAR_BUILD_IP:-10.0.2.15/24}" dev "$iface" 2>&1)" &&
         error="$(ip route replace default via "${INTAR_BUILD_GATEWAY:-10.0.2.2}" dev "$iface" 2>&1)"; then
        echo "configured build network on $iface" >&2
        return 0
      fi
      last_error="interface $iface: $error"
    done
    sleep 1
  done
  echo "timed out configuring build network: $last_error" >&2
  return 1
}

# The base rootfs has no resolver configuration. Without a nameserver every
# apt/curl step in the build provisioning fails on DNS resolution.
rm -f /etc/resolv.conf
for dns_server in ${INTAR_BUILD_DNS:-10.0.2.3}; do
  printf 'nameserver %s\n' "$dns_server" >>/etc/resolv.conf
done
chmod 0644 /etc/resolv.conf

install -d -m 0700 -o @USER@ -g @USER@ /home/@USER@/.ssh
install -m 0600 -o @USER@ -g @USER@ /run/intar-build/authorized_keys /home/@USER@/.ssh/authorized_keys
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
  ssh-keygen -q -N '' -t ed25519 -f /etc/ssh/ssh_host_ed25519_key
fi
install -d -o root -g root -m 0755 /run/sshd
set -- \
@SSHD_ARGS@  -o UsePAM=yes \
  -o PAMServiceName=intar-build \
  -o AuthenticationMethods=publickey \
  -o PerSourcePenalties=no \
  -o MaxStartups=100:30:200 \
  -o LoginGraceTime=30
/usr/sbin/sshd -t "$@"
configure_network

# This sshd is reachable only through QEMU's loopback host forward. The
# builder's readiness probes must not poison OpenSSH's production-oriented
# per-source penalty state while the guest is still starting. Its dedicated
# PAM service keeps the shadow-locked build account while omitting normal
# boot/session gates. The same fixed options are validated above.
exec /usr/sbin/sshd -D -e "$@"
"#
    .replace("@USER@", username)
    .replace("@SSHD_ARGS@", extra_sshd_args)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use crate::config::QemuBuildConfig;
    use crate::platform::render_platform_rootfs_plan;

    fn plan_for(temp: &tempfile::TempDir) -> super::RootfsBuildPlan {
        let config = QemuBuildConfig {
            output_root: temp.path().join("dist"),
            work_root: temp.path().join(".work"),
            ..QemuBuildConfig::default()
        };
        render_platform_rootfs_plan(&config)
    }

    /// Stage the layout a real OCI build leaves behind after umoci unpacks it:
    /// the compiled pair and the provenance record inside the image rootfs, at
    /// the paths the generated Dockerfile copies them to. Nothing writes a host
    /// directory, so the test must not create one.
    fn stage_unpacked_image(plan: &super::RootfsBuildPlan, kernel: &str, initrd: &str) {
        let rootfs = &plan.paths.rootfs_dir;
        let boot = rootfs.join("boot");
        let provenance = rootfs.join(crate::kernel::KERNEL_PROVENANCE_PATH.trim_start_matches('/'));
        std::fs::create_dir_all(&boot).unwrap();
        std::fs::create_dir_all(provenance.parent().unwrap()).unwrap();
        std::fs::write(
            rootfs.join(crate::kernel::kernel_image_path_in_image().trim_start_matches('/')),
            kernel,
        )
        .unwrap();
        std::fs::write(
            rootfs.join(crate::kernel::kernel_initrd_path_in_image().trim_start_matches('/')),
            initrd,
        )
        .unwrap();
        std::fs::write(&provenance, "{\"schema_version\":1}\n").unwrap();
        std::fs::create_dir_all(rootfs.join("etc")).unwrap();
        std::fs::write(rootfs.join("etc/hostname"), "intar-build\n").unwrap();
        // The OCI staging step creates the artifact directory before this runs.
        std::fs::create_dir_all(plan.paths.base_ext4_path.parent().unwrap()).unwrap();
    }

    fn in_image_path(plan: &super::RootfsBuildPlan, path: &str) -> std::path::PathBuf {
        plan.paths.rootfs_dir.join(path.trim_start_matches('/'))
    }

    #[test]
    fn installs_the_pair_from_the_image_paths_the_dockerfile_writes() {
        let temp = tempfile::tempdir().unwrap();
        let plan = plan_for(&temp);
        stage_unpacked_image(&plan, "kernel", "initrd");

        super::install_kernel_boot_artifacts(&plan).unwrap();

        assert_eq!(
            std::fs::read_to_string(&plan.paths.kernel_path).unwrap(),
            "kernel"
        );
        assert_eq!(
            std::fs::read_to_string(&plan.paths.initrd_path).unwrap(),
            "initrd"
        );
        // The base image keeps its own copies, and every other byte is untouched.
        assert_eq!(
            std::fs::read_to_string(in_image_path(&plan, "/boot/vmlinuz-6.12.96-intar-cutover"))
                .unwrap(),
            "kernel"
        );
        assert_eq!(
            std::fs::read_to_string(in_image_path(
                &plan,
                "/boot/initrd.img-6.12.96-intar-cutover"
            ))
            .unwrap(),
            "initrd"
        );
        assert!(in_image_path(&plan, "/usr/lib/intar/kernel/kernel-build.json").is_file());
        assert!(in_image_path(&plan, "/etc/hostname").is_file());
    }

    #[test]
    fn a_missing_image_artifact_fails_the_build() {
        for missing in [
            "/boot/vmlinuz-6.12.96-intar-cutover",
            "/boot/initrd.img-6.12.96-intar-cutover",
            "/usr/lib/intar/kernel/kernel-build.json",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let plan = plan_for(&temp);
            stage_unpacked_image(&plan, "kernel", "initrd");
            std::fs::remove_file(in_image_path(&plan, missing)).unwrap();

            let error = super::install_kernel_boot_artifacts(&plan).unwrap_err();

            assert!(
                format!("{error:#}").contains("the built image has no file"),
                "{missing}"
            );
        }
    }

    #[test]
    fn an_empty_or_symlinked_image_artifact_fails_the_build() {
        for empty in [
            "/boot/vmlinuz-6.12.96-intar-cutover",
            "/boot/initrd.img-6.12.96-intar-cutover",
            "/usr/lib/intar/kernel/kernel-build.json",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let plan = plan_for(&temp);
            stage_unpacked_image(&plan, "kernel", "initrd");
            std::fs::write(in_image_path(&plan, empty), "").unwrap();

            let error = super::install_kernel_boot_artifacts(&plan).unwrap_err();

            assert!(
                format!("{error:#}").contains("not a non-empty regular file"),
                "{empty}"
            );
        }

        // A symlink is not an artifact, whatever it points at.
        let temp = tempfile::tempdir().unwrap();
        let plan = plan_for(&temp);
        stage_unpacked_image(&plan, "kernel", "initrd");
        let path = in_image_path(&plan, "/boot/vmlinuz-6.12.96-intar-cutover");
        let target = in_image_path(&plan, "/boot/initrd.img-6.12.96-intar-cutover");
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();

        let error = super::install_kernel_boot_artifacts(&plan).unwrap_err();

        assert!(format!("{error:#}").contains("not a non-empty regular file"));
    }

    #[test]
    fn ext4_image_size_has_headroom_and_minimum() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("small"), "content").unwrap();

        let size = super::ext4_image_size_bytes(temp.path()).unwrap();

        assert_eq!(size, 384 * 1024 * 1024);
    }
}
