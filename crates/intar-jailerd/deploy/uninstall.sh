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

assert_unit_cgroup_drained() {
  audit_unit=$1
  audit_leaf=$2
  audit_label=$3
  unit_loaded "${audit_unit}" || return 0
  audit_cgroup=$(systemctl show --property=ControlGroup --value "${audit_unit}") || \
    die "failed to query ${audit_label} path"
  if [ -z "${audit_cgroup}" ]; then
    audit_state=$(active_state "${audit_unit}") || die "failed to query ${audit_label} state"
    case "${audit_state}" in
      inactive|failed) return 0 ;;
      *) die "${audit_label} has no systemd ControlGroup" ;;
    esac
  fi
  case "${audit_cgroup}" in
    /*) ;;
    *) die "${audit_label} has a non-absolute systemd ControlGroup" ;;
  esac
  case "${audit_cgroup}" in
    *[!A-Za-z0-9_./:@-]*|*//*|*/./*|*/../*|*/.|*/..)
      die "${audit_label} has an unsafe systemd ControlGroup"
      ;;
  esac
  [ "${audit_cgroup##*/}" = "${audit_leaf}" ] || \
    die "${audit_label} has an unexpected systemd ControlGroup leaf"
  audit_events=/sys/fs/cgroup${audit_cgroup}/cgroup.events
  if [ ! -f "${audit_events}" ]; then
    audit_state=$(active_state "${audit_unit}") || die "failed to query ${audit_label} state"
    case "${audit_state}" in
      inactive|failed) return 0 ;;
      *) die "${audit_label} cgroup.events is missing" ;;
    esac
  fi
  audit_populated=$(awk '
    $1 == "populated" {
      if (seen || NF != 2 || $2 !~ /^(0|1)$/) exit 2
      seen = 1
      value = $2
    }
    END {
      if (!seen) exit 3
      print value
    }
  ' "${audit_events}") || die "${audit_label} cgroup.events is malformed"
  [ "${audit_populated}" = 0 ] || die "${audit_label} still has descendants"
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
assert_unit_cgroup_drained intar-vms.slice intar-vms.slice intar-vms.slice
assert_unit_cgroup_drained intar-agent.service intar-agent.service "legacy intar-agent cgroup"
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
