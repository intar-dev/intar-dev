#!/usr/bin/env bash
set -euo pipefail

# Upstream's generic catch-up requires solutions/module-NN/apps and therefore
# intentionally cannot represent module 01. The pinned module-01 solve
# contract is to create the Talos-in-Docker cluster, then wait for both nodes.
readonly workshop_root=/opt/platform-engineering-workshop
cd "${workshop_root}"

# create-cluster.sh rejects an existing cluster. Keep canonical publication
# idempotent for a healthy resumed build without destroying state in place.
if [[ -n "$(docker ps -aq --filter 'label=talos.cluster.name=cloudbox' 2>/dev/null)" ]]; then
  echo "cloudbox cluster already exists; checking readiness"
else
  ./scripts/create-cluster.sh
fi

exec kubectl wait --for=condition=Ready nodes --all --timeout=300s
