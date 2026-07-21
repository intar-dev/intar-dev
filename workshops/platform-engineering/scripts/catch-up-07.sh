#!/usr/bin/env bash
set -euo pipefail

readonly workshop_root=/opt/platform-engineering-workshop
readonly generic_catch_up="${workshop_root}/scripts/catch-up.sh"
readonly upstream_post="${workshop_root}/solutions/module-07/post.sh"
cd "${workshop_root}"
export MISE_OFFLINE=1

# The pinned upstream post-step copies BusyBox from an external registry. The
# Intar publication contract is fully offline, so let the generic helper apply
# the cumulative GitOps state while temporarily suppressing that post-step.
[[ -x "${generic_catch_up}" ]] || { echo "missing generic catch-up helper" >&2; exit 1; }
[[ -x "${upstream_post}" ]] || { echo "missing module-07 post-step" >&2; exit 1; }
readonly upstream_post_mode="$(stat -c '%a' "${upstream_post}")"
restore_upstream_post() {
  chmod "${upstream_post_mode}" "${upstream_post}"
}
trap restore_upstream_post EXIT
chmod a-x "${upstream_post}"
"${generic_catch_up}" 07
restore_upstream_post
trap - EXIT

# Preserve the pinned imperative contract, but seed Zot exclusively from the
# guest-local registry populated in checkpoint 00. Missing cache content is a
# publication failure; the builder must never fall back to conference Wi-Fi.
"${workshop_root}/solutions/module-03/post.sh"
if curl -fsS --max-time 5 http://localhost:30500/v2/_catalog 2>/dev/null | grep -q hello-site; then
  echo "hello-site already in Zot; skipping build"
  exit 0
fi
crane manifest --insecure \
  localhost:5001/library/busybox:1.37.0 >/dev/null
crane copy --insecure \
  localhost:5001/library/busybox:1.37.0 localhost:30500/library/busybox:1.37.0

workflow_name="$(kubectl create -f "${workshop_root}/lab/07-ci/workflow-run.yaml" -o jsonpath='{.metadata.name}')"
echo "submitted build workflow: ${workflow_name}"
waited=0
while true; do
  phase="$(kubectl -n builds get workflow "${workflow_name}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "${phase}" in
    Succeeded)
      echo "build succeeded"
      break
      ;;
    Failed|Error)
      echo "build workflow ${phase}" >&2
      exit 1
      ;;
  esac
  if (( waited >= 900 )); then
    echo "build timed out" >&2
    exit 1
  fi
  sleep 15
  waited=$((waited + 15))
done

kubectl -n demo delete pods -l app=hello-site --ignore-not-found
kubectl -n demo rollout status deploy/hello-site --timeout=300s || true
