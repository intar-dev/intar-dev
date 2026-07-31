# Canonical solution for module 03

This is adapted from the pinned upstream `solve.sh` for Intar's digest-pinned external runtime. Reveal it only after the learner has chosen to see the solution.

```bash
#!/usr/bin/env bash
# Module 03 — full solution: enable cnpg + rustfs, deliver app-db via git,
# create the app-assets bucket with an object in it.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAB_DIR/../.." && pwd)"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

# 1. Enable the catalog apps + deliver the database manifest, all in one push.
CLONE="$(gitops_clone)"
enable_catalog "$CLONE" cnpg-operator.yaml rustfs.yaml
mkdir -p "$CLONE/gitops/components/demo"
cp "$LAB_DIR/postgres-cluster.yaml" "$CLONE/gitops/components/demo/postgres-cluster.yaml"
gitops_push "$CLONE" "module 03: enable cnpg-operator + rustfs, add app-db"

wait_app cnpg-operator
# The demo app can report Synced without creating app-db if it synced before
# CNPG's CRD was Established (SkipDryRunOnMissingResource) — a race that leaves
# cluster/app-db missing. Wait for the CRD first, then make sure the Cluster
# actually materializes before waiting on its readiness.
kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io --timeout=180s
wait_app rustfs
wait_app demo

# 2. Wait for the database to be genuinely healthy, prove it with SELECT 1.
# Nudge the demo app in case it first-synced before the CRD existed, then
# wait for the Cluster object to appear (self-heal applies it once it can).
kubectl -n argocd annotate application demo argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1 || true
for _ in $(seq 1 60); do
  kubectl -n demo get cluster/app-db >/dev/null 2>&1 && break
  sleep 5
done
kubectl -n demo wait --for=condition=Ready cluster/app-db --timeout=420s
kubectl -n demo exec app-db-1 -- psql -U postgres -d app -tAc 'SELECT 1;'

# 3. Bucket + object + a guest-local presigned download.
aws_s3() {
  docker run --rm --network host -i \
    -e AWS_ACCESS_KEY_ID=cloudbox \
    -e AWS_SECRET_ACCESS_KEY=cloudbox123 \
    -e AWS_REGION=us-east-1 \
    public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581 \
    --endpoint-url http://localhost:30900 "$@"
}
aws_s3 s3 mb s3://app-assets 2>/dev/null || true
printf 'hello from my own cloud\n' |
  aws_s3 s3 cp - s3://app-assets/hello.txt
PRESIGNED_URL="$(aws_s3 s3 presign s3://app-assets/hello.txt --expires-in 3600)"
curl --fail --show-error --output /dev/null "$PRESIGNED_URL"
printf 'Presigned object download verified inside the learner VM.\n'
```
