#!/usr/bin/env bash
# Scenario 02 — constrain the Git-managed demo-web memory with a plausible rightsizing edit.
#
# Target: the attendee's OWN platform repo clone (cloudbox/platform in Gitea),
# path gitops/components/demo/demo-web.yaml — synced into namespace demo by
# the "demo" Application from module 02 (canonical module state).
# cloudbox/demo-app is unrelated: it is Go SOURCE for module 07's in-cluster
# build, has no deploy manifests, and nothing syncs it directly — never target it.
# This scenario owns the whole resources: block (requests AND limits) of the
# web container; never change env or image here. It must own both fields: a
# limit alone below the existing 32Mi request is an invalid pod spec (request
# > limit is rejected by ValidateResourceRequirements at admission), so the
# request has to move down with it for the fault to actually reach a pod.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime lookup is anchored to this script; ShellCheck cannot resolve $DIR.
# shellcheck disable=SC1091
source "$DIR/../../../common.sh"

COMPONENT_PATH="gitops/components/demo/demo-web.yaml"
BASELINE_SRC="$DIR/../../baseline/demo-web.yaml"
CONTAINER_NAME="web"
# 8Mi is a placeholder tight enough to be implausible for a Go HTTP server;
# rehearsal should calibrate this against helloworld-go's real RSS. The
# invariant this scenario asserts is lastState.terminated.reason: OOMKilled —
# whether the process dies at startup or later under probe/request traffic,
# that reason (not the exact millisecond it fires) is what verify.sh and the
# attendee both read, so the precise number matters less than staying tight
# enough to guarantee an OOM at rehearsal.
POISON_VALUE="8Mi"
POISON_MARKER="memory: $POISON_VALUE"

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
  echo "Wait for ArgoCD to converge, then run ./inject.sh 2 again to inject the fault:"
  echo "  kubectl -n demo rollout status deploy/demo-web"
  exit 0
fi

# Idempotency is by construction: the exact memory field/value is the injected
# artifact's marker. Refusing before mutation makes a second injection unable to push.
if grep -Fq -- "$POISON_MARKER" "$CLONE/$COMPONENT_PATH"; then
  echo "ERROR: scenario 2 already injected — run ./restore.sh 2 first" >&2
  exit 1
fi

# Cheap guard: refuse to hide an ArgoCD convergence problem behind this fault.
READY="$(kubectl -n demo get deploy demo-web -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
if [ -z "$READY" ] || [ "$READY" -eq 0 ]; then
  echo "FAIL: deploy/demo-web in namespace demo has no ready replicas yet." >&2
  echo "Wait for ArgoCD to converge, then re-run ./inject.sh 2:" >&2
  echo "  kubectl -n demo rollout status deploy/demo-web" >&2
  exit 1
fi

MUTATED="$TMP_PARENT/demo-web.yaml"
if ! awk -v poison="$POISON_VALUE" -v target="$CONTAINER_NAME" '
  function indent_of(s, t) {
    t = s
    sub(/[^ ].*$/, "", t)
    return length(t)
  }
  function spaces(n, s) {
    s = ""
    while (length(s) < n) s = s " "
    return s
  }
  function blank_or_comment(s, t) {
    t = s
    sub(/^[ ]*/, "", t)
    return t == "" || substr(t, 1, 1) == "#"
  }
  function close_resources() {
    if (!in_resources) return
    if (!requests_seen) {
      print "resources under the " target " container has no requests map" > "/dev/stderr"
      bad = 1
    } else if (!request_child_seen) {
      print "requests under the " target " container is not a populated block map" > "/dev/stderr"
      bad = 1
    } else if (!memory_rewritten) {
      print "requests under the " target " container has no memory field to rewrite" > "/dev/stderr"
      bad = 1
    }
    if (limits_seen) {
      print "resources.limits already exists under the " target " container" > "/dev/stderr"
      bad = 1
    }
    in_resources = 0
  }
  function close_container() {
    close_resources()
    if (in_target && !resources_seen) {
      print "could not find resources under the " target " container" > "/dev/stderr"
      bad = 1
    }
    in_target = 0
    resources_seen = 0
    requests_seen = 0
    request_child_seen = 0
    memory_rewritten = 0
    limits_seen = 0
  }
  BEGIN {
    container_indent = -1
    name_pattern = "^[ ]*-[ ]+name:[ ]*[\"\047]?" target "[\"\047]?[ ]*(#.*)?$"
  }
  {
    line = $0
    ind = indent_of(line)

    if (in_resources && !blank_or_comment(line) && ind <= resources_indent)
      close_resources()

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
    if (line ~ /^kind:[ ]*Deployment[ ]*(#.*)?$/)
      in_deployment = 1

    if (in_deployment && line ~ /^[ ]*containers:[ ]*(#.*)?$/) {
      in_containers = 1
      containers_indent = ind
      container_indent = -1
      print line
      next
    }

    if (in_containers && container_indent < 0 && line ~ /^[ ]*-[ ]+name:/)
      container_indent = ind

    if (in_containers && container_indent >= 0 && ind == container_indent &&
        line ~ /^[ ]*-/) {
      close_container()
      in_target = (line ~ name_pattern)
      if (in_target) {
        target_seen++
        if (target_seen > 1) {
          print "found more than one container named " target > "/dev/stderr"
          bad = 1
        }
      }
    }

    if (in_target && line ~ /^[ ]*resources:/) {
      if (ind != container_indent + 2 || line !~ /^[ ]*resources:[ ]*(#.*)?$/) {
        print "unsupported resources value under the " target " container" > "/dev/stderr"
        bad = 1
        exit 42
      }
      if (resources_seen) {
        print "found more than one resources map under the " target " container" > "/dev/stderr"
        bad = 1
        exit 43
      }
      resources_seen = 1
      in_resources = 1
      resources_indent = ind
    }

    if (in_resources && line ~ /^[ ]*requests:/) {
      if (ind != resources_indent + 2 || line !~ /^[ ]*requests:[ ]*(#.*)?$/) {
        print "unsupported requests value under the " target " container" > "/dev/stderr"
        bad = 1
        exit 44
      }
      if (requests_seen) {
        print "found more than one requests map under the " target " container" > "/dev/stderr"
        bad = 1
        exit 45
      }
      requests_seen = 1
      request_indent = ind
      # Own the whole resources: block, not just limits: a limit below the
      # existing request is an invalid pod spec (rejected at admission), so
      # requests.memory has to move down to the same tight value below — see
      # the memory_rewritten check in close_resources for the other half.
      print spaces(ind) "limits:"
      print spaces(ind + 2) "memory: " poison
      changed = 1
    } else if (in_resources && line ~ /^[ ]*limits:/ && ind == resources_indent + 2) {
      limits_seen = 1
    } else if (in_resources && requests_seen && ind == request_indent + 2 &&
               line ~ /^[ ]*memory:/) {
      if (memory_rewritten) {
        print "requests under the " target " container has more than one memory field" > "/dev/stderr"
        bad = 1
        exit 48
      }
      request_child_seen = 1
      memory_rewritten = 1
      comment = ""
      if (match(line, /[ ]+#/)) comment = substr(line, RSTART)
      line = spaces(ind) "memory: " poison comment
      changed = 1
    } else if (in_resources && requests_seen && ind == request_indent + 2 &&
               line ~ /^[ ]*[A-Za-z0-9_.-]+:[ ]*/) {
      request_child_seen = 1
    }

    print line
  }
  END {
    close_container()
    if (!target_seen) {
      print "could not find a container named " target > "/dev/stderr"
      bad = 1
    }
    if (!changed) {
      print "deployment was not changed" > "/dev/stderr"
      bad = 1
    }
    if (bad) exit 1
  }
' "$CLONE/$COMPONENT_PATH" > "$MUTATED"; then
  echo "ERROR: could not safely rewrite resources.requests.memory/resources.limits.memory in $COMPONENT_PATH — check the $CONTAINER_NAME container's resources/requests YAML structure" >&2
  exit 1
fi
mv "$MUTATED" "$CLONE/$COMPONENT_PATH"

# Add the specific path only (never -A): env, image, welcome.yaml, and anything
# else the attendee has in gitops/components/demo/ are untouched by construction.
git -C "$CLONE" add "$COMPONENT_PATH"
git -C "$CLONE" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
  commit -q -m "release: demo-web memory rightsizing" \
  -m "Cloudbox-Scenario: day2-02"
INJECTED_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"
git -C "$CLONE" push -q origin main
argocd_refresh demo

echo "💥 Scenario 02-oomkill-crashloop injected as commit $INJECTED_SHA."
echo
echo "Your job: follow the restart cadence to its cause, prove it, then revert the rightsizing commit."
echo "Start with:"
echo "  kubectl -n demo get pods -l app=demo-web -w"
echo
echo "NO PEEKING at scenarios/02-oomkill-crashloop/description.md"
echo "until you have written down a diagnosis. Give up / done: ./restore.sh 2"
