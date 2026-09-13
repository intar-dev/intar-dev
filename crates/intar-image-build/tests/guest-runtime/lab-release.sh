#!/usr/bin/env bash
# Functional check for the laboratory release channel.
#
# The test substitutes the work placeholder with a temporary directory and
# the functions placeholder with the generated supervisor functions. The
# systemd action is the only stub, so the check counts the real release
# decisions.
set -uo pipefail

work=@WORK@
runtime_state_path="$work/run"
mkdir -p "$runtime_state_path"
lab_release_fifo="$runtime_state_path/lab-release.fifo"
recording_user="$(id -un)"
INTAR_VM_HOSTNAME="klustered-server"
KINO_PID=$$
lab_release_fallback_seconds=0
lab_release_done=""
systemctl_calls=0
log_phase() { :; }
systemctl() { systemctl_calls=$((systemctl_calls + 1)); }

@FUNCTIONS@
# The guest clock source is /proc/uptime, which a host check does not have.
# The override is the host clock in whole milliseconds.
monotonic_millis() { local now=$EPOCHREALTIME; printf '%s' "${now:0:10}${now:11:3}"; }

release_once() {
  local event="$1"
  systemctl_calls=0
  lab_release_done=""
  rm -f "$lab_release_fifo"
  prepare_guest_channels
  exec {lab_release_fd}<>"$lab_release_fifo"
  if [ -n "$event" ]; then printf '%s\n' "$event" >"$lab_release_fifo"; fi
  release_lab_services >/dev/null 2>&1
  printf '%s' "$systemctl_calls"
}

release_once "INTAR_EVENT v2 recording_started vm=$INTAR_VM_HOSTNAME kino=$KINO_PID" >"$work/from-event"
release_once "" >"$work/from-fallback"
release_once "INTAR_EVENT v2 stop_everything" >"$work/from-unknown"

failures=0
require_count() {
  local label="$1" path="$2"
  local got
  got="$(cat "$path")"
  if [ "$got" = "1" ]; then
    echo "PASS $label"
  else
    echo "FAIL $label: the laboratory target started $got times, expected 1"
    failures=$((failures + 1))
  fi
}

require_count "a recording event starts the laboratory target once" "$work/from-event"
require_count "the fallback timer starts the laboratory target once" "$work/from-fallback"
require_count "an unknown event is ignored and the fallback starts it once" "$work/from-unknown"

echo "failures=$failures"
exit "$failures"
