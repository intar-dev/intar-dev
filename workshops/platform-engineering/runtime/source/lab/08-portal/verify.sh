#!/usr/bin/env bash
# Module 08 — verify the Cloudbox Console is up, and (if created) that the
# form-made database is real.
set -euo pipefail

FAILED=0
ok()   { echo "✅ $1"; }
fail() { echo "❌ FAIL: $1"; FAILED=$((FAILED + 1)); }

check_app() { # <name>
  # HEALTH is the real signal (workloads running); sync is advisory. Poll ~180s so
  # a transient OutOfSync/Progressing/Degraded while the app reconciles under CI
  # load rides out, instead of failing on a single point-in-time sample.
  local st sync health i
  for i in $(seq 1 36); do
    st="$(kubectl -n argocd get application "$1" \
      -o jsonpath='{.status.sync.status} {.status.health.status}' 2>/dev/null || echo missing)"
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
  fail "portal app is '$st' — cp gitops/catalog/$1.yaml to gitops/apps/ and push (needs the demo ns + module 04's API)"
}

# --- The portal app -----------------------------------------------------------
check_app portal

if kubectl -n portal wait --for=condition=Available deploy/portal --timeout=5s >/dev/null 2>&1; then
  ok "portal deployment is ready"
else
  fail "portal deployment not ready — kubectl -n portal get pods; logs tell you which API it's missing"
fi

# The ServiceAccount is the portal's only credential — its existence (plus the
# RBAC shipped in the same component) is what makes the pages work.
if kubectl -n portal get serviceaccount portal >/dev/null 2>&1; then
  ok "ServiceAccount portal/portal exists (the portal's only credential)"
else
  fail "no ServiceAccount 'portal' in ns portal — the component didn't sync fully; kubectl -n argocd get app portal -o yaml"
fi

# --- The UI answers ------------------------------------------------------------
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:30600/ 2>/dev/null || echo 000)"
if [ "$HTTP_CODE" = "200" ]; then
  ok "Cloudbox Console answers on :30600"
else
  fail "no console on :30600 (HTTP $HTTP_CODE) — kubectl -n portal get svc portal; kubectl -n portal logs deploy/portal --tail=20"
fi

# --- The star task: the form-created database, if you've made it ----------------
WDB_READY="$(kubectl -n demo get workshopdatabase console-db \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
if [ -z "$WDB_READY" ]; then
  echo "○ star task not done yet: create 'console-db' via the console's New database form (http://localhost:30600/databases) — verify passes without it, but the module's trophy is missing"
else
  if [ "$WDB_READY" = "True" ]; then
    ok "WorkshopDatabase console-db exists and is Ready (created via the console!)"
  else
    fail "console-db exists but isn't Ready — kubectl -n demo describe workshopdatabase console-db (2–3 min boot is normal)"
  fi
  PG_PHASE="$(kubectl -n demo get cluster console-db-pg \
    -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  if [ "$PG_PHASE" = "Cluster in healthy state" ]; then
    ok "composed CNPG cluster console-db-pg is healthy — the form made a real database"
  else
    fail "CNPG cluster console-db-pg is '${PG_PHASE:-missing}' — kubectl -n demo describe cluster console-db-pg"
  fi
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed."
  exit 1
fi
echo "✅ Module 08 complete — your platform has a front door, and you can read every line of it."
