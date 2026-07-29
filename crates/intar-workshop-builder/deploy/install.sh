#!/bin/sh
set -eu
set -f

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
umask 022

program=intar-workshop-builder-install
service_user=intar-builder
service_group=intar-builder
service_unit=intar-workshop-builder.service
state_root=/var/lib/intar-workshop-builder
cache_root=/var/cache/intar-workshop-builder
config_path=/etc/intar/workshop-builder.toml
signing_key_path=/etc/intar/workshop-runtime-ed25519
builder_path=/usr/local/bin/intar-workshop-builder
libexec_root=/usr/local/libexec/intar
share_root=/usr/local/share/intar/workshops
unit_path=/etc/systemd/system/intar-workshop-builder.service

die() {
  echo "${program}: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  sudo ./deploy/install.sh
  sudo ./deploy/install.sh --check
  ./deploy/install.sh --verify-package

Modes:
  (default)          Install or upgrade a fully drained builder host.
  --check            Validate the package, host, drain state, and any existing
                     account/configuration without changing the host.
  --verify-package   Verify only the extracted release package.

The installer never enables or starts the service and never prepares an image.
EOF
}

mode=install
case "${1-}" in
  "")
    ;;
  --check)
    mode=check
    ;;
  --verify-package)
    mode=verify-package
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
[ "$#" -le 1 ] || {
  usage >&2
  exit 2
}

archive_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required host command is missing: $1"
}

verify_package() {
  for command in awk find sha256sum stat; do
    require_command "${command}"
  done

  sums=${archive_dir}/deploy/SHA256SUMS
  [ -f "${sums}" ] || die "archive SHA256SUMS is missing"
  [ ! -L "${sums}" ] || die "archive SHA256SUMS must not be a symlink"

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
  done < "${sums}"

  (
    cd "${archive_dir}"
    find . -type f ! -path './deploy/SHA256SUMS' -print
  ) | while IFS= read -r archive_file; do
    awk -v path="${archive_file}" \
      '$2 == path { found = 1 } END { exit !found }' "${sums}" ||
      die "archive file is missing from SHA256SUMS: ${archive_file}"
  done

  (
    cd "${archive_dir}"
    sha256sum --check --strict deploy/SHA256SUMS
  ) >/dev/null

  for required_file in \
    intar-workshop-builder \
    intar-workspace-agent \
    intar-workspace-agent.sha256 \
    intar-workshop-sanitize.sha256 \
    kino \
    kino.sha256 \
    platform-engineering-workshop.tar.gz \
    platform-engineering-workshop.tar.gz.sha256 \
    workshop-guest-tools.provenance.json \
    workshop-builder.config.example.toml \
    deploy/intar-workshop-builder.service \
    deploy/intar-workshop-sanitize \
    deploy/install.sh; do
    [ -f "${archive_dir}/${required_file}" ] ||
      die "required archive file is missing: ${required_file}"
    [ ! -L "${archive_dir}/${required_file}" ] ||
      die "required archive file is a symlink: ${required_file}"
  done
  (
    cd "${archive_dir}"
    sha256sum --check --strict \
      intar-workspace-agent.sha256 \
      intar-workshop-sanitize.sha256 \
      kino.sha256 \
      platform-engineering-workshop.tar.gz.sha256
  ) >/dev/null
}

if [ "${mode}" = verify-package ]; then
  verify_package
  echo "Workshop-builder release package verification passed."
  exit 0
fi

for command in \
  awk chmod chown cmp dirname find flock getent grep groupadd id install \
  mktemp mv python3 runuser sha256sum stat systemctl tr uname useradd usermod; do
  require_command "${command}"
done

verify_package

if [ "${mode}" = install ] || [ "${mode}" = check ]; then
  [ "$(id -u)" -eq 0 ] || die "${mode} must run as root"
fi
if [ "${mode}" = install ]; then
  install -d -o root -g root -m 0755 /run/lock
  exec 9>/run/lock/intar-workshop-builder-install.lock
  flock -n 9 || die "another workshop-builder installation is in progress"
fi

[ "$(uname -s)" = Linux ] || die "the workshop builder requires Linux"
[ "$(uname -m)" = x86_64 ] || die "the workshop builder requires x86_64"
[ -x /usr/sbin/nologin ] || die "/usr/sbin/nologin is unavailable"
[ -d /run/systemd/system ] || die "systemd must be the active service manager"
systemctl show --property=Version >/dev/null 2>&1 ||
  die "cannot communicate with systemd"

for executable in \
  /usr/bin/qemu-system-x86_64 \
  /usr/sbin/e2fsck \
  /usr/sbin/resize2fs; do
  [ -x "${executable}" ] || die "required host executable is missing: ${executable}"
  [ ! -L "${executable}" ] || die "required host executable must not be a symlink: ${executable}"
done
/usr/bin/qemu-system-x86_64 -accel help 2>&1 |
  grep -Eq '(^|[[:space:]])kvm($|[[:space:]])' ||
  die "QEMU does not advertise the KVM accelerator"

getent group kvm >/dev/null 2>&1 || die "the kvm group does not exist"
[ -c /dev/kvm ] || die "/dev/kvm is not a character device"
kvm_gid=$(getent group kvm | awk -F: 'NR == 1 { print $3 }')
[ -n "${kvm_gid}" ] || die "the kvm group has no numeric GID"
[ "$(stat -c '%g' /dev/kvm)" = "${kvm_gid}" ] ||
  die "/dev/kvm is not owned by the kvm group"
kvm_mode=$(stat -c '%a' /dev/kvm)
kvm_mode_numeric=$((0${kvm_mode}))
[ $((kvm_mode_numeric & 0060)) -eq 48 ] ||
  die "/dev/kvm does not grant read/write access to its group"

validate_owned_directory() {
  path=$1
  if [ -e "${path}" ] || [ -L "${path}" ]; then
    [ -d "${path}" ] || die "expected a directory: ${path}"
    [ ! -L "${path}" ] || die "managed directory must not be a symlink: ${path}"
  fi
}

for directory in \
  /usr/local \
  /usr/local/bin \
  /usr/local/libexec \
  /usr/local/share \
  /etc/systemd/system \
  /etc/intar \
  "${libexec_root}" \
  /usr/local/share/intar \
  "${share_root}" \
  "${state_root}" \
  "${state_root}/bundles" \
  "${state_root}/executions" \
  "${cache_root}" \
  "${cache_root}/clean" \
  "${cache_root}/authored"; do
  validate_owned_directory "${directory}"
done
if [ -d /etc/intar ]; then
  [ "$(stat -c '%u:%g' /etc/intar)" = "0:0" ] ||
    die "/etc/intar must be owned by root:root"
  intar_config_mode=$(stat -c '%a' /etc/intar)
  intar_config_mode_numeric=$((0${intar_config_mode}))
  [ $((intar_config_mode_numeric & 0022)) -eq 0 ] ||
    die "/etc/intar must not be writable by group or other users"
fi

validate_existing_target() {
  path=$1
  if [ -e "${path}" ] || [ -L "${path}" ]; then
    [ -f "${path}" ] || die "managed file must be regular: ${path}"
    [ ! -L "${path}" ] || die "managed file must not be a symlink: ${path}"
    [ "$(stat -c '%h' "${path}")" -eq 1 ] ||
      die "managed file must have exactly one link: ${path}"
  fi
}

for target in \
  "${builder_path}" \
  "${libexec_root}/intar-workspace-agent" \
  "${libexec_root}/kino" \
  "${libexec_root}/intar-workshop-sanitize" \
  "${share_root}/platform-engineering-workshop.tar.gz" \
  "${unit_path}"; do
  validate_existing_target "${target}"
done

config_digest_before=
if [ -e "${config_path}" ] || [ -L "${config_path}" ]; then
  [ -f "${config_path}" ] || die "existing config must be a regular file"
  [ ! -L "${config_path}" ] || die "existing config must not be a symlink"
  [ "$(stat -c '%u' "${config_path}")" -eq 0 ] ||
    die "existing config must be owned by root"
  [ "$(stat -c '%h' "${config_path}")" -eq 1 ] ||
    die "existing config must have exactly one link"
  config_mode=$(stat -c '%a' "${config_path}")
  case "${config_mode}" in
    400|440|600|640) ;;
    *) die "existing config must not grant write access to group or any access to other" ;;
  esac
  config_gid=$(stat -c '%g' "${config_path}")
  service_group_gid=
  if service_group_entry=$(getent group "${service_group}" 2>/dev/null); then
    service_group_gid=$(echo "${service_group_entry}" | awk -F: '{print $3}')
  fi
  if [ "${config_gid}" -ne 0 ] &&
    { [ -z "${service_group_gid}" ] || [ "${config_gid}" != "${service_group_gid}" ]; }; then
    die "existing config group must be root or ${service_group}"
  fi
  if [ "${mode}" = install ]; then
    config_digest_before=$(sha256sum "${config_path}" | awk '{print $1}')
  fi
fi

assert_unit_drained() {
  unit=$1
  load_state=$(systemctl show --property=LoadState --value "${unit}") ||
    die "failed to query ${unit}"
  if [ "${load_state}" != not-found ]; then
    active_state=$(systemctl show --property=ActiveState --value "${unit}") ||
      die "failed to query ${unit} state"
    case "${active_state}" in
      inactive|failed) ;;
      *)
        die "${unit} must be stopped before install/upgrade (state ${active_state})"
        ;;
    esac
  fi
  systemd_jobs=$(systemctl list-jobs --no-legend --no-pager --plain) ||
    die "failed to inspect pending systemd jobs for ${unit}"
  pending_job=$(printf '%s\n' "${systemd_jobs}" |
    awk -v unit="${unit}" '$2 == unit { print; exit }')
  [ -z "${pending_job}" ] ||
    die "${unit} has a pending systemd job: ${pending_job}"
}

for drained_unit in \
  intar-agent.service \
  intar-jailerd.socket \
  intar-jailerd.service \
  intar-builder.service \
  "${service_unit}"; do
  assert_unit_drained "${drained_unit}"
done

if live_process=$(
  python3 <<'PY'
import os

names = {
    "cloud-hypervisor",
    "intar-agent",
    "intar-builder",
    "intar-jailerd",
    "intar-workshop-builder",
    "qemu-system-x86_64",
}
for entry in os.listdir("/proc"):
    if not entry.isascii() or not entry.isdigit():
        continue
    executable = f"/proc/{entry}/exe"
    try:
        target = os.readlink(executable)
    except (FileNotFoundError, ProcessLookupError):
        continue
    except PermissionError:
        raise SystemExit(2)
    except OSError:
        raise SystemExit(2)
    name = os.path.basename(target.removesuffix(" (deleted)"))
    if name in names or name.startswith("cloud-hypervisor-"):
        print(f"{name}:{executable}")
        raise SystemExit(0)
raise SystemExit(1)
PY
); then
  die "builder host is not drained; live process: ${live_process}"
else
  process_status=$?
  [ "${process_status}" -eq 1 ] || die "failed to audit live host processes"
fi

validate_existing_group() {
  group_entry=$(getent group "${service_group}") ||
    die "existing ${service_group} group is missing"
  group_name=$(echo "${group_entry}" | awk -F: '{print $1}')
  group_gid=$(echo "${group_entry}" | awk -F: '{print $3}')
  [ "${group_name}" = "${service_group}" ] ||
    die "existing service group name is not canonical"
  case "${group_gid}" in
    ""|*[!0-9]*) die "existing ${service_group} GID is malformed" ;;
  esac
  [ "${group_gid}" -gt 0 ] && [ "${group_gid}" -lt 1000 ] ||
    die "existing ${service_group} must have a non-root system GID"
  duplicate_group=$(getent group | awk -F: \
    -v name="${service_group}" \
    -v gid="${group_gid}" \
    '$3 == gid && $1 != name { print $1; exit }')
  [ -z "${duplicate_group}" ] ||
    die "${service_group} shares GID ${group_gid} with ${duplicate_group}"
  unexpected_member=$(echo "${group_entry}" |
    awk -F: -v expected="${service_user}" '
      {
        count = split($4, members, ",")
        for (index = 1; index <= count; index++) {
          if (members[index] != "" && members[index] != expected) {
            print members[index]
            exit
          }
        }
      }
    ')
  [ -z "${unexpected_member}" ] ||
    die "${service_group} has unexpected explicit member ${unexpected_member}"
  unexpected_primary_user=$(getent passwd | awk -F: \
    -v expected="${service_user}" \
    -v gid="${group_gid}" \
    '$4 == gid && $1 != expected { print $1; exit }')
  [ -z "${unexpected_primary_user}" ] ||
    die "${unexpected_primary_user} unexpectedly uses ${service_group} as its primary group"
}

validate_existing_account() {
  passwd_entry=$(getent passwd "${service_user}") ||
    die "failed to read existing ${service_user} account"
  user_name=$(echo "${passwd_entry}" | awk -F: '{print $1}')
  user_uid=$(echo "${passwd_entry}" | awk -F: '{print $3}')
  user_gid=$(echo "${passwd_entry}" | awk -F: '{print $4}')
  user_home=$(echo "${passwd_entry}" | awk -F: '{print $6}')
  user_shell=$(echo "${passwd_entry}" | awk -F: '{print $7}')
  [ "${user_name}" = "${service_user}" ] ||
    die "existing service account name is not canonical"
  case "${user_uid}:${user_gid}" in
    *[!0-9:]*|:|:*|*:) die "existing ${service_user} numeric identity is malformed" ;;
  esac
  [ "${user_uid}" -gt 0 ] && [ "${user_uid}" -lt 1000 ] ||
    die "existing ${service_user} must have a non-root system UID"
  [ "${user_gid}" -gt 0 ] && [ "${user_gid}" -lt 1000 ] ||
    die "existing ${service_user} must have a non-root system primary GID"
  [ -n "${user_uid}" ] && [ -n "${user_gid}" ] ||
    die "existing ${service_user} account is malformed"
  [ "${user_home}" = "${state_root}" ] ||
    die "existing ${service_user} home must be ${state_root}"
  case "${user_shell}" in
    /usr/sbin/nologin|/sbin/nologin|/bin/false|/usr/bin/false) ;;
    *) die "existing ${service_user} account must use a non-login shell" ;;
  esac
  validate_existing_group
  [ "${user_gid}" = "${group_gid}" ] ||
    die "existing ${service_user} account must use ${service_group} as its primary group"
  duplicate_user=$(getent passwd | awk -F: \
    -v name="${service_user}" \
    -v uid="${user_uid}" \
    '$3 == uid && $1 != name { print $1; exit }')
  [ -z "${duplicate_user}" ] ||
    die "${service_user} shares UID ${user_uid} with ${duplicate_user}"
  unexpected_group=$(
    id -nG "${service_user}" |
      tr ' ' '\n' |
      awk -v primary="${service_group}" \
        '$0 != primary && $0 != "kvm" { print; exit }'
  )
  [ -z "${unexpected_group}" ] ||
    die "${service_user} has unexpected supplementary group ${unexpected_group}"
}

if getent group "${service_group}" >/dev/null 2>&1; then
  validate_existing_group
fi
if id "${service_user}" >/dev/null 2>&1; then
  validate_existing_account
  if ! id -nG "${service_user}" | tr ' ' '\n' | grep -Fqx kvm; then
    if [ "${mode}" = check ]; then
      echo "Would add ${service_user} to the kvm group."
    fi
  fi
else
  if [ "${mode}" = check ]; then
    if getent group "${service_group}" >/dev/null 2>&1; then
      echo "Would create the non-login ${service_user} account using its existing group."
    else
      echo "Would create the non-login ${service_user} service account and group."
    fi
  fi
fi

validate_existing_signing_key() {
  if [ ! -e "${signing_key_path}" ] && [ ! -L "${signing_key_path}" ]; then
    return
  fi
  id "${service_user}" >/dev/null 2>&1 ||
    die "remove or defer ${signing_key_path} until ${service_user} exists"
  [ -f "${signing_key_path}" ] ||
    die "runtime signing key must be a regular file"
  [ ! -L "${signing_key_path}" ] ||
    die "runtime signing key must not be a symlink"
  service_gid=$(id -g "${service_user}")
  [ "$(stat -c '%u:%g:%a:%h' "${signing_key_path}")" = "0:${service_gid}:640:1" ] ||
    die "runtime signing key must be root:${service_group} 0640 with exactly one link"
  if python3 - "${signing_key_path}" <<'PY'
import errno
import os
import sys

try:
    os.getxattr(sys.argv[1], "system.posix_acl_access", follow_symlinks=False)
except OSError as error:
    if error.errno in {errno.ENODATA, errno.ENOTSUP}:
        raise SystemExit(1)
    raise SystemExit(2)
raise SystemExit(0)
PY
  then
    die "runtime signing key must not have a POSIX access ACL"
  else
    acl_status=$?
    [ "${acl_status}" -eq 1 ] ||
      die "failed to inspect runtime signing key access ACL"
  fi
  runuser -u "${service_user}" -- /usr/bin/test -r "${signing_key_path}" ||
    die "${service_user} cannot read the runtime signing key"
  if runuser -u "${service_user}" -- /usr/bin/test -w "${signing_key_path}"; then
    die "${service_user} must not be able to write the runtime signing key"
  fi
}

validate_existing_signing_key

report_directory_plan() {
  path=$1
  expected=$2
  if [ ! -d "${path}" ]; then
    echo "Would create ${path} with ${expected}."
    return
  fi
  actual=$(stat -c '%U:%G:%a' "${path}")
  if [ "${actual}" != "${expected}" ]; then
    echo "Would normalize ${path} from ${actual} to ${expected}."
  fi
}

if [ "${mode}" = check ]; then
  if id "${service_user}" >/dev/null 2>&1; then
    for directory in \
      "${state_root}" \
      "${state_root}/bundles" \
      "${state_root}/executions"; do
      report_directory_plan \
        "${directory}" \
        "${service_user}:${service_group}:750"
    done
    report_directory_plan "${cache_root}" "root:${service_group}:750"
    report_directory_plan "${cache_root}/clean" "root:${service_group}:750"
    report_directory_plan \
      "${cache_root}/authored" \
      "${service_user}:${service_group}:750"
  else
    echo "Would create the state directories as ${service_user}:${service_group} 0750."
    echo "Would create ${cache_root} as root:${service_group} 0750."
    echo "Would create ${cache_root}/clean as root:${service_group} 0750."
    echo "Would create ${cache_root}/authored as ${service_user}:${service_group} 0750."
  fi
  echo "Workshop-builder install preflight passed; no host changes were made."
  exit 0
fi

if ! getent group "${service_group}" >/dev/null 2>&1; then
  groupadd --system "${service_group}"
fi
validate_existing_group
if ! id "${service_user}" >/dev/null 2>&1; then
  useradd \
    --system \
    --gid "${service_group}" \
    --groups kvm \
    --home-dir "${state_root}" \
    --no-create-home \
    --shell /usr/sbin/nologin \
    "${service_user}"
else
  validate_existing_account
  if ! id -nG "${service_user}" | tr ' ' '\n' | grep -Fqx kvm; then
    usermod --append --groups kvm "${service_user}"
  fi
fi
validate_existing_account
id -nG "${service_user}" | tr ' ' '\n' | grep -Fqx kvm ||
  die "${service_user} is not a member of the kvm group"
runuser -u "${service_user}" -- /usr/bin/test -r /dev/kvm ||
  die "${service_user} cannot read /dev/kvm"
runuser -u "${service_user}" -- /usr/bin/test -w /dev/kvm ||
  die "${service_user} cannot write /dev/kvm"

service_gid=$(id -g "${service_user}")
validate_existing_signing_key

install -d -o root -g root -m 0755 \
  /etc/intar \
  /usr/local/bin \
  /usr/local/libexec \
  "${libexec_root}" \
  /usr/local/share/intar \
  "${share_root}"
install -d -o "${service_user}" -g "${service_group}" -m 0750 \
  "${state_root}" \
  "${state_root}/bundles" \
  "${state_root}/executions"
install -d -o root -g "${service_group}" -m 0750 "${cache_root}"
# Keep clean proof inputs in a root-owned, non-writable directory. Authored
# outputs use a separate service-owned parent whose 0750 mode satisfies the
# preparer's non-group/world-writable output-parent contract.
install -d -o root -g "${service_group}" -m 0750 "${cache_root}/clean"
install -d -o "${service_user}" -g "${service_group}" -m 0750 \
  "${cache_root}/authored"
runuser -u "${service_user}" -- /usr/bin/test -r "${cache_root}/clean" ||
  die "${service_user} cannot read ${cache_root}/clean"
if runuser -u "${service_user}" -- /usr/bin/test -w "${cache_root}/clean"; then
  die "${service_user} must not be able to write ${cache_root}/clean"
fi
runuser -u "${service_user}" -- /usr/bin/test -r "${cache_root}/authored" ||
  die "${service_user} cannot read ${cache_root}/authored"
runuser -u "${service_user}" -- /usr/bin/test -w "${cache_root}/authored" ||
  die "${service_user} cannot write ${cache_root}/authored"

publish_file() {
  source=$1
  destination=$2
  mode_bits=$3
  destination_dir=$(dirname -- "${destination}")
  temporary=$(mktemp "${destination_dir}/.intar-workshop-builder.XXXXXX")
  install -o root -g root -m "${mode_bits}" "${source}" "${temporary}"
  mv -f -- "${temporary}" "${destination}"
}

publish_file "${archive_dir}/intar-workshop-builder" "${builder_path}" 0555
publish_file \
  "${archive_dir}/intar-workspace-agent" \
  "${libexec_root}/intar-workspace-agent" \
  0555
publish_file "${archive_dir}/kino" "${libexec_root}/kino" 0555
publish_file \
  "${archive_dir}/deploy/intar-workshop-sanitize" \
  "${libexec_root}/intar-workshop-sanitize" \
  0555
publish_file \
  "${archive_dir}/platform-engineering-workshop.tar.gz" \
  "${share_root}/platform-engineering-workshop.tar.gz" \
  0444
publish_file \
  "${archive_dir}/deploy/intar-workshop-builder.service" \
  "${unit_path}" \
  0644

if [ ! -e "${config_path}" ]; then
  config_tmp=$(mktemp /etc/intar/.workshop-builder.toml.XXXXXX)
  install \
    -o root \
    -g "${service_group}" \
    -m 0640 \
    "${archive_dir}/workshop-builder.config.example.toml" \
    "${config_tmp}"
  mv -f -- "${config_tmp}" "${config_path}"
else
  chown root:"${service_group}" "${config_path}"
  chmod 0640 "${config_path}"
  config_digest_after=$(sha256sum "${config_path}" | awk '{print $1}')
  [ "${config_digest_after}" = "${config_digest_before}" ] ||
    die "existing operator configuration changed during installation"
fi

assert_file() {
  source=$1
  destination=$2
  expected_mode=$3
  [ -f "${destination}" ] && [ ! -L "${destination}" ] ||
    die "installed file is not regular: ${destination}"
  [ "$(stat -c '%u:%g:%a:%h' "${destination}")" = "0:0:${expected_mode}:1" ] ||
    die "installed file has unsafe ownership or mode: ${destination}"
  cmp -s "${source}" "${destination}" ||
    die "installed file differs from its release artifact: ${destination}"
}

assert_file "${archive_dir}/intar-workshop-builder" "${builder_path}" 555
assert_file \
  "${archive_dir}/intar-workspace-agent" \
  "${libexec_root}/intar-workspace-agent" \
  555
assert_file "${archive_dir}/kino" "${libexec_root}/kino" 555
assert_file \
  "${archive_dir}/deploy/intar-workshop-sanitize" \
  "${libexec_root}/intar-workshop-sanitize" \
  555
assert_file \
  "${archive_dir}/platform-engineering-workshop.tar.gz" \
  "${share_root}/platform-engineering-workshop.tar.gz" \
  444
assert_file \
  "${archive_dir}/deploy/intar-workshop-builder.service" \
  "${unit_path}" \
  644

[ "$(stat -c '%u:%g:%a:%h' "${config_path}")" = "0:${service_gid}:640:1" ] ||
  die "installed config has unsafe ownership or mode"
for directory in "${state_root}" "${state_root}/bundles" "${state_root}/executions"; do
  [ "$(stat -c '%u:%g:%a' "${directory}")" = \
    "$(id -u "${service_user}"):${service_gid}:750" ] ||
    die "state directory has unsafe ownership or mode: ${directory}"
done
[ "$(stat -c '%u:%g:%a' "${cache_root}")" = "0:${service_gid}:750" ] ||
  die "cache root has unsafe ownership or mode"
[ "$(stat -c '%u:%g:%a' "${cache_root}/clean")" = "0:${service_gid}:750" ] ||
  die "clean-input directory has unsafe ownership or mode"
[ "$(stat -c '%u:%g:%a' "${cache_root}/authored")" = \
  "$(id -u "${service_user}"):${service_gid}:750" ] ||
  die "authored-output directory has unsafe ownership or mode"

systemctl daemon-reload
post_state=$(systemctl show --property=ActiveState --value "${service_unit}") ||
  die "failed to query installed ${service_unit}"
case "${post_state}" in
  inactive|failed) ;;
  *) die "${service_unit} unexpectedly became active" ;;
esac

echo "Installed the drained workshop-builder package."
echo "Preserved ${config_path} when it already existed."
echo "The installer did not enable/start ${service_unit} or prepare an image."
echo "Next: review ${config_path}, provision the pinned base assets, then run doctor."
