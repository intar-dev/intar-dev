#!/usr/bin/env bash
# Website workflow, deploy job, step "Download tested deployment artifact".
set -euo pipefail
[[ "${TESTED_ARTIFACT_ID}" =~ ^[0-9]+$ ]]
[[ "${TESTED_ARTIFACT_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]
expected_digest="${TESTED_ARTIFACT_DIGEST#sha256:}"
artifact_name="website-dist-${GITHUB_SHA}"
artifact_json="${RUNNER_TEMP}/website-dist-artifact.json"
gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${TESTED_ARTIFACT_ID}" \
  > "${artifact_json}"
# The release uses this run's build, with the recorded identity and digest.
jq -e \
  --arg run "${GITHUB_RUN_ID}" \
  --arg name "${artifact_name}" \
  --arg expected "${expected_digest}" '
  .name == $name and
  ((.workflow_run.id | tostring) == $run) and
  (.expired == false) and
  (.digest == ("sha256:" + $expected))
' "${artifact_json}" >/dev/null
test "$(jq -r .digest "${artifact_json}")" = "sha256:${expected_digest}"
artifact_zip="${RUNNER_TEMP}/website-dist.zip"
gh api \
  "repos/${GITHUB_REPOSITORY}/actions/artifacts/${TESTED_ARTIFACT_ID}/zip" \
  > "${artifact_zip}"
measured_digest="$(sha256sum "${artifact_zip}" | cut -d ' ' -f 1)"
test "${measured_digest}" = "${expected_digest}"
mkdir -p apps/web/dist
python3 - "${artifact_zip}" "${GITHUB_WORKSPACE}/apps/web/dist" <<'PY'
import sys, zipfile
archive_path, destination = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive_path) as archive:
    for name in archive.namelist():
        if name.startswith("/") or ".." in name.split("/"):
            sys.exit("unsafe artifact member: " + name)
    archive.extractall(destination)
PY
test -f "${GITHUB_WORKSPACE}/apps/web/dist/server/wrangler.json"
