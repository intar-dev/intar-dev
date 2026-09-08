use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use intar_image_scenario::BaseImageSpec;

use crate::config::QemuBuildConfig;

const INITRAMFS_MODULES: &[&str] = &[
    "virtio_blk",
    "virtio_pci",
    "virtio_net",
    "virtio_console",
    "vmw_vsock_virtio_transport",
    "ext4",
    "crc32c",
];

pub(crate) const BASE_EXT4_LABEL: &str = "INTARROOT";

pub(crate) const BASE_RUNTIME_MODULES: &[&str] = &["nf_tables"];
pub(crate) const KUBERNETES_RUNTIME_MODULES: &[&str] = &["overlay", "br_netfilter", "vxlan"];

// QMP system_powerdown injects this ACPI event, but the minimal image has no
// D-Bus-backed logind consumer. Bash resolves the libc-relative RTMIN+4 name;
// Dash and procps kill do not. Systemd PID 1 maps that signal to poweroff.target.
pub(crate) const INTAR_ACPI_EVENT_PATH: &str = "/etc/acpi/events/90-intar-power-button";
pub(crate) const INTAR_ACPI_POWEROFF_PATH: &str = "/usr/local/sbin/intar-acpi-poweroff";
pub(crate) const INTAR_ACPI_EVENT_RULE: &str =
    "event=button[ /]power\naction=/usr/local/sbin/intar-acpi-poweroff\n";
pub(crate) const INTAR_ACPI_POWEROFF_SCRIPT: &str = "#!/bin/bash\nset -eu\nkill -s RTMIN+4 1\n";

const MASKED_UNITS: &[&str] = &[
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
    pub(crate) lease: Arc<BaseRootfsLease>,
}

/// Reuse or build an OCI-imported base rootfs artifact.
///
/// # Errors
/// Returns an error if the base rootfs cannot be generated or required boot artifacts are missing.
pub fn ensure_base_rootfs(
    base: &BaseImageSpec,
    config: &QemuBuildConfig,
) -> Result<BaseRootfsArtifact> {
    let plan = render_rootfs_build_plan(base, config);
    crate::oci::ensure_oci_base_rootfs(base, config, &plan)
}

/// Render the OCI rootfs build plan for a base image definition.
#[must_use]
pub fn render_rootfs_build_plan(base: &BaseImageSpec, config: &QemuBuildConfig) -> RootfsBuildPlan {
    let essential_hook = render_essential_hook();
    let build_service = render_intar_build_service();
    let build_start_script = render_intar_build_start_script();
    let customize_hook = render_customize_hook(&build_service, &build_start_script);
    let definition_hash =
        crate::oci::layered_definition_hash(base, &essential_hook, &customize_hook, config);
    let paths = rootfs_build_paths(base, config, &definition_hash);

    RootfsBuildPlan {
        definition_hash,
        paths,
        essential_hook,
        customize_hook,
    }
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
        lease,
    }
}

pub(crate) fn extract_boot_artifacts(plan: &RootfsBuildPlan) -> Result<()> {
    let boot_dir = plan.paths.rootfs_dir.join("boot");
    let artifacts = find_boot_artifact_pair(&boot_dir)?;
    fs::copy(&artifacts.kernel_path, &plan.paths.kernel_path).with_context(|| {
        format!(
            "failed to copy kernel '{}' to '{}'",
            artifacts.kernel_path.display(),
            plan.paths.kernel_path.display()
        )
    })?;
    fs::copy(&artifacts.initrd_path, &plan.paths.initrd_path).with_context(|| {
        format!(
            "failed to copy initrd '{}' to '{}'",
            artifacts.initrd_path.display(),
            plan.paths.initrd_path.display()
        )
    })?;
    for entry in fs::read_dir(&boot_dir)
        .with_context(|| format!("failed to read boot directory '{}'", boot_dir.display()))?
    {
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            fs::remove_dir_all(&path)
                .with_context(|| format!("failed to remove '{}'", path.display()))?;
        } else {
            fs::remove_file(&path)
                .with_context(|| format!("failed to remove '{}'", path.display()))?;
        }
    }
    Ok(())
}

struct BootArtifactPair {
    kernel_path: PathBuf,
    initrd_path: PathBuf,
}

fn find_boot_artifact_pair(boot_dir: &Path) -> Result<BootArtifactPair> {
    let kernels = boot_artifacts_by_version(boot_dir, "vmlinuz-")?;
    let initrds = boot_artifacts_by_version(boot_dir, "initrd.img-")?;
    let version = kernels
        .keys()
        .rfind(|version| initrds.contains_key(*version))
        .with_context(|| {
            format!(
                "missing matching vmlinuz/initrd boot artifacts in '{}'",
                boot_dir.display()
            )
        })?;

    Ok(BootArtifactPair {
        kernel_path: kernels[version].clone(),
        initrd_path: initrds[version].clone(),
    })
}

fn boot_artifacts_by_version(boot_dir: &Path, prefix: &str) -> Result<BTreeMap<String, PathBuf>> {
    let mut matches = BTreeMap::new();
    for entry in fs::read_dir(boot_dir)
        .with_context(|| format!("failed to read boot directory '{}'", boot_dir.display()))?
    {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if let Some(version) = name.strip_prefix(prefix) {
            let version = version.trim();
            if !version.is_empty() {
                matches.insert(version.to_string(), path);
            }
        }
    }
    Ok(matches)
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

fn rootfs_build_paths(
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

fn render_essential_hook() -> String {
    let module_lines = INITRAMFS_MODULES.join(" ");
    format!(
        r#"#!/bin/sh
set -eu
root="$1"
# BuildKit binds /etc/hostname and /etc/hosts read-only while this hook runs.
# The OCI importer writes the neutral VM files after umoci unpack.
mkdir -p "$root/etc/dpkg/dpkg.cfg.d" "$root/etc/initramfs-tools/conf.d"
cat > "$root/etc/dpkg/dpkg.cfg.d/01intar-path-excludes" <<'EOF'
path-exclude=/usr/share/doc/*
path-exclude=/usr/share/man/*
path-exclude=/usr/share/info/*
path-exclude=/usr/share/locale/*
EOF
# Conffiles pre-seeded by this hook (e.g. initramfs.conf) must win over the
# package defaults; without this dpkg raises an interactive conffile prompt
# and non-interactive package configuration fails.
cat > "$root/etc/dpkg/dpkg.cfg.d/02intar-conffile-policy" <<'EOF'
force-confold
EOF
cat > "$root/etc/initramfs-tools/initramfs.conf" <<'EOF'
MODULES=list
COMPRESS=zstd
EOF
cat > "$root/etc/initramfs-tools/conf.d/resume" <<'EOF'
RESUME=none
EOF
cat > "$root/etc/initramfs-tools/modules" <<'EOF'
{module_lines}
EOF
"#
    )
}

fn render_customize_hook(build_service: &str, build_start_script: &str) -> String {
    // The generic build rootfs may provision either kind of scenario, so make
    // every module available during the image build. The scenario provisioner
    // rewrites this file for the final guest and keeps the Kubernetes-only
    // modules only when that VM actually uses Kubernetes actions or probes.
    let runtime_module_lines = BASE_RUNTIME_MODULES
        .iter()
        .chain(KUBERNETES_RUNTIME_MODULES)
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    let intar_acpi_event_path = INTAR_ACPI_EVENT_PATH;
    let intar_acpi_poweroff_path = INTAR_ACPI_POWEROFF_PATH;
    let intar_acpi_event_rule = INTAR_ACPI_EVENT_RULE;
    let intar_acpi_poweroff_script = INTAR_ACPI_POWEROFF_SCRIPT;
    let masked_units = MASKED_UNITS
        .iter()
        .map(|unit| format!("systemctl --root=\"$root\" mask {unit} >/dev/null 2>&1 || true"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"#!/bin/sh
set -eu
root="$1"
mkdir -p "$root/etc/acpi/events" "$root/etc/modules-load.d" "$root/etc/pam.d" "$root/etc/systemd/journald.conf.d" "$root/etc/ssh/sshd_config.d" "$root/etc/systemd/system/ssh.service.d" "$root/usr/local/sbin"
cat > "$root{intar_acpi_event_path}" <<'EOF_INTAR_ACPI_EVENT'
{intar_acpi_event_rule}EOF_INTAR_ACPI_EVENT
cat > "$root{intar_acpi_poweroff_path}" <<'EOF_INTAR_ACPI_POWEROFF'
{intar_acpi_poweroff_script}EOF_INTAR_ACPI_POWEROFF
chown root:root "$root{intar_acpi_event_path}" "$root{intar_acpi_poweroff_path}"
chmod 0644 "$root{intar_acpi_event_path}"
chmod 0755 "$root{intar_acpi_poweroff_path}"
systemctl --root="$root" enable acpid.service >/dev/null
cat > "$root/etc/modules-load.d/90-intar-runtime.conf" <<'EOF'
{runtime_module_lines}
EOF
cat > "$root/etc/systemd/journald.conf.d/90-intar-volatile.conf" <<'EOF'
[Journal]
Storage=volatile
EOF
cat > "$root/etc/ssh/sshd_config.d/90-intar-build.conf" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
HostKey /etc/ssh/ssh_host_ed25519_key
EOF
cat > "$root/etc/pam.d/intar-build" <<'EOF'
#%PAM-1.0
# Authentication is fixed to publickey by the build-only sshd. pam_unix keeps
# this policy fail-closed if that daemon's authentication method ever drifts.
auth required pam_unix.so
# The ephemeral daemon starts before the normal login stack, so its locked
# build account must not inherit boot/session gates such as pam_nologin.
account required pam_permit.so
password required pam_deny.so
session required pam_permit.so
EOF
chmod 0644 "$root/etc/pam.d/intar-build"
cat > "$root/etc/systemd/system/ssh.service.d/10-intar-gate.conf" <<'EOF'
[Unit]
ConditionPathExists=/run/intar/ssh-ready
EOF
chroot "$root" useradd -m -s /bin/bash -G sudo ubuntu
echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > "$root/etc/sudoers.d/90-intar-build"
chmod 0440 "$root/etc/sudoers.d/90-intar-build"
# The build bootstrap owns port 22 until the scenario image is finalized.
# Do not let the distribution ssh unit race it before the ephemeral key and
# static QEMU network have been installed. The condition also blocks activation
# through systemd-ssh-generator's transient sshd-unix-local.socket.
systemctl --root="$root" disable ssh.service >/dev/null
ssh_socket_state="$(systemctl --root="$root" is-enabled ssh.socket 2>/dev/null || true)"
case "$ssh_socket_state" in
  enabled|enabled-runtime) systemctl --root="$root" disable ssh.socket >/dev/null ;;
  alias|disabled|masked|not-found|static|"") ;;
  *) echo "unsafe build ssh.socket enablement state: $ssh_socket_state" >&2; exit 1 ;;
esac
ssh_service_state="$(systemctl --root="$root" is-enabled ssh.service 2>/dev/null || true)"
case "$ssh_service_state" in
  disabled|not-found|static) ;;
  *) echo "failed to disable build ssh.service: $ssh_service_state" >&2; exit 1 ;;
esac
sshd_service_state="$(systemctl --root="$root" is-enabled sshd.service 2>/dev/null || true)"
case "$sshd_service_state" in
  alias|disabled|not-found|static) ;;
  *) echo "unsafe build sshd.service enablement state: $sshd_service_state" >&2; exit 1 ;;
esac
cat > "$root/etc/systemd/system/intar-build.service" <<'EOF'
{build_service}
EOF
cat > "$root/usr/local/sbin/intar-build-start" <<'EOF'
{build_start_script}
EOF
chmod 0755 "$root/usr/local/sbin/intar-build-start"
ln -sf /etc/systemd/system/intar-build.service "$root/etc/systemd/system/multi-user.target.wants/intar-build.service"
{masked_units}
"#
    )
}

fn render_intar_build_service() -> String {
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

fn render_intar_build_start_script() -> String {
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

install -d -m 0700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
install -m 0600 -o ubuntu -g ubuntu /run/intar-build/authorized_keys /home/ubuntu/.ssh/authorized_keys
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
  ssh-keygen -q -N '' -t ed25519 -f /etc/ssh/ssh_host_ed25519_key
fi
install -d -o root -g root -m 0755 /run/sshd
set -- \
  -o UsePAM=yes \
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
    .to_string()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use intar_image_scenario::BaseImageCatalog;

    use super::{
        BASE_RUNTIME_MODULES, KUBERNETES_RUNTIME_MODULES, MASKED_UNITS, render_intar_build_service,
        render_intar_build_start_script, render_rootfs_build_plan,
    };
    use crate::config::QemuBuildConfig;

    fn base_image() -> intar_image_scenario::BaseImageSpec {
        let catalog = BaseImageCatalog::parse(
            r#"
base_image "trixie" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages       = ["acpid", "openssh-server", "ca-certificates", "curl", "iproute2", "e2fsprogs", "kmod", "systemd-sysv", "udev", "sudo"]
}
"#,
        )
        .unwrap();
        catalog.base_image_by_name("trixie").unwrap().clone()
    }

    #[test]
    fn rootfs_plan_contains_oci_inputs_and_stable_paths() {
        let config = QemuBuildConfig::default();
        let base = base_image();
        let plan = render_rootfs_build_plan(&base, &config);

        assert_eq!(plan.definition_hash.len(), 64);
        assert!(
            plan.paths
                .base_ext4_path
                .display()
                .to_string()
                .contains("trixie-amd64-")
        );
        assert!(plan.essential_hook.contains("BuildKit binds /etc/hostname"));
        assert!(plan.customize_hook.contains("intar-build.service"));
    }

    #[test]
    fn hooks_defer_buildkit_protected_host_files_until_oci_unpack() {
        let plan = render_rootfs_build_plan(&base_image(), &QemuBuildConfig::default());

        assert!(!plan.essential_hook.contains("> \"$root/etc/hostname\""));
        assert!(!plan.essential_hook.contains(">> \"$root/etc/hosts\""));

        let directory = tempfile::tempdir().unwrap();
        for (name, script) in [
            ("essential-hook", &plan.essential_hook),
            ("customize-hook", &plan.customize_hook),
        ] {
            let path = directory.path().join(name);
            std::fs::write(&path, script).unwrap();
            let output = std::process::Command::new("sh")
                .arg("-n")
                .arg(&path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn rootfs_hooks_install_fast_boot_build_environment() {
        let plan = render_rootfs_build_plan(&base_image(), &QemuBuildConfig::default());
        let build_service = render_intar_build_service();
        let build_start_script = render_intar_build_start_script();

        assert!(
            plan.essential_hook
                .contains("path-exclude=/usr/share/doc/*")
        );
        assert!(plan.essential_hook.contains("MODULES=list"));
        assert!(plan.essential_hook.contains("COMPRESS=zstd"));
        assert!(plan.essential_hook.contains("force-confold"));
        assert!(plan.essential_hook.contains("vmw_vsock_virtio_transport"));
        assert!(
            plan.essential_hook
                .contains("/etc/initramfs-tools/conf.d/resume")
        );
        assert!(plan.essential_hook.contains("RESUME=none"));
        assert!(!plan.essential_hook.contains("RESUME=/dev/"));
        assert!(!plan.essential_hook.contains("$root/etc/hostname"));
        assert!(!plan.essential_hook.contains("$root/etc/hosts"));
        assert!(plan.customize_hook.contains(
            "cat > \"$root/etc/acpi/events/90-intar-power-button\" <<'EOF_INTAR_ACPI_EVENT'"
        ));
        assert!(
            plan.customize_hook
                .contains("event=button[ /]power\naction=/usr/local/sbin/intar-acpi-poweroff")
        );
        assert!(plan.customize_hook.contains(
            "cat > \"$root/usr/local/sbin/intar-acpi-poweroff\" <<'EOF_INTAR_ACPI_POWEROFF'"
        ));
        assert!(
            plan.customize_hook
                .contains("#!/bin/bash\nset -eu\nkill -s RTMIN+4 1")
        );
        assert!(plan.customize_hook.contains(
            "chown root:root \"$root/etc/acpi/events/90-intar-power-button\" \"$root/usr/local/sbin/intar-acpi-poweroff\""
        ));
        assert!(
            plan.customize_hook
                .contains("chmod 0644 \"$root/etc/acpi/events/90-intar-power-button\"")
        );
        assert!(
            plan.customize_hook
                .contains("chmod 0755 \"$root/usr/local/sbin/intar-acpi-poweroff\"")
        );
        assert!(
            plan.customize_hook
                .contains("systemctl --root=\"$root\" enable acpid.service >/dev/null")
        );
        assert!(
            plan.customize_hook
                .contains("/etc/modules-load.d/90-intar-runtime.conf")
        );
        for module in BASE_RUNTIME_MODULES
            .iter()
            .chain(KUBERNETES_RUNTIME_MODULES)
        {
            assert!(plan.customize_hook.contains(module));
        }
        assert!(
            plan.customize_hook
                .contains("useradd -m -s /bin/bash -G sudo ubuntu")
        );
        assert!(plan.customize_hook.contains("Storage=volatile"));
        assert!(
            plan.customize_hook
                .contains("HostKey /etc/ssh/ssh_host_ed25519_key")
        );
        assert!(plan.customize_hook.contains(&build_service));
        assert!(plan.customize_hook.contains(&build_start_script));
        assert!(build_service.contains("After=local-fs.target"));
        assert!(!build_service.contains("systemd-udev-trigger.service"));
        assert!(build_service.contains("Before=multi-user.target"));
        assert!(build_service.contains("RuntimeDirectory=sshd"));
        assert!(build_service.contains("RuntimeDirectoryMode=0755"));
        assert!(build_service.contains("StandardError=journal+console"));
        assert!(
            plan.customize_hook
                .contains("ConditionPathExists=/run/intar/ssh-ready")
        );
        assert!(
            plan.customize_hook
                .contains("systemctl --root=\"$root\" disable ssh.service")
        );
        assert!(
            plan.customize_hook
                .contains("failed to disable build ssh.service")
        );
        assert!(
            plan.customize_hook
                .contains("unsafe build sshd.service enablement state")
        );
        assert!(!plan.customize_hook.contains("mask ssh.service"));
        assert!(!plan.customize_hook.contains("mask sshd.service"));
        assert!(build_start_script.contains("blkid -L INTARBUILD"));
        assert!(build_start_script.contains("mountpoint -q /run/intar-build"));
        assert!(build_start_script.contains("findmnt -n -o SOURCE --target /run/intar-build"));
        assert!(build_start_script.contains("INTAR_BUILD_IP:-10.0.2.15/24"));
        assert!(build_start_script.contains("/sys/class/net/*"));
        assert!(build_start_script.contains("no non-loopback network interface found"));
        assert!(build_start_script.contains("ip link set \"$iface\" up 2>&1"));
        assert!(build_start_script.contains("ip addr replace"));
        assert!(build_start_script.contains("timed out configuring build network"));
        assert!(build_start_script.contains("install -d -o root -g root -m 0755 /run/sshd"));
        assert!(
            plan.customize_hook
                .contains("cat > \"$root/etc/pam.d/intar-build\"")
        );
        assert!(plan.customize_hook.contains("auth required pam_unix.so"));
        assert!(
            plan.customize_hook
                .contains("account required pam_permit.so")
        );
        assert!(
            plan.customize_hook
                .contains("password required pam_deny.so")
        );
        assert!(
            plan.customize_hook
                .contains("session required pam_permit.so")
        );
        assert!(
            plan.customize_hook
                .contains("chmod 0644 \"$root/etc/pam.d/intar-build\"")
        );
        assert!(build_start_script.contains("/usr/sbin/sshd -t \"$@\""));
        assert!(build_start_script.contains("-o UsePAM=yes"));
        assert!(build_start_script.contains("-o PAMServiceName=intar-build"));
        assert!(build_start_script.contains("-o AuthenticationMethods=publickey"));
        assert!(!build_start_script.contains("-o UsePAM=no"));
        assert!(build_start_script.contains("-o PerSourcePenalties=no"));
        assert!(build_start_script.contains("-o MaxStartups=100:30:200"));
        assert!(build_start_script.contains("ssh-keygen -q -N '' -t ed25519"));
        let install_key = build_start_script
            .find("/run/intar-build/authorized_keys")
            .unwrap();
        let configure_network = build_start_script.rfind("\nconfigure_network\n").unwrap();
        let start_sshd = build_start_script
            .find("exec /usr/sbin/sshd -D -e")
            .unwrap();
        assert!(install_key < configure_network);
        assert!(configure_network < start_sshd);

        let directory = tempfile::tempdir().unwrap();
        let script_path = directory.path().join("intar-build-start");
        std::fs::write(&script_path, &build_start_script).unwrap();
        let syntax = std::process::Command::new("sh")
            .arg("-n")
            .arg(&script_path)
            .output()
            .unwrap();
        assert!(
            syntax.status.success(),
            "{}",
            String::from_utf8_lossy(&syntax.stderr)
        );
        let customize_path = directory.path().join("customize-hook");
        std::fs::write(&customize_path, &plan.customize_hook).unwrap();
        let customize_syntax = std::process::Command::new("sh")
            .arg("-n")
            .arg(&customize_path)
            .output()
            .unwrap();
        assert!(
            customize_syntax.status.success(),
            "{}",
            String::from_utf8_lossy(&customize_syntax.stderr)
        );
        for unit in MASKED_UNITS {
            assert!(plan.customize_hook.contains(&format!("mask {unit}")));
        }
    }

    #[test]
    fn extracts_boot_artifacts_and_removes_them_from_rootfs_tree() {
        let temp = tempfile::tempdir().unwrap();
        let config = QemuBuildConfig {
            output_root: temp.path().join("dist"),
            work_root: temp.path().join(".work"),
            ..QemuBuildConfig::default()
        };
        let plan = render_rootfs_build_plan(&base_image(), &config);
        let boot_dir = plan.paths.rootfs_dir.join("boot");
        std::fs::create_dir_all(&boot_dir).unwrap();
        std::fs::write(boot_dir.join("vmlinuz-6.12.1-cloud-amd64"), "kernel").unwrap();
        std::fs::write(boot_dir.join("initrd.img-6.12.1-cloud-amd64"), "initrd").unwrap();
        std::fs::write(boot_dir.join("config-6.12.1-cloud-amd64"), "config").unwrap();
        std::fs::create_dir_all(plan.paths.base_ext4_path.parent().unwrap()).unwrap();

        super::extract_boot_artifacts(&plan).unwrap();

        assert_eq!(
            std::fs::read_to_string(&plan.paths.kernel_path).unwrap(),
            "kernel"
        );
        assert_eq!(
            std::fs::read_to_string(&plan.paths.initrd_path).unwrap(),
            "initrd"
        );
        assert_eq!(std::fs::read_dir(&boot_dir).unwrap().count(), 0);
    }

    #[test]
    fn extracts_latest_matching_kernel_and_initrd_pair() {
        let temp = tempfile::tempdir().unwrap();
        let config = QemuBuildConfig {
            output_root: temp.path().join("dist"),
            work_root: temp.path().join(".work"),
            ..QemuBuildConfig::default()
        };
        let plan = render_rootfs_build_plan(&base_image(), &config);
        let boot_dir = plan.paths.rootfs_dir.join("boot");
        std::fs::create_dir_all(&boot_dir).unwrap();
        std::fs::write(boot_dir.join("vmlinuz-6.12.1-cloud-amd64"), "kernel-old").unwrap();
        std::fs::write(boot_dir.join("initrd.img-6.12.1-cloud-amd64"), "initrd-old").unwrap();
        std::fs::write(boot_dir.join("vmlinuz-6.12.2-cloud-amd64"), "kernel-new").unwrap();
        std::fs::write(
            boot_dir.join("vmlinuz-6.12.3-cloud-amd64"),
            "kernel-unpaired",
        )
        .unwrap();
        std::fs::write(boot_dir.join("initrd.img-6.12.2-cloud-amd64"), "initrd-new").unwrap();
        std::fs::create_dir_all(plan.paths.base_ext4_path.parent().unwrap()).unwrap();

        super::extract_boot_artifacts(&plan).unwrap();

        assert_eq!(
            std::fs::read_to_string(&plan.paths.kernel_path).unwrap(),
            "kernel-new"
        );
        assert_eq!(
            std::fs::read_to_string(&plan.paths.initrd_path).unwrap(),
            "initrd-new"
        );
    }

    #[test]
    fn rejects_mismatched_kernel_and_initrd_versions() {
        let temp = tempfile::tempdir().unwrap();
        let config = QemuBuildConfig {
            output_root: temp.path().join("dist"),
            work_root: temp.path().join(".work"),
            ..QemuBuildConfig::default()
        };
        let plan = render_rootfs_build_plan(&base_image(), &config);
        let boot_dir = plan.paths.rootfs_dir.join("boot");
        std::fs::create_dir_all(&boot_dir).unwrap();
        std::fs::write(boot_dir.join("vmlinuz-6.12.2-cloud-amd64"), "kernel").unwrap();
        std::fs::write(boot_dir.join("initrd.img-6.12.1-cloud-amd64"), "initrd").unwrap();
        std::fs::create_dir_all(plan.paths.base_ext4_path.parent().unwrap()).unwrap();

        let error = super::extract_boot_artifacts(&plan).unwrap_err();

        assert!(format!("{error:#}").contains("missing matching vmlinuz/initrd"));
    }

    #[test]
    fn ext4_image_size_has_headroom_and_minimum() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("small"), "content").unwrap();

        let size = super::ext4_image_size_bytes(temp.path()).unwrap();

        assert_eq!(size, 384 * 1024 * 1024);
    }
}
