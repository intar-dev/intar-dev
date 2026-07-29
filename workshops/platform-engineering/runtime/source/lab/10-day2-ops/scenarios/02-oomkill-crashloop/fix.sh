#!/usr/bin/env bash
# Canonical repair for scenario 02: revert the traced rightsizing commit and push,
# against the attendee's cloudbox/platform clone (never cloudbox/demo-app —
# that repo is unrelated Go source, see inject.sh's header comment).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime lookup is anchored to this script; ShellCheck cannot resolve $DIR.
# shellcheck disable=SC1091
source "$DIR/../../../common.sh"

COMPONENT_PATH="gitops/components/demo/demo-web.yaml"
POISON_VALUE="8Mi"
POISON_MARKER="memory: $POISON_VALUE"
SCENARIO_TRAILER="Cloudbox-Scenario: day2-02"

CLONE="$(gitops_clone)" || exit 1
TMP_PARENT="$(dirname "$CLONE")"
trap 'rm -rf "$TMP_PARENT"' EXIT

if [ ! -f "$CLONE/$COMPONENT_PATH" ] || \
  ! grep -Fq -- "$POISON_MARKER" "$CLONE/$COMPONENT_PATH"; then
  echo "scenario 2 was never injected — skipping"
  exit 0
fi

INJECTED_SHA="$(git -C "$CLONE" log --format='%H' \
  --grep="$SCENARIO_TRAILER" -n 1 -- "$COMPONENT_PATH")"
if [ -z "$INJECTED_SHA" ]; then
  echo "ERROR: $POISON_MARKER is present, but no '$SCENARIO_TRAILER' commit was found." >&2
  echo "Inspect git log and revert the commit that introduced the tight memory allocation manually." >&2
  exit 1
fi

if ! git -C "$CLONE" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
  revert --no-edit "$INJECTED_SHA"; then
  echo "ERROR: git revert conflicted — inspect the commits after ${INJECTED_SHA:0:12} and revert the memory allocation change manually." >&2
  exit 1
fi
REVERT_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"
git -C "$CLONE" push -q origin main
argocd_refresh demo

echo "✅ scenario 2 restored with revert commit $REVERT_SHA"
