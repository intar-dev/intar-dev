#!/usr/bin/env bash
# Website workflow, plan job, step "Resolve the verified guest-tools pin".
set -euo pipefail
release_dir="${RUNNER_TEMP}/guest-tools-release"
mkdir -p "${release_dir}"
tools_run_id=""
if [ "${MAINTENANCE_MODE}" = auto ]; then
  # A routine release changes no runtime contract, so it keeps the
  # promoted stable pin and reads no tools build at all. The published
  # objects are still verified against that pin below.
  bunx wrangler r2 object get \
    "${BUCKET}/guest-tools/scenario/stable.json" \
    --remote --jurisdiction eu --file "${release_dir}/manifest.json"
  pin_source=stable
else
  # A deliberate release changes the runtime contract, so its pin must
  # come from a tools build of this exact revision.
  runs_json="${RUNNER_TEMP}/image-ops-runs.json"
  gh api --paginate \
    "repos/${GITHUB_REPOSITORY}/actions/workflows/image-ops.yml/runs?branch=main&status=success&per_page=20" \
    > "${runs_json}"
  # A successful image-ops run can be a cleanup status read, so the
  # run must also carry a successful tools-build job. The newest such
  # run for this revision is the one whose candidate this release pins.
  jobs_json="${RUNNER_TEMP}/image-ops-jobs.json"
  tools_run_id=""
  for candidate in $(jq -r --arg sha "${GITHUB_SHA}" '
    [ .workflow_runs[]
      | select(
          .conclusion == "success" and
          .head_branch == "main" and
          .head_sha == $sha and
          .event == "workflow_dispatch"
        )
    ] | .[].id' "${runs_json}"); do
    gh api --paginate \
      "repos/${GITHUB_REPOSITORY}/actions/runs/${candidate}/jobs" \
      > "${jobs_json}"
    if jq -e '
      [ .jobs[]
        | select(.name == "Build and verify tools" and .conclusion == "success")
      ] | length > 0
    ' "${jobs_json}" >/dev/null 2>&1; then
      tools_run_id="${candidate}"
      break
    fi
  done
  test -n "${tools_run_id}"
  pin_source="run-${tools_run_id}"
  artifact_name="guest-tools-deployment-${tools_run_id}"
  artifacts_json="${RUNNER_TEMP}/guest-tools-artifacts.json"
  gh api --paginate \
    "repos/${GITHUB_REPOSITORY}/actions/runs/${tools_run_id}/artifacts" \
    > "${artifacts_json}"
  jq -e --arg name "${artifact_name}" '
    [.artifacts[] | select(.name == $name and .expired == false)] |
    if length == 1 then
      .[0] as $artifact |
      ($artifact.id | type == "number") and
      ($artifact.digest |
        type == "string" and test("^sha256:[0-9a-f]{64}$"))
    else false end
  ' "${artifacts_json}" >/dev/null
  artifact_id="$(jq -er --arg name "${artifact_name}" \
    '[.artifacts[] | select(.name == $name)] | .[0].id' "${artifacts_json}")"
  expected_digest="$(jq -er --arg name "${artifact_name}" \
    '[.artifacts[] | select(.name == $name)] | .[0].digest' \
    "${artifacts_json}" | cut -d: -f2)"
  artifact_zip="${RUNNER_TEMP}/guest-tools-release.zip"
  gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact_id}/zip" \
    > "${artifact_zip}"
  test "$(sha256sum "${artifact_zip}" | cut -d ' ' -f 1)" = "${expected_digest}"
  python3 - "${artifact_zip}" "${release_dir}" <<'PY'
import sys, zipfile
archive_path, destination = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive_path) as archive:
    for name in archive.namelist():
        if name.startswith("/") or ".." in name.split("/"):
            sys.exit("unsafe artifact member: " + name)
    archive.extractall(destination)
PY
  test -f "${release_dir}/candidate.json"
  jq -e '.schema_version == 1 and .bootstrap_abi == 2' \
    "${release_dir}/candidate.json" >/dev/null
  mv "${release_dir}/candidate.json" "${release_dir}/manifest.json"
fi
manifest="${release_dir}/manifest.json"
# The pin is generated from the published release objects, never from
# a declared digest, and the verifier needs these two readers to
# decompress the disk and read the embedded files.
for tool in zstd debugfs; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "missing required release verification tool: ${tool}" >&2
    exit 1
  }
done
disk="$(jq -er .tools_disk_sha256 "${manifest}")"
kino="$(jq -er .kino_sha256 "${manifest}")"
(
  cd apps/web
  bunx wrangler r2 object get \
    "${BUCKET}/guest-tools/scenario/disks/${disk}.ext4.zst" \
    --remote --jurisdiction eu --file "${release_dir}/tools.ext4.zst"
  bunx wrangler r2 object get \
    "${BUCKET}/guest-tools/scenario/kino/${kino}/kino" \
    --remote --jurisdiction eu --file "${release_dir}/kino"
)
pin_file="${RUNNER_TEMP}/release-static-pin.json"
evidence_file="${RUNNER_TEMP}/release-static-pin-evidence.json"
bun tools/deploy/guest-tools-pin.ts release \
  --manifest "${manifest}" \
  --disk "${release_dir}/tools.ext4.zst" \
  --kino "${release_dir}/kino" \
  --out "${pin_file}" > "${evidence_file}"
jq -e '.status == "verified"' "${evidence_file}" >/dev/null
bun tools/deploy/guest-tools-pin.ts check --pin "${pin_file}" >/dev/null
printf 'static_pin_json=%s\n' "$(jq -c . "${pin_file}")" >> "${GITHUB_OUTPUT}"
printf 'pin_source=%s\n' "${pin_source}" >> "${GITHUB_OUTPUT}"
printf 'Resolved the runtime pin from %s.\n' "${pin_source}" >> "${GITHUB_STEP_SUMMARY}"
jq -c '{static_pin_sha256, compressed_disk_sha256, tools_disk_sha256, kino_sha256}' \
  "${evidence_file}" >> "${GITHUB_STEP_SUMMARY}"
