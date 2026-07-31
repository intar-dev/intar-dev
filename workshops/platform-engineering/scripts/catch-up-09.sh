#!/usr/bin/env bash
# Trusted checkpoint reconstruction adapted from pinned module 09.
# Module 09 — full solution: enable eventing, the picture pipeline, and the
# complete observability capability, then upload a tiny test PNG through the
# portal so the trace and image outcome checks are unconditional.
set -euo pipefail

LAB_DIR="/opt/platform-engineering-workshop/lab/09-capstone"
REPO_ROOT="/opt/platform-engineering-workshop"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

CLONE="$(gitops_clone)"
# knative-serving.yaml (module 06) and portal.yaml (module 08) are earlier
# modules' apps; re-copying is a no-op when they're already enabled, and makes
# this module solvable standalone (the ksvcs need Serving, the upload goes
# through the portal).
enable_catalog "$CLONE" \
  knative-serving.yaml portal.yaml knative-eventing.yaml picture-pipeline.yaml \
  victoria-metrics.yaml victoria-logs.yaml victoria-traces.yaml grafana.yaml \
  otel-collector.yaml
gitops_push "$CLONE" "module 09: eventing, picture pipeline, and observability"

wait_app knative-serving 600
wait_app knative-eventing 600
wait_app portal
wait_app picture-pipeline 600

# The picture-pipeline app can be Healthy before every resource is applied
# (wait_app keys on health; sync may lag) — guard each condition-wait with an
# existence-wait so a not-yet-created resource doesn't hard-fail the wait.
wait_exists pipeline broker/default
wait_exists pipeline ksvc/uploader
wait_exists pipeline ksvc/resizer
wait_exists pipeline trigger/resize-on-upload
wait_condition pipeline broker/default Ready 300
# Wait for the subscriber ksvcs BEFORE the trigger. A Knative Trigger only goes
# Ready once BOTH its broker AND its subscriber (the resizer ksvc) are
# address-resolvable — so waiting on the trigger before its subscriber is a race
# that intermittently timed out under CI load. Order the dependency correctly.
wait_condition pipeline ksvc/uploader Ready 300
wait_condition pipeline ksvc/resizer Ready 300
# The trigger latches "BrokerNotConfigured" if it first reconciled before the
# broker was Ready (the broker itself races the eventing-config install). With the
# broker AND subscriber now up, poke the trigger to re-reconcile so it picks them
# up. The timestamp guarantees the annotation actually changes (forcing a
# reconcile) even on a re-run; ArgoCD selfHeal reverts it afterwards.
kubectl -n pipeline annotate trigger/resize-on-upload \
  cloudbox.io/rereconcile="$(date +%s)" --overwrite >/dev/null 2>&1 || true
wait_condition pipeline trigger/resize-on-upload Ready 300
wait_exists pipeline job/create-images-bucket
wait_condition pipeline job/create-images-bucket Complete 300

# The three storage backends and Grafana are ArgoCD wave 0. The collector is
# wave 1, so prove the whole first wave before waiting for its two workloads.
wait_app victoria-metrics 600
wait_app victoria-logs 600
wait_app victoria-traces 600
wait_app grafana 600

wait_exists observability service/victoria-metrics 600
wait_exists observability deployment/victoria-metrics 600
kubectl -n observability rollout status deployment/victoria-metrics --timeout=600s
wait_exists observability service/victoria-logs 600
wait_exists observability deployment/victoria-logs 600
kubectl -n observability rollout status deployment/victoria-logs --timeout=600s
wait_exists observability service/victoria-traces 600
wait_exists observability deployment/victoria-traces 600
kubectl -n observability rollout status deployment/victoria-traces --timeout=600s
wait_exists observability service/grafana-nodeport 600
wait_exists observability deployment/grafana 600
kubectl -n observability rollout status deployment/grafana --timeout=600s

wait_app otel-collector 600
wait_exists observability service/otel-collector 600
wait_exists observability deployment/otel-collector-gateway 600
wait_exists observability daemonset/otel-collector-agent 600
kubectl -n observability rollout status deployment/otel-collector-gateway --timeout=600s
kubectl -n observability rollout status daemonset/otel-collector-agent --timeout=600s

# Rollout readiness proves the pod's /api/health probe. Also prove the declared
# browser-facing NodePort before creating the fresh trace used by verification.
WAITED=0
until grafana_health="$(curl -fsS --max-time 5 http://localhost:30030/api/health 2>/dev/null)" &&
      jq -e '.database == "ok"' <<<"$grafana_health" >/dev/null 2>&1; do
  [ "$WAITED" -ge 300 ] && { echo "timed out waiting for Grafana on :30030" >&2; exit 1; }
  sleep 10; WAITED=$((WAITED + 10))
done

# Wait for the portal UI (the upload path goes browser → portal → uploader).
WAITED=0
until curl -fsS --max-time 5 -o /dev/null http://localhost:30600/healthz 2>/dev/null; do
  [ "$WAITED" -ge 300 ] && { echo "timed out waiting for the portal on :30600" >&2; exit 1; }
  sleep 10; WAITED=$((WAITED + 10))
done

# A 1x1 PNG, embedded so the solve needs no local image file.
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
TMP_PNG="$(mktemp).png"
trap 'rm -f "$TMP_PNG"' EXIT
# shellcheck disable=SC2015  # macOS base64 wants -D on older releases
echo "$PNG_B64" | base64 -d > "$TMP_PNG" 2>/dev/null || echo "$PNG_B64" | base64 -D > "$TMP_PNG"

echo "uploading test image through the portal (cold-starts the uploader)..."
curl -fsS --max-time 120 -o /dev/null \
  -F "file=@${TMP_PNG};type=image/png;filename=solve-test.png" \
  http://localhost:30600/gallery/upload

# The resizer scales from zero to process the event — poll S3 for its output.
s3() {
  if command -v aws >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1 \
      aws --endpoint-url http://localhost:30900 "$@" 2>/dev/null
  else
    kubectl -n pipeline run "solve-s3-$$-${RANDOM}" --rm -i --restart=Never --quiet \
      --image=public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581 \
      --env AWS_ACCESS_KEY_ID=cloudbox --env AWS_SECRET_ACCESS_KEY=cloudbox123 \
      --env AWS_REGION=us-east-1 \
      -- --endpoint-url http://rustfs-svc.rustfs.svc.cluster.local:9000 "$@" 2>/dev/null
  fi
}

echo "waiting for the resizer (scaling from zero) to write the thumbnail..."
WAITED=0
until s3 s3api list-objects-v2 --bucket images --prefix thumbs/ \
        --query 'Contents[].Key' --output text | grep -q thumbs/; do
  [ "$WAITED" -ge 240 ] && { echo "no thumbnail after ${WAITED}s — check: kubectl -n pipeline logs -l serving.knative.dev/service=resizer -c user-container" >&2; exit 1; }
  sleep 10; WAITED=$((WAITED + 10))
done
echo "thumbnail produced after ~${WAITED}s — see it in Cloudbox Console under Gallery."

# The first upload can beat trace indexing or a freshly ready portal S3 client.
# Re-drive only from this trusted catch-up while polling the exact final
# outcomes. The participant verifier remains side-effect-free.
module09_trace_ready=0
module09_gallery_ready=0
module09_gallery_hard_failure=0
module09_outcome_status=0
module09_public_host=wa-workshop-probe.intar.app
module09_deadline=$((SECONDS + 300))

module09_portal_curl() {
  curl -sS --max-time 5 \
    -H "Host: ${module09_public_host}" \
    -H "X-Forwarded-Host: ${module09_public_host}" \
    -H 'X-Forwarded-Proto: https' \
    -H 'X-Forwarded-Port: 443' \
    "$@"
}

for module09_attempt in $(seq 1 60); do
  if (( SECONDS >= module09_deadline )); then
    break
  fi
  if (( module09_trace_ready == 0 )); then
    module09_connected_trace="$(
      curl -fsS --max-time 5 \
        'http://localhost:30030/api/datasources/proxy/uid/victoriatraces/api/traces?service=cloudbox-portal&limit=20' \
        2>/dev/null || true
    )"
    if jq -e \
      'any(.data[]?;
        ([.processes[]?.serviceName] | unique) as $services |
        (["cloudbox-portal", "cloudbox-uploader", "cloudbox-resizer"] -
          $services | length == 0))' \
      <<<"${module09_connected_trace}" >/dev/null 2>&1; then
      module09_trace_ready=1
    fi
  fi

  if (( module09_gallery_ready == 0 )); then
    module09_gallery_page="$(
      module09_portal_curl --fail \
        http://localhost:30600/gallery/grid 2>/dev/null || true
    )"
    if [[ "${module09_gallery_page}" == *"localhost:"* ]]; then
      printf 'Cloudbox gallery exposed a localhost URL through the workspace-app route\n' >&2
      module09_gallery_hard_failure=1
      module09_outcome_status=1
      break
    fi
    module09_gallery_url=$(
      printf '%s\n' "${module09_gallery_page}" |
        grep -Eo 'https://wa-workshop-probe\.intar\.app/__intar-s3/[^"<[:space:]]+' |
        sed 's/&amp;/\&/g' |
        sed -n '1p' || true
    )
    if [[ -n "${module09_gallery_url}" ]]; then
      module09_gallery_path="${module09_gallery_url#https://wa-workshop-probe.intar.app}"
      module09_gallery_file="$(mktemp)"
      if module09_portal_curl --fail \
        --output "${module09_gallery_file}" \
        "http://localhost:30600${module09_gallery_path}" \
        2>/dev/null &&
          [[ -s "${module09_gallery_file}" ]]; then
        module09_gallery_ready=1
      fi
      rm -f "${module09_gallery_file}"
    fi
  fi

  if (( module09_trace_ready == 1 && module09_gallery_ready == 1 )); then
    break
  fi
  if (( SECONDS >= module09_deadline )); then
    break
  fi
  if (( module09_attempt % 6 == 0 )); then
    curl -fsS --max-time 15 --output /dev/null \
      -F "file=@${TMP_PNG};type=image/png;filename=solve-test.png" \
      http://localhost:30600/gallery/upload 2>/dev/null || true
  fi
  if (( SECONDS >= module09_deadline )); then
    break
  fi
  sleep 5
done

if (( module09_trace_ready == 0 && module09_gallery_hard_failure == 0 )); then
  printf 'module 09 connected upload trace did not converge within 300s\n' >&2
  module09_outcome_status=1
fi
if (( module09_gallery_ready == 0 && module09_gallery_hard_failure == 0 )); then
  printf 'Cloudbox gallery did not converge on a non-empty canonical /__intar-s3/ object within 300s\n' >&2
  module09_outcome_status=1
fi

if (( module09_outcome_status != 0 )); then
  exit 1
fi
rm -f "$TMP_PNG"
trap - EXIT
