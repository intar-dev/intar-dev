#!/usr/bin/env bash
# Restore day-2 scenarios with their canonical Git revert.
#   ./restore.sh <n>     restore one scenario
#   ./restore.sh all     restore every currently injected scenario
#   ./restore.sh clean   same as all; no cluster resources are deleted directly
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: ./restore.sh <scenario-number> | all | clean"
  exit 1
}

restore_one() { # <NN>
  local NN="$1" scenario_dir=""
  for d in "$DIR/scenarios/$NN"-*/; do
    [ -d "$d" ] && scenario_dir="${d%/}" && break
  done
  [ -n "$scenario_dir" ] || { echo "ERROR: no scenario $NN" >&2; return 1; }
  [ -x "$scenario_dir/fix.sh" ] || {
    echo "ERROR: scenario $NN has no executable fix.sh" >&2
    return 1
  }

  echo "restoring $(basename "$scenario_dir") ..."
  "$scenario_dir/fix.sh"
}

restore_all() {
  # Best-effort: a failing scenario must not stop the others from restoring
  # (set -e would otherwise abort the loop at the first failure).
  local d name NN failed=0
  for d in "$DIR"/scenarios/[0-9][0-9]-*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    NN="${name%%-*}"
    if ! restore_one "$NN"; then
      failed=1
    fi
  done
  return "$failed"
}

case "${1:-}" in
  all|clean)
    # Both preserve Git as the only write path: revert all injected scenarios.
    restore_all
    ;;
  ''|-h|--help)
    usage
    ;;
  *)
    case "$1" in
      *[!0-9]*|'') usage ;;
    esac
    # Force base-10: a bare '%02d' rejects "08"/"09" as invalid octal.
    printf -v NN '%02d' "$((10#$1))"
    restore_one "$NN"
    ;;
esac
