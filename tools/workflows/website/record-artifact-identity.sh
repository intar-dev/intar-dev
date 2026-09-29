#!/usr/bin/env bash
# Website workflow, validate job, step "Record the tested artifact identity".
set -euo pipefail
artifact_name="website-dist-${GITHUB_SHA}"
artifacts_json="${RUNNER_TEMP}/website-artifact.json"
gh api --paginate \
  "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/artifacts?name=${artifact_name}" \
  > "${artifacts_json}"
# The artifact must belong to THIS run and this revision: the deploy
# job consumes it from the same run, so a green conclusion is not the
# proof any more, identity is.
jq -e \
  --arg run "${GITHUB_RUN_ID}" \
  --arg name "${artifact_name}" '
  [.artifacts[] | select(.name == $name and .expired == false)] as $found |
  if ($found | length) == 1 then
    $found[0] as $artifact |
    ($artifact.id | type == "number") and
    ($artifact.digest |
      type == "string" and test("^sha256:[0-9a-f]{64}$"))
  else false end
' "${artifacts_json}" >/dev/null
jq -r '[.artifacts[] | select(.name == $name)] | .[0].id' \
  --arg name "${artifact_name}" "${artifacts_json}" \
  > "${RUNNER_TEMP}/artifact-id.txt"
{
  printf 'artifact_id=%s\n' "$(cat "${RUNNER_TEMP}/artifact-id.txt")"
  printf 'artifact_digest=%s\n' \
    "$(jq -r --arg name "${artifact_name}" '[.artifacts[] | select(.name == $name)] | .[0].digest' "${artifacts_json}")"
} >> "${GITHUB_OUTPUT}"
