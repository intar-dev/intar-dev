#!/usr/bin/env bash
# release.yml, job release, step "Publish tagged GitHub release".
set -euo pipefail
git fetch origin main --tags
remote_main="$(git rev-parse origin/main)"
if [ "${RESUME}" = "true" ]; then
  remote_tag_object="$(
    git ls-remote --exit-code --refs origin "refs/tags/${TAG}" \
      | awk 'NR == 1 { print $1 }'
  )"
  local_tag_object="$(git rev-parse "refs/tags/${TAG}")"
  remote_release_sha="$(git rev-parse "refs/tags/${TAG}^{commit}")"
  if [ -z "${remote_tag_object}" ] || \
    [ "${remote_tag_object}" != "${local_tag_object}" ] || \
    [ "${remote_release_sha}" != "${RELEASE_SHA}" ]; then
    echo "Origin tag ${TAG} changed during resume verification." >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "${RELEASE_SHA}" "${remote_main}"; then
    echo "Release commit ${RELEASE_SHA} is no longer reachable from main." >&2
    exit 1
  fi
else
  if [ "${remote_main}" != "${GITHUB_SHA}" ]; then
    echo "main advanced during release verification; start a fresh dispatch from ${remote_main}." >&2
    exit 1
  fi
  git tag -a "${TAG}" "${RELEASE_SHA}" \
    -m "${PROJECT} ${VERSION_TAG}" \
    -m "Release-Run-ID: ${PAYLOAD_RUN_ID}" \
    -m "Release-Artifact-ID: ${PAYLOAD_ID}" \
    -m "Release-Artifact-Name: ${PAYLOAD_NAME}" \
    -m "Release-Artifact-Digest: ${PAYLOAD_DIGEST}" \
    -m "Release-Source-SHA: ${PAYLOAD_SOURCE_SHA}"
  git push --atomic origin HEAD:refs/heads/main "refs/tags/${TAG}"
fi

mapfile -t local_assets < <(
  find dist -mindepth 1 -maxdepth 1 -type f -printf '%f\n' \
    | LC_ALL=C sort
)
if [ "${#local_assets[@]}" -eq 0 ]; then
  echo "No release assets were built." >&2
  exit 1
fi
for asset_name in "${local_assets[@]}"; do
  case "${asset_name}" in
    *[!A-Za-z0-9._-]*)
      echo "Unsafe release asset name: ${asset_name}" >&2
      exit 1
      ;;
  esac
done

release_title="${PROJECT} ${VERSION_TAG}"
if gh release view "${TAG}" >/dev/null 2>&1; then
  release_metadata="$(
    gh release view "${TAG}" \
      --json tagName,name,isDraft,isPrerelease \
      --jq '[.tagName, .name, (.isDraft | tostring), (.isPrerelease | tostring)] | @tsv'
  )"
  IFS=$'\t' read -r \
    existing_tag existing_title existing_draft existing_prerelease \
    <<<"${release_metadata}"
  if [ "${existing_tag}" != "${TAG}" ] || \
    [ "${existing_title}" != "${release_title}" ] || \
    [ "${existing_prerelease}" != "false" ]; then
    echo "Existing GitHub release metadata for ${TAG} is not canonical." >&2
    exit 1
  fi
  case "${existing_draft}" in
    true|false) ;;
    *)
      echo "Existing GitHub release draft state is invalid." >&2
      exit 1
      ;;
  esac
else
  gh release create "${TAG}" \
    --draft \
    --verify-tag \
    --target "${RELEASE_SHA}" \
    --title "${release_title}" \
    --notes "Release ${VERSION_TAG}."
  existing_draft=true
fi

mapfile -t remote_assets < <(
  gh release view "${TAG}" --json assets --jq '.assets[].name' \
    | LC_ALL=C sort
)
for asset_name in "${remote_assets[@]}"; do
  if ! printf '%s\n' "${local_assets[@]}" \
    | grep -Fqx -- "${asset_name}"; then
    echo "Unexpected existing release asset: ${asset_name}" >&2
    exit 1
  fi
done

verify_root="$(mktemp -d)"
cleanup_release_verify() {
  rm -rf "${verify_root}"
}
trap cleanup_release_verify EXIT
for asset_name in "${local_assets[@]}"; do
  if printf '%s\n' "${remote_assets[@]}" \
    | grep -Fqx -- "${asset_name}"; then
    existing_dir="${verify_root}/existing-${asset_name}"
    mkdir -p "${existing_dir}"
    gh release download "${TAG}" \
      --pattern "${asset_name}" \
      --dir "${existing_dir}"
    if ! cmp --silent \
      "dist/${asset_name}" "${existing_dir}/${asset_name}"; then
      echo "Existing asset ${asset_name} does not match this exact build." >&2
      exit 1
    fi
  else
    gh release upload "${TAG}" "dist/${asset_name}"
  fi
done

final_dir="${verify_root}/final"
mkdir -p "${final_dir}"
gh release download "${TAG}" --dir "${final_dir}"
mapfile -t final_assets < <(
  find "${final_dir}" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' \
    | LC_ALL=C sort
)
if [ "${final_assets[*]}" != "${local_assets[*]}" ]; then
  echo "Published release asset set does not match the build." >&2
  exit 1
fi
for asset_name in "${local_assets[@]}"; do
  cmp --silent "dist/${asset_name}" "${final_dir}/${asset_name}"
done

if [ "${existing_draft}" = "true" ]; then
  gh release edit "${TAG}" --draft=false
fi
published_metadata="$(
  gh release view "${TAG}" \
    --json tagName,name,isDraft,isPrerelease \
    --jq '[.tagName, .name, (.isDraft | tostring), (.isPrerelease | tostring)] | @tsv'
)"
IFS=$'\t' read -r \
  published_tag published_title published_draft published_prerelease \
  <<<"${published_metadata}"
if [ "${published_tag}" != "${TAG}" ] || \
  [ "${published_title}" != "${release_title}" ] || \
  [ "${published_draft}" != "false" ] || \
  [ "${published_prerelease}" != "false" ]; then
  echo "Published GitHub release metadata for ${TAG} is not canonical." >&2
  exit 1
fi
