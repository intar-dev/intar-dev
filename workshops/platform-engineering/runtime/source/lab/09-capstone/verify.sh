#!/usr/bin/env bash
# Module 09 — verify the event-driven picture pipeline: eventing up, broker +
# trigger + ksvcs Ready, bucket present, and (if anything was uploaded) that
# originals produced thumbnails.
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
  fail "app '$1' is '$st' — cp gitops/catalog/$1.yaml to gitops/apps/ and push"
}

# --- The two apps ---------------------------------------------------------------
check_app knative-eventing
check_app picture-pipeline

# --- Eventing control plane + broker data plane ----------------------------------
for d in eventing-controller eventing-webhook mt-broker-ingress mt-broker-filter imc-dispatcher; do
  if kubectl -n knative-eventing wait --for=condition=Available "deploy/$d" --timeout=5s >/dev/null 2>&1; then
    ok "knative-eventing/$d Available"
  else
    fail "knative-eventing/$d not Available — kubectl -n knative-eventing get pods"
  fi
done

# --- Broker + Trigger --------------------------------------------------------------
BROKER_READY="$(kubectl -n pipeline get broker default \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
if [ "$BROKER_READY" = "True" ]; then
  ok "Broker pipeline/default is Ready"
elif [ -z "$BROKER_READY" ]; then
  fail "no Broker 'default' in ns pipeline — is picture-pipeline synced? kubectl -n pipeline get broker"
else
  fail "Broker default not Ready — kubectl -n pipeline describe broker default (is eventing fully up?)"
fi

TRIG_READY="$(kubectl -n pipeline get trigger resize-on-upload \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
if [ "$TRIG_READY" = "True" ]; then
  ok "Trigger resize-on-upload is Ready (filters type dev.cloudbox.image.uploaded → resizer)"
else
  fail "Trigger resize-on-upload is '${TRIG_READY:-missing}' — kubectl -n pipeline describe trigger resize-on-upload"
fi

# --- The two Knative Services --------------------------------------------------------
for s in uploader resizer; do
  KSVC_READY="$(kubectl -n pipeline get ksvc "$s" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  if [ "$KSVC_READY" = "True" ]; then
    ok "ksvc $s is Ready (cluster-local, scales from zero)"
  else
    fail "ksvc $s is '${KSVC_READY:-missing}' — kubectl -n pipeline describe ksvc $s"
  fi
done

# --- Bucket + outcome ------------------------------------------------------------------
# aws CLI locally against the NodePort if available, else the in-cluster
# pattern from module 03.
s3() {
  if command -v aws >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1 \
      aws --endpoint-url http://localhost:30900 "$@" 2>/dev/null
  else
    kubectl -n pipeline run "verify-s3-$$-${RANDOM}" --rm -i --restart=Never --quiet \
      --image=public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581 \
      --env AWS_ACCESS_KEY_ID=cloudbox --env AWS_SECRET_ACCESS_KEY=cloudbox123 \
      --env AWS_REGION=us-east-1 \
      -- --endpoint-url http://rustfs-svc.rustfs.svc.cluster.local:9000 "$@" 2>/dev/null
  fi
}

if s3 s3api head-bucket --bucket images >/dev/null; then
  ok "bucket 'images' exists in RustFS"
else
  fail "bucket 'images' not found — kubectl -n pipeline logs job/create-images-bucket (is rustfs up?)"
fi

list_keys() { # <prefix>
  s3 s3api list-objects-v2 --bucket images --prefix "$1" \
    --query 'Contents[].Key' --output text | tr '\t' '\n' | grep -v '^None$' || true
}

ORIGINALS="$(list_keys originals/)"
if [ -z "$ORIGINALS" ]; then
  echo "○ star task not done yet: upload a photo from Cloudbox Console's Gallery in Intar (watch kubectl -n pipeline get pods -w) — verify passes without it, but the capstone moment is missing"
else
  THUMBS="$(list_keys thumbs/)"
  MATCHED=""
  while IFS= read -r key; do
    # resizer writes originals/<base> → thumbs/<base>.jpg; match on the stem
    # so an extension swap still counts (escape regex metachars, e.g. dots).
    stem="${key#originals/}"; stem="${stem%.*}"
    stem_re="$(printf '%s' "$stem" | sed 's/[.[\*^$]/\\&/g')"
    if printf '%s\n' "$THUMBS" | grep -q "^thumbs/${stem_re}"; then
      MATCHED="$key"
      break
    fi
  done <<<"$ORIGINALS"
  if [ -n "$MATCHED" ]; then
    ok "upload processed: ${MATCHED} has a matching thumbnail under thumbs/"
  else
    fail "originals/ has objects but no matching thumbs/ — the resizer never ran? kubectl -n pipeline logs -l serving.knative.dev/service=resizer -c user-container; then hint 2"
  fi
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed."
  exit 1
fi
echo "✅ Module 09 complete — an event-driven pipeline, on hardware you own. That's the whole tour."
