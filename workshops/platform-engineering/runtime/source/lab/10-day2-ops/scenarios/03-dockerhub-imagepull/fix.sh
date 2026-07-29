#!/usr/bin/env bash
# Canonical repair for scenario 03: revert the traced registry commit and push,
# against the attendee's cloudbox/platform clone (never cloudbox/demo-app —
# that repo is unrelated Go source, see inject.sh's header comment).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime lookup is anchored to this script; ShellCheck cannot resolve $DIR.
# shellcheck disable=SC1091
source "$DIR/../../../common.sh"

COMPONENT_PATH="gitops/components/demo/demo-web.yaml"
# Predicate-based, not tied to a specific digest — matches inject.sh's
# IMAGE_DOCKERHUB_PATTERN (see its header comment for why).
IMAGE_DOCKERHUB_PATTERN="^[[:space:]]*image:[[:space:]]*[\"']?docker\.io/"
SCENARIO_TRAILER="Cloudbox-Scenario: day2-03"

CLONE="$(gitops_clone)" || exit 1
TMP_PARENT="$(dirname "$CLONE")"
trap 'rm -rf "$TMP_PARENT"' EXIT

if [ ! -f "$CLONE/$COMPONENT_PATH" ] || \
  ! grep -Eq -- "$IMAGE_DOCKERHUB_PATTERN" "$CLONE/$COMPONENT_PATH"; then
  echo "scenario 3 was never injected — skipping"
  exit 0
fi

INJECTED_SHA="$(git -C "$CLONE" log --format='%H' \
  --grep="$SCENARIO_TRAILER" -n 1 -- "$COMPONENT_PATH")"
if [ -z "$INJECTED_SHA" ]; then
  echo "ERROR: a docker.io/ image reference is present, but no '$SCENARIO_TRAILER' commit was found." >&2
  echo "Inspect git log and revert the commit that changed the image registry manually." >&2
  exit 1
fi

if ! git -C "$CLONE" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
  revert --no-edit "$INJECTED_SHA"; then
  echo "ERROR: git revert conflicted — inspect the commits after ${INJECTED_SHA:0:12} and revert the image registry change manually." >&2
  exit 1
fi
REVERT_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"
git -C "$CLONE" push -q origin main
argocd_refresh demo

echo "✅ scenario 3 restored with revert commit $REVERT_SHA"
