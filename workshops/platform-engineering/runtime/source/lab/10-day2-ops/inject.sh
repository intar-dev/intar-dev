#!/usr/bin/env bash
# Inject a day-2 operations scenario: ./inject.sh <scenario-number>
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: ./inject.sh <scenario-number>"
  echo "scenarios:"
  for d in "$DIR"/scenarios/[0-9][0-9]-*/; do
    [ -d "$d" ] || continue
    echo "  $(basename "$d")"
  done
  exit 1
}

[ $# -eq 1 ] || usage
case "$1" in
  *[!0-9]*|'') usage ;;
esac
# Force base-10 so future scenarios 08 and 09 do not trip over shell octal parsing.
printf -v NN '%02d' "$((10#$1))"

SCENARIO_DIR=""
for d in "$DIR/scenarios/$NN"-*/; do
  [ -d "$d" ] && SCENARIO_DIR="${d%/}" && break
done
[ -n "$SCENARIO_DIR" ] || { echo "ERROR: no scenario $NN" >&2; usage; }

if [ ! -x "$SCENARIO_DIR/inject.sh" ]; then
  echo "ERROR: scenario $NN has no executable inject.sh" >&2
  exit 1
fi

"$SCENARIO_DIR/inject.sh"
