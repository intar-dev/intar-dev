#!/usr/bin/env bash
# =============================================================================
# destroy-cluster.sh — tear down the CloudBox Talos cluster
#
# Destroys the Talos Docker cluster and removes its kubeconfig entries.
# The Intar direct-cloud runtime has no local image mirror to preserve.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"


need talosctl
need docker

step "Destroying Talos cluster '${CLUSTER_NAME}'"
# Talos labels every node container with talos.cluster.name=<cluster>
if [[ -n "$(docker ps -aq --filter "label=talos.cluster.name=${CLUSTER_NAME}")" ]]; then
  talosctl cluster destroy --name "${CLUSTER_NAME}" --force
  ok "Cluster destroyed"
else
  warn "No '${CLUSTER_NAME}' cluster found — nothing to destroy"
fi

# --- Clean up kubeconfig / talosconfig contexts (best effort) -----------------
if have kubectl; then
  kubectl config delete-context "admin@${CLUSTER_NAME}" >/dev/null 2>&1 || true
  kubectl config delete-cluster "${CLUSTER_NAME}" >/dev/null 2>&1 || true
  kubectl config delete-user "admin@${CLUSTER_NAME}" >/dev/null 2>&1 || true
  ok "kubeconfig entries removed"
fi
talosctl config remove "${CLUSTER_NAME}" --noconfirm >/dev/null 2>&1 || true


echo
ok "Done. Recreate with: ./scripts/create-cluster.sh"
