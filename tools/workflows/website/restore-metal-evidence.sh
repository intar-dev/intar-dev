#!/usr/bin/env bash
# Website workflow, deploy job, step "Restore metal retirement evidence".
set -euo pipefail
source_run="${RUNNER_TEMP}/metal-source-run.json"
gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${SOURCE_RUN_ID}" > "${source_run}"
jq -e --arg sha "${GITHUB_SHA}" --arg action "${METAL_ACTION}" '
  .head_sha == $sha and .head_branch == "main" and
  .path == ".github/workflows/website.yml" and .event == "workflow_dispatch" and
  .status == "completed" and ($action == "deploy" or .conclusion == "success")
' "${source_run}" >/dev/null
artifact_name="personal-metal-${GITHUB_SHA}-${SOURCE_RUN_ID}-1"
if [ "${METAL_ACTION}" = deploy ]; then
  artifact_name="personal-metal-inputs-${GITHUB_SHA}-${SOURCE_RUN_ID}"
fi
gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${SOURCE_RUN_ID}/artifacts" \
  > "${RUNNER_TEMP}/metal-source-artifacts.json"
artifact_id="$(jq -er --arg name "${artifact_name}" '
  [.artifacts[] | select(.name == $name and .expired == false)] |
  select(length == 1) | .[0].id
' "${RUNNER_TEMP}/metal-source-artifacts.json")"
# Verify immutable artifact bytes before extracting any evidence.
download_evidence() {
  local id="$1" destination="$2" metadata archive digest
  metadata="${RUNNER_TEMP}/metal-artifact-${id}.json"
  archive="${RUNNER_TEMP}/metal-artifact-${id}.zip"
  gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${id}" > "${metadata}"
  jq -e --arg sha "${GITHUB_SHA}" '
    .expired == false and .workflow_run.head_sha == $sha and
    (.digest | test("^sha256:[0-9a-f]{64}$"))
  ' "${metadata}" >/dev/null
  digest="$(jq -er .digest "${metadata}")"
  gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${id}/zip" > "${archive}"
  test "$(sha256sum "${archive}" | cut -d ' ' -f 1)" = "${digest#sha256:}"
  python3 - "${archive}" "${destination}" <<'PYTHON'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in archive.namelist():
        if name.startswith("/") or ".." in name.split("/"):
            sys.exit("unsafe artifact member: " + name)
    archive.extractall(sys.argv[2])
PYTHON
}
prior="${RUNNER_TEMP}/metal-prior"
download_evidence "${artifact_id}" "${prior}"
jq -e --arg sha "${GITHUB_SHA}" '
  .action == "deploy" and .revision == $sha and (.buildRunId | test("^[1-9][0-9]*$"))
' "${prior}/release.json" >/dev/null
mkdir -p "${RUNNER_TEMP}/personal-metal"
cp "${prior}/release-static-pin.json" "${prior}/release.json" "${RUNNER_TEMP}/personal-metal/"
if [ "${METAL_ACTION}" != deploy ]; then
  jq -e --arg sha "${GITHUB_SHA}" '
    .revision == $sha and (.runtimeRetiredAt | type == "number")
  ' "${prior}/deploy.json" >/dev/null
  cp "${prior}/deploy.json" "${RUNNER_TEMP}/personal-metal/"
fi
if [ -n "${PROOF_ARTIFACT_ID}" ]; then
  download_evidence "${PROOF_ARTIFACT_ID}" "${RUNNER_TEMP}/metal-proof"
  test -s "${RUNNER_TEMP}/metal-proof/personal-metal-proof.evidence"
  cp "${RUNNER_TEMP}/metal-artifact-${PROOF_ARTIFACT_ID}.json" \
    "${RUNNER_TEMP}/personal-metal/proof-artifact.json"
fi
