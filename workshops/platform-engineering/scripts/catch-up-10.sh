#!/usr/bin/env bash
# Trusted checkpoint reconstruction adapted from pinned module 10.
# Canonical answer for attendees and the CI inject -> solve -> verify regression.
# Unlike module 05, solving this lab means reverting whatever is injected now;
# solve.sh must not inject a scenario of its own first.
set -euo pipefail

DIR="/opt/platform-engineering-workshop/lab/10-day2-ops"
REPO_ROOT="/opt/platform-engineering-workshop"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

# A normal cumulative run reaches module 10 without injecting a day-two fault.
# Revert any fault that does exist, then make the clean demo-web baseline an
# explicit part of the canonical checkpoint instead of relying on inject.sh's
# learner-only first-run setup path.
"$DIR/restore.sh" all

CLONE="$(gitops_clone)"
TMP_PARENT="$(dirname "$CLONE")"
trap 'rm -rf "$TMP_PARENT"' EXIT
COMPONENT_PATH="gitops/components/demo/demo-web.yaml"
BASELINE_SRC="$DIR/baseline/demo-web.yaml"

mkdir -p "$(dirname "$CLONE/$COMPONENT_PATH")"
# Only the absent baseline is a normal cumulative state. Known injected faults
# were reverted above; preserve any other drift so the verifier reports it.
if [[ ! -f "$CLONE/$COMPONENT_PATH" ]]; then
  cp "$BASELINE_SRC" "$CLONE/$COMPONENT_PATH"
  git -C "$CLONE" add "$COMPONENT_PATH"
  if ! git -C "$CLONE" diff --cached --quiet -- "$COMPONENT_PATH"; then
    git -C "$CLONE" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
      commit -q -m "module 10: restore demo-web baseline"
    git -C "$CLONE" push -q origin main
  fi
fi

argocd_refresh demo
wait_exists demo deployment/demo-web 300
kubectl -n demo rollout status deployment/demo-web --timeout=300s
