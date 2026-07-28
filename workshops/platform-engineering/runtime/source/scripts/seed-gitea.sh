#!/usr/bin/env bash
# =============================================================================
# seed-gitea.sh — module 2: push this repo into your cloud's git server
#
# Pushes the local checkout to the in-cluster Gitea using push-to-create:
#
#   local checkout  --push-->  http://localhost:30300/cloudbox/platform.git
#
# The 'cloudbox' org and 'platform' repo are created by the push itself
# (ENABLE_PUSH_CREATE_ORG). ArgoCD then reaches the same repo cluster-
# internally at http://gitea-http.gitea.svc.cluster.local:3000/cloudbox/platform.git.
#
# Finally, the root "platform" Application (app-of-apps pointing at
# gitops/apps) is applied so ArgoCD starts converging your platform.
#
# Usage:
#   ./scripts/seed-gitea.sh
#
# Idempotent: force-pushes, so re-running resets Gitea's main branch to your
# local checkout. Only COMMITTED changes are pushed.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

need git
need kubectl

# Credentials are supplied via GIT_ASKPASS (git_as_gitea_admin), not the URL.
PUSH_URL="http://localhost:${NODEPORT_GITEA}/${PLATFORM_REPO_PATH}.git"

# --- 1. Wait for Gitea ---------------------------------------------------------
step "Checking Gitea at ${GITEA_HOST_URL}"
for _ in $(seq 1 30); do
  curl -fsS "${GITEA_HOST_URL}/api/healthz" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "${GITEA_HOST_URL}/api/healthz" >/dev/null 2>&1 \
  || die "Gitea is not answering on ${GITEA_HOST_URL} — run ./scripts/bootstrap-gitops.sh first."
ok "Gitea is up"

# --- 2. Ensure the organization exists ---------------------------------------------
# Push-to-create makes the REPO on first push, but not the ORG that owns it
# (ENABLE_PUSH_CREATE_ORG only permits creation inside an existing org) —
# found by rehearsal-in-CI. Idempotent: 404 -> create, anything else -> keep going.
ORG="${PLATFORM_REPO_PATH%%/*}"
if ! curl -fsS -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASSWORD}" \
     "${GITEA_HOST_URL}/api/v1/orgs/${ORG}" >/dev/null 2>&1; then
  info "Creating Gitea organization '${ORG}'"
  curl -fsS -X POST -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASSWORD}" \
    -H "Content-Type: application/json" \
    -d "{\"username\": \"${ORG}\", \"visibility\": \"public\", \"description\": \"Est. this morning. Uptime: since you created it.\"}" \
    "${GITEA_HOST_URL}/api/v1/orgs" >/dev/null \
    || die "Could not create Gitea org '${ORG}'."
fi

# --- 3. Push -----------------------------------------------------------------------
cd "${REPO_ROOT}"
# Gitea rejects pushes from shallow clones ("shallow update not allowed").
if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  die "This clone is shallow — run 'git fetch --unshallow' first, then re-run."
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "You have uncommitted changes — they will NOT be pushed (commit them first if intended)."
fi

step "Pushing local checkout to ${GITEA_HOST_URL}/${PLATFORM_REPO_PATH} (branch main)"
git_as_gitea_admin push --force "${PUSH_URL}" "HEAD:refs/heads/main"
ok "Pushed $(git rev-parse --short HEAD) to ${PLATFORM_REPO_PATH}:main"

# Safety net: push-to-create honors DEFAULT_PUSH_CREATE_PRIVATE=false from the
# chart values, but make sure the repo really is public — ArgoCD polls anonymously.
curl -fsS -X PATCH \
  -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASSWORD}" \
  -H "Content-Type: application/json" \
  -d '{"private": false}' \
  "${GITEA_HOST_URL}/api/v1/repos/${PLATFORM_REPO_PATH}" >/dev/null \
  || warn "Could not verify repo visibility — check ${GITEA_HOST_URL}/${PLATFORM_REPO_PATH}"

# --- 3b. Seed the demo app as its OWN repo ------------------------------------------
# The app-team golden path (deploy from source) needs a real, standalone app to
# build — separate from this platform config repo. Push apps/demo-app as
# cloudbox/demo-app (push-to-create in the same org), public, and marked a Gitea
# TEMPLATE so the console can later scaffold new app repos from it.
DEMO_REPO="${ORG}/demo-app"
DEMO_PUSH_URL="http://localhost:${NODEPORT_GITEA}/${DEMO_REPO}.git"
if [[ -d "${REPO_ROOT}/apps/demo-app" ]]; then
  step "Seeding the demo app as ${DEMO_REPO} (a standalone repo to deploy-from-source)"
  DEMO_TMP="$(mktemp -d)"
  cp -R "${REPO_ROOT}/apps/demo-app/." "${DEMO_TMP}/"
  (
    cd "${DEMO_TMP}"
    git init -q
    git add -A
    git -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
      commit -q -m "demo-app: visit counter + bucket, wired via the platform"
    git_as_gitea_admin push --force "${DEMO_PUSH_URL}" "HEAD:refs/heads/main"
  )
  rm -rf "${DEMO_TMP}"
  curl -fsS -X PATCH -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASSWORD}" \
    -H "Content-Type: application/json" -d '{"private": false, "template": true}' \
    "${GITEA_HOST_URL}/api/v1/repos/${DEMO_REPO}" >/dev/null \
    || warn "Could not set ${DEMO_REPO} visibility/template flag"
  ok "Seeded ${DEMO_REPO} (public, template) — deploy it from the console's Applications page"
fi

# --- 3. Root Application (app-of-apps) -----------------------------------------------
if kubectl get namespace argocd >/dev/null 2>&1; then
  step "Applying the root 'platform' Application (app-of-apps)"
  if [[ -f "${REPO_ROOT}/gitops/root-app.yaml" ]]; then
    kubectl apply -n argocd -f "${REPO_ROOT}/gitops/root-app.yaml"
  else
    # Fallback if gitops/root-app.yaml doesn't exist (yet): generate it from
    # the architecture contract. Keep in sync with gitops/.
    kubectl apply -f - <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: platform
  namespace: argocd
spec:
  project: default
  source:
    repoURL: ${GITEA_CLUSTER_URL}/${PLATFORM_REPO_PATH}.git
    targetRevision: main
    path: gitops/apps
  destination:
    server: https://kubernetes.default.svc
  syncPolicy:
    automated:
      # prune is DELIBERATELY off on the ROOT app-of-apps. Each module's solve
      # incrementally adds child Application files to gitops/apps/ and pushes in
      # rapid succession; the app-of-apps only ever needs to CREATE/UPDATE those
      # children. With prune:true a transient sync that computes desired state
      # from a stale repo-server generation (e.g. a failed-child retry loop
      # pinned to a pre-push revision, more likely under peak runner memory
      # pressure at module 09) cascade-DELETES the newest child Applications —
      # tearing whole namespaces (pipeline/portal/knative-eventing) out from
      # under a running lab. The child apps keep their own prune:true, so
      # in-app GitOps pruning is unaffected; only file-level removal from
      # gitops/apps/ now needs a manual "kubectl delete application".
      prune: false
      selfHeal: true
    retry:
      limit: 5
      backoff:
        duration: 10s
        factor: 2
        maxDuration: 2m
EOF
  fi
  ok "Root Application applied — ArgoCD is now converging your platform"
else
  warn "ArgoCD namespace not found — skipped applying the root Application."
fi

echo
ok "Your cloud has its own git server, and it has this repo."
echo
echo "  Browse it:      ${GITEA_HOST_URL}/${PLATFORM_REPO_PATH}"
echo "  Watch ArgoCD:   ${ARGOCD_HOST_URL}"
echo
info "The GitOps loop from here on:"
echo "   edit gitops/...  ->  git commit  ->  git push cloudbox main  ->  watch ArgoCD"
echo
info "Add the remote for convenient pushing:"
echo "   git remote add cloudbox ${PUSH_URL}"
