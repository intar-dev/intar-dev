#!/usr/bin/env bash
# Canonical repair for scenario 01: revert the traced release commit and push,
# against the attendee's cloudbox/platform clone (never cloudbox/demo-app —
# that repo is unrelated Go source, see inject.sh's header comment).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime lookup is anchored to this script; ShellCheck cannot resolve $DIR.
# shellcheck disable=SC1091
source "$DIR/../../../common.sh"

COMPONENT_PATH="gitops/components/demo/demo-web.yaml"
POISON_VALUE="8080-canary"
SCENARIO_TRAILER="Cloudbox-Scenario: day2-01"

CLONE="$(gitops_clone)" || exit 1
TMP_PARENT="$(dirname "$CLONE")"
trap 'rm -rf "$TMP_PARENT"' EXIT

if [ ! -f "$CLONE/$COMPONENT_PATH" ] || \
  ! grep -Fq -- "$POISON_VALUE" "$CLONE/$COMPONENT_PATH"; then
  echo "scenario 1 was never injected — skipping"
  exit 0
fi

INJECTED_SHA="$(git -C "$CLONE" log --format='%H' \
  --grep="$SCENARIO_TRAILER" -n 1 -- "$COMPONENT_PATH")"
if [ -z "$INJECTED_SHA" ]; then
  echo "ERROR: $POISON_VALUE is present, but no '$SCENARIO_TRAILER' commit was found." >&2
  echo "Inspect git log and revert the commit that introduced the PORT value manually." >&2
  exit 1
fi

if ! git -C "$CLONE" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
  revert --no-edit "$INJECTED_SHA"; then
  echo "ERROR: git revert conflicted — inspect the commits after ${INJECTED_SHA:0:12} and revert the PORT change manually." >&2
  exit 1
fi
REVERT_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"
git -C "$CLONE" push -q origin main
argocd_refresh demo

echo "✅ scenario 1 restored with revert commit $REVERT_SHA"
