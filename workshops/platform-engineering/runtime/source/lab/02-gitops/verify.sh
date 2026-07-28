#!/usr/bin/env bash
# Module 02 — verify the GitOps loop end to end.
set -euo pipefail

FAILED=0
ok()   { echo "✅ $1"; }
fail() { echo "❌ FAIL: $1"; FAILED=$((FAILED + 1)); }

app_status() { # <name> -> "<sync> <health>"
  kubectl -n argocd get application "$1" \
    -o jsonpath='{.status.sync.status} {.status.health.status}' 2>/dev/null || echo "missing missing"
}

check_app() { # <name>
  # HEALTH is the real signal (workloads running); sync is advisory. Poll ~180s so
  # a transient OutOfSync/Progressing/Degraded while the app reconciles under CI
  # load rides out, instead of failing on a single point-in-time sample.
  local st sync health i
  for i in $(seq 1 36); do
    st="$(app_status "$1")"
    # Fast-fail the missing case: if the app doesn't exist yet, don't stare at the
    # full 180s poll — an attendee who runs verify.sh before enabling the catalog
    # item should get instant feedback. Allow ~10s (two iterations) for a
    # just-created app to register, then fall through to the fail below.
    case "$st" in
      missing|"missing missing"|"") [ "$i" -ge 2 ] && break ;;
    esac
    health="${st##* }"
    if [ "$health" = "Healthy" ]; then
      sync="${st%% *}"
      if [ "$sync" = "Synced" ]; then ok "ArgoCD app '$1' is Synced/Healthy"
      else ok "ArgoCD app '$1' is Healthy (sync: ${sync:-unknown})"; fi
      return 0
    fi
    sleep 5
  done
  fail "ArgoCD app '$1' is '$st' (want Healthy) — open http://localhost:30080 or: kubectl -n argocd get app $1 -o yaml"
}

# --- Gitea -------------------------------------------------------------------
if curl -fsS --max-time 5 http://localhost:30300/api/healthz >/dev/null 2>&1 \
   || curl -fsS --max-time 5 http://localhost:30300/ >/dev/null 2>&1; then
  ok "Gitea answers on http://localhost:30300"
else
  fail "Gitea not reachable on :30300 — did ./scripts/bootstrap-gitops.sh run? kubectl -n gitea get pods"
fi

if curl -fsS --max-time 5 -u gitea_admin:cloudbox123 \
     http://localhost:30300/api/v1/repos/cloudbox/platform >/dev/null 2>&1; then
  ok "repo cloudbox/platform exists in Gitea"
else
  fail "cloudbox/platform repo missing in Gitea — run ./scripts/seed-gitea.sh"
fi

# --- ArgoCD ------------------------------------------------------------------
if curl -fsSk --max-time 5 -o /dev/null http://localhost:30080/ 2>/dev/null \
   || curl -fsSk --max-time 5 -o /dev/null https://localhost:30080/ 2>/dev/null; then
  ok "ArgoCD UI answers on :30080"
else
  fail "ArgoCD UI not reachable on :30080 — kubectl -n argocd get pods,svc"
fi

REPO_URL="$(kubectl -n argocd get application platform -o jsonpath='{.spec.source.repoURL}' 2>/dev/null || true)"
if echo "$REPO_URL" | grep -q gitea; then
  ok "root app 'platform' watches the in-cluster Gitea ($REPO_URL)"
elif [ -n "$REPO_URL" ]; then
  fail "root app watches '$REPO_URL' — it must point at the in-cluster Gitea, never GitHub; re-run ./scripts/bootstrap-gitops.sh"
else
  fail "no root Application 'platform' found in ns argocd — run ./scripts/bootstrap-gitops.sh"
fi

check_app platform
check_app local-path-provisioner

# --- Wave-0 side effects -------------------------------------------------------
if kubectl get storageclass local-path >/dev/null 2>&1; then
  ok "storageclass 'local-path' exists (wave 0)"
else
  fail "storageclass 'local-path' missing — is the local-path-provisioner app synced?"
fi

# Observability is no longer wave-0: the Victoria stack (metrics/logs/traces +
# Grafana + OTel Collector) is an on-demand capability enabled later (it replaced
# the always-on otel-lgtm pod in the #57 rework), so module 02 no longer checks
# for a running observability namespace.

# --- Your GitOps change --------------------------------------------------------
check_app demo

OWNER="$(kubectl -n demo get configmap welcome -o jsonpath='{.data.owner}' 2>/dev/null || true)"
if [ -z "$OWNER" ]; then
  fail "ConfigMap 'welcome' not found in ns demo — did you push gitops/apps/demo.yaml AND gitops/components/demo/welcome.yaml to Gitea? (ArgoCD polls ~3 min; Refresh in the UI to hurry it)"
elif [ "$OWNER" = "CHANGE ME" ]; then
  fail "welcome ConfigMap still says owner='CHANGE ME' — edit it in the GIT REPO (not kubectl edit!) and push"
else
  ok "welcome ConfigMap delivered via git — owner: $OWNER"
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed. Catch-up if needed: ./scripts/catch-up.sh 02"
  exit 1
fi
echo "✅ Module 02 complete — git is now the only door. Two-minute explain-back time."
