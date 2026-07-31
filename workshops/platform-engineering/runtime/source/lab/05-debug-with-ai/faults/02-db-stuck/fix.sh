#!/usr/bin/env bash
# Fault 02 fix: the storageClass on a PVC is immutable — editing the Cluster
# spec does NOT rebind the already-created Pending PVC. Recovery is
# delete-and-recreate (fine for a fresh cluster; on a real one you'd migrate).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../common.sh
source "$DIR/../../../common.sh"

kubectl -n faultlab-02 delete cluster orders-db --ignore-not-found --wait=true
kubectl -n faultlab-02 delete pvc -l cnpg.io/cluster=orders-db --ignore-not-found
kubectl apply -f "$DIR/fix.yaml"
wait_condition faultlab-02 cluster/orders-db Ready 300
