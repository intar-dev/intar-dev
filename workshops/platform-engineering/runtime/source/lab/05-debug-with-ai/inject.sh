#!/usr/bin/env bash
# Inject a fault into your cluster: ./inject.sh <1-4>
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: ./inject.sh <fault-number>"
  echo "faults:"
  for d in "$DIR"/faults/*/; do
    echo "  $(basename "$d")"
  done
  exit 1
}

[ $# -eq 1 ] || usage
printf -v NN '%02d' "$1" 2>/dev/null || usage

FAULT_DIR=""
for d in "$DIR/faults/$NN"-*/; do
  [ -d "$d" ] && FAULT_DIR="${d%/}" && break
done
[ -n "$FAULT_DIR" ] || { echo "ERROR: no fault $NN"; usage; }

if [ -x "$FAULT_DIR/issue.sh" ]; then
  "$FAULT_DIR/issue.sh"
else
  kubectl apply -f "$FAULT_DIR/issue.yaml" >/dev/null
fi

echo "💥 Fault $(basename "$FAULT_DIR") injected into namespace faultlab-$NN."
echo
echo "Your job: find it, prove it, fix it. Start with:"
echo "  kubectl -n faultlab-$NN get all"
echo
echo "NO PEEKING at faults/$(basename "$FAULT_DIR")/description.md or fix.yaml"
echo "until you have written down a diagnosis. Stuck for real? That file is the spoiler."
echo "Give up / done: ./restore.sh $1"
