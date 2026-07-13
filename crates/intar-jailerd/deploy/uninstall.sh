#!/bin/sh
set -eu

die() {
  echo "intar-jailerd uninstall: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "must run as root"
for command in awk flock install readlink systemctl; do
  command -v "${command}" >/dev/null 2>&1 || die "required host command is missing: ${command}"
done
systemctl show --property=Version >/dev/null 2>&1 || die "cannot communicate with systemd"

active_state() {
  systemctl show --property=ActiveState --value "$1"
}

unit_loaded() {
  load_state=$(systemctl show --property=LoadState --value "$1") || \
    die "failed to query systemd unit $1"
  [ "${load_state}" != not-found ]
}

agent_was_active=false
socket_was_active=false
daemon_was_active=false
if unit_loaded intar-agent.service && [ "$(active_state intar-agent.service)" = active ]; then
  agent_was_active=true
fi
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
    if [ "${agent_was_active}" = true ]; then
      systemctl start intar-agent.service || status=1
    fi
  fi
  exit "${status}"
}
trap restore_on_exit 0
trap 'exit 130' HUP INT TERM

# Freeze callers and launch activation before taking the exclusive lock.
if unit_loaded intar-agent.service; then
  systemctl stop intar-agent.service
  case "$(active_state intar-agent.service)" in
    inactive|failed) ;;
    *) die "intar-agent.service did not stop" ;;
  esac
fi
if unit_loaded intar-jailerd.socket; then
  systemctl stop intar-jailerd.socket
  [ "$(active_state intar-jailerd.socket)" = inactive ] || die "jailerd socket did not stop"
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
for executable in /proc/[0-9]*/exe; do
  if target=$(readlink "${executable}" 2>/dev/null); then
    name=${target##*/}
    name=${name% (deleted)}
    case "${name}" in
      cloud-hypervisor|cloud-hypervisor-*) die "Cloud Hypervisor is still running: ${executable}" ;;
    esac
  fi
done

mutated=true
systemctl disable --now intar-agent.service
systemctl disable --now intar-jailerd.socket
systemctl disable --now intar-jailerd.service

rm -f -- \
  /etc/systemd/system/intar-agent.service \
  /etc/systemd/system/intar-jailerd.socket \
  /etc/systemd/system/intar-jailerd.service \
  /etc/systemd/system/intar-vms.slice \
  /etc/tmpfiles.d/intar-jailerd.conf \
  /etc/sysctl.d/90-intar-jailerd.conf \
  /usr/lib/intar/intar-jailerd \
  /usr/lib/intar/intar-jailer \
  /usr/lib/intar/intar-jailerd-self-test \
  /usr/lib/intar/cloud-hypervisor-v53.0 \
  /usr/lib/intar/cloud-hypervisor-v53.0.sha256 \
  /usr/local/bin/intar-agent \
  /usr/share/doc/intar-jailerd/THIRD_PARTY_NOTICES.md \
  /usr/share/doc/intar-jailerd/intar-rust-dependencies.json \
  /usr/share/doc/intar-jailerd/SHA256SUMS \
  /usr/share/doc/intar-jailerd/cloud-hypervisor-LICENSES/Apache-2.0.txt \
  /usr/share/doc/intar-jailerd/cloud-hypervisor-LICENSES/BSD-3-Clause.txt \
  /usr/share/doc/intar-jailerd/cloud-hypervisor-LICENSES/CC-BY-4.0.txt \
  /var/lib/intar/jails/self-test-attestation-v1.json
rmdir /usr/share/doc/intar-jailerd/cloud-hypervisor-LICENSES 2>/dev/null || true
rmdir /usr/share/doc/intar-jailerd 2>/dev/null || true
rmdir /usr/lib/intar 2>/dev/null || true

systemctl daemon-reload

for path in \
  /etc/systemd/system/intar-agent.service \
  /etc/systemd/system/intar-jailerd.socket \
  /etc/systemd/system/intar-jailerd.service \
  /etc/systemd/system/intar-vms.slice \
  /etc/tmpfiles.d/intar-jailerd.conf \
  /etc/sysctl.d/90-intar-jailerd.conf \
  /usr/lib/intar/intar-jailerd \
  /usr/lib/intar/intar-jailer \
  /usr/lib/intar/intar-jailerd-self-test \
  /usr/lib/intar/cloud-hypervisor-v53.0 \
  /usr/local/bin/intar-agent; do
  if [ -e "${path}" ] || [ -L "${path}" ]; then
    die "installed path remains: ${path}"
  fi
done

for wants in /etc/systemd/system/*.wants /etc/systemd/system/*.requires; do
  [ -d "${wants}" ] || continue
  for link in \
    "${wants}/intar-agent.service" \
    "${wants}/intar-jailerd.socket" \
    "${wants}/intar-jailerd.service"; do
    if [ -e "${link}" ] || [ -L "${link}" ]; then
      die "systemd enablement link remains: ${link}"
    fi
  done
done

echo "Binaries and units removed. Configuration, jail quarantine, source cache, self-test downloads, and the live forwarding sysctl were preserved."
