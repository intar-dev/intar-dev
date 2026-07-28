#!/usr/bin/env bash
# Scenario 01 — poison the Git-managed demo-web PORT with a plausible release edit.
#
# Target: the attendee's OWN platform repo clone (cloudbox/platform in Gitea),
# path gitops/components/demo/demo-web.yaml — synced into namespace demo by
# the "demo" Application from module 02 (canonical module state).
# cloudbox/demo-app is unrelated: it is Go SOURCE for module 07's in-cluster
# build, has no deploy manifests, and nothing syncs it directly — never target it.
# This scenario owns only env; never change resources or image here (scenario 2
# owns resources, scenario 3 owns image — see their inject.sh header comments).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime lookup is anchored to this script; ShellCheck cannot resolve $DIR.
# shellcheck disable=SC1091
source "$DIR/../../../common.sh"

COMPONENT_PATH="gitops/components/demo/demo-web.yaml"
BASELINE_SRC="$DIR/../../baseline/demo-web.yaml"
CONTAINER_NAME="web"
POISON_VALUE="8080-canary"

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
  echo "Wait for ArgoCD to converge, then run ./inject.sh 1 again to inject the fault:"
  echo "  kubectl -n demo rollout status deploy/demo-web"
  exit 0
fi

# Idempotency is by construction: the poison value is the injected artifact's
# marker. Refusing before mutation makes a second injection unable to push.
if grep -Fq -- "$POISON_VALUE" "$CLONE/$COMPONENT_PATH"; then
  echo "ERROR: scenario 1 already injected — run ./restore.sh 1 first" >&2
  exit 1
fi

# Cheap guard: the seed step above asks the attendee to wait for ArgoCD before
# re-running, but nothing enforced that wait — a fault landing on top of a
# demo-web that isn't Ready yet would be indistinguishable from "ArgoCD just
# hasn't synced yet". Refuse until at least one replica is ready.
READY="$(kubectl -n demo get deploy demo-web -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
if [ -z "$READY" ] || [ "$READY" -eq 0 ]; then
  echo "FAIL: deploy/demo-web in namespace demo has no ready replicas yet." >&2
  echo "Wait for ArgoCD to converge, then re-run ./inject.sh 1:" >&2
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
  function add_port(env_column) {
    print spaces(env_column + 2) "- name: PORT"
    print spaces(env_column + 4) "value: \"" poison "\""
    port_found = 1
    changed = 1
  }
  function close_env() {
    if (in_target && in_env && !port_found) add_port(env_indent)
    in_env = 0
  }
  function close_container() {
    close_env()
    if (in_target && !env_seen) {
      print spaces(container_indent + 2) "env:"
      add_port(container_indent + 2)
    }
    in_target = 0
    env_seen = 0
    port_found = 0
    port_pending = 0
  }
  BEGIN {
    container_indent = -1
    name_pattern = "^[ ]*-[ ]+name:[ ]*[\"\047]?" target "[\"\047]?[ ]*(#.*)?$"
  }
  {
    line = $0
    ind = indent_of(line)

    # A PORT item is changed only when its next meaningful child is value: —
    # blank lines and comments in between (attendee-formatted YAML) pass through.
    if (port_pending) {
      if (blank_or_comment(line)) {
        print line
        next
      }
      if (ind > port_name_indent && line ~ /^[ ]*value:[ ]*/) {
        comment = ""
        if (match(line, /[ ]+#/)) comment = substr(line, RSTART)
        print spaces(ind) "value: \"" poison "\"" comment
        port_pending = 0
        port_found = 1
        changed = 1
        next
      }
      print "PORT under the " target " container is not immediately followed by value:" > "/dev/stderr"
      bad = 1
      exit 42
    }

    if (in_target && in_env && !blank_or_comment(line) && ind <= env_indent)
      close_env()

    if (in_containers && !blank_or_comment(line) && ind <= containers_indent) {
      close_container()
      in_containers = 0
      container_indent = -1
    }

    if (line ~ /^[ ]*containers:[ ]*(#.*)?$/) {
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
      if (in_target) target_seen = 1
    }

    if (in_target && line ~ /^[ ]*env:[ ]*\[[ ]*\][ ]*(#.*)?$/) {
      print spaces(ind) "env:"
      env_seen = 1
      add_port(ind)
      next
    }
    if (in_target && line ~ /^[ ]*env:[ ]*(#.*)?$/) {
      env_seen = 1
      in_env = 1
      env_indent = ind
    } else if (in_target && line ~ /^[ ]*env:/) {
      print "unsupported inline env value under the " target " container" > "/dev/stderr"
      bad = 1
      exit 43
    }

    if (in_target && in_env &&
        line ~ /^[ ]*-[ ]+name:[ ]*["\047]?PORT["\047]?[ ]*(#.*)?$/) {
      port_pending = 1
      port_name_indent = ind
    }

    print line
  }
  END {
    if (bad) exit 1
    close_container()
    if (!target_seen) {
      print "could not find a container named " target > "/dev/stderr"
      exit 1
    }
    if (!changed) {
      print "deployment was not changed" > "/dev/stderr"
      exit 1
    }
  }
' "$CLONE/$COMPONENT_PATH" > "$MUTATED"; then
  echo "ERROR: could not safely update PORT in $COMPONENT_PATH — check the $CONTAINER_NAME container's YAML structure" >&2
  exit 1
fi
mv "$MUTATED" "$CLONE/$COMPONENT_PATH"

# Add the specific path only (never -A): welcome.yaml and anything else the
# attendee has in gitops/components/demo/ is untouched by construction.
git -C "$CLONE" add "$COMPONENT_PATH"
git -C "$CLONE" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \
  commit -q -m "release: demo-web port-band rollout" \
  -m "Cloudbox-Scenario: day2-01"
INJECTED_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"
git -C "$CLONE" push -q origin main
argocd_refresh demo

echo "💥 Scenario 01-bad-release-rollback injected as commit $INJECTED_SHA."
echo
echo "Your job: find the symptom, write a diagnosis, prove it, then revert the bad release."
echo "Start with:"
echo "  kubectl -n demo get all"
echo
echo "NO PEEKING at scenarios/01-bad-release-rollback/description.md"
echo "until you have written down a diagnosis. Give up / done: ./restore.sh 1"
