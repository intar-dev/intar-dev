#!/usr/bin/env bash
# Module 05 — verify all injected faults are diagnosed-and-fixed (or cleaned up),
# and that the rest of the platform survived your debugging session.
set -euo pipefail

FAILED=0
INJECTED=0
ok()   { echo "✅ $1"; }
fail() { echo "❌ FAIL: $1"; FAILED=$((FAILED + 1)); }

ns_exists() { kubectl get namespace "$1" >/dev/null 2>&1; }

# --- fault 01: web deployment must serve ------------------------------------
if ns_exists faultlab-01; then
  INJECTED=$((INJECTED + 1))
  if kubectl -n faultlab-01 wait --for=condition=Available deploy/web --timeout=15s >/dev/null 2>&1; then
    ok "fault 01 fixed: deploy/web is Available"
  else
    fail "fault 01 not fixed: deploy/web not Available — kubectl -n faultlab-01 describe pod (read the Events!)"
  fi
fi

# --- fault 02: orders-db must be healthy -------------------------------------
if ns_exists faultlab-02; then
  INJECTED=$((INJECTED + 1))
  if kubectl -n faultlab-02 wait --for=condition=Ready cluster/orders-db --timeout=15s >/dev/null 2>&1; then
    ok "fault 02 fixed: cluster/orders-db is Ready"
  else
    fail "fault 02 not fixed: orders-db not Ready — follow the chain: pod -> pvc -> storageclass. (Editing in place is not enough here; see the spoiler if truly stuck.)"
  fi
fi

# --- fault 03: orders-api must reach the database -----------------------------
if ns_exists faultlab-03; then
  INJECTED=$((INJECTED + 1))
  # Poll for up to ~30s: after a policy fix, Cilium needs a moment to stop
  # enforcing the old rule, and a freshly-rolled db pod needs to accept
  # connections. A human usually fixes-then-checks with that gap; give it here.
  ok03=""
  for _ in $(seq 1 15); do
    if kubectl -n faultlab-03 exec deploy/orders-api -- pg_isready -h inventory-db -p 5432 -t 3 >/dev/null 2>&1; then
      ok03=1; break
    fi
    sleep 2
  done
  if [ -n "$ok03" ]; then
    ok "fault 03 fixed: orders-api reaches inventory-db"
  else
    fail "fault 03 not fixed: connection still failing — pod healthy + endpoints present + timeout? something is eating packets. Who is allowed to talk to whom?"
  fi
fi

# --- fault 04: connection must succeed EVERY time, not half the time ----------
if ns_exists faultlab-04; then
  INJECTED=$((INJECTED + 1))
  # Let endpoints reconverge after the fix before judging (removing the
  # mislabeled pod takes a beat to leave the Service's endpoint list).
  kubectl -n faultlab-04 rollout status deploy/orders-api --timeout=30s >/dev/null 2>&1 || true
  sleep 5
  ATTEMPTS=6 FAILS=0
  for _ in $(seq 1 $ATTEMPTS); do
    kubectl -n faultlab-04 exec deploy/orders-api -- pg_isready -h inventory-db -p 5432 -t 3 >/dev/null 2>&1 || FAILS=$((FAILS + 1))
    sleep 1
  done
  if [ "$FAILS" -eq 0 ]; then
    ok "fault 04 fixed: $ATTEMPTS/$ATTEMPTS connections succeeded"
  elif [ "$FAILS" -lt "$ATTEMPTS" ]; then
    fail "fault 04 not fixed: $FAILS/$ATTEMPTS connections still fail INTERMITTENTLY — what does intermittent rule out? What does the Service actually route to?"
  else
    fail "fault 04: all connections failing now (worse than injected!) — check what your fix changed: kubectl -n faultlab-04 get endpoints inventory-db"
  fi
fi

if [ "$INJECTED" -eq 0 ]; then
  ok "no fault namespaces present (nothing injected, or './restore.sh clean' was run)"
fi

# --- the platform must have survived your debugging ---------------------------
if kubectl -n demo get cluster app-db >/dev/null 2>&1; then
  PHASE="$(kubectl -n demo get cluster app-db -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  if [ "$PHASE" = "Cluster in healthy state" ]; then
    ok "platform workloads untouched: app-db still healthy"
  else
    fail "app-db in ns demo is no longer healthy ('$PHASE') — did a fix land in the wrong namespace? ./scripts/catch-up.sh 04 can restore module state"
  fi
fi
DEGRADED="$(kubectl -n argocd get applications -o jsonpath='{range .items[*]}{.metadata.name}={.status.health.status} {end}' 2>/dev/null | tr ' ' '\n' | awk '!/=Healthy/ && !/^$/ {n++} END {print n+0}')"
if [ "${DEGRADED:-0}" -eq 0 ]; then
  ok "all ArgoCD applications still Healthy"
else
  fail "$DEGRADED ArgoCD app(s) not Healthy — kubectl -n argocd get applications"
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed. The FAIL lines above are nudges, not spoilers — the full spoiler is each fault's description.md."
  exit 1
fi
echo "✅ Module 05 complete — trust, but verify. Especially the confident answers."
