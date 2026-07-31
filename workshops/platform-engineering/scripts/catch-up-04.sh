#!/usr/bin/env bash
# Trusted checkpoint reconstruction adapted from pinned module 04.
# Module 04 — full solution: ship the platform API and consume it.
set -euo pipefail

LAB_DIR="/opt/platform-engineering-workshop/lab/04-self-service"
REPO_ROOT="/opt/platform-engineering-workshop"
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
# platform-api is the app that ships the XRD. The null-safe condition
# helper treats both a not-yet-served XRD and an initial null conditions field as
# pending, closing the gap between "ArgoCD applied it" and "it's Established".
wait_app platform-api
wait_condition "" xrd/workshopdatabases.platform.cloudbox.io Established 180
wait_app demo

# 3. Nudge the demo app in case it first-synced before the XRD existed, then
# wait for the XR object to appear before waiting on its readiness.
kubectl -n argocd annotate application demo argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1 || true
for _ in $(seq 1 60); do
  kubectl -n demo get workshopdatabase/my-db >/dev/null 2>&1 && break
  sleep 5
done

# Wait for the developer's stack to be fully Ready (DB boot takes minutes).
wait_condition demo workshopdatabase/my-db Ready 600

kubectl -n demo get workshopdatabase,cluster,job
