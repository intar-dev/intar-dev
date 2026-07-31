#!/usr/bin/env bash
# Trusted checkpoint reconstruction adapted from pinned module 08.
# Module 08 — full solution: enable the Cloudbox Console, then create the
# star-task database. The lab does that through the console's form; here we
# create the identical WorkshopDatabase via kubectl (the form is sugar over
# the same API call — that's the module's point).
set -euo pipefail

LAB_DIR="/opt/platform-engineering-workshop/lab/08-portal"
REPO_ROOT="/opt/platform-engineering-workshop"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

CLONE="$(gitops_clone)"
enable_catalog "$CLONE" portal.yaml
# The write grant for the star task: the portal's Role/RoleBinding for
# WorkshopDatabases lives in the demo component — the platform owner hands
# the portal its keys; the portal ships without them.
mkdir -p "$CLONE/gitops/components/demo"
cp "$LAB_DIR/portal-access.yaml" "$CLONE/gitops/components/demo/portal-access.yaml"
gitops_push "$CLONE" "module 08: enable the cloudbox console + grant it demo access"

wait_app portal
wait_app demo

# Wait until the UI actually answers on the NodePort.
WAITED=0
until curl -fsS --max-time 5 -o /dev/null http://localhost:30600/ 2>/dev/null; do
  [ "$WAITED" -ge 300 ] && { echo "timed out waiting for the console UI" >&2; exit 1; }
  sleep 10; WAITED=$((WAITED + 10))
done
echo "Cloudbox Console is ready; open it under Workspace applications in the Intar room."

# The star task, non-UI path: same object the "New database" form creates.
kubectl -n demo apply -f - <<'EOF'
apiVersion: platform.cloudbox.io/v1alpha1
kind: WorkshopDatabase
metadata:
  name: console-db
spec:
  size: small
EOF

wait_condition demo workshopdatabase/console-db Ready 600
echo "console-db is Ready — see it in Cloudbox Console under Databases."
