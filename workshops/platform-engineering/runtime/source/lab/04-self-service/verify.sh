#!/usr/bin/env bash
# Module 04 — verify the self-service platform API.
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
  fail "ArgoCD app '$1' is '$st' — check http://localhost:30080 and the module hints"
}

# --- Crossplane installed ----------------------------------------------------
check_app crossplane
check_app platform-api

if kubectl -n crossplane-system wait --for=condition=Available deploy/crossplane --timeout=5s >/dev/null 2>&1; then
  ok "Crossplane core running"
else
  fail "Crossplane deployment not Available — kubectl -n crossplane-system get pods"
fi

FN_HEALTHY="$(kubectl get functions.pkg.crossplane.io function-patch-and-transform \
  -o jsonpath='{.status.conditions[?(@.type=="Healthy")].status}' 2>/dev/null || true)"
if [ "$FN_HEALTHY" = "True" ]; then
  ok "function-patch-and-transform installed and Healthy"
else
  fail "Function 'function-patch-and-transform' not Healthy — kubectl get functions.pkg.crossplane.io; kubectl describe function function-patch-and-transform"
fi

# --- The API exists ------------------------------------------------------------
XRD_EST="$(kubectl get xrd workshopdatabases.platform.cloudbox.io \
  -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || true)"
if [ "$XRD_EST" = "True" ]; then
  ok "XRD workshopdatabases.platform.cloudbox.io is Established"
else
  fail "XRD not Established — did you push platform/xrd.yaml to gitops/components/platform-api/? kubectl get xrd"
fi

if kubectl get composition workshopdatabase-cnpg >/dev/null 2>&1; then
  ok "Composition workshopdatabase-cnpg exists"
else
  fail "Composition workshopdatabase-cnpg missing — push platform/composition.yaml and check the platform-api app"
fi

# --- The developer experience ---------------------------------------------------
XR_SYNCED="$(kubectl -n demo get workshopdatabase my-db \
  -o jsonpath='{.status.conditions[?(@.type=="Synced")].status}' 2>/dev/null || true)"
XR_READY="$(kubectl -n demo get workshopdatabase my-db \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
if [ -z "$XR_SYNCED" ]; then
  fail "no WorkshopDatabase 'my-db' in ns demo — push examples/my-database.yaml to gitops/components/demo/"
elif [ "$XR_SYNCED" = "True" ] && [ "$XR_READY" = "True" ]; then
  ok "WorkshopDatabase my-db is Synced and Ready"
else
  fail "my-db Synced=$XR_SYNCED Ready=$XR_READY — kubectl -n demo describe workshopdatabase my-db (events tell you which composed piece is unhappy)"
fi

# --- The composed stack ----------------------------------------------------------
PHASE="$(kubectl -n demo get cluster my-db-pg -o jsonpath='{.status.phase}' 2>/dev/null || true)"
if [ "$PHASE" = "Cluster in healthy state" ]; then
  ok "composed CNPG cluster my-db-pg is healthy"
elif [ -z "$PHASE" ]; then
  fail "composed cluster my-db-pg does not exist — the composition didn't fire; see describe output of my-db"
else
  fail "composed cluster my-db-pg is '${PHASE}' — kubectl -n demo describe cluster my-db-pg"
fi

JOB_OK="$(kubectl -n demo get job my-db-bucket \
  -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)"
if [ "$JOB_OK" = "True" ]; then
  ok "bucket Job my-db-bucket completed"
else
  fail "bucket Job my-db-bucket not complete — kubectl -n demo logs job/my-db-bucket (is rustfs up?)"
fi

# Bucket really exists in RustFS?
s3ls() {
  if command -v aws >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1 \
      aws --endpoint-url http://localhost:30900 s3api head-bucket --bucket my-db-assets 2>/dev/null
  else
    kubectl -n demo run "verify-s3-$$" --rm -i --restart=Never --quiet \
      --image=public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581 \
      --env AWS_ACCESS_KEY_ID=cloudbox --env AWS_SECRET_ACCESS_KEY=cloudbox123 \
      --env AWS_REGION=us-east-1 \
      -- --endpoint-url http://rustfs-svc.rustfs.svc.cluster.local:9000 \
      s3api head-bucket --bucket my-db-assets 2>/dev/null
  fi
}
if s3ls >/dev/null 2>&1; then
  ok "bucket my-db-assets exists in RustFS"
else
  fail "bucket my-db-assets not found in RustFS — kubectl -n demo logs job/my-db-bucket"
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed. Catch-up if needed: ./scripts/catch-up.sh 04"
  exit 1
fi
echo "✅ Module 04 complete — your platform has an API. One YAML in, a stack out."
