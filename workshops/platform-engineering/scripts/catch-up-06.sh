#!/usr/bin/env bash
# Trusted checkpoint reconstruction adapted from pinned module 06.
# Module 06 — full solution: enable knative, deploy the ksvc, exercise it once.
set -euo pipefail

LAB_DIR="/opt/platform-engineering-workshop/lab/06-serverless"
REPO_ROOT="/opt/platform-engineering-workshop"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

CLONE="$(gitops_clone)"
enable_catalog "$CLONE" knative-serving.yaml
mkdir -p "$CLONE/gitops/components/demo"
cp "$LAB_DIR/hello-ksvc.yaml" "$CLONE/gitops/components/demo/hello-ksvc.yaml"
gitops_push "$CLONE" "module 06: knative-serving + hello ksvc"

wait_app knative-serving
wait_app demo

# The hello ksvc can be skipped if demo synced before Knative's CRD was ready.
wait_for_cr demo ksvc/hello services.serving.knative.dev
kubectl -n demo wait --for=condition=Ready ksvc/hello --timeout=300s

# Strip the scheme in pure bash — BSD sed has no \? in basic regex.
URL="$(kubectl -n demo get ksvc hello -o jsonpath='{.status.url}')"
HOST="${URL#http://}"; HOST="${HOST#https://}"
echo "cold-starting hello via Kourier..."
curl -fsS --max-time 60 -H "Host: $HOST" http://localhost:31080/
