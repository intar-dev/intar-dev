#!/usr/bin/env bash
# Module 03 — verify Postgres-as-a-service and S3-as-a-service.
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
  fail "ArgoCD app '$1' is '$st' — did you cp gitops/catalog/$1.yaml to gitops/apps/ and push? Check http://localhost:30080"
}

# --- Platform components enabled -------------------------------------------
check_app cnpg-operator
check_app rustfs

# --- CNPG operator actually running ----------------------------------------
if kubectl get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
  ok "CNPG CRDs installed"
else
  fail "CRD clusters.postgresql.cnpg.io missing — cnpg-operator app not synced yet"
fi

CNPG_READY="$(kubectl -n cnpg-system get deploy --no-headers 2>/dev/null | awk '{split($2,a,"/"); if (a[1]==a[2] && a[1]>0) n++} END {print n+0}')"
if [ "${CNPG_READY:-0}" -ge 1 ]; then
  ok "CNPG operator deployment ready in ns cnpg-system"
else
  fail "no ready deployment in ns cnpg-system — kubectl -n cnpg-system get pods"
fi

# --- The database ------------------------------------------------------------
PHASE="$(kubectl -n demo get cluster app-db -o jsonpath='{.status.phase}' 2>/dev/null || true)"
READY_INST="$(kubectl -n demo get cluster app-db -o jsonpath='{.status.readyInstances}' 2>/dev/null || echo 0)"
if [ "$PHASE" = "Cluster in healthy state" ] && [ "${READY_INST:-0}" -ge 1 ]; then
  ok "CNPG cluster app-db healthy (${READY_INST} ready instance)"
elif [ -z "$PHASE" ]; then
  fail "no Cluster 'app-db' in ns demo — push lab/03-data/postgres-cluster.yaml to gitops/components/demo/ in your Gitea repo"
else
  fail "app-db is '${PHASE}' (${READY_INST} ready) — kubectl -n demo describe cluster app-db; check pvc + events"
fi

if [ -n "$PHASE" ]; then
  RESULT="$(kubectl -n demo exec app-db-1 -- psql -U postgres -d app -tAc 'SELECT 1;' 2>/dev/null || true)"
  if [ "$RESULT" = "1" ]; then
    ok "SELECT 1 works inside app-db — it's a real database"
  else
    fail "could not run SELECT 1 in app-db-1 — kubectl -n demo exec -it app-db-1 -- psql -U postgres -d app"
  fi
fi

# --- Object storage -----------------------------------------------------------
RUSTFS_RUNNING="$(kubectl -n rustfs get pods --no-headers 2>/dev/null | awk '$3 == "Running"' | wc -l | tr -d ' ')"
if [ "${RUSTFS_RUNNING:-0}" -ge 1 ]; then
  ok "RustFS running in ns rustfs"
else
  fail "no running RustFS pod — kubectl -n rustfs get pods; check the rustfs app in ArgoCD"
fi

if curl -sS --max-time 5 -o /dev/null http://localhost:30900/ 2>/dev/null; then
  ok "S3 endpoint answers on :30900"
else
  fail "nothing answering on :30900 — kubectl -n rustfs get svc; is the NodePort up?"
fi

# Bucket check: local aws CLI if present, else a short-lived in-cluster pod.
s3ls() {
  if command -v aws >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1 \
      aws --endpoint-url http://localhost:30900 s3 ls "s3://app-assets" 2>/dev/null
  else
    kubectl -n demo run "verify-s3-$$" --rm -i --restart=Never --quiet \
      --image=public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581 \
      --env AWS_ACCESS_KEY_ID=cloudbox --env AWS_SECRET_ACCESS_KEY=cloudbox123 \
      --env AWS_REGION=us-east-1 \
      -- --endpoint-url http://rustfs-svc.rustfs.svc.cluster.local:9000 s3 ls "s3://app-assets" 2>/dev/null
  fi
}

LISTING="$(s3ls || true)"
if [ -n "$LISTING" ]; then
  ok "bucket app-assets exists and has objects"
elif s3ls >/dev/null 2>&1; then
  fail "bucket app-assets exists but is empty — upload any file (aws s3 cp) so you can presign it"
else
  fail "bucket app-assets not found — create it: aws --endpoint-url http://localhost:30900 s3 mb s3://app-assets (creds cloudbox/cloudbox123)"
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed. Catch-up if needed: ./scripts/catch-up.sh 03"
  exit 1
fi
echo "✅ Module 03 complete — you are now the RDS team AND the S3 team."
