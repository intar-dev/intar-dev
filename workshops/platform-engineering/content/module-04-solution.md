# Canonical solution for module 04

This is adapted from the pinned upstream `solve.sh` for Intar's digest-pinned external runtime. Reveal it only after the learner has chosen to see the solution.

```bash
#!/usr/bin/env bash
# Module 04 — full solution: ship the platform API and consume it.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAB_DIR/../.." && pwd)"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

# 1. One push: enable crossplane, ship XRD+Composition, create the first XR.
CLONE="$(gitops_clone)"
enable_catalog "$CLONE" crossplane.yaml
mkdir -p "$CLONE/gitops/components/platform-api" "$CLONE/gitops/components/demo"
cp "$LAB_DIR/platform/xrd.yaml"         "$CLONE/gitops/components/platform-api/"
cp "$LAB_DIR/platform/composition.yaml" "$CLONE/gitops/components/platform-api/"
cp "$LAB_DIR/platform-api-app.yaml"     "$CLONE/gitops/apps/platform-api.yaml"
cp "$LAB_DIR/examples/my-database.yaml" "$CLONE/gitops/components/demo/"
gitops_push "$CLONE" "module 04: crossplane + WorkshopDatabase API + my-db"

# 2. Wait for the machinery. The XRD must be Established before the my-db XR
# can be applied — the demo app can otherwise report Synced having SKIPPED the
# XR (SkipDryRunOnMissingResource), leaving it "not found". Same race as
# module 03; found by rehearsal-in-CI.
wait_app crossplane
# platform-api is the app that ships the XRD — wait for ArgoCD to sync it FIRST,
# otherwise `kubectl wait --for=condition=Established` below hits the XRD before
# it exists and fails IMMEDIATELY with NotFound (the --timeout only applies once
# the object exists, not while waiting for it to appear). Then poll until the
# API server actually serves the XRD, closing the gap between "ArgoCD applied
# it" and "it's queryable", before waiting on the Established condition.
wait_app platform-api
for _ in $(seq 1 60); do
  kubectl get xrd/workshopdatabases.platform.cloudbox.io >/dev/null 2>&1 && break
  sleep 2
done
kubectl wait --for=condition=Established \
  xrd/workshopdatabases.platform.cloudbox.io --timeout=180s
wait_app demo

# 3. Nudge the demo app in case it first-synced before the XRD existed, then
# wait for the XR object to appear before waiting on its readiness.
kubectl -n argocd annotate application demo argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1 || true
for _ in $(seq 1 60); do
  kubectl -n demo get workshopdatabase/my-db >/dev/null 2>&1 && break
  sleep 5
done

# Wait for the developer's stack to be fully Ready (DB boot takes minutes).
kubectl -n demo wait --for=condition=Ready \
  workshopdatabase/my-db --timeout=600s

kubectl -n demo get workshopdatabase,cluster,job
```
