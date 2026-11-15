//! The commands the builder runs in a build VM. Only the lowered scripts of
//! the bundle reach the guest; everything else here is fixed text.

use std::collections::{BTreeMap, BTreeSet};

use intar_contracts::guest::GUEST_USERNAME;

use super::host::shell_quote;
use crate::platform::BUILD_BOOTSTRAP_FILES;

/// tmpfs: scripts never reach the image's disk.
pub(crate) const STAGE_DIR: &str = "/run/intar/build";
/// Where the scripts land before `install` moves them under [`STAGE_DIR`].
pub(crate) const UPLOAD_PATH: &str = "/tmp/intar-stage.sh";
const BOOT_FILES_PATH: &str = "/run/intar/boot-files";
const STAGE_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/// The repack target: the third virtio drive, attached from the first spawn.
pub(crate) const REPACK_DEVICE: &str = "/dev/vdc";

/// Record the base's `/boot` at the cold boot, for finalize's check.
pub(crate) fn record_boot_files() -> String {
    format!(
        "sudo sh -c {}",
        shell_quote(&format!(
            "set -eu\nmkdir -p /run/intar\nfind /boot -mindepth 1 -maxdepth 1 -printf '%P\\n' | sort > {BOOT_FILES_PATH}\n"
        ))
    )
}

/// The file of stage `index` under [`STAGE_DIR`].
pub(crate) fn stage_file(index: usize, name: &str) -> String {
    format!("{STAGE_DIR}/{index:02}-{name}.sh")
}

/// Move the uploaded script into place and run it as root with `bash -euo
/// pipefail` and nothing in its environment but `PATH`, `HOME` and `env`.
pub(crate) fn stage_command(file: &str, env: &BTreeMap<String, String>) -> String {
    let assignments: String = env
        .iter()
        .map(|(name, value)| format!(" {}", shell_quote(&format!("{name}={value}"))))
        .collect();
    let file = shell_quote(file);
    format!(
        "sudo install -d -m 0700 {STAGE_DIR} && sudo install -m 0700 {UPLOAD_PATH} {file} && rm -f {UPLOAD_PATH} && sudo /usr/bin/env -i PATH={STAGE_PATH} HOME=/root{assignments} /bin/bash -euo pipefail {file}"
    )
}

/// Make the image a run image: `defer` units wait for `intar-lab.target`,
/// and nothing of the build, no host key, no machine id and no cache stays.
pub(crate) fn finalize_script(defer: &BTreeSet<String>) -> String {
    let mut script = String::from("set -eu\n");
    for unit in defer {
        let unit = shell_quote(unit);
        script.push_str(&format!(
            "systemctl disable {unit}\nsystemctl add-wants intar-lab.target {unit}\n"
        ));
    }
    script.push_str(&format!(
        r#"systemctl disable intar-build.service intar-build.path >/dev/null 2>&1 || true
rm -f {bootstrap}
rm -f /home/{GUEST_USERNAME}/.ssh/authorized_keys /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
initial="$(cat {BOOT_FILES_PATH})"
final="$(find /boot -mindepth 1 -maxdepth 1 -printf '%P\n' | sort)"
if [ "$final" != "$initial" ]; then
  echo 'setup changed /boot; installing kernels is not supported' >&2
  printf 'before:\n%s\nafter:\n%s\n' "$initial" "$final" >&2
  exit 1
fi
rm -rf {STAGE_DIR} /var/lib/apt/lists/* /tmp/* /tmp/.[!.]* /var/tmp/*
apt-get clean
find /var/log -type f -exec truncate -s 0 {{}} +
sync
fstrim -v /
"#,
        bootstrap = BUILD_BOOTSTRAP_FILES.join(" "),
    ));
    script
}

/// Copy the finalized root into a fresh `INTARROOT` on [`REPACK_DEVICE`]
/// inside the guest: the host never mounts what a setup script wrote. The
/// bind mount shows `/` without `/proc`, `/sys`, `/dev` or `/run`.
pub(crate) fn repack_script() -> String {
    format!(
        r"set -eu
mkdir -p /run/intar/repack
mount --bind / /run/intar/repack
mke2fs -q -F -t ext4 -L {label} -d /run/intar/repack {REPACK_DEVICE}
umount /run/intar/repack
sync
",
        label = crate::rootfs::BASE_EXT4_LABEL,
    )
}

/// Run `script` as root.
pub(crate) fn as_root(script: &str) -> String {
    format!("sudo bash -c {}", shell_quote(script))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stage_runs_from_tmpfs_with_only_its_env() {
        let env = BTreeMap::from([("GREETING".to_owned(), "it's".to_owned())]);
        let command = stage_command(&stage_file(3, "packages"), &env);
        assert_eq!(stage_file(3, "packages"), "/run/intar/build/03-packages.sh");
        assert!(command.starts_with("sudo install -d -m 0700 /run/intar/build && "));
        assert!(command.contains(
            "sudo install -m 0700 /tmp/intar-stage.sh '/run/intar/build/03-packages.sh' && rm -f /tmp/intar-stage.sh"
        ));
        assert!(command.ends_with(
            "sudo /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root 'GREETING=it'\\''s' /bin/bash -euo pipefail '/run/intar/build/03-packages.sh'"
        ));
        let bare = stage_command(&stage_file(0, "x"), &BTreeMap::new());
        assert!(bare.contains("HOME=/root /bin/bash -euo pipefail"));
    }

    #[test]
    fn finalize_defers_units_and_removes_the_build() {
        let defer = BTreeSet::from(["nginx.service".to_owned(), "b.timer".to_owned()]);
        let script = finalize_script(&defer);
        let nginx = "systemctl disable 'nginx.service'\nsystemctl add-wants intar-lab.target 'nginx.service'\n";
        assert!(script.contains(nginx));
        assert!(script.find("'b.timer'") < script.find("'nginx.service'"));
        for removed in [
            "/etc/systemd/system/intar-build.service",
            "/etc/systemd/system/intar-build.path",
            "/usr/local/sbin/intar-build-start",
            "/etc/pam.d/intar-build",
            "/etc/ssh/intar-build-sshd_config",
            "/home/user/.ssh/authorized_keys",
            "/etc/ssh/ssh_host_*",
            "/var/lib/dbus/machine-id",
            "/run/intar/build",
            "/var/lib/apt/lists/*",
            "/tmp/*",
        ] {
            assert!(script.contains(removed), "{removed}");
        }
        assert!(script.contains("truncate -s 0 /etc/machine-id\n"));
        assert!(script.contains("find /var/log -type f -exec truncate -s 0 {} +\n"));
        assert!(script.contains("installing kernels is not supported"));
        // The /boot check runs before the trim, which comes last.
        assert!(script.find("/boot") < script.find("fstrim"));
        assert!(script.ends_with("fstrim -v /\n"));
        assert!(!finalize_script(&BTreeSet::new()).contains("add-wants"));
    }

    #[test]
    fn repack_writes_the_third_drive_in_the_guest() {
        let script = repack_script();
        assert!(script.contains("mount --bind / /run/intar/repack\n"));
        assert!(
            script.contains("mke2fs -q -F -t ext4 -L INTARROOT -d /run/intar/repack /dev/vdc\n")
        );
        assert!(script.find("umount") > script.find("mke2fs"));
    }

    #[test]
    fn the_scripts_are_valid_bash() {
        let defer = BTreeSet::from(["a.service".to_owned()]);
        for script in [finalize_script(&defer), repack_script()] {
            let output = std::process::Command::new("bash")
                .args(["-n", "-c", &script])
                .output()
                .expect("bash");
            assert!(output.status.success(), "{script}");
        }
    }
}
