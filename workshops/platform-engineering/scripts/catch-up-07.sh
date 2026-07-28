#!/usr/bin/env bash
# Trusted checkpoint reconstruction adapted from pinned module 07.
# Module 07 — full solution: enable zot + argo-workflows, build in-cluster,
# deploy the result via GitOps.
set -euo pipefail

LAB_DIR="/opt/platform-engineering-workshop/lab/07-ci"
REPO_ROOT="/opt/platform-engineering-workshop"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

# 1. Enable the pipeline machinery.
CLONE="$(gitops_clone)"
enable_catalog "$CLONE" zot.yaml argo-workflows.yaml
gitops_push "$CLONE" "module 07: enable zot + argo-workflows"

wait_app zot
wait_app argo-workflows
# wait_app returns on app HEALTH, but argo-workflows can be Healthy while still
# OutOfSync — the build-and-push WorkflowTemplate syncs a beat after the
# controller. Guard so the submit below can't race ahead of the template it
# references (else the Workflow errors "workflowtemplates ... build-and-push not
# found"). This is the exact case wait_exists exists for.
wait_exists builds workflowtemplate/build-and-push 180

# 2. Seed YOUR registry with the (pre-pulled) base image — the app's Dockerfile
#    builds FROM zot.zot.svc.cluster.local:5000, so the platform never touches
#    an external registry. Host-side crane against Zot's NodePort (plain HTTP).
crane copy --insecure \
  docker.io/library/busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028 localhost:30500/library/busybox:1.37.0

# 3. Build inside the cluster.
WF_NAME="$(kubectl create -f "$LAB_DIR/workflow-run.yaml" -o jsonpath='{.metadata.name}')"
echo "submitted workflow: $WF_NAME"

WAITED=0
while true; do
  PHASE="$(kubectl -n builds get workflow "$WF_NAME" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "$PHASE" in
    Succeeded) echo "workflow Succeeded"; break ;;
    Failed|Error) echo "workflow $PHASE" >&2; kubectl -n builds get workflow "$WF_NAME" -o yaml >&2; exit 1 ;;
  esac
  [ "$WAITED" -ge 900 ] && { echo "timed out waiting for build" >&2; exit 1; }
  sleep 15; WAITED=$((WAITED + 15))
done

curl -fsS http://localhost:30500/v2/_catalog

# 4. Run the built image, delivered via GitOps.
CLONE="$(gitops_clone)"
mkdir -p "$CLONE/gitops/components/demo"
cp "$LAB_DIR/hello-site.yaml" "$CLONE/gitops/components/demo/hello-site.yaml"
gitops_push "$CLONE" "module 07: deploy hello-site from zot"

# The demo app already exists and is Synced/Healthy from module 06, so a bare
# `wait_app demo` returns immediately on the PREVIOUS revision — before ArgoCD
# reconciles this hello-site commit — and the Deployment isn't there yet. Poll
# for it to actually appear (hard-refresh + wait), then gate on its rollout.
# (Same stale-revision race the wait_for_cr helper was built for, modules 03/04/06.)
wait_for_cr demo deploy/hello-site
kubectl -n demo rollout status deploy/hello-site --timeout=300s
