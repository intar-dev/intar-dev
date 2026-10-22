#!/usr/bin/env bash
# deploy.yml, job resolve, step "Find the tested builds".
# Names the build each lane deploys: the newest one CI built from inputs
# identical to main's tip's. ci.yml names a lane's build by the hash of its
# inputs (tools/ci/lane-inputs.sh), so a merge group that did not touch the
# website deploys the website build an earlier group, or a dispatch from main,
# uploaded.
#
# A build counts when its run is ci.yml for a merge group into main or a
# dispatch from main, its commit is on main (a group that never landed does
# not count), and the run passed. Break glass (BREAK_GLASS=true, a dispatch
# input) also takes a run that failed elsewhere, such as on a newly published
# advisory in the security lane, as long as the lane's own jobs passed.
#
# Without such a build: a push that did not change the lane's inputs leaves
# production on the build it already serves, and the deploy skips. A push that
# changed them, or a dispatch, fails: the build must exist, so dispatch CI from
# main to rebuild it.
set -euo pipefail
# Every deploy step names its revision by GITHUB_SHA, main's tip when this run
# was triggered. Should main have moved on since, the run for it deploys.
main="$(gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha)"
if [ "${main}" != "${GITHUB_SHA}" ]; then
  echo "main moved on to ${main}; the run for it deploys." | tee -a "${GITHUB_STEP_SUMMARY}"
  exit 0
fi
declare -A inputs=([web]="${WEB_INPUTS}" [docs]="${DOCS_INPUTS}")

# A lane's jobs passed in a run: its build-only job in a merge group, or the
# lane's job itself (the web build also with its Chromium smoke), by their
# names in ci.yml.
lane_passed() {
  local run="$1" lane="$2" passed
  passed="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${run}/jobs?filter=latest" \
    --jq '.jobs[] | select(.conclusion == "success") | .name')"
  grep -qxF "${lane} build" <<<"${passed}" && return 0
  grep -qxF "${lane}" <<<"${passed}" || return 1
  [ "${lane}" != web ] || grep -qxF "Chromium smoke" <<<"${passed}"
}

# The newest build that counts, as `<artifact id> <digest> <run id> <sha>`.
find_build() {
  local name="$1" lane="$2" artifacts id digest run run_json
  artifacts="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/artifacts?name=${name}" \
    --jq '.artifacts[] | select(.expired == false) | "\(.id) \(.digest) \(.workflow_run.id)"' | sort -rn)"
  while read -r id digest run; do
    [[ "${id}" =~ ^[0-9]+$ && "${digest}" =~ ^sha256:[0-9a-f]{64}$ && "${run}" =~ ^[0-9]+$ ]] || continue
    run_json="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run}")"
    jq -e --arg repo "${GITHUB_REPOSITORY}" '
      .path == ".github/workflows/ci.yml" and .head_repository.full_name == $repo and
      ((.event == "merge_group" and (.head_branch | startswith("gh-readonly-queue/main/"))) or
       (.event == "workflow_dispatch" and .head_branch == "main"))
    ' <<<"${run_json}" >/dev/null || continue
    sha="$(jq -r .head_sha <<<"${run_json}")"
    git merge-base --is-ancestor "${sha}" HEAD 2>/dev/null || continue
    # The queue merges once ci-ok passed, which can be moments before the run
    # completes, and a push that did not change these inputs may be the first
    # to look for that run's build.
    for _ in {1..10}; do
      [ "$(jq -r .status <<<"${run_json}")" != completed ] || break
      sleep 30
      run_json="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run}")"
    done
    if [ "$(jq -r .conclusion <<<"${run_json}")" != success ]; then
      if [ "${BREAK_GLASS:-false}" != true ] || ! lane_passed "${run}" "${lane}"; then
        continue
      fi
    fi
    echo "${id} ${digest} ${run} ${sha}"
    return 0
  done <<<"${artifacts}"
  return 0
}

builds=""
summary=""
missing=""
for lane in web docs; do
  read -r -a globs <<<"${inputs[${lane}]}"
  pathspecs=("${globs[@]/#/:(glob)}")
  hash="$(GITHUB_OUTPUT='' "$(dirname "$0")/../../ci/lane-inputs.sh" "${lane} ${inputs[${lane}]}" | cut -d= -f2)"
  name="${lane}-dist-${hash}"
  # A push that changed the lane's inputs landed a merge group that built
  # them, so their build must exist.
  changed=false
  if [ "${GITHUB_EVENT_NAME}" = push ]; then
    if ! git cat-file -e "${BEFORE:-}^{commit}" 2>/dev/null ||
      ! git diff --quiet "${BEFORE}" HEAD -- "${pathspecs[@]}"; then
      changed=true
    fi
  fi
  build="$(find_build "${name}" "${lane}")"
  if [ -n "${build}" ]; then
    read -r id digest run sha <<<"${build}"
    builds+="${lane}_artifact=${id}"$'\n'"${lane}_digest=${digest}"$'\n'"${lane}_run=${run}"$'\n'
    summary+="- ${lane}: ${name}, built from ${sha} in CI run ${run}"$'\n'
  elif [ "${GITHUB_EVENT_NAME}" = push ] && [ "${changed}" = false ]; then
    summary+="- ${lane}: inputs unchanged and no build of them is kept, so production keeps the build it serves; dispatch CI from main to rebuild it"$'\n'
  else
    missing+="${lane} "
    echo "No passing build of ${name} for main's tip. Dispatch CI from main; it deploys once it passes." >&2
  fi
done
if [ -n "${missing}" ]; then
  exit 1
fi
printf '%s' "${builds}" >>"${GITHUB_OUTPUT}"
printf 'Deploying %s:\n\n%s' "${GITHUB_SHA}" "${summary}" >>"${GITHUB_STEP_SUMMARY}"
