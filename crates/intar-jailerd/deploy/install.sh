#!/bin/sh
set -eu
set -f

die() {
  echo "intar-jailerd install: $*" >&2
  exit 1
}

# Keep pathname expansion disabled for the privileged installer, but enumerate
# procfs explicitly so the live-process drain check cannot be neutralized by
# `set -f`. Return 0 with "name:/proc/PID/exe" for a forbidden process, 1 when
# the host is clean, and 2 when procfs cannot be enumerated completely.
# INTAR_INSTALL_PROCESS_AUDIT_BEGIN
find_forbidden_process_in() {
  [ "$#" -eq 1 ] || return 2
  # Snapshot only the numeric entries from one procfs directory read. A PID
  # may disappear after this point; only that ENOENT race is ignored. Failure
  # to enumerate /proc or inspect any still-present executable returns 2.
  python3 - "$1" <<'PY'
import os
import sys

proc_root = sys.argv[1]
if not os.path.isabs(proc_root):
    raise SystemExit(2)

try:
    entries = os.listdir(proc_root)
except OSError:
    raise SystemExit(2)

for pid in sorted(
    (entry for entry in entries if entry.isascii() and entry.isdigit()),
    key=int,
):
    executable = os.path.join(proc_root, pid, "exe")
    try:
        target = os.readlink(executable)
    except (FileNotFoundError, ProcessLookupError):
        continue
    except OSError:
        raise SystemExit(2)

    name = os.path.basename(target.removesuffix(" (deleted)"))
    if name in {
        "cloud-hypervisor",
        "intar-agent",
        "intar-jailer",
        "intar-jailerd",
        "kino",
    } or name.startswith("cloud-hypervisor-"):
        print(f"{name}:{executable}")
        raise SystemExit(0)

raise SystemExit(1)
PY
}

# Production callers cannot override the procfs root through arguments or the
# environment. Tests exercise the scanner above with isolated fixture roots.
find_forbidden_process() {
  find_forbidden_process_in /proc
}
# INTAR_INSTALL_PROCESS_AUDIT_END

breaking_v6_cutover=false
case "$#" in
  0) ;;
  1)
    [ "$1" = --breaking-v6-cutover ] || \
      die "usage: $0 [--breaking-v6-cutover]"
    breaking_v6_cutover=true
    ;;
  *) die "usage: $0 [--breaking-v6-cutover]" ;;
esac

[ "$(id -u)" -eq 0 ] || die "must run as root"
archive_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
id intar-agent >/dev/null 2>&1 || die "intar-agent system user must exist first"
agent_uid=$(id -u intar-agent)
agent_gid=$(id -g intar-agent)
agent_config=/etc/intar-agent/config.toml
agent_database=/var/cache/intar-agent/state/intar-agent/intar-agent.sqlite3
cutover_helper=${archive_dir}/deploy/prepare-v6-cutover.py

for command in \
  awk find flock getent getfacl gpasswd grep install ip mktemp mv nft \
  python3 sed setfacl sha256sum stat sysctl systemctl systemd-tmpfiles tr; do
  command -v "${command}" >/dev/null 2>&1 || die "required host command is missing: ${command}"
done
systemctl show --property=Version >/dev/null 2>&1 || die "cannot communicate with systemd"

# Verify the complete extracted archive before freezing or mutating the host.
[ -f "${archive_dir}/deploy/SHA256SUMS" ] || die "archive SHA256SUMS is missing"
[ ! -L "${archive_dir}/deploy/SHA256SUMS" ] || die "archive SHA256SUMS is a symlink"
unsafe_entry=$(find "${archive_dir}" -mindepth 1 ! -type d ! -type f -print -quit)
[ -z "${unsafe_entry}" ] || die "archive contains a non-regular entry: ${unsafe_entry}"
linked_file=$(find "${archive_dir}" -type f -links +1 -print -quit)
[ -z "${linked_file}" ] || die "archive contains a multiply-linked file: ${linked_file}"
while IFS= read -r checksum_line; do
  checksum_digest=${checksum_line%%  *}
  checksum_path=${checksum_line#*  }
  [ "${#checksum_digest}" -eq 64 ] || die "malformed SHA256SUMS digest"
  [ "${checksum_path}" != "${checksum_line}" ] || die "malformed SHA256SUMS entry"
  case "${checksum_path}" in
    ./*) ;;
    *) die "unsafe SHA256SUMS path: ${checksum_path}" ;;
  esac
  case "${checksum_path}" in
    *../*) die "unsafe SHA256SUMS path: ${checksum_path}" ;;
  esac
done < "${archive_dir}/deploy/SHA256SUMS"
(cd "${archive_dir}" && find . -type f ! -path './deploy/SHA256SUMS' -print) |
  while IFS= read -r archive_file; do
    awk -v path="${archive_file}" '$2 == path { found = 1 } END { exit !found }' \
      "${archive_dir}/deploy/SHA256SUMS" || \
      die "archive file is missing from SHA256SUMS: ${archive_file}"
  done
(cd "${archive_dir}" && sha256sum --check --strict deploy/SHA256SUMS)

expected=448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc
actual=$(sha256sum "${archive_dir}/cloud-hypervisor-v53.0" | awk '{print $1}')
[ "${actual}" = "${expected}" ] || die "Cloud Hypervisor archive digest mismatch"

if [ -e /etc/intar-jailerd/config.toml ] || [ -L /etc/intar-jailerd/config.toml ]; then
  [ ! -L /etc/intar-jailerd/config.toml ] || die "jailerd config must not be a symlink"
  case "$(stat -c '%u:%g:%a:%h' /etc/intar-jailerd/config.toml)" in
    0:0:400:1|0:0:600:1) ;;
    *) die "/etc/intar-jailerd/config.toml must be root:root, 0400/0600 and one link" ;;
  esac
fi

active_state() {
  systemctl show --property=ActiveState --value "$1"
}

unit_loaded() {
  load_state=$(systemctl show --property=LoadState --value "$1") || \
    die "failed to query systemd unit $1"
  [ "${load_state}" != not-found ]
}

agent_state=$(active_state intar-agent.service) || die "failed to query intar-agent.service"
case "${agent_state}" in
  inactive|failed) ;;
  *) die "intar-agent.service must be stopped before install/upgrade (state ${agent_state})" ;;
esac

socket_was_active=false
daemon_was_active=false
if unit_loaded intar-jailerd.socket && [ "$(active_state intar-jailerd.socket)" = active ]; then
  socket_was_active=true
fi
if unit_loaded intar-jailerd.service && [ "$(active_state intar-jailerd.service)" = active ]; then
  daemon_was_active=true
fi
mutated=false

restore_on_exit() {
  status=$?
  trap - 0 HUP INT TERM
  if [ "${status}" -ne 0 ] && [ "${mutated}" = false ]; then
    if [ "${socket_was_active}" = true ]; then
      systemctl start intar-jailerd.socket || status=1
    fi
    if [ "${daemon_was_active}" = true ]; then
      systemctl start intar-jailerd.service || status=1
    fi
  fi
  exit "${status}"
}
trap restore_on_exit 0
trap 'exit 130' HUP INT TERM

# Freeze admission first. The old daemon's shared lock disappears when its
# service stops; this installer then owns the exclusive boundary until commit.
if unit_loaded intar-jailerd.socket; then
  systemctl stop intar-jailerd.socket
  [ "$(active_state intar-jailerd.socket)" = inactive ] || die "socket did not stop"
fi
if unit_loaded intar-jailerd.service; then
  systemctl stop intar-jailerd.service
  case "$(active_state intar-jailerd.service)" in
    inactive|failed) ;;
    *) die "jailerd service did not stop" ;;
  esac
fi
install -d -o root -g root -m 0750 /run/intar-jailerd
exec 9>/run/intar-jailerd/maintenance.lock
chown root:root /run/intar-jailerd/maintenance.lock
chmod 0600 /run/intar-jailerd/maintenance.lock
flock -x 9

# Coordinated V6 cutover cannot adopt old or partially drained VMs.
active_vms=$(systemctl list-units --all --type=service --no-legend --plain 'intar-vm-*.service') || \
  die "failed to enumerate Intar VM units"
[ -z "${active_vms}" ] || {
  echo "${active_vms}" >&2
  die "Intar VM units still exist"
}
if [ -f /sys/fs/cgroup/intar-vms.slice/cgroup.events ]; then
  populated=$(awk '$1 == "populated" { print $2 }' /sys/fs/cgroup/intar-vms.slice/cgroup.events)
  [ "${populated}" = 0 ] || die "intar-vms.slice still has descendants"
fi
agent_cgroup=$(systemctl show --property=ControlGroup --value intar-agent.service) || \
  die "failed to query the legacy agent cgroup"
if [ -n "${agent_cgroup}" ] && [ -f "/sys/fs/cgroup${agent_cgroup}/cgroup.events" ]; then
  populated=$(awk '$1 == "populated" { print $2 }' "/sys/fs/cgroup${agent_cgroup}/cgroup.events")
  [ "${populated}" = 0 ] || die "legacy intar-agent cgroup is still populated"
fi
if forbidden_process=$(find_forbidden_process); then
  forbidden_name=${forbidden_process%%:*}
  forbidden_executable=${forbidden_process#*:}
  case "${forbidden_name}" in
    cloud-hypervisor|cloud-hypervisor-*)
      die "legacy/foreign Cloud Hypervisor is still running: ${forbidden_executable}"
      ;;
    *) die "Intar workload/helper process is still running: ${forbidden_executable}" ;;
  esac
else
  forbidden_status=$?
  [ "${forbidden_status}" -eq 1 ] || die "failed to enumerate live host processes"
fi

# The V5 database is deliberately incompatible with V6.  Inspect every
# install, and require an explicit destructive flag before archiving and
# resetting a proven-drained legacy state.  The helper never prints config
# values; its archive is root-only and contains a consistent SQLite backup.
cutover_state=$(python3 "${cutover_helper}" \
  --mode inspect \
  --config "${agent_config}" \
  --database "${agent_database}" \
  --agent-uid "${agent_uid}" \
  --agent-gid "${agent_gid}") || \
  die "agent state failed the V6 cutover safety inspection"
case "${cutover_state}" in
  fresh|current)
    [ "${breaking_v6_cutover}" = false ] || \
      die "--breaking-v6-cutover was requested, but no eligible V5 state exists"
    ;;
  legacy-drained)
    [ "${breaking_v6_cutover}" = true ] || \
      die "drained V5 agent state found; rerun with --breaking-v6-cutover to archive it and continue"
    install -d -o root -g root -m 0700 /var/lib/intar/cutover-archives
    cutover_archive=$(mktemp -d /var/lib/intar/cutover-archives/bridge-v5-to-v6.XXXXXX)
    chown root:root "${cutover_archive}"
    chmod 0700 "${cutover_archive}"
    # From this point onward an error must leave admission stopped for manual
    # archive inspection instead of restoring a previous jailerd daemon.
    mutated=true
    python3 "${cutover_helper}" \
      --mode apply \
      --config "${agent_config}" \
      --database "${agent_database}" \
      --agent-uid "${agent_uid}" \
      --agent-gid "${agent_gid}" \
      --archive-dir "${cutover_archive}" || \
      die "V6 agent-state cutover failed; keep the agent stopped and inspect ${cutover_archive}"
    ;;
  *) die "cutover helper returned an unknown state" ;;
esac

mutated=true

# Remove legacy direct KVM/TUN group access from the unprivileged agent.
for group in kvm netdev; do
  if getent group "${group}" >/dev/null 2>&1 && \
     id -nG intar-agent | tr ' ' '\n' | grep -Fqx "${group}"; then
    gpasswd --delete intar-agent "${group}" >/dev/null
  fi
done

publish_file() {
  source=$1
  destination=$2
  mode=$3
  temporary=${destination}.new.$$
  install -o root -g root -m "${mode}" "${source}" "${temporary}"
  mv -f -- "${temporary}" "${destination}"
}

install -d -o root -g root -m 0755 /usr/lib/intar /usr/local/bin
publish_file "${archive_dir}/intar-agent" /usr/local/bin/intar-agent 0755
publish_file "${archive_dir}/intar-jailerd" /usr/lib/intar/intar-jailerd 0755
publish_file "${archive_dir}/intar-jailer" /usr/lib/intar/intar-jailer 0755
publish_file "${archive_dir}/cloud-hypervisor-v53.0" /usr/lib/intar/cloud-hypervisor-v53.0 0555
publish_file "${archive_dir}/deploy/intar-jailerd-self-test.sh" /usr/lib/intar/intar-jailerd-self-test 0755
publish_file "${archive_dir}/deploy/cloud-hypervisor-v53.0.sha256" /usr/lib/intar/cloud-hypervisor-v53.0.sha256 0644

install -d -o root -g root -m 0755 /usr/share/doc/intar-jailerd
publish_file "${archive_dir}/deploy/THIRD_PARTY_NOTICES.md" /usr/share/doc/intar-jailerd/THIRD_PARTY_NOTICES.md 0644
publish_file "${archive_dir}/deploy/intar-rust-dependencies.json" /usr/share/doc/intar-jailerd/intar-rust-dependencies.json 0644
publish_file "${archive_dir}/deploy/SHA256SUMS" /usr/share/doc/intar-jailerd/SHA256SUMS 0644
install -d -o root -g root -m 0755 /usr/share/doc/intar-jailerd/cloud-hypervisor-LICENSES
for license in Apache-2.0.txt BSD-3-Clause.txt CC-BY-4.0.txt; do
  publish_file "${archive_dir}/deploy/cloud-hypervisor-LICENSES/${license}" \
    "/usr/share/doc/intar-jailerd/cloud-hypervisor-LICENSES/${license}" 0644
done

actual=$(sha256sum /usr/lib/intar/cloud-hypervisor-v53.0 | awk '{print $1}')
[ "${actual}" = "${expected}" ] || die "Cloud Hypervisor digest changed during installation"

install -d -o root -g root -m 0755 /etc/intar-jailerd
if [ ! -e /etc/intar-jailerd/config.toml ]; then
  config_tmp=$(mktemp /etc/intar-jailerd/.config.toml.XXXXXX)
  sed \
    -e "s/^agent_uid = .*/agent_uid = ${agent_uid}/" \
    -e "s/^agent_gid = .*/agent_gid = ${agent_gid}/" \
    "${archive_dir}/deploy/config.example.toml" > "${config_tmp}"
  chown root:root "${config_tmp}"
  chmod 0600 "${config_tmp}"
  mv -f -- "${config_tmp}" /etc/intar-jailerd/config.toml
fi

install -d -o root -g root -m 0755 /etc/intar-agent
if [ ! -e "${agent_config}" ]; then
  publish_file "${archive_dir}/deploy/intar-agent.config.example.toml" "${agent_config}" 0640
  chown root:"${agent_gid}" "${agent_config}"
fi

install -d -o "${agent_uid}" -g "${agent_gid}" -m 0700 /var/cache/intar-agent
install -d -o root -g root -m 0755 /run/netns

publish_file "${archive_dir}/deploy/intar-jailerd.service" /etc/systemd/system/intar-jailerd.service 0644
publish_file "${archive_dir}/deploy/intar-jailerd.socket" /etc/systemd/system/intar-jailerd.socket 0644
publish_file "${archive_dir}/deploy/intar-vms.slice" /etc/systemd/system/intar-vms.slice 0644
publish_file "${archive_dir}/deploy/intar-agent.service" /etc/systemd/system/intar-agent.service 0644
publish_file "${archive_dir}/deploy/intar-jailerd.tmpfiles" /etc/tmpfiles.d/intar-jailerd.conf 0644
publish_file "${archive_dir}/deploy/intar-jailerd.sysctl.conf" /etc/sysctl.d/90-intar-jailerd.conf 0644

# Any binary/config change invalidates the boot-bound proof.
rm -f -- /var/lib/intar/jails/self-test-attestation-v1.json
systemd-tmpfiles --create /etc/tmpfiles.d/intar-jailerd.conf
sysctl -p /etc/sysctl.d/90-intar-jailerd.conf >/dev/null
[ "$(sysctl -n net.ipv4.ip_forward)" = 1 ] || die "IPv4 forwarding remains disabled"
systemctl daemon-reload
systemctl enable --now intar-jailerd.socket
[ "$(active_state intar-jailerd.socket)" = active ] || die "jailerd socket did not activate"

echo "Installed the jailed scenario-host package; intar-agent remains stopped."
echo "Run: sudo /usr/lib/intar/intar-jailerd-self-test"
echo "Then run doctor and explicitly enable/start intar-agent only when both pass."
