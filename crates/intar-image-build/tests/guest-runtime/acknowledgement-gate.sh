#!/usr/bin/env bash
# Functional check for the Kino startup acknowledgement gate.
#
# The test substitutes the work placeholder with a temporary directory and the
# functions placeholder with the generated supervisor functions. The rest is
# the real gate: the pipe, the child processes, the retry bound, and the
# decision logic. The fake Kino binaries and the clock are the only stand-ins.
#
# The clock is a counter that stays frozen until the case's child process
# signals that it is running. A case therefore can never reach its deadline
# before the child is scheduled, whatever the host load, and the decision cases
# never reach their deadline at all.
set -uo pipefail

work=@WORK@
runtime_state_path="$work/run"
mkdir -p "$runtime_state_path"
kino_log_path="$runtime_state_path/kino.log"
kino_ready_fifo="$runtime_state_path/kino-ready.fifo"
recording_user="$(id -un)"
kino_config_path="$work/kino.hcl"
kino_control_socket="$work/kino-control.sock"
lab_release_fifo="$work/lab-release.fifo"
export INTAR_KINO_SHA256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
export INTAR_VM_HOSTNAME="klustered-server"
KINO_VSOCK_CID=2
KINO_VSOCK_PORT=18080
kino_start_attempts=3
lab_release_fallback_seconds=1
kino_lab_release_uid=""
lab_release_done=""
KINO_PID=""
child_marker=""
log_phase() { :; }
install() { :; }
wait_for_vsock_ready() { :; }

# The generated supervisor reads the Kino configuration template from the
# image. The check owns that file so the step writes to a temporary path.
printf 'cid = __INTAR_KINO_CID__\nport = __INTAR_KINO_PORT__\n' >"$work/kino.hcl.tpl"

@FUNCTIONS@

# Every clock read advances CLOCK_STEP_MS, but only after the case's child
# process has signalled that it is running.
CLOCK_STEP_MS=1000
monotonic_millis() {
  local value step
  if [ -e "$child_marker" ]; then
    step=$CLOCK_STEP_MS
  else
    step=0
  fi
  value="$(cat "$work/monotonic-ms" 2>/dev/null || printf '0')"
  value=$((value + step))
  printf '%s\n' "$value" >"$work/monotonic-ms"
  printf '%s\n' "$value"
}

# Every fake child signals that it is running before it does anything else.
write_fake_kino() {
  local name="$1"
  {
    echo '#!/usr/bin/env bash'
    printf ': >"%s"\n' "$work/child-$name.started"
    cat
  } >"$work/fake-kino-$name"
  chmod 0755 "$work/fake-kino-$name"
}

failures=0

run_case() {
  local name="$1" expected_status="$2" expected_report="$3" timeout="$4"
  printf '0\n' >"$work/monotonic-ms"
  rm -f "$work/child-$name.started"
  child_marker="$work/child-$name.started"
  kino_ready_timeout_seconds=$timeout
  FAKE_KINO="$work/fake-kino-$name"
  local output status
  output="$( ( start_kino ) 2>&1 )"
  status=$?
  pkill -f "$work/fake-kino-$name" >/dev/null 2>&1 || true
  if [ "$status" != "$expected_status" ]; then
    echo "FAIL $name: exit $status, expected $expected_status"
    printf '%s\n' "$output" | tail -3
    failures=$((failures + 1))
    return 0
  fi
  if [ -n "$expected_report" ] && ! grep -qF "$expected_report" <<<"$output"; then
    echo "FAIL $name: the report did not contain: $expected_report"
    printf '%s\n' "$output" | tail -3
    failures=$((failures + 1))
    return 0
  fi
  echo "PASS $name"
}

# A decision case never reaches its deadline. The child's acknowledgement, its
# refusal, or its exit decides the case while the clock is far from the budget.
DECIDED=3600

write_fake_kino ready <<'FAKE'
printf 'INTAR_KINO_READY v2 sha256=%s pid=%s\n' "$INTAR_KINO_SHA256" "$$" >"$KINO_READY_FIFO"
sleep 30
FAKE
run_case ready 0 "" "$DECIDED"

write_fake_kino older <<'FAKE'
printf 'INTAR_KINO_READY v1 sha256=%s pid=%s\n' "$INTAR_KINO_SHA256" "$$" >"$KINO_READY_FIFO"
sleep 30
FAKE
run_case older 1 "unusable startup acknowledgement" "$DECIDED"

write_fake_kino foreign-digest <<'FAKE'
printf 'INTAR_KINO_READY v2 sha256=%s pid=%s\n' "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "$$" >"$KINO_READY_FIFO"
sleep 30
FAKE
run_case foreign-digest 1 "unusable startup acknowledgement" "$DECIDED"

write_fake_kino foreign-pid <<'FAKE'
printf 'INTAR_KINO_READY v2 sha256=%s pid=999999\n' "$INTAR_KINO_SHA256" >"$KINO_READY_FIFO"
sleep 30
FAKE
run_case foreign-pid 1 "unusable startup acknowledgement" "$DECIDED"

# The timeout case is the only one that waits for the deadline. The child
# signals that it is running and then stays silent, so the deadline is reached
# exactly one clock step after the child is known to be alive.
write_fake_kino silent <<'FAKE'
sleep 30
FAKE
run_case silent 1 "did not acknowledge startup before the deadline" 1

write_fake_kino early-exit <<'FAKE'
echo 'kino: no probe configured' >&2
exit 3
FAKE
run_case early-exit 1 "kino exited during startup" "$DECIDED"

write_fake_kino bind-failure <<'FAKE'
echo 'failed to bind vsock://2:18080' >&2
exit 1
FAKE
run_case bind-failure 1 "kino exited during startup" "$DECIDED"

echo "failures=$failures"
exit "$failures"
