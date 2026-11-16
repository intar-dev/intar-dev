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

/// Stop a deferred unit and everything left in its control group: a unit
/// with `KillMode=process` (k3s) leaves its children running after `stop`.
/// Processes the unit started in another control group (a pod's containers)
/// keep running; the freeze in [`repack_script`] is what makes the copy whole.
const QUIESCE_FUNCTION: &str = r#"quiesce() {
  cgroup="$(systemctl show -P ControlGroup -- "$1")"
  systemctl stop -- "$1" || { echo "deferred unit $1 did not stop" >&2; exit 1; }
  dir="/sys/fs/cgroup$cgroup"
  [ -n "$cgroup" ] || return 0
  # The leftovers may exit after `stop` and systemd remove the cgroup.
  if ! { echo 1 > "$dir/cgroup.kill"; } 2>/dev/null; then
    [ ! -e "$dir" ] && return 0
    echo "deferred unit $1: could not kill the processes in $cgroup" >&2
    exit 1
  fi
  i=0
  while grep -qs '^populated 1$' "$dir/cgroup.events"; do
    if [ "$i" -ge 100 ]; then
      echo "deferred unit $1: processes still run in $cgroup after stop and kill" >&2
      exit 1
    fi
    i=$((i + 1))
    sleep 0.1
  done
}
"#;

/// Make the image a run image: `defer` units are stopped with all their
/// processes and wait for `intar-lab.target`, and nothing of the build, no
/// host key, no machine id and no cache stays.
pub(crate) fn finalize_script(defer: &BTreeSet<String>) -> String {
    let mut script = String::from("set -eu\n");
    if !defer.is_empty() {
        script.push_str(QUIESCE_FUNCTION);
    }
    // What can start a service again (a socket, timer or path) stops first.
    let (services, triggers): (Vec<_>, Vec<_>) =
        defer.iter().partition(|unit| unit.ends_with(".service"));
    for unit in triggers.into_iter().chain(services) {
        script.push_str(&format!("quiesce {}\n", shell_quote(unit)));
    }
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
/// bind mount shows `/` without `/proc`, `/sys`, `/dev` or `/run`. The root
/// is frozen for the copy, so what still runs (a pod's store) cannot change
/// it halfway; a writer blocks until the thaw. Nothing between freeze and
/// thaw writes to `/`, and the trap thaws on every way out; a copy that
/// never ends hits the build deadline, which kills the VM.
pub(crate) fn repack_script() -> String {
    format!(
        r"set -eu
command -v fsfreeze >/dev/null || {{ echo 'fsfreeze is missing: the root cannot be frozen for the copy' >&2; exit 1; }}
mkdir -p /run/intar/repack
mount --bind / /run/intar/repack
trap 'exit 1' HUP INT TERM
trap 'fsfreeze -u / 2>/dev/null' EXIT
fsfreeze -f /
mke2fs -q -F -t ext4 -L {label} -d /run/intar/repack {REPACK_DEVICE}
fsfreeze -u /
trap - EXIT
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
        let empty = finalize_script(&BTreeSet::new());
        assert!(!empty.contains("add-wants") && !empty.contains("quiesce"));
    }

    #[test]
    fn finalize_stops_every_deferred_unit_and_its_cgroup_first() {
        let defer = BTreeSet::from(["k3s.service".to_owned(), "b.timer".to_owned()]);
        let script = finalize_script(&defer);
        let stop = |unit: &str| script.find(&format!("quiesce '{unit}'\n"));
        // Every unit stops before anything is disabled, cleaned or synced.
        for unit in ["b.timer", "k3s.service"] {
            assert!(
                stop(unit) < script.find("systemctl disable 'b.timer'"),
                "{unit}"
            );
        }
        assert!(script.find("quiesce() {") < stop("b.timer"));
        assert!(script.find("systemctl disable 'k3s.service'") < script.find("\nsync\n"));
        // The leftovers of a `KillMode=process` unit go with its cgroup,
        // and the build fails when they do not.
        for part in [
            "systemctl show -P ControlGroup -- \"$1\"",
            "systemctl stop -- \"$1\" || {",
            "echo 1 > \"$dir/cgroup.kill\"",
            "grep -qs '^populated 1$' \"$dir/cgroup.events\"",
            "processes still run in $cgroup after stop and kill",
        ] {
            assert!(script.contains(part), "{part}");
        }
    }

    /// The function against a fake cgroup tree: a unit whose stop leaves
    /// a process is killed through `cgroup.kill`; one that never empties
    /// fails the build.
    #[test]
    fn quiesce_kills_the_cgroup_and_fails_when_it_stays_populated() {
        let run = |stays: bool| {
            let root = tempfile::tempdir().expect("tempdir");
            let cgroup = root.path().join("system.slice/k3s.service");
            std::fs::create_dir_all(&cgroup).expect("cgroup");
            std::fs::write(cgroup.join("cgroup.events"), "populated 1\nfrozen 0\n")
                .expect("events");
            std::fs::write(cgroup.join("cgroup.kill"), "").expect("kill");
            let empties = if stays {
                ":"
            } else {
                "printf 'populated 0\\nfrozen 0\\n' > \"$dir/cgroup.events\""
            };
            let script = format!(
                "set -eu\nsystemctl() {{ case \"$1\" in show) echo /system.slice/k3s.service ;; esac; }}\nsleep() {{ {empties}; }}\n{}quiesce k3s.service\necho done\n",
                QUIESCE_FUNCTION.replace("/sys/fs/cgroup", &root.path().display().to_string())
            );
            let output = std::process::Command::new("bash")
                .args(["-c", &script])
                .output()
                .expect("bash");
            let killed = std::fs::read_to_string(cgroup.join("cgroup.kill")).expect("kill");
            (output, killed)
        };
        let (output, killed) = run(false);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(killed, "1\n");
        let (output, _) = run(true);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("processes still run"));
    }

    /// The leftovers exited after `stop` and systemd removed the cgroup:
    /// nothing is left to kill. A cgroup that stays but takes no kill
    /// fails the build.
    #[test]
    fn quiesce_tolerates_a_cgroup_that_vanished_but_not_one_that_stays() {
        let run = |cgroup_kill_is_a_directory: bool| {
            let root = tempfile::tempdir().expect("tempdir");
            if cgroup_kill_is_a_directory {
                std::fs::create_dir_all(root.path().join("system.slice/k3s.service/cgroup.kill"))
                    .expect("cgroup");
            }
            let script = format!(
                "set -eu\nsystemctl() {{ case \"$1\" in show) echo /system.slice/k3s.service ;; esac; }}\n{}quiesce k3s.service\necho done\n",
                QUIESCE_FUNCTION.replace("/sys/fs/cgroup", &root.path().display().to_string())
            );
            std::process::Command::new("bash")
                .args(["-c", &script])
                .output()
                .expect("bash")
        };
        let vanished = run(false);
        assert!(vanished.status.success(), "{vanished:?}");
        assert_eq!(String::from_utf8_lossy(&vanished.stdout), "done\n");
        assert!(vanished.stderr.is_empty(), "{vanished:?}");
        let stays = run(true);
        assert!(!stays.status.success());
        assert!(
            String::from_utf8_lossy(&stays.stderr)
                .contains("could not kill the processes in /system.slice/k3s.service")
        );
    }

    #[test]
    fn repack_writes_the_third_drive_in_the_guest() {
        let script = repack_script();
        assert!(script.contains("mount --bind / /run/intar/repack\n"));
        assert!(
            script.contains("mke2fs -q -F -t ext4 -L INTARROOT -d /run/intar/repack /dev/vdc\n")
        );
        assert!(script.find("umount") > script.find("mke2fs"));
        // Frozen around the copy only, with the thaw on every way out.
        let at = |part: &str| script.find(part).unwrap_or_else(|| panic!("{part}"));
        let order = [
            "command -v fsfreeze",
            "mount --bind",
            "trap 'exit 1' HUP INT TERM\n",
            "trap 'fsfreeze -u / 2>/dev/null' EXIT\n",
            "fsfreeze -f /\n",
            "mke2fs",
            "fsfreeze -u /\n",
            "trap - EXIT\n",
            "umount",
            "sync\n",
        ];
        for pair in order.windows(2) {
            assert!(at(pair[0]) < at(pair[1]), "{pair:?}");
        }
    }

    #[test]
    fn finalize_stops_what_can_restart_a_service_first() {
        let defer = ["a.service", "a.socket", "b.timer"]
            .map(String::from)
            .into();
        let script = finalize_script(&defer);
        let at = |part: &str| script.find(part).unwrap_or_else(|| panic!("{part}"));
        assert!(at("quiesce 'a.socket'\n") < at("quiesce 'a.service'\n"));
        assert!(at("quiesce 'b.timer'\n") < at("quiesce 'a.service'\n"));
    }

    /// The script against stubs that log each call: the root is thawed
    /// when the copy succeeds, when it fails, and the build fails clearly
    /// without `fsfreeze`.
    #[test]
    fn repack_thaws_the_root_on_every_way_out() {
        let run = |mke2fs: &str, with_fsfreeze: bool| {
            let fsfreeze = if with_fsfreeze {
                "fsfreeze() { echo \"fsfreeze $*\"; }\n"
            } else {
                ""
            };
            let script = format!(
                "PATH=/nonexistent\nmkdir() {{ :; }}\nmount() {{ echo \"mount $*\"; }}\numount() {{ echo umount; }}\nsync() {{ echo sync; }}\nmke2fs() {{ echo mke2fs; {mke2fs}; }}\n{fsfreeze}{}",
                repack_script()
            );
            let output = std::process::Command::new("bash")
                .args(["-c", &script])
                .output()
                .expect("bash");
            (
                output.status.success(),
                String::from_utf8_lossy(&output.stdout).into_owned(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            )
        };
        let (ok, calls, _) = run("true", true);
        assert!(ok);
        assert_eq!(
            calls,
            "mount --bind / /run/intar/repack\nfsfreeze -f /\nmke2fs\nfsfreeze -u /\numount\nsync\n"
        );
        let (ok, calls, _) = run("return 1", true);
        assert!(!ok);
        assert_eq!(
            calls,
            "mount --bind / /run/intar/repack\nfsfreeze -f /\nmke2fs\nfsfreeze -u /\n"
        );
        let (ok, calls, errors) = run("true", false);
        assert!(!ok && calls.is_empty());
        assert!(errors.contains("fsfreeze is missing"), "{errors}");
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
