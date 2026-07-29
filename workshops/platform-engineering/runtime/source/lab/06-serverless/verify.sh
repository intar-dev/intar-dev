#!/usr/bin/env bash
# Module 06 — verify Knative serving, cold start, and scale-to-zero.
set -euo pipefail

FAILED=0
ok()   { echo "✅ $1"; }
fail() { echo "❌ FAIL: $1"; FAILED=$((FAILED + 1)); }

# --- Knative installed --------------------------------------------------------
check_app() { # <name>
  # HEALTH is the real signal (workloads running); sync is advisory. Poll ~180s so
  # transient states while the app reconciles under CI load ride out instead of
  # failing on a single point-in-time sample. knative-serving needs this twice over:
  #   1. Its steady state is OutOfSync/Healthy — Knative's webhook injects the
  #      caBundle into its own webhook configs at runtime, so live never matches
  #      git (see gitops/catalog/knative-serving.yaml). Keying on "Synced Healthy"
  #      would fail a perfectly working install.
  #   2. Its cold start is heavy (5 Deployments pulling images), so ArgoCD briefly
  #      reports Progressing/Degraded while pods fail readiness (connection refused)
  #      before self-healing to Healthy ~15-20s later.
  # Mirrors lab/07-ci/verify.sh check_app.
  local st sync health i
  for i in $(seq 1 36); do
    st="$(kubectl -n argocd get application "$1" \
      -o jsonpath='{.status.sync.status} {.status.health.status}' 2>/dev/null || echo missing)"
    # Fast-fail the missing case so an attendee who runs verify.sh before enabling
    # the catalog item gets instant feedback: allow ~10s (two iterations) for a
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
  fail "knative-serving app is '$st' — cp gitops/catalog/knative-serving.yaml to gitops/apps/ and push"
}

check_app knative-serving

for d in activator autoscaler controller webhook; do
  if kubectl -n knative-serving wait --for=condition=Available "deploy/$d" --timeout=5s >/dev/null 2>&1; then
    ok "knative-serving/$d Available"
  else
    fail "knative-serving/$d not Available — kubectl -n knative-serving get pods"
  fi
done

# --- The ksvc ------------------------------------------------------------------
KSVC_READY="$(kubectl -n demo get ksvc hello \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
if [ "$KSVC_READY" = "True" ]; then
  ok "ksvc hello is Ready"
elif [ -z "$KSVC_READY" ]; then
  fail "no ksvc 'hello' in ns demo — push lab/06-serverless/hello-ksvc.yaml to gitops/components/demo/"
else
  fail "ksvc hello not Ready — kubectl -n demo describe ksvc hello (look at the conditions)"
fi

# --- Cold start / serving through Kourier ---------------------------------------
# Strip the scheme in pure bash — BSD sed has no \? in basic regex.
URL="$(kubectl -n demo get ksvc hello -o jsonpath='{.status.url}' 2>/dev/null || true)"
HOST="${URL#http://}"; HOST="${HOST#https://}"
if [ -n "$HOST" ]; then
  BODY="$(curl -fsS --max-time 30 -H "Host: $HOST" http://localhost:31080/ 2>/dev/null || true)"
  if echo "$BODY" | grep -qi hello; then
    ok "curl via Kourier (:31080, Host: $HOST) answered: $(echo "$BODY" | head -1)"
  else
    fail "no answer through Kourier — is 31080 up? kubectl get svc -A | grep 31080; try: curl -v -H 'Host: $HOST' http://localhost:31080/"
  fi
else
  fail "cannot determine ksvc URL — fix the ksvc checks above first"
fi

# --- Scale to zero ----------------------------------------------------------------
pod_count() {
  kubectl -n demo get pods -l serving.knative.dev/service=hello --no-headers 2>/dev/null | grep -cv Terminating || true
}
COUNT="$(pod_count)"
if [ "${COUNT:-0}" -eq 0 ]; then
  ok "hello is scaled to zero right now (pods exist only while requests flow)"
else
  echo "…waiting up to 150s for scale-to-zero (currently ${COUNT} pod(s); don't curl it now!)"
  WAITED=0
  while [ "$WAITED" -lt 150 ]; do
    sleep 10; WAITED=$((WAITED + 10))
    COUNT="$(pod_count)"
    [ "${COUNT:-0}" -eq 0 ] && break
  done
  if [ "${COUNT:-0}" -eq 0 ]; then
    ok "scale-to-zero observed after ~${WAITED}s of silence"
  else
    fail "still ${COUNT} pod(s) after ${WAITED}s idle — a loop still curling? min-scale set? kubectl -n knative-serving logs deploy/autoscaler --tail=20"
  fi
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed."
  exit 1
fi
echo "✅ Module 06 complete — serverless, minus the invoice."
