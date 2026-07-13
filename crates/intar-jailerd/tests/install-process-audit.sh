#!/bin/sh
set -eu
set -f

die() {
  echo "intar installer process-audit test: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || die "usage: $0 INSTALLER"
installer=$1
[ -f "${installer}" ] || die "installer does not exist: ${installer}"

for command in awk chmod grep id ln mkdir mktemp python3 rm; do
  command -v "${command}" >/dev/null 2>&1 || die "required command is missing: ${command}"
done

work_root=$(mktemp -d)
cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  chmod 0700 "${work_root}/denied-proc/41" 2>/dev/null || true
  rm -rf -- "${work_root}"
  exit "${status}"
}
trap cleanup 0
trap 'exit 130' HUP INT TERM

# Exercise the exact scanner shipped by install.sh without invoking the
# privileged production wrapper or inspecting any host process.
function_file=${work_root}/find-forbidden-process.sh
awk '
  $0 == "# INTAR_INSTALL_PROCESS_AUDIT_BEGIN" { capture = 1; next }
  $0 == "# INTAR_INSTALL_PROCESS_AUDIT_END" { found = 1; exit }
  capture { print }
  END { if (!found) exit 1 }
' "${installer}" > "${function_file}" || die "could not extract process-audit functions"
# shellcheck source=/dev/null
. "${function_file}"
grep -Fqx '  find_forbidden_process_in /proc' "${function_file}" || \
  die "production process audit does not pin its procfs root"

case $- in
  *f*) ;;
  *) die "noglob was not enabled before the process audit" ;;
esac

clean_root=${work_root}/clean-proc
mkdir -m 0700 "${clean_root}" "${clean_root}/17" "${clean_root}/not-a-pid"
ln -s /usr/bin/harmless "${clean_root}/17/exe"
ln -s /jail/cloud-hypervisor "${clean_root}/not-a-pid/exe"
if find_forbidden_process_in "${clean_root}" >/dev/null; then
  die "clean fixture reported a forbidden executable"
else
  status=$?
  [ "${status}" -eq 1 ] || die "clean fixture returned status ${status}, expected 1"
fi

forbidden_root=${work_root}/forbidden-proc
mkdir -m 0700 "${forbidden_root}" "${forbidden_root}/23"
ln -s '/jail/cloud-hypervisor-regression (deleted)' "${forbidden_root}/23/exe"
if forbidden_process=$(find_forbidden_process_in "${forbidden_root}"); then
  :
else
  status=$?
  die "forbidden fixture was not detected (status ${status})"
fi
[ "${forbidden_process}" = "cloud-hypervisor-regression:${forbidden_root}/23/exe" ] || \
  die "process audit returned the wrong executable: ${forbidden_process}"

denied_root=${work_root}/denied-proc
mkdir -m 0700 "${denied_root}" "${denied_root}/41"
ln -s /jail/kino "${denied_root}/41/exe"
chmod 000 "${denied_root}/41"
if [ "$(id -u)" -eq 0 ]; then
  echo "intar installer process-audit test: EACCES fixture skipped for root caller"
elif find_forbidden_process_in "${denied_root}" >/dev/null 2>&1; then
  die "process audit ignored an unreadable live executable"
else
  status=$?
  [ "${status}" -eq 2 ] || die "EACCES fixture returned status ${status}, expected 2"
fi

case $- in
  *f*) ;;
  *) die "process audit disabled noglob" ;;
esac

echo "intar installer process-audit test: deterministic fixtures passed with noglob enabled"
