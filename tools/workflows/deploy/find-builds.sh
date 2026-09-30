#!/usr/bin/env bash
# deploy.yml, job resolve, step "Find the tested builds".
# Names the CI run this deploy takes its builds from, and each lane's build in
# it: after a CI run, that run; on a dispatch, the latest successful CI run for
# main's tip. A lane that did not run uploaded no build, so its deploy skips.
set -euo pipefail
# Every deploy step names its revision by GITHUB_SHA, main's tip when this run
# was triggered. Should main have moved on since, the CI run for it deploys.
main="$(gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha)"
if [ "${main}" != "${GITHUB_SHA}" ]; then
  echo "main moved on to ${main}; the CI run for it deploys." | tee -a "${GITHUB_STEP_SUMMARY}"
  exit 0
fi
run_id="${CI_RUN_ID}"
if [ -z "${run_id}" ]; then
  run_id="$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&head_sha=${GITHUB_SHA}&status=success" \
    --jq '[.workflow_runs[] | select(.event == "push" or .event == "workflow_dispatch")] | max_by(.run_number) | .id // empty')"
  if [ -z "${run_id}" ]; then
    echo "No CI run passed for main's tip ${GITHUB_SHA}. Dispatch CI from main; it deploys once it passes." >&2
    exit 1
  fi
fi
[[ "${run_id}" =~ ^[0-9]+$ ]]
artifacts="${RUNNER_TEMP}/ci-artifacts.json"
gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/artifacts" --jq '.artifacts[]' |
  jq -s . >"${artifacts}"
# A lane that ran uploaded its build once, from this revision. One that expired
# fails here: dispatching CI from main builds and deploys it again.
builds=""
for lane in web docs; do
  build="$(jq -r --arg lane "${lane}" --arg run "${run_id}" --arg sha "${GITHUB_SHA}" '
    ($lane + "-dist-" + $sha) as $name |
    [.[] | select(.name == $name)] |
    if length == 0 then empty
    elif length == 1 and (.[0] |
      .expired == false and
      (.workflow_run.id | tostring) == $run and
      .workflow_run.head_sha == $sha and
      (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")))
    then .[0] | "\($lane)_artifact=\(.id)\n\($lane)_digest=\(.digest)"
    else error("\($name) is not one live artifact of CI run \($run) with a sha256 digest")
    end
  ' "${artifacts}")"
  [ -z "${build}" ] || builds+="${build}"$'\n'
done
printf 'run_id=%s\n%s' "${run_id}" "${builds}" >>"${GITHUB_OUTPUT}"
printf 'Deploying %s from CI run %s:\n\n%s\n' "${GITHUB_SHA}" "${run_id}" "${builds:-no builds}" \
  >>"${GITHUB_STEP_SUMMARY}"
