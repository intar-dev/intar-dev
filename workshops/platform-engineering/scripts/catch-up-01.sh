#!/usr/bin/env bash
# Trusted checkpoint reconstruction adapted from pinned module 01.
# Module 01 — full solution: create the cluster. (The exploration part of the
# module has no machine state to produce; verify.sh checks the cluster itself.)
set -euo pipefail

REPO_ROOT="/opt/platform-engineering-workshop"

# Idempotent: solve.sh's contract is "produce the module's end state", and it
# may already exist (re-runs, CI, catch-up) — create-cluster.sh itself refuses
# to run against an existing cluster. Found by rehearsal-in-CI run 5.
# -aq (not -q): match stopped containers too, so we agree with
# create-cluster.sh's own "already exists" check (it uses -aq) — otherwise a
# stopped cluster would slip past this guard and make create-cluster.sh die.
if [[ -n "$(docker ps -aq --filter "label=talos.cluster.name=cloudbox" 2>/dev/null)" ]]; then
  echo "cloudbox cluster already exists — skipping creation."
else
  "$REPO_ROOT/scripts/create-cluster.sh"
fi

# Wait for both nodes to be Ready (Cilium needs a moment after bootstrap).
kubectl wait --for=condition=Ready nodes --all --timeout=300s
