//! The platform base `trixie` of guest contract 3 (#309 §4.1, #311 §6.1):
//! the BuildKit rootfs of the old base with exactly one intar unit, the
//! guest loader, the learner's links to the run disk's Kino and the T2
//! masks. No supervisor, runtime asset, Kino or tools-disk mount is baked:
//! everything of a run comes from the run disk.
//!
//! It is a variant beside the old base: its definition hash also holds
//! [`IMAGE_FORMAT`] and `build_key("trixie")`, so both build and cache side
//! by side.

use anyhow::Result;
use intar_contracts::guest::{GUEST_LOADER_PATH, GUEST_USERNAME, KINO_FILENAME, RUN_DISK_MOUNT};
use intar_contracts::oci::IMAGE_FORMAT;
use intar_contracts::scenario::{PLATFORM_BASE_IMAGE, base_key};
use intar_image_scenario::BaseImageSpec;

use crate::config::QemuBuildConfig;
use crate::rootfs::{
    BaseRootfsArtifact, INTAR_ACPI_EVENT_PATH, INTAR_ACPI_EVENT_RULE, INTAR_ACPI_POWEROFF_PATH,
    INTAR_ACPI_POWEROFF_SCRIPT, MASKED_UNITS, RootfsBuildPlan, render_build_start_script,
    render_essential_hook, render_intar_build_service, rootfs_build_paths,
};
use crate::sha256::sha256_bytes_hex;

/// The smallest build geometry: the base image at its published size.
pub const PLATFORM_BASE_DISK_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The one intar unit (#309 §4.1).
pub(crate) const GUEST_UNIT: &str = "[Unit]
Description=Intar guest
After=local-fs.target
[Service]
Type=exec
ExecStart=/usr/lib/intar/guest-loader
Restart=no
FailureAction=poweroff-force
[Install]
WantedBy=multi-user.target
";

/// The loader (#309 §4.1). A build VM has the `INTARBUILD` seed at vdb, so
/// the loader exits 0 there.
pub(crate) const GUEST_LOADER: &str = r#"#!/bin/sh
# /usr/lib/intar/guest-loader: changes only with the guest contract
set -eu
i=0; while [ ! -b /dev/vdb ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
# a build VM boots this base with the INTARBUILD seed at vdb: not a run boot, nothing to do
[ "$(blkid -p -s LABEL -o value /dev/vdb 2>/dev/null)" = INTARRUN ] || exit 0
mkdir -p /run/intar/run
mount -t vfat -o ro,nosuid,nodev,fmask=0022,dmask=0022 /dev/vdb /run/intar/run
exec /run/intar/run/kino init
"#;

/// Started by Kino once the lab is released; `defer` units are its wants.
pub(crate) const LAB_TARGET: &str = "[Unit]\nDescription=Intar lab\n";

/// The T2 V1 masks: units that do nothing on this kernel and this VM.
pub(crate) const T2_MASKED_UNITS: &[&str] = &[
    "systemd-timesyncd.service",
    "modprobe@.service",
    "systemd-modules-load.service",
    "dev-hugepages.mount",
    "sys-kernel-debug.mount",
    "sys-kernel-tracing.mount",
    "systemd-binfmt.service",
];

/// Links into the run disk, dangling until it mounts.
pub(crate) const RUN_DISK_LINKS: &[&str] = &["intar", "kino", "kino-shell"];

/// The learner's sshd: every session of `user` runs through the recorder.
pub(crate) const LEARNER_SSHD_CONFIG: &str = "Match User user
    ForceCommand /usr/local/bin/kino-shell
Match all
";

/// The build-only sshd reads this file instead of `sshd_config`, so the
/// learner's `ForceCommand` never applies to the builder. Finalize removes it.
pub(crate) const BUILD_SSHD_CONFIG_PATH: &str = "/etc/ssh/intar-build-sshd_config";
const BUILD_SSHD_CONFIG: &str = "HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
";

pub(crate) const COMPLETION_PATH: &str = "/usr/share/intar/completions/intar.bash";
/// Bash completion of the run CLI, sourced from `bash.bashrc` because the
/// recorder starts bash with `-i`.
const COMPLETION: &str = r#"# Bash completion for the Intar run CLI.
_intar_complete() {
  local cur candidate candidates
  cur="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  if (( COMP_CWORD == 1 )); then
    COMPREPLY=( $(compgen -W 'status check hints hint solution help' -- "$cur") )
    return 0
  fi
  case "${COMP_WORDS[1]:-}" in
    solution)
      if (( COMP_CWORD == 2 )); then
        COMPREPLY=( $(compgen -W 'reveal' -- "$cur") )
      fi
      ;;
    hint)
      if (( COMP_CWORD == 2 )); then
        candidates="$(/usr/bin/timeout --signal=KILL 0.25s '/usr/local/bin/intar' __complete "$COMP_CWORD" "${COMP_WORDS[@]}" 2>/dev/null)" || return 0
        while IFS= read -r candidate; do
          [[ "$candidate" =~ ^[a-z0-9][a-z0-9-]*$ ]] || continue
          [[ "$candidate" == "$cur"* ]] || continue
          COMPREPLY+=("$candidate")
        done <<<"$candidates"
      fi
      ;;
  esac
}
complete -F _intar_complete intar
"#;

/// The packages of the base: those of `content/scenarios/base-images.hcl`.
const PACKAGES: &[&str] = &[
    "acpid",
    "openssh-server",
    "ca-certificates",
    "curl",
    "iproute2",
    "e2fsprogs",
    "kmod",
    "systemd-sysv",
    "udev",
    "sudo",
];

/// The Debian side of the base.
#[must_use]
pub fn platform_base_spec() -> BaseImageSpec {
    BaseImageSpec {
        name: PLATFORM_BASE_IMAGE.to_owned(),
        suite: "trixie".to_owned(),
        mirror: "https://deb.debian.org/debian".to_owned(),
        arch: "amd64".to_owned(),
        packages: PACKAGES.iter().map(|&package| package.to_owned()).collect(),
    }
}

/// The OCI build plan of the base.
#[must_use]
pub fn render_platform_rootfs_plan(config: &QemuBuildConfig) -> RootfsBuildPlan {
    let base = platform_base_spec();
    let essential_hook = render_essential_hook();
    let customize_hook = render_platform_customize_hook();
    let layered =
        crate::oci::layered_definition_hash(&base, &essential_hook, &customize_hook, config);
    let definition_hash = sha256_bytes_hex(
        format!(
            "{layered}\nimage_format={IMAGE_FORMAT}\nbuild_key={}",
            base_key().as_str()
        )
        .as_bytes(),
    );
    let paths = rootfs_build_paths(&base, config, &definition_hash);
    RootfsBuildPlan {
        definition_hash,
        paths,
        essential_hook,
        customize_hook,
    }
}

/// Reuse or build the base's ext4, kernel and initrd.
///
/// # Errors
/// Returns an error when the BuildKit build or the ext4 assembly fails.
pub fn ensure_platform_base(config: &QemuBuildConfig) -> Result<BaseRootfsArtifact> {
    let plan = render_platform_rootfs_plan(config);
    crate::oci::ensure_oci_base_rootfs(&platform_base_spec(), config, &plan)
}

fn render_platform_customize_hook() -> String {
    let masks = MASKED_UNITS
        .iter()
        .chain(T2_MASKED_UNITS)
        .map(|unit| format!("systemctl --root=\"$root\" mask {unit} >/dev/null\n"))
        .collect::<String>();
    let links = RUN_DISK_LINKS
        .iter()
        .map(|name| {
            format!("ln -sfn {RUN_DISK_MOUNT}/{KINO_FILENAME} \"$root/usr/local/bin/{name}\"\n")
        })
        .collect::<String>();
    let build_service = render_intar_build_service();
    let build_start_script = render_build_start_script(
        GUEST_USERNAME,
        &format!("  -f {BUILD_SSHD_CONFIG_PATH} \\\n"),
    );
    format!(
        r#"#!/bin/sh
set -eu
root="$1"
mkdir -p "$root/etc/acpi/events" "$root/etc/pam.d" "$root/etc/systemd/journald.conf.d" "$root/etc/ssh/sshd_config.d" "$root/etc/systemd/system/ssh.service.d" "$root/usr/local/sbin" "$root/usr/local/bin" "$root/usr/lib/intar" "$root/usr/share/intar/completions"
cat > "$root{INTAR_ACPI_EVENT_PATH}" <<'EOF_INTAR_ACPI_EVENT'
{INTAR_ACPI_EVENT_RULE}EOF_INTAR_ACPI_EVENT
cat > "$root{INTAR_ACPI_POWEROFF_PATH}" <<'EOF_INTAR_ACPI_POWEROFF'
{INTAR_ACPI_POWEROFF_SCRIPT}EOF_INTAR_ACPI_POWEROFF
chmod 0644 "$root{INTAR_ACPI_EVENT_PATH}"
chmod 0755 "$root{INTAR_ACPI_POWEROFF_PATH}"
systemctl --root="$root" enable acpid.service >/dev/null
cat > "$root/etc/systemd/journald.conf.d/90-intar-volatile.conf" <<'EOF'
[Journal]
Storage=volatile
EOF
cat > "$root/etc/ssh/sshd_config.d/90-intar.conf" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
HostKey /etc/ssh/ssh_host_ed25519_key
EOF
cat > "$root/etc/ssh/sshd_config.d/91-intar-learner.conf" <<'EOF'
{LEARNER_SSHD_CONFIG}EOF
cat > "$root/etc/systemd/system/ssh.service.d/10-intar-gate.conf" <<'EOF'
[Unit]
ConditionPathExists=/run/intar/ssh-ready
EOF
chroot "$root" useradd -m -s /bin/bash -G sudo {GUEST_USERNAME}
echo '{GUEST_USERNAME} ALL=(ALL) NOPASSWD:ALL' > "$root/etc/sudoers.d/90-intar"
chmod 0440 "$root/etc/sudoers.d/90-intar"
systemctl --root="$root" disable ssh.service >/dev/null
ssh_socket_state="$(systemctl --root="$root" is-enabled ssh.socket 2>/dev/null || true)"
case "$ssh_socket_state" in
  enabled|enabled-runtime) systemctl --root="$root" disable ssh.socket >/dev/null ;;
  alias|disabled|masked|not-found|static|"") ;;
  *) echo "unsafe ssh.socket enablement state: $ssh_socket_state" >&2; exit 1 ;;
esac
systemctl --root="$root" mask ssh.socket >/dev/null
ssh_service_state="$(systemctl --root="$root" is-enabled ssh.service 2>/dev/null || true)"
case "$ssh_service_state" in
  disabled|not-found|static) ;;
  *) echo "failed to disable ssh.service: $ssh_service_state" >&2; exit 1 ;;
esac
cat > "$root{GUEST_UNIT_PATH}" <<'EOF'
{GUEST_UNIT}EOF
cat > "$root{GUEST_LOADER_PATH}" <<'EOF'
{GUEST_LOADER}EOF
chmod 0755 "$root{GUEST_LOADER_PATH}"
systemctl --root="$root" enable intar.service >/dev/null
cat > "$root/etc/systemd/system/intar-lab.target" <<'EOF'
{LAB_TARGET}EOF
{links}cat > "$root{COMPLETION_PATH}" <<'EOF'
{COMPLETION}EOF
chmod 0644 "$root{COMPLETION_PATH}"
cat >> "$root/etc/bash.bashrc" <<'EOF'

# Intar run CLI completion for interactive SSH sessions.
if [ -r {COMPLETION_PATH} ]; then
  . {COMPLETION_PATH}
fi
EOF
cat > "$root/etc/pam.d/intar-build" <<'EOF'
#%PAM-1.0
# The build-only sshd authenticates with a public key; pam_unix keeps the
# policy fail-closed if that ever drifts.
auth required pam_unix.so
account required pam_permit.so
password required pam_deny.so
session required pam_permit.so
EOF
chmod 0644 "$root/etc/pam.d/intar-build"
cat > "$root{BUILD_SSHD_CONFIG_PATH}" <<'EOF'
{BUILD_SSHD_CONFIG}EOF
cat > "$root/etc/systemd/system/intar-build.service" <<'EOF'
{build_service}
EOF
cat > "$root/usr/local/sbin/intar-build-start" <<'EOF'
{build_start_script}
EOF
chmod 0755 "$root/usr/local/sbin/intar-build-start"
cat > "$root/etc/systemd/system/intar-build.path" <<'EOF'
[Unit]
Description=Intar image build seed activation

[Path]
PathExists=/dev/disk/by-label/INTARBUILD
Unit=intar-build.service

[Install]
WantedBy=multi-user.target
EOF
ln -sf /etc/systemd/system/intar-build.path "$root/etc/systemd/system/multi-user.target.wants/intar-build.path"
systemctl --root="$root" set-default multi-user.target >/dev/null
{masks}"#
    )
}

const GUEST_UNIT_PATH: &str = "/etc/systemd/system/intar.service";

/// Files finalize removes: the build bootstrap, its PAM file and its sshd
/// config.
pub(crate) const BUILD_BOOTSTRAP_FILES: &[&str] = &[
    "/etc/systemd/system/intar-build.service",
    "/etc/systemd/system/intar-build.path",
    "/etc/systemd/system/multi-user.target.wants/intar-build.path",
    "/usr/local/sbin/intar-build-start",
    "/etc/pam.d/intar-build",
    BUILD_SSHD_CONFIG_PATH,
];

#[cfg(test)]
mod tests {
    use super::*;

    fn hook() -> String {
        render_platform_customize_hook()
    }

    /// The text between `cat > "$root<path>" <<'EOF'` and its `EOF`.
    fn written(hook: &str, path: &str) -> String {
        let start = format!("cat > \"$root{path}\" <<'EOF'\n");
        let at = hook.find(&start).map(|at| at + start.len());
        let Some(at) = at else {
            panic!("{path} is not written")
        };
        let end = hook[at..].find("EOF\n").map_or(hook.len(), |end| at + end);
        hook[at..end].to_owned()
    }

    #[test]
    fn the_unit_and_the_loader_are_309s() {
        let hook = hook();
        assert_eq!(written(&hook, GUEST_UNIT_PATH), GUEST_UNIT);
        assert_eq!(written(&hook, GUEST_LOADER_PATH), GUEST_LOADER);
        assert!(GUEST_UNIT.contains("ExecStart=/usr/lib/intar/guest-loader\n"));
        assert!(GUEST_UNIT.contains("FailureAction=poweroff-force\n"));
        assert!(GUEST_LOADER.contains(
            "[ \"$(blkid -p -s LABEL -o value /dev/vdb 2>/dev/null)\" = INTARRUN ] || exit 0\n"
        ));
        assert!(GUEST_LOADER.ends_with("exec /run/intar/run/kino init\n"));
        assert!(hook.contains("systemctl --root=\"$root\" enable intar.service"));
        assert_eq!(
            written(&hook, "/etc/systemd/system/intar-lab.target"),
            LAB_TARGET
        );
    }

    #[test]
    fn the_learner_tools_link_to_the_run_disk() {
        let hook = hook();
        for name in ["intar", "kino", "kino-shell"] {
            assert!(hook.contains(&format!(
                "ln -sfn /run/intar/run/kino \"$root/usr/local/bin/{name}\"\n"
            )));
        }
        assert!(written(&hook, COMPLETION_PATH).contains("complete -F _intar_complete intar"));
        assert!(hook.contains("useradd -m -s /bin/bash -G sudo user\n"));
        assert!(
            written(&hook, "/etc/ssh/sshd_config.d/91-intar-learner.conf")
                .contains("Match User user\n    ForceCommand /usr/local/bin/kino-shell\n")
        );
        assert!(hook.contains("ConditionPathExists=/run/intar/ssh-ready"));
    }

    #[test]
    fn the_t2_masks_join_the_old_ones() {
        let hook = hook();
        for unit in MASKED_UNITS.iter().chain(T2_MASKED_UNITS) {
            assert!(
                hook.contains(&format!("mask {unit} >/dev/null\n")),
                "{unit}"
            );
        }
        assert!(hook.contains("mask systemd-timesyncd.service"));
        assert!(hook.contains("mask modprobe@.service"));
    }

    #[test]
    fn nothing_of_the_old_runtime_is_baked() {
        let hook = hook();
        for gone in [
            "intar-scenario",
            "supervisor",
            "kino.hcl",
            "INTARTOOLS",
            "intar-tools",
            "runtime.env",
            "ubuntu",
            "/etc/kino",
        ] {
            assert!(!hook.contains(gone), "{gone}");
        }
        // The builder logs in as `user` through its own sshd config, so the
        // learner's ForceCommand never applies to it.
        let start = written(&hook, "/usr/local/sbin/intar-build-start");
        assert!(start.contains("/home/user/.ssh/authorized_keys"));
        assert!(start.contains(&format!("  -f {BUILD_SSHD_CONFIG_PATH} \\\n")));
        for file in BUILD_BOOTSTRAP_FILES {
            assert!(hook.contains(file), "{file}");
        }
    }

    #[test]
    fn the_hook_is_valid_sh_and_the_plan_is_its_own() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("hook");
        std::fs::write(&path, hook()).expect("write");
        let syntax = std::process::Command::new("sh")
            .arg("-n")
            .arg(&path)
            .output()
            .expect("sh");
        assert!(
            syntax.status.success(),
            "{}",
            String::from_utf8_lossy(&syntax.stderr)
        );
        let config = QemuBuildConfig::default();
        let plan = render_platform_rootfs_plan(&config);
        let old = crate::rootfs::render_rootfs_build_plan(&platform_base_spec(), &config);
        assert_ne!(plan.definition_hash, old.definition_hash);
        assert_ne!(plan.paths.base_ext4_path, old.paths.base_ext4_path);
        assert_eq!(
            plan.definition_hash,
            render_platform_rootfs_plan(&config).definition_hash
        );
    }
}
