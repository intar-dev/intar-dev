#!/usr/bin/env bash
# Module 10 — verify Git is clean and the day-2 demo workload is healthy.
# Check-only: this script never commits, pushes, applies, patches, edits, or deletes.
#
# Target: the attendee's cloudbox/platform clone, gitops/components/demo/ —
# the same path module 02's "demo" Application (canonical module state)
# syncs into namespace demo. cloudbox/demo-app is unrelated Go source for
# module 07's in-cluster build and is never read here.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime lookup is anchored to this script; ShellCheck cannot resolve $DIR.
# shellcheck disable=SC1091
source "$DIR/../common.sh"

WELCOME_PATH="gitops/components/demo/welcome.yaml"
COMPONENT_PATH="gitops/components/demo/demo-web.yaml"
BASELINE_SRC="$DIR/baseline/demo-web.yaml"
POISON_VALUE="8080-canary"
SCENARIO_TRAILER="Cloudbox-Scenario: day2-01"
OOM_POISON_VALUE="8Mi"
OOM_POISON_MARKER="memory: $OOM_POISON_VALUE"
OOM_SCENARIO_TRAILER="Cloudbox-Scenario: day2-02"
# Predicate-based, not tied to a specific digest: any image: value
# referencing docker.io/ (quoted or not) is scenario 3's marker. A future
# baseline digest bump must not silently break routing here — matches
# scenario 3's inject.sh/fix.sh, which use the same pattern for the same
# reason. docker.io/ appears in no other scenario's markers or the baseline,
# so this stays disjoint from scenario 1's and scenario 2's routing.
IMAGE_POISON_PATTERN="^[[:space:]]*image:[[:space:]]*[\"']?docker\.io/"
IMAGE_SCENARIO_TRAILER="Cloudbox-Scenario: day2-03"
FAILED=0

ok()   { echo "✅ $1"; }
fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

pod_status_sample() {
  kubectl --request-timeout=3s -n demo get pods -l app=demo-web \
    -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{range .status.containerStatuses[*]}{.name}{":"}{.state.waiting.reason}{":"}{.state.terminated.reason}{":"}{.lastState.terminated.reason}{":"}{.restartCount}{","}{end}{"\n"}{end}' \
    2>/dev/null || true
}

pod_restart_total() {
  printf '%s\n' "$1" | awk -F '[:|,]' '
    { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) total += $i }
    END { print total + 0 }
  '
}

pod_has_high_restarts() {
  printf '%s\n' "$1" | awk -F '[:|,]' '
    { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/ && $i > 3) found = 1 }
    END { exit(found ? 0 : 1) }
  '
}

CLONE="$(gitops_clone)" || exit 1
TMP_PARENT="$(dirname "$CLONE")"
trap 'rm -rf "$TMP_PARENT"' EXIT

if [ ! -f "$CLONE/$WELCOME_PATH" ]; then
  fail "cloudbox/platform has no $WELCOME_PATH — enable module 02 first (see lab/02-gitops), then run ./verify.sh again"
  echo
  echo "❌ $FAILED check(s) failed. Follow the FAIL lines above, then run ./verify.sh again."
  exit 1
fi

if [ ! -f "$CLONE/$COMPONENT_PATH" ]; then
  fail "cloudbox/platform has no $COMPONENT_PATH — module 10's baseline hasn't been seeded yet; run ./inject.sh 1, 2, or 3 once to seed it, wait for ArgoCD, then run the same scenario again to inject the fault"
  echo
  echo "❌ $FAILED check(s) failed. Follow the FAIL lines above, then run ./verify.sh again."
  exit 1
fi

# First-match reporting is intentional: the three poison markers are
# disjoint by construction (different fields, never injected together in
# normal use), so at most one branch is ever expected to be relevant. Order
# does not encode priority — it's just the order the scenarios were added in.
if grep -Fq -- "$POISON_VALUE" "$CLONE/$COMPONENT_PATH"; then
  fail "scenario 1 is still present in Git ($COMPONENT_PATH contains $POISON_VALUE) — inspect git log, then run git revert <scenario-commit> && git push"

  # The Git marker is authoritative. Live probes only confirm that the injected
  # commit has produced the intended failure, and are deliberately short-lived.
  if ! command -v kubectl >/dev/null 2>&1 || \
    ! kubectl --request-timeout=3s get namespace demo >/dev/null 2>&1; then
    fail "could not confirm scenario 1's live symptoms — restore cluster access, then run kubectl -n demo get pods -l app=demo-web"
  else
    POD_STATE="$(kubectl --request-timeout=3s -n demo get pods -l app=demo-web \
      -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{range .status.containerStatuses[*]}{.state.waiting.reason}{":"}{.restartCount}{","}{end}{"\n"}{end}' \
      2>/dev/null || true)"
    if printf '%s\n' "$POD_STATE" | grep -Fq 'CrashLoopBackOff'; then
      ok "scenario 1 confirmed live: a demo-web pod is CrashLoopBackOff"
    else
      fail "Git is poisoned but no demo-web pod reports CrashLoopBackOff yet — wait for ArgoCD, then run kubectl -n demo describe pod <new-pod>"
    fi

    if kubectl --request-timeout=3s -n demo rollout status deploy/demo-web \
      --timeout=5s >/dev/null 2>&1; then
      fail "Git is poisoned but the demo-web rollout reports complete — inspect the ArgoCD Application and run kubectl -n demo get rs,pods"
    else
      ok "scenario 1 confirmed live: the demo-web rollout is not completing"
    fi
  fi
elif grep -Fq -- "$OOM_POISON_MARKER" "$CLONE/$COMPONENT_PATH"; then
  fail "scenario 2 is still present in Git ($COMPONENT_PATH contains $OOM_POISON_MARKER) — inspect git log, then run git revert <scenario-commit> && git push"

  # Periodic OOMKills can leave a Deployment Available, so rollout completion
  # is not a reliable symptom. Confirm the prior OOMKilled state and a non-zero
  # restart count instead.
  if ! command -v kubectl >/dev/null 2>&1 || \
    ! kubectl --request-timeout=3s get namespace demo >/dev/null 2>&1; then
    fail "could not confirm scenario 2's live symptoms — restore cluster access, then run kubectl -n demo get pods -l app=demo-web -w"
  else
    POD_STATE="$(pod_status_sample)"
    if printf '%s\n' "$POD_STATE" | grep -Fq 'OOMKilled'; then
      ok "scenario 2 confirmed live: a demo-web container was OOMKilled"
    else
      fail "Git is poisoned but no demo-web container reports a previous OOMKilled termination yet — wait for ArgoCD, then run kubectl -n demo describe pod <pod>"
    fi

    if printf '%s\n' "$POD_STATE" | awk -F '[:|,]' '
      { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/ && $i > 0) found = 1 }
      END { exit(found ? 0 : 1) }
    '; then
      ok "scenario 2 confirmed live: a demo-web container has restarted"
    else
      fail "Git is poisoned but demo-web restart counts are still zero — watch kubectl -n demo get pods -l app=demo-web -w until the rightsizing commit takes effect"
    fi
  fi
elif grep -Eq -- "$IMAGE_POISON_PATTERN" "$CLONE/$COMPONENT_PATH"; then
  fail "scenario 3 is still present in Git ($COMPONENT_PATH references a docker.io/ image) — inspect git log, then run git revert <scenario-commit> && git push"

  # An image-pull failure has no previous process logs: confirm the waiting
  # reason and send the attendee to pod Events for the registry error.
  if ! command -v kubectl >/dev/null 2>&1 || \
    ! kubectl --request-timeout=3s get namespace demo >/dev/null 2>&1; then
    fail "could not confirm scenario 3's live symptoms — restore cluster access, then run kubectl -n demo get pods -l app=demo-web"
  else
    POD_STATE="$(pod_status_sample)"
    if printf '%s\n' "$POD_STATE" | grep -Eq 'ImagePullBackOff|ErrImagePull'; then
      ok "scenario 3 confirmed live: a demo-web container is waiting on an image pull"
    else
      fail "Git is poisoned but no demo-web container reports ImagePullBackOff or ErrImagePull yet — wait for ArgoCD, then run kubectl -n demo describe pod <pod>"
    fi
  fi
else
  # Scoped to COMPONENT_PATH (matching each scenario's own fix.sh) so an
  # unrelated commit elsewhere in the repo that happens to carry the same
  # trailer text cannot misreport scenario history.
  SCENARIO_HISTORY_FOUND=0
  if git -C "$CLONE" log --format='%H' --grep="$SCENARIO_TRAILER" -n 1 -- "$COMPONENT_PATH" | grep -q .; then
    ok "scenario 1 fixed: the poison value is absent from cloudbox/platform:main"
    SCENARIO_HISTORY_FOUND=1
  fi
  if git -C "$CLONE" log --format='%H' --grep="$OOM_SCENARIO_TRAILER" -n 1 -- "$COMPONENT_PATH" | grep -q .; then
    ok "scenario 2 fixed: the poison value is absent from cloudbox/platform:main"
    SCENARIO_HISTORY_FOUND=1
  fi
  if git -C "$CLONE" log --format='%H' --grep="$IMAGE_SCENARIO_TRAILER" -n 1 -- "$COMPONENT_PATH" | grep -q .; then
    ok "scenario 3 fixed: the poison value is absent from cloudbox/platform:main"
    SCENARIO_HISTORY_FOUND=1
  fi
  if [ "$SCENARIO_HISTORY_FOUND" -eq 0 ]; then
    ok "day-2 scenarios were never injected (repository is clean)"
  fi

  # "Repo clean" means gitops/components/demo/demo-web.yaml matches this
  # module's own baseline byte-for-byte — not just "no poison substring" —
  # so a leftover, half-reverted, or hand-edited manifest is still caught.
  if cmp -s "$CLONE/$COMPONENT_PATH" "$BASELINE_SRC"; then
    ok "gitops/components/demo/demo-web.yaml matches the module's baseline"
  else
    fail "gitops/components/demo/demo-web.yaml no longer matches lab/10-day2-ops/baseline/demo-web.yaml — diff them and revert any leftover edit"
  fi

  IMAGE_LINES_FOUND=0
  NON_GHCR_IMAGE_FOUND=0
  while IFS= read -r image_line; do
    IMAGE_LINES_FOUND=1
    image_value="${image_line#*image:}"
    image_value="${image_value#"${image_value%%[![:space:]]*}"}"
    # A quoted scalar (image: "ghcr.io/..." or image: 'ghcr.io/...') must not
    # false-fail this check: strip one leading and, if present, one trailing
    # quote character before matching.
    case "$image_value" in
      \"*) image_value="${image_value#\"}" ;;
      \'*) image_value="${image_value#\'}" ;;
    esac
    case "$image_value" in
      *\") image_value="${image_value%\"}" ;;
      *\') image_value="${image_value%\'}" ;;
    esac
    case "$image_value" in
      ghcr.io/*) ;;
      *)
        fail "every demo-web image must start with ghcr.io/ — offending line: $image_line"
        NON_GHCR_IMAGE_FOUND=1
        ;;
    esac
  done < <(grep -E '^[[:space:]]*image:[[:space:]]*' "$CLONE/$COMPONENT_PATH" || true)
  if [ "$IMAGE_LINES_FOUND" -eq 0 ]; then
    fail "no image references were found in $COMPONENT_PATH — restore the module baseline"
  elif [ "$NON_GHCR_IMAGE_FOUND" -eq 0 ]; then
    ok "every demo-web image reference uses ghcr.io/"
  fi

  # welcome.yaml is the attendee's own module-02 customization (their name goes
  # in `owner`), so we cannot diff it against a fixed baseline — but our own
  # commits only ever `git add` the demo-web.yaml path (never -A), so this is a
  # sanity check that our scripts left it alone, not a content comparison.
  if grep -q '^kind: ConfigMap' "$CLONE/$WELCOME_PATH" && \
    grep -q 'name: welcome' "$CLONE/$WELCOME_PATH"; then
    ok "welcome.yaml is untouched (still a ConfigMap named welcome)"
  else
    fail "gitops/components/demo/welcome.yaml no longer looks like module 02's ConfigMap — inspect git log for an unrelated change"
  fi

  # Git-clean and live-healthy are separate, unconditional checks. Together they
  # catch a live-only edit: ArgoCD selfHeal makes Git the durable source of truth.
  # Reachability is gated fast (3s), then the rollout watch runs WITHOUT
  # --request-timeout — a short per-request timeout would abort the 60s watch.
  if ! command -v kubectl >/dev/null 2>&1 || \
    ! kubectl --request-timeout=3s -n demo get deploy demo-web >/dev/null 2>&1; then
    fail "cluster unreachable or deploy/demo-web missing — check kubectl access, then run kubectl -n demo get deploy demo-web"
  elif kubectl -n demo rollout status deploy/demo-web \
      --timeout=60s >/dev/null 2>&1; then
    ok "demo-web rollout is healthy"
  else
    fail "demo-web rollout is not healthy — run kubectl -n demo rollout status deploy/demo-web, then fix Git and retry"
  fi

  POD_STATE_1=""
  if command -v kubectl >/dev/null 2>&1; then
    POD_STATE_1="$(pod_status_sample)"
  fi
  if [ -z "$POD_STATE_1" ]; then
    fail "no demo-web pod status was readable — run kubectl -n demo get pods -l app=demo-web and restore cluster access or the workload"
  else
    # A periodic OOMKill can be briefly Running at a single snapshot. Sample a
    # second time within a bounded window and require both states to be clean,
    # with the aggregate restart count not increasing. This is scenario 2's
    # stability gate specifically — it runs on EVERY green (no-poison-marker)
    # verify, not just after scenario 2, since it's the only way to catch a
    # periodic OOMKilled cadence that a single snapshot could miss.
    sleep 15
    POD_STATE_2="$(pod_status_sample)"
    POD_STABLE=1

    if [ -z "$POD_STATE_2" ]; then
      fail "the second demo-web pod-status sample was unreadable — run kubectl -n demo get pods -l app=demo-web and restore cluster access or the workload"
      POD_STABLE=0
    else
      if printf '%s\n%s\n' "$POD_STATE_1" "$POD_STATE_2" | grep -Fq 'CrashLoopBackOff'; then
        fail "a demo-web pod was CrashLoopBackOff during the 15-second stability window — run kubectl -n demo logs <pod> --previous and inspect the Git-managed Deployment"
        POD_STABLE=0
      fi
      if printf '%s\n%s\n' "$POD_STATE_1" "$POD_STATE_2" | grep -Fq 'OOMKilled'; then
        fail "a demo-web container showed a previous OOMKilled termination during the 15-second stability window — run kubectl -n demo describe pod <pod> and inspect its memory limit"
        POD_STABLE=0
      fi
      if pod_has_high_restarts "$POD_STATE_1" || pod_has_high_restarts "$POD_STATE_2"; then
        fail "a demo-web container has more than 3 restarts — run kubectl -n demo describe pod <pod> and confirm the rollout has stabilized"
        POD_STABLE=0
      fi

      RESTART_TOTAL_1="$(pod_restart_total "$POD_STATE_1")"
      RESTART_TOTAL_2="$(pod_restart_total "$POD_STATE_2")"
      if [ "$RESTART_TOTAL_2" -gt "$RESTART_TOTAL_1" ]; then
        fail "demo-web restart counts increased during the 15-second stability window — run kubectl -n demo get pods -l app=demo-web -w and inspect the next termination"
        POD_STABLE=0
      fi
    fi

    if [ "$POD_STABLE" -eq 1 ]; then
      ok "demo-web pods stayed free of CrashLoopBackOff/OOMKilled and restart counts did not increase for 15 seconds"
    fi
  fi
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed. Follow the FAIL lines above, then run ./verify.sh again."
  exit 1
fi
echo "✅ Module 10 scenario complete — Git is clean and demo-web is healthy."
