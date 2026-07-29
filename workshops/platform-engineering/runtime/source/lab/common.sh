#!/usr/bin/env bash
# Shared helpers for lab solve.sh scripts. Source me, don't run me.
#
# The single write-path of this platform is the in-cluster Gitea repo; these
# helpers clone it, push to it, and wait for ArgoCD to converge.

GITEA_HOST="${GITEA_HOST:-localhost:30300}"
GITEA_REPO_URL="${GITEA_REPO_URL:-http://gitea_admin:cloudbox123@${GITEA_HOST}/cloudbox/platform.git}"

# Clone the platform repo from in-cluster Gitea into a temp dir; prints the path.
# On failure: cleans up the temp dir and fails with a friendly pointer (callers
# run under `set -e`, so the non-zero return stops their script).
gitops_clone() {
  local dir
  dir="$(mktemp -d)"
  if ! git clone -q "$GITEA_REPO_URL" "$dir/platform" 2>/dev/null; then
    rm -rf "$dir"
    echo "ERROR: could not clone http://${GITEA_HOST}/cloudbox/platform.git —" \
      "is Gitea up and seeded? (./scripts/bootstrap-gitops.sh, then ./scripts/seed-gitea.sh)" >&2
    return 1
  fi
  echo "$dir/platform"
}

# Commit + push everything staged-able in <clone-dir> (no-op if nothing changed).
gitops_push() { # <clone-dir> <commit-message>
  git -C "$1" add -A
  if ! git -C "$1" diff --cached --quiet; then
    git -C "$1" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
      commit -q -m "$2"
    git -C "$1" push -q
  fi
}

# Copy catalog Application manifests into gitops/apps/ inside a clone.
enable_catalog() { # <clone-dir> <catalog-file.yaml>...
  local clone="$1"; shift
  local f
  for f in "$@"; do
    cp "$clone/gitops/catalog/$f" "$clone/gitops/apps/$f"
  done
}

# Ask ArgoCD to compare against git right now instead of waiting for the poll.
argocd_refresh() { # <app-name>
  kubectl -n argocd annotate application "$1" \
    argocd.argoproj.io/refresh=normal --overwrite >/dev/null 2>&1 || true
}

# Block until an ArgoCD Application is Synced + Healthy (default 420s).
wait_app() { # <app-name> [timeout-seconds]
  local name="$1" timeout="${2:-420}" waited=0 st
  argocd_refresh platform
  while [ "$waited" -lt "$timeout" ]; do
    argocd_refresh "$name"
    st="$(kubectl -n argocd get application "$name" \
      -o jsonpath='{.status.sync.status} {.status.health.status}' 2>/dev/null || true)"
    # Succeed on HEALTH — the workloads are running, which is what every
    # capability check downstream actually needs. Sync status (the git-vs-cluster
    # diff) is advisory: an app legitimately sits "OutOfSync Healthy" while ArgoCD
    # is mid-reconcile or on a benign serverside-apply field diff, and timing out
    # on that is a race, not a real failure (the functional assertions that follow
    # catch genuine breakage). Requiring "Synced Healthy" was a recurring flake.
    local sync="${st%% *}" health="${st##* }"
    if [ "$health" = "Healthy" ]; then
      if [ "$sync" = "Synced" ]; then
        echo "app '$name' is Synced/Healthy"
      else
        echo "app '$name' is Healthy (sync: ${sync:-unknown})"
      fi
      return 0
    fi
    # If the child Application doesn't exist yet, the app-of-apps parent hasn't
    # rendered it — hard-refresh the parent to nudge child creation. Fixes
    # intermittent "last: missing" timeouts when ArgoCD is slow to reconcile the
    # git push under load (only fires while the child is absent).
    if [ -z "$st" ]; then
      kubectl -n argocd annotate application platform \
        argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1 || true
    fi
    # Poll every 5s (not 10s): apps usually flip Healthy between polls, so a
    # tighter cadence halves the average detection latency across the many
    # wait_app calls in a run, without touching the timeout budget.
    sleep 5
    waited=$((waited + 5))
  done
  echo "ERROR: timed out after ${timeout}s waiting for app '$name' (last: ${st:-missing})" >&2
  return 1
}

# wait_exists <ns> <kind/name> [timeout-seconds] — poll until a resource EXISTS.
# `kubectl wait --for=condition=...` errors immediately on a missing resource
# (it does not wait for creation), and wait_app now returns on app HEALTH — an
# app can be Healthy while still OutOfSync with a resource not yet applied. Use
# this before any `kubectl wait` on a resource an ArgoCD app is expected to create.
wait_exists() {
  local ns="$1" obj="$2" timeout="${3:-300}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    kubectl -n "$ns" get "$obj" >/dev/null 2>&1 && return 0
    sleep 5
    waited=$((waited + 5))
  done
  echo "ERROR: $obj never appeared in ns $ns after ${timeout}s" >&2
  return 1
}

# wait_for_cr <ns> <resource> [crd] — the demo app can report Synced while
# SKIPPING a custom resource whose CRD wasn't Established yet
# (SkipDryRunOnMissingResource), leaving the CR "not found" when a solve script
# immediately waits on it. This closes that race: optionally wait for the CRD
# Established, nudge the demo app to re-apply, then poll for the CR to appear.
# (Recurring finding across modules 03/04/06 in rehearsal-in-CI.)
wait_for_cr() {
  ns="$1"; resource="$2"; crd="${3:-}"
  [ -n "$crd" ] && kubectl wait --for=condition=Established "crd/$crd" --timeout=180s
  kubectl -n argocd annotate application demo argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    kubectl -n "$ns" get "$resource" >/dev/null 2>&1 && return 0
    sleep 5
  done
  echo "ERROR: $resource never appeared in ns $ns" >&2
  return 1
}
