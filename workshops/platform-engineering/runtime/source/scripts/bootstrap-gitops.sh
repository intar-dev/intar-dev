#!/usr/bin/env bash
# =============================================================================
# bootstrap-gitops.sh — module 2: install Gitea + ArgoCD (the GitOps engine)
#
# This is the only imperative install in the workshop — everything after this
# is delivered as ArgoCD Applications from the in-cluster Gitea. It installs:
#
#   1. local-path-provisioner (vendored manifest) — Gitea's PVC needs a
#      storage class before GitOps exists; ArgoCD adopts it in wave 0 later
#   2. Gitea (official chart, pinned) — single-pod SQLite mode, push-to-create
#      enabled, admin gitea_admin/cloudbox123, NodePort 30300
#   3. ArgoCD (vendored install.yaml, pinned) — NodePort 30080, plus the
#      Application-CRD health check in argocd-cm (without it, app-of-apps
#      sync waves don't gate — the most-missed step; see docs/RESEARCH.md §3)
#
# Usage:
#   ./scripts/bootstrap-gitops.sh
#
# Requires: a running cluster (./scripts/create-cluster.sh). Fully offline:
# the Gitea chart and the ArgoCD install manifest are vendored into
# scripts/manifests/, and images come from the cloudbox-mirror.
# Idempotent: safe to re-run.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

need kubectl
need helm

kubectl get nodes >/dev/null 2>&1 \
  || die "Cannot reach a cluster. Run ./scripts/create-cluster.sh first."

# --- 1. Storage class -----------------------------------------------------------
step "Installing local-path-provisioner ${LOCAL_PATH_PROVISIONER_VERSION} (storage for Gitea)"
# Applied straight from the gitops component — the SAME manifest the wave-0
# ArgoCD Application later adopts, so the two can never drift. Server-side
# apply avoids field-ownership conflicts on adoption.
kubectl apply --server-side --force-conflicts \
  -f "${REPO_ROOT}/gitops/components/local-path-provisioner/local-path-storage.yaml"
wait_rollout local-path-storage deployment/local-path-provisioner
ok "Default storage class 'local-path' ready"

# --- 2. Gitea ----------------------------------------------------------------------
step "Installing Gitea (chart ${GITEA_CHART_VERSION}, vendored) — your cloud's git server"

# Chart is vendored into scripts/manifests/ (re-vendor from GITEA_HELM_REPO
# when bumping) so this needs no internet at the venue — principle 2.
# Single-pod mode: SQLite + in-memory cache/session, no HA subcharts. This is
# a workshop git server for ~1 user, not a production forge — and that is fine.
# Values are fed on stdin (-f -) to keep everything in this one readable file.
helm upgrade --install gitea \
  "${SCRIPT_DIR}/manifests/gitea-${GITEA_CHART_VERSION}.tgz" \
  --namespace gitea --create-namespace \
  -f - <<EOF
image:
  registry: docker.gitea.com
  repository: gitea
  tag: ""
  digest: sha256:4c4256497e2e237ddebdd30986c7ce52cb6f936b3e90c34bb9f4665714599f62
  rootless: true

service:
  http:
    type: NodePort
    nodePort: ${NODEPORT_GITEA}
    clusterIP: ""

# Disable all HA subcharts — single pod, SQLite on a PVC.
postgresql:
  enabled: false
postgresql-ha:
  enabled: false
valkey:
  enabled: false
valkey-cluster:
  enabled: false

persistence:
  enabled: true
  size: 5Gi

gitea:
  admin:
    username: ${GITEA_ADMIN_USER}
    password: ${GITEA_ADMIN_PASSWORD}
    email: ${GITEA_ADMIN_USER}@cloudbox.local
  config:
    database:
      DB_TYPE: sqlite3
    session:
      PROVIDER: memory
    cache:
      ADAPTER: memory
    queue:
      TYPE: level
    repository:
      # push-to-create: pushing to a repo that does not exist yet creates it
      ENABLE_PUSH_CREATE_USER: true
      ENABLE_PUSH_CREATE_ORG: true
      # ArgoCD polls anonymously — repos must be born public
      DEFAULT_PUSH_CREATE_PRIVATE: false
    server:
      DOMAIN: localhost
      ROOT_URL: http://localhost:${NODEPORT_GITEA}/
      LOCAL_ROOT_URL: ${GITEA_CLUSTER_URL}/
      PUBLIC_URL_DETECTION: auto
EOF

# --- 3. ArgoCD ------------------------------------------------------------------------
step "Installing ArgoCD ${ARGOCD_VERSION} (vendored manifest — no internet needed)"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# --server-side: the ApplicationSet CRD exceeds client-side annotation limits.
kubectl apply --server-side --force-conflicts -n argocd \
  -f "${SCRIPT_DIR}/manifests/argocd-install-${ARGOCD_VERSION}.yaml"

info "Restoring the Application-CRD health check (argocd-cm) so sync waves gate"
info "  + treating metrics-less HPAs as Healthy (this lab has no metrics-server)"
kubectl patch configmap argocd-cm -n argocd --type merge --patch-file /dev/stdin <<'EOF'
data:
  resource.customizations.health.argoproj.io_Application: |
    hs = {}
    hs.status = "Progressing"
    hs.message = ""
    if obj.status ~= nil then
      if obj.status.health ~= nil then
        hs.status = obj.status.health.status
        if obj.status.health.message ~= nil then
          hs.message = obj.status.health.message
        end
      end
    end
    return hs
  # This lab has no metrics-server (observability is VictoriaMetrics/OTel), so
  # HPAs that key on CPU can't fetch metrics. ArgoCD's default HPA health then
  # reports Degraded, which cascades to mark the whole owning app Degraded —
  # e.g. knative-eventing ships broker-ingress/-filter HPAs, so its app flipped
  # to Degraded over time even though every eventing workload is Running/Ready.
  # An idle autoscaler is not a broken capability in a single-user lab: report
  # HPAs Healthy so an unused scaler can't red-flag a working component.
  resource.customizations.health.autoscaling_HorizontalPodAutoscaler: |
    hs = {}
    hs.status = "Healthy"
    hs.message = ""
    if obj.status ~= nil and obj.status.conditions ~= nil then
      for _, c in ipairs(obj.status.conditions) do
        if c.type == "ScalingActive" and c.status == "False"
           and c.reason == "FailedGetResourceMetric" then
          hs.message = "autoscaler idle — no metrics-server in this lab (workloads healthy)"
        end
      end
    end
    return hs
EOF

info "Creating read-only 'backstage' ArgoCD account (used by the module-08 portal)"
kubectl patch configmap argocd-cm -n argocd --type merge \
  -p '{"data":{"accounts.backstage":"apiKey, login"}}'
kubectl patch configmap argocd-rbac-cm -n argocd --type merge --patch-file /dev/stdin <<'EOF'
data:
  policy.csv: |
    g, backstage, role:readonly
EOF
# Workshop-grade password "cloudbox123", pre-hashed (bcrypt) so this works
# offline without the argocd CLI. Must match gitops/components/backstage.
kubectl patch secret argocd-secret -n argocd --type merge --patch-file /dev/stdin <<'EOF'
stringData:
  accounts.backstage.password: $2a$10$25nwQLqr5OyQijChv7urwu0fPnSsJdWgMfwB0UX9aRvubyFrfwbwK
  accounts.backstage.passwordMtime: "2026-07-13T00:00:00Z"
EOF

info "Exposing the ArgoCD UI on NodePort ${NODEPORT_ARGOCD} (plain http for the lab)"
# server.insecure: plain http for the lab.
# reposerver.max.combined... : the vendored Argo Workflows install is ~11 MB
# (huge CEL-validated CRDs) and exceeds the 10M default → the app never syncs
# ("exceeded max combined manifest file size"). Raise it. Found by rehearsal-in-CI.
kubectl patch configmap argocd-cmd-params-cm -n argocd --type merge \
  -p '{"data":{"server.insecure":"true","reposerver.max.combined.directory.manifests.size":"50M"}}'
kubectl patch service argocd-server -n argocd \
  -p "{\"spec\":{\"type\":\"NodePort\",\"ports\":[{\"port\":80,\"nodePort\":${NODEPORT_ARGOCD}}]}}"
# Restart both: server picks up server.insecure, repo-server the size limit.
kubectl -n argocd rollout restart deployment argocd-server argocd-repo-server >/dev/null

# --- 4. Wait for everything --------------------------------------------------------------
step "Waiting for Gitea and ArgoCD to become ready"
wait_rollout gitea deployment/gitea
wait_rollout argocd deployment/argocd-server
wait_rollout argocd deployment/argocd-repo-server
wait_rollout argocd statefulset/argocd-application-controller

echo
ok "GitOps engine is running."
echo
echo "  Gitea:   ${GITEA_HOST_URL}  (${GITEA_ADMIN_USER} / ${GITEA_ADMIN_PASSWORD})"
echo "  ArgoCD:  ${ARGOCD_HOST_URL}  (user: admin)"
echo
info "ArgoCD admin password:"
echo "   kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo"
echo
info "Next: ./scripts/seed-gitea.sh   # push this repo into your cloud"
