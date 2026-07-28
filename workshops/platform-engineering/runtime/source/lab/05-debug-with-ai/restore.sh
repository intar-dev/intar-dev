#!/usr/bin/env bash
# Restore fault scenarios to a healthy state.
#   ./restore.sh <1-4>   fix one fault (applies its fix)
#   ./restore.sh all     fix every injected fault
#   ./restore.sh clean   delete all fault namespaces entirely
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

restore_one() { # <NN>
  local NN="$1" fault_dir=""
  for d in "$DIR/faults/$NN"-*/; do
    [ -d "$d" ] && fault_dir="${d%/}" && break
  done
  [ -n "$fault_dir" ] || { echo "ERROR: no fault $NN"; return 1; }

  if ! kubectl get namespace "faultlab-$NN" >/dev/null 2>&1; then
    echo "fault $NN was never injected (no namespace faultlab-$NN) — skipping"
    return 0
  fi

  echo "restoring $(basename "$fault_dir") ..."
  if [ -x "$fault_dir/fix.sh" ]; then
    "$fault_dir/fix.sh"
  else
    kubectl apply -f "$fault_dir/fix.yaml" >/dev/null
  fi
  echo "✅ $(basename "$fault_dir") restored"
}

case "${1:-}" in
  clean)
    for n in 01 02 03 04; do
      kubectl delete namespace "faultlab-$n" --ignore-not-found --wait=false
    done
    echo "🧹 all fault namespaces deleted (deletion runs in background)"
    ;;
  all)
    for n in 01 02 03 04; do restore_one "$n"; done
    ;;
  ''|-h|--help)
    echo "usage: ./restore.sh <1-4> | all | clean"; exit 1
    ;;
  *)
    # Force base-10: a bare '%02d' chokes on "08"/"09" (leading zero = octal).
    case "$1" in
      *[!0-9]*) echo "usage: ./restore.sh <1-4> | all | clean"; exit 1 ;;
    esac
    printf -v NN '%02d' "$((10#$1))"
    restore_one "$NN"
    ;;
esac
