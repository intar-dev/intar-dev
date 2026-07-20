# Canonical solution for module 02

This is adapted verbatim from the pinned upstream `solve.sh`. Reveal it only after the learner has chosen to see the solution.

```bash
#!/usr/bin/env bash
# Module 02 — full solution: bootstrap GitOps and make the first change via git.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAB_DIR/../.." && pwd)"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

# 1. Bootstrap Gitea + ArgoCD and seed the repo (skip if already done).
# Marker for "bootstrap already ran" is the ArgoCD server Deployment — the
# `platform` Application only appears later, when seed-gitea.sh creates it.
if ! kubectl -n argocd get deploy argocd-server >/dev/null 2>&1; then
  "$REPO_ROOT/scripts/bootstrap-gitops.sh"
fi
if ! curl -fsS --max-time 5 -u gitea_admin:cloudbox123 \
     http://localhost:30300/api/v1/repos/cloudbox/platform >/dev/null 2>&1; then
  "$REPO_ROOT/scripts/seed-gitea.sh"
fi

wait_app platform
wait_app local-path-provisioner

# 2. The GitOps change: demo Application + welcome ConfigMap, via git push.
CLONE="$(gitops_clone)"
cp "$LAB_DIR/demo-app.yaml" "$CLONE/gitops/apps/demo.yaml"
mkdir -p "$CLONE/gitops/components/demo"
sed 's/CHANGE ME/Cloudbox Attendee/' "$LAB_DIR/welcome.yaml" \
  > "$CLONE/gitops/components/demo/welcome.yaml"
gitops_push "$CLONE" "module 02: demo app with welcome configmap"

# 3. Watch it converge.
wait_app demo
kubectl -n demo get configmap welcome -o jsonpath='{.data.owner}'; echo
```
