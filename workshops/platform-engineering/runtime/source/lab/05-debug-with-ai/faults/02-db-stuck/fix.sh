#!/usr/bin/env bash
# Fault 02 fix: the storageClass on a PVC is immutable — editing the Cluster
# spec does NOT rebind the already-created Pending PVC. Recovery is
# delete-and-recreate (fine for a fresh cluster; on a real one you'd migrate).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

kubectl -n faultlab-02 delete cluster orders-db --ignore-not-found --wait=true
kubectl -n faultlab-02 delete pvc -l cnpg.io/cluster=orders-db --ignore-not-found
kubectl apply -f "$DIR/fix.yaml"
kubectl -n faultlab-02 wait --for=condition=Ready cluster/orders-db --timeout=300s
