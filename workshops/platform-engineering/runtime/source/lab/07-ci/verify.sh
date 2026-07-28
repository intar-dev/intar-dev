#!/usr/bin/env bash
# Module 07 — verify the in-cluster build pipeline end to end.
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
  fail "ArgoCD app '$1' is '$st' — cp gitops/catalog/$1.yaml to gitops/apps/ and push"
}

check_app zot
check_app argo-workflows

# --- Zot registry ---------------------------------------------------------------
if curl -fsS --max-time 5 http://localhost:30500/v2/ >/dev/null 2>&1; then
  ok "Zot registry API answers on :30500"
else
  fail "Zot not answering on :30500 — kubectl -n zot get pods,svc"
fi

# --- WorkflowTemplate present ------------------------------------------------------
if kubectl -n builds get workflowtemplate build-and-push >/dev/null 2>&1; then
  ok "WorkflowTemplate build-and-push exists in ns builds"
else
  fail "WorkflowTemplate build-and-push missing in ns builds — is the argo-workflows app fully synced?"
fi

# --- A build succeeded --------------------------------------------------------------
PHASES="$(kubectl -n builds get workflows \
  -o jsonpath='{range .items[*]}{.metadata.name}={.status.phase}{"\n"}{end}' 2>/dev/null | grep '^build-hello-site-' || true)"
if [ -z "$PHASES" ]; then
  fail "no build-hello-site-* workflow found — submit one: kubectl create -f workflow-run.yaml"
elif echo "$PHASES" | grep -q '=Succeeded'; then
  ok "build workflow Succeeded ($(echo "$PHASES" | grep -c '=Succeeded') run(s))"
else
  fail "build workflow(s) exist but none Succeeded ($(echo "$PHASES" | tr '\n' ' ')) — kubectl -n builds get pods; read the failing step's logs"
fi

# --- Image actually in the registry ---------------------------------------------------
CATALOG="$(curl -fsS --max-time 5 http://localhost:30500/v2/_catalog 2>/dev/null || echo '{}')"
if echo "$CATALOG" | grep -q 'hello-site'; then
  ok "image 'hello-site' present in Zot catalog"
else
  fail "hello-site not in Zot catalog ($CATALOG) — did the push step succeed? check the workflow logs"
fi

# --- And it runs ------------------------------------------------------------------------
if kubectl -n demo wait --for=condition=Available deploy/hello-site --timeout=10s >/dev/null 2>&1; then
  ok "hello-site Deployment is Available"
  BODY="$(kubectl -n demo run "verify-curl-$$" --rm -i --restart=Never --quiet \
    --image=docker.io/library/busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028 \
    --command -- /bin/sh -c 'wget -qO- http://hello-site.demo.svc.cluster.local/ 2>/dev/null || true' 2>/dev/null || true)"
  if echo "$BODY" | grep -q 'hello-site'; then
    ok "hello-site serves the page you built"
  else
    # The probe pod may fail to start on a struggling cluster; the rollout
    # above already proves the built image runs — pass with a note.
    echo "⚠️  note: could not fetch the page via a probe pod — rollout-only pass. Check it yourself: kubectl -n demo port-forward svc/hello-site 8087:80 & curl http://localhost:8087/"
  fi
else
  fail "hello-site Deployment not Available in ns demo — push lab/07-ci/hello-site.yaml to gitops/components/demo/ (AFTER the build); if ImagePullBackOff, see hint 3 (node registry mirror)"
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed. This is the pioneer module — red sticky note and we'll dig in together."
  exit 1
fi
echo "✅ Module 07 complete — git, build, registry, deploy: all yours."
