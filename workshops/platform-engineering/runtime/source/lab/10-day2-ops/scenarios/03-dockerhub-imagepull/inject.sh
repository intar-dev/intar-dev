#!/usr/bin/env bash
# Scenario 03 — move the Git-managed demo-web image to its canonical upstream registry.
#
# Target: the attendee's OWN platform repo clone (cloudbox/platform in Gitea),
# path gitops/components/demo/demo-web.yaml — synced into namespace demo by
# the "demo" Application from module 02 (canonical module state).
# cloudbox/demo-app is unrelated: it is Go SOURCE for module 07's in-cluster
# build, has no deploy manifests, and nothing syncs it directly — never target it.
# This scenario owns only image; never change env (scenario 1) or resources
# (scenario 2, the whole requests/limits block — see its inject.sh header).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime lookup is anchored to this script; ShellCheck cannot resolve $DIR.
# shellcheck disable=SC1091
source "$DIR/../../../common.sh"

COMPONENT_PATH="gitops/components/demo/demo-web.yaml"
BASELINE_SRC="$DIR/../../baseline/demo-web.yaml"
# Detection is predicate-based, not tied to a specific digest: any image:
# value referencing docker.io/ (quoted or not) means this scenario is
# already injected. A future baseline digest bump must not silently break
# detection, so no digest string is hard-coded here — the awk mutation below
# is generic for the same reason (it rewrites any ghcr.io/ image found, not
# one specific string). verify.sh and fix.sh use this same pattern.
IMAGE_DOCKERHUB_PATTERN="^[[:space:]]*image:[[:space:]]*[\"']?docker\.io/"

CLONE="$(gitops_clone)" || exit 1
TMP_PARENT="$(dirname "$CLONE")"
trap 'rm -rf "$TMP_PARENT"' EXIT

# --- Setup step: seed the baseline workload the first time this scenario runs.
# The attendee never hand-copies this file (unlike module 02's welcome.yaml) —
# inject.sh owns it, seeds it once, then asks the attendee to re-run once
# ArgoCD has converged, so the fault commit always lands on top of a workload
# that is actually Ready (a poisoned commit on top of a not-yet-synced
# Deployment would be indistinguishable from "ArgoCD just hasn't synced yet").
if [ ! -f "$CLONE/$COMPONENT_PATH" ]; then
  # The dir normally exists from module 02 (welcome.yaml lives there); recreate
  # it rather than dying on a raw cp error if it was pruned.
  mkdir -p "$(dirname "$CLONE/$COMPONENT_PATH")"
  cp "$BASELINE_SRC" "$CLONE/$COMPONENT_PATH"
  git -C "$CLONE" add "$COMPONENT_PATH"
  git -C "$CLONE" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
    commit -q -m "chore(demo): seed the demo-web baseline workload"
  git -C "$CLONE" push -q origin main
  argocd_refresh demo

  echo "🌱 Seeded $COMPONENT_PATH in cloudbox/platform (module 10's baseline workload)."
  echo
  echo "Wait for ArgoCD to converge, then run ./inject.sh 3 again to inject the fault:"
  echo "  kubectl -n demo rollout status deploy/demo-web"
  exit 0
fi

# Idempotency is by construction: any docker.io/ image reference already
# present is the injected artifact's marker. Refusing before mutation makes
# a second injection unable to push.
if grep -Eq -- "$IMAGE_DOCKERHUB_PATTERN" "$CLONE/$COMPONENT_PATH"; then
  echo "ERROR: scenario 3 already injected — run ./restore.sh 3 first" >&2
  exit 1
fi

# Cheap guard: refuse to hide an ArgoCD convergence problem behind this fault.
READY="$(kubectl -n demo get deploy demo-web -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
if [ -z "$READY" ] || [ "$READY" -eq 0 ]; then
  echo "FAIL: deploy/demo-web in namespace demo has no ready replicas yet." >&2
  echo "Wait for ArgoCD to converge, then re-run ./inject.sh 3:" >&2
  echo "  kubectl -n demo rollout status deploy/demo-web" >&2
  exit 1
fi

MUTATED="$TMP_PARENT/demo-web.yaml"
if ! awk '
  function indent_of(s, t) {
    t = s
    sub(/[^ ].*$/, "", t)
    return length(t)
  }
  function blank_or_comment(s, t) {
    t = s
    sub(/^[ ]*/, "", t)
    return t == "" || substr(t, 1, 1) == "#"
  }
  function close_container() {
    if (!in_container) return
    if (!image_seen) {
      print "container " container_name " has no direct image field" > "/dev/stderr"
      bad = 1
    }
    in_container = 0
    image_seen = 0
    container_name = ""
  }
  {
    line = $0
    ind = indent_of(line)

    if (in_containers && !blank_or_comment(line) && ind <= containers_indent) {
      close_container()
      in_containers = 0
      container_indent = -1
    }

    if (line ~ /^---[ ]*(#.*)?$/) {
      in_deployment = 0
      print line
      next
    }
    if (line ~ /^kind:[ ]*Deployment[ ]*(#.*)?$/) {
      deployment_seen++
      if (deployment_seen > 1) {
        print "found more than one Deployment document" > "/dev/stderr"
        bad = 1
        exit 42
      }
      in_deployment = 1
    }

    if (in_deployment && line ~ /^[ ]*containers:[ ]*(#.*)?$/) {
      containers_seen++
      if (containers_seen > 1) {
        print "found more than one containers block in the Deployment" > "/dev/stderr"
        bad = 1
        exit 43
      }
      in_containers = 1
      containers_indent = ind
      container_indent = -1
      print line
      next
    }

    if (in_containers && line ~ /^[ ]*-/ &&
        (container_indent < 0 || ind == container_indent)) {
      if (line !~ /^[ ]*-[ ]+name:[ ]*[^ ]+/) {
        print "container list item does not start with - name:" > "/dev/stderr"
        bad = 1
        exit 44
      }
      close_container()
      container_indent = ind
      in_container = 1
      container_count++
      container_name = line
      sub(/^[ ]*-[ ]+name:[ ]*/, "", container_name)
      sub(/[ ]+#.*$/, "", container_name)
      print line
      next
    }

    if (in_container && line ~ /^[ ]*image:/) {
      if (ind != container_indent + 2) {
        print "image is not a direct field of container " container_name > "/dev/stderr"
        bad = 1
        exit 45
      }
      if (image_seen) {
        print "container " container_name " has more than one image field" > "/dev/stderr"
        bad = 1
        exit 46
      }
      image_seen = 1
      value = line
      sub(/^[ ]*image:[ ]*/, "", value)
      if (value !~ /^[^[:space:]#]+([[:space:]]+#.*)?$/) {
        print "unsupported image scalar under container " container_name > "/dev/stderr"
        bad = 1
        exit 47
      }
      # Tolerate an optional leading quote character (double or single) so a
      # quoted image scalar is not missed. \047 is the octal escape for a
      # literal single quote, needed because a literal one here would close
      # the surrounding bash single-quoted awk program (same technique the
      # other scenarios use in their name_pattern definitions).
      if (value ~ /^["\047]?ghcr\.io\//) {
        sub(/ghcr\.io\//, "docker.io/", line)
        changed++
      }
    }

    print line
  }
  END {
    if (!bad) {
      close_container()
      if (deployment_seen != 1) {
        print "could not find exactly one Deployment document" > "/dev/stderr"
        bad = 1
      }
      if (containers_seen != 1 || container_count == 0) {
        print "could not find a populated containers block in the Deployment" > "/dev/stderr"
        bad = 1
      }
      if (!changed) {
        print "could not find a ghcr.io/ image in any container" > "/dev/stderr"
        bad = 1
      }
    }
    if (bad) exit 1
  }
' "$CLONE/$COMPONENT_PATH" > "$MUTATED"; then
  echo "ERROR: could not safely rewrite container images in $COMPONENT_PATH — expected a Deployment with direct, plain-scalar image fields and at least one ghcr.io/ image" >&2
  exit 1
fi
mv "$MUTATED" "$CLONE/$COMPONENT_PATH"

# Add the specific path only (never -A): env, resources, welcome.yaml, and
# anything else the attendee has in gitops/components/demo/ are untouched.
git -C "$CLONE" add "$COMPONENT_PATH"
git -C "$CLONE" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
  commit -q -m "release: demo-web canonical registry" \
  -m "Cloudbox-Scenario: day2-03"
INJECTED_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"
git -C "$CLONE" push -q origin main
argocd_refresh demo

echo "💥 Scenario 03-dockerhub-imagepull injected as commit $INJECTED_SHA."
echo
echo "Your job: follow the failed pull to its exact image reference, prove the Git change, then revert it."
echo "Start with:"
echo "  kubectl -n demo get pods -l app=demo-web"
echo "  kubectl -n demo describe pod <pod>"
echo
echo "NO PEEKING at scenarios/03-dockerhub-imagepull/description.md"
echo "until you have written down a diagnosis. Give up / done: ./restore.sh 3"
