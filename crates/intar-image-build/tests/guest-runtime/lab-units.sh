#!/usr/bin/env bash
# Functional check for the laboratory unit move in the image finalization.
#
# The test substitutes the work and system directory placeholders with a
# temporary tree and the function placeholder with the generated
# finalization function. The systemd action is the only stub, so the check
# observes the real link moves.
set -uo pipefail

work=@WORK@
system_dir=@SYSTEM_DIR@
mkdir -p "$system_dir/multi-user.target.wants" "$system_dir/k3s.service.wants" \
  "$system_dir/intar-lab.target.wants"
printf '[Unit]\n' >"$system_dir/k3s.service"
: >"$system_dir/multi-user.target.wants/k3s.service"
: >"$system_dir/k3s.service.wants/keep.conf"
log_phase() { :; }

# install -d is stubbed because this check owns the temporary tree, so the
# stub creates the directory that the generated command would create.
install() {
  local last
  for last in "$@"; do :; done
  mkdir -p "$last"
}

systemctl() { printf '%s\n' "$*" >>"$work/calls.txt"; }

@FUNCTION@

configure_lab_services

failures=0
require() {
  local label="$1"
  shift
  if "$@"; then
    echo "PASS $label"
  else
    echo "FAIL $label"
    failures=$((failures + 1))
  fi
}

require "the laboratory unit leaves the boot path" \
  test ! -e "$system_dir/multi-user.target.wants/k3s.service"
require "the laboratory unit starts from the lab target" \
  test "$(readlink "$system_dir/intar-lab.target.wants/k3s.service")" = "$system_dir/k3s.service"
require "an absent unit gets no laboratory link" \
  test ! -e "$system_dir/intar-lab.target.wants/k3s-agent.service"
require "a unit dependency directory is kept" \
  test -e "$system_dir/k3s.service.wants/keep.conf"
require "the move reloads systemd once and runs no other verb" \
  test "$(cat "$work/calls.txt")" = "daemon-reload"

echo "failures=$failures"
exit "$failures"
