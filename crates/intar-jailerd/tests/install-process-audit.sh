#!/bin/sh
set -eu
set -f

die() {
  echo "intar installer process-audit test: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || die "usage: $0 INSTALLER"
[ "$(uname -s)" = Linux ] || {
  echo "intar installer process-audit test: skipped outside Linux"
  exit 0
}

installer=$1
[ -f "${installer}" ] || die "installer does not exist: ${installer}"

for command in awk chmod cp mktemp python3 readlink rm sleep; do
  command -v "${command}" >/dev/null 2>&1 || die "required command is missing: ${command}"
done

work_root=$(mktemp -d)
process_pid=
cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  if [ -n "${process_pid}" ]; then
    kill "${process_pid}" >/dev/null 2>&1 || true
    wait "${process_pid}" 2>/dev/null || true
  fi
  rm -rf -- "${work_root}"
  exit "${status}"
}
trap cleanup 0
trap 'exit 130' HUP INT TERM

# Exercise the exact function body shipped by install.sh without running the
# privileged installer around it.
function_file=${work_root}/find-forbidden-process.sh
awk '
  $0 == "# INTAR_INSTALL_PROCESS_AUDIT_BEGIN" { capture = 1; next }
  $0 == "# INTAR_INSTALL_PROCESS_AUDIT_END" { found = 1; exit }
  capture { print }
  END { if (!found) exit 1 }
' "${installer}" > "${function_file}" || die "could not extract process-audit function"
# shellcheck source=/dev/null
. "${function_file}"

case $- in
  *f*) ;;
  *) die "noglob was not enabled before the process audit" ;;
esac

sleep_binary=$(command -v sleep)
forbidden_binary=${work_root}/cloud-hypervisor-regression
cp "${sleep_binary}" "${forbidden_binary}"
chmod 0700 "${forbidden_binary}"
"${forbidden_binary}" 60 &
process_pid=$!

process_ready=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if target=$(readlink "/proc/${process_pid}/exe" 2>/dev/null) && \
     [ "${target}" = "${forbidden_binary}" ]; then
    process_ready=true
    break
  fi
  sleep 0.05
done
[ "${process_ready}" = true ] || die "forbidden fixture process did not become observable"

if forbidden_process=$(find_forbidden_process); then
  :
else
  status=$?
  die "live forbidden executable was not detected (status ${status})"
fi
[ "${forbidden_process}" = "cloud-hypervisor-regression:/proc/${process_pid}/exe" ] || \
  die "process audit returned the wrong executable: ${forbidden_process}"

case $- in
  *f*) ;;
  *) die "process audit disabled noglob" ;;
esac

kill "${process_pid}"
wait "${process_pid}" 2>/dev/null || true
process_pid=
if find_forbidden_process >/dev/null; then
  die "clean process audit reported a forbidden executable"
else
  status=$?
  [ "${status}" -eq 1 ] || die "clean process audit returned status ${status}, expected 1"
fi

case $- in
  *f*) ;;
  *) die "clean process audit disabled noglob" ;;
esac

echo "intar installer process-audit test: live rejection and clean scan passed with noglob enabled"
