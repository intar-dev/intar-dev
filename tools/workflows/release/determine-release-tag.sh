#!/usr/bin/env bash
# release.yml, job release, step "Determine release tag".
set -euo pipefail
git fetch origin main --tags
if [ -n "${RESUME_TAG}" ]; then
  version_tag="${RESUME_TAG#"${TAG_PREFIX}"}"
  if [ "${version_tag}" = "${RESUME_TAG}" ] || \
    ! [[ "${version_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Resume tag must match ${TAG_PREFIX}v<major>.<minor>.<patch>." >&2
    exit 1
  fi

  tag_ref="refs/tags/${RESUME_TAG}"
  if ! git rev-parse --verify --quiet "${tag_ref}" >/dev/null; then
    echo "Resume tag ${RESUME_TAG} does not exist." >&2
    exit 1
  fi
  if [ "$(git cat-file -t "${tag_ref}")" != "tag" ]; then
    echo "Resume tag ${RESUME_TAG} must be an annotated release tag." >&2
    exit 1
  fi

  remote_tag_object="$(
    git ls-remote --exit-code --refs origin "${tag_ref}" \
      | awk 'NR == 1 { print $1 }'
  )"
  local_tag_object="$(git rev-parse "${tag_ref}")"
  if [ -z "${remote_tag_object}" ] || \
    [ "${remote_tag_object}" != "${local_tag_object}" ]; then
    echo "Resume tag ${RESUME_TAG} does not match the immutable origin tag." >&2
    exit 1
  fi

  release_sha="$(git rev-parse "${tag_ref}^{commit}")"
  trigger_sha="$(git rev-parse "${GITHUB_SHA}^{commit}")"
  if [ "${trigger_sha}" != "${release_sha}" ]; then
    echo "Resume must use the exact tagged workflow revision ${release_sha}." >&2
    echo "Select ${RESUME_TAG}, or main while it still points at that commit." >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "${release_sha}" origin/main; then
    echo "Resume tag ${RESUME_TAG} is not reachable from origin/main." >&2
    exit 1
  fi

  tag_subject="$(
    git for-each-ref --format='%(contents:subject)' "${tag_ref}"
  )"
  if [ "${tag_subject}" != "${PROJECT} ${version_tag}" ]; then
    echo "Resume tag annotation does not match ${PROJECT} ${version_tag}." >&2
    exit 1
  fi
  manifest_version="$(
    git show "${release_sha}:${MANIFEST}" \
      | sed -n 's/^version = "\([0-9][0-9.]*\)".*/\1/p' \
      | head -n 1
  )"
  if [ "${manifest_version}" != "${version_tag#v}" ]; then
    echo "Resume tag version does not match ${MANIFEST} at ${release_sha}." >&2
    exit 1
  fi

  tag_contents="$(git for-each-ref --format='%(contents)' "${tag_ref}")"
  payload_run_id="$(
    printf '%s\n' "${tag_contents}" \
      | sed -n 's/^Release-Run-ID: \([0-9][0-9]*\)$/\1/p'
  )"
  payload_id="$(
    printf '%s\n' "${tag_contents}" \
      | sed -n 's/^Release-Artifact-ID: \([0-9][0-9]*\)$/\1/p'
  )"
  payload_name="$(
    printf '%s\n' "${tag_contents}" \
      | sed -n 's/^Release-Artifact-Name: \(.*\)$/\1/p'
  )"
  payload_digest="$(
    printf '%s\n' "${tag_contents}" \
      | sed -n 's/^Release-Artifact-Digest: \(sha256:[0-9a-f]*\)$/\1/p'
  )"
  payload_source_sha="$(
    printf '%s\n' "${tag_contents}" \
      | sed -n 's/^Release-Source-SHA: \([0-9a-f]*\)$/\1/p'
  )"
  expected_payload_name="release-payload-${PROJECT}-${version_tag#v}"
  if ! [[ "${payload_run_id}" =~ ^[0-9]+$ ]] || \
    ! [[ "${payload_id}" =~ ^[0-9]+$ ]] || \
    [ "${payload_name}" != "${expected_payload_name}" ] || \
    ! [[ "${payload_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
    ! [[ "${payload_source_sha}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Resume tag ${RESUME_TAG} lacks canonical release payload metadata." >&2
    exit 1
  fi

  git checkout --detach "${release_sha}"
  {
    echo "resume=true"
    echo "release_sha=${release_sha}"
    echo "payload_digest=${payload_digest}"
    echo "payload_id=${payload_id}"
    echo "payload_name=${payload_name}"
    echo "payload_run_id=${payload_run_id}"
    echo "payload_source_sha=${payload_source_sha}"
    echo "version=${version_tag#v}"
    echo "version_tag=${version_tag}"
    echo "tag=${RESUME_TAG}"
  } >> "${GITHUB_OUTPUT}"
  exit 0
fi

latest_project_tag="$(git tag --list "${TAG_PREFIX}v*" --sort=-v:refname | awk -v prefix="${TAG_PREFIX}" 'index($0, prefix "v") == 1 && $0 ~ /^.+\/v[0-9]+\.[0-9]+\.[0-9]+$/ { print; exit }')"
if [ -n "${latest_project_tag}" ]; then
  latest_version_tag="${latest_project_tag#"${TAG_PREFIX}"}"
else
  cargo_version="$(sed -n 's/^version = "\([0-9][0-9.]*\)".*/\1/p' "${MANIFEST}" | head -n 1)"
  latest_version_tag="v${cargo_version:-0.0.0}"
fi
version="${latest_version_tag#v}"
IFS='.' read -r major minor patch <<<"${version}"
case "${BUMP}" in
  patch) patch=$((patch + 1)) ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  major) major=$((major + 1)); minor=0; patch=0 ;;
esac
next_version="v${major}.${minor}.${patch}"
next_tag="${TAG_PREFIX}${next_version}"
if git rev-parse --verify --quiet "refs/tags/${next_tag}" >/dev/null; then
  echo "Tag ${next_tag} already exists." >&2
  exit 1
fi
{
  echo "resume=false"
  echo "release_sha="
  echo "payload_digest="
  echo "payload_id="
  echo "payload_name=release-payload-${PROJECT}-${next_version#v}"
  echo "payload_run_id="
  echo "payload_source_sha="
  echo "version=${next_version#v}"
  echo "version_tag=${next_version}"
  echo "tag=${next_tag}"
} >> "${GITHUB_OUTPUT}"
