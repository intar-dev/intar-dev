# Canonical solution for module 09

This is adapted from the pinned upstream `solve.sh` for Intar's digest-pinned external runtime. Reveal it only after the learner has chosen to see the solution.

```bash
#!/usr/bin/env bash
# Module 09 — full solution: enable eventing + the picture pipeline, then
# upload a tiny test PNG through the portal (plain curl — the gallery form is
# just a multipart POST) so the outcome check in verify.sh is unconditional.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAB_DIR/../.." && pwd)"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

CLONE="$(gitops_clone)"
# knative-serving.yaml (module 06) and portal.yaml (module 08) are earlier
# modules' apps; re-copying is a no-op when they're already enabled, and makes
# this module solvable standalone (the ksvcs need Serving, the upload goes
# through the portal).
enable_catalog "$CLONE" knative-serving.yaml portal.yaml knative-eventing.yaml picture-pipeline.yaml
gitops_push "$CLONE" "module 09: knative-eventing + picture pipeline"

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
kubectl -n pipeline wait --for=condition=Ready broker/default --timeout=300s
# Wait for the subscriber ksvcs BEFORE the trigger. A Knative Trigger only goes
# Ready once BOTH its broker AND its subscriber (the resizer ksvc) are
# address-resolvable — so waiting on the trigger before its subscriber is a race
# that intermittently timed out under CI load. Order the dependency correctly.
kubectl -n pipeline wait --for=condition=Ready ksvc/uploader ksvc/resizer --timeout=300s
# The trigger latches "BrokerNotConfigured" if it first reconciled before the
# broker was Ready (the broker itself races the eventing-config install). With the
# broker AND subscriber now up, poke the trigger to re-reconcile so it picks them
# up. The timestamp guarantees the annotation actually changes (forcing a
# reconcile) even on a re-run; ArgoCD selfHeal reverts it afterwards.
kubectl -n pipeline annotate trigger/resize-on-upload \
  cloudbox.io/rereconcile="$(date +%s)" --overwrite >/dev/null 2>&1 || true
kubectl -n pipeline wait --for=condition=Ready trigger/resize-on-upload --timeout=300s
wait_exists pipeline job/create-images-bucket
kubectl -n pipeline wait --for=condition=Complete job/create-images-bucket --timeout=300s

# Wait for the portal UI (the upload path goes browser → portal → uploader).
WAITED=0
until curl -fsS --max-time 5 -o /dev/null http://localhost:30600/healthz 2>/dev/null; do
  [ "$WAITED" -ge 300 ] && { echo "timed out waiting for the portal on :30600" >&2; exit 1; }
  sleep 10; WAITED=$((WAITED + 10))
done

# A 1x1 PNG, embedded so the solve needs no local image file.
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
TMP_PNG="$(mktemp).png"
# shellcheck disable=SC2015  # macOS base64 wants -D on older releases
echo "$PNG_B64" | base64 -d > "$TMP_PNG" 2>/dev/null || echo "$PNG_B64" | base64 -D > "$TMP_PNG"

echo "uploading test image through the portal (cold-starts the uploader)..."
curl -fsS --max-time 120 -o /dev/null \
  -F "file=@${TMP_PNG};type=image/png;filename=solve-test.png" \
  http://localhost:30600/gallery/upload
rm -f "$TMP_PNG"

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
```
