#!/usr/bin/env bash
# release.yml, job build, step "Smoke-test image CLI release package".
set -euo pipefail
smoke_root="$(mktemp -d)"
cleanup_smoke() {
  rm -rf "${smoke_root}"
}
trap cleanup_smoke EXIT

(
  cd dist
  sha256sum --check --strict "intar-image-cli_${VERSION}_checksums.txt"
)

for arch in amd64 arm64; do
  archive="dist/intar-image-cli_${VERSION}_linux_${arch}.tar.gz"
  extract_dir="${smoke_root}/${arch}"
  mkdir -p "${extract_dir}"

  while IFS= read -r entry; do
    entry="${entry#./}"
    case "${entry}" in
      ""|intar-image-cli|base-images.hcl|third-party/|third-party/libnbd/|third-party/libnbd/*) ;;
      *)
        echo "unexpected path in ${archive}: ${entry}" >&2
        exit 1
        ;;
    esac
  done < <(tar -tzf "${archive}")

  tar -xzf "${archive}" -C "${extract_dir}"
  test -x "${extract_dir}/intar-image-cli"
  cmp content/scenarios/base-images.hcl "${extract_dir}/base-images.hcl"
  test -f "${extract_dir}/third-party/libnbd/source/PROVENANCE"
  test -x "${extract_dir}/third-party/libnbd/source/build-libnbd-static.sh"
  test -f "${extract_dir}/third-party/libnbd/rust-bindings/PROVENANCE.md"
  test -f "${extract_dir}/third-party/libnbd/relink/libnbd.a"
  (
    cd "${extract_dir}/third-party/libnbd"
    sha256sum --check --strict SHA256SUMS
  )
  mapfile -t packaged_files < <(
    find "${extract_dir}" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' \
      | LC_ALL=C sort
  )
  expected_files=(base-images.hcl intar-image-cli)
  if [ "${packaged_files[*]}" != "${expected_files[*]}" ]; then
    echo "unexpected files in ${archive}: ${packaged_files[*]}" >&2
    exit 1
  fi
done

test "$("${smoke_root}/amd64/intar-image-cli" --version)" = \
  "intar-image-cli ${VERSION}"

fixture_root="${smoke_root}/fixture"
course_dir="${fixture_root}/courses/release-smoke"
theory_dir="${course_dir}/00-operating-model"
lecture_dir="${course_dir}/01-broken-nginx"
mkdir -p "${theory_dir}" "${lecture_dir}"
cp content/courses/linux-operations/course.md "${course_dir}/course.md"
cp content/courses/linux-operations/00-operating-model/lecture.md \
  "${theory_dir}/lecture.md"
cp content/courses/linux-operations/01-broken-nginx/lecture.md \
  "${lecture_dir}/lecture.md"
cp content/courses/linux-operations/01-broken-nginx/scenario.hcl \
  "${lecture_dir}/scenario.hcl"

"${smoke_root}/amd64/intar-image-cli" validate \
  --courses-root "${fixture_root}/courses" \
  --base-images "${smoke_root}/amd64/base-images.hcl"
"${smoke_root}/amd64/intar-image-cli" bundle broken-nginx \
  --courses-root "${fixture_root}/courses" \
  --base-images "${smoke_root}/amd64/base-images.hcl" \
  --rev release-smoke \
  --output "${fixture_root}/bundle.tar.gz" \
  --no-upload

# The frozen scenario-publish argv: intar.yaml mode, no flags.
printf 'version: 1\nscope: release-smoke\n' > "${fixture_root}/intar.yaml"
digest="$(cd "${fixture_root}" && "${smoke_root}/amd64/intar-image-cli" validate \
  | sed -n 's/^compile digest: //p')"
if ! [[ "${digest}" =~ ^p[0-9a-f]{8}$ ]]; then
  echo "validate printed no compile digest" >&2
  exit 1
fi
(
  cd "${fixture_root}"
  "${smoke_root}/amd64/intar-image-cli" bundle \
    --rev "git-1-0123456789abcdef0123456789abcdef01234567-${digest}" \
    --output "${fixture_root}/source-bundle.tar.gz" \
    --no-upload
)

expected_bundle_files=(
  base-images.hcl
  curriculum/catalog.json
  curriculum/release-smoke/00-operating-model/lecture.md
  curriculum/release-smoke/01-broken-nginx/lecture.md
  curriculum/release-smoke/course.md
  scenarios/broken-nginx/scenario.hcl
)
for bundle in bundle source-bundle; do
  bundle_listing="${fixture_root}/${bundle}-listing.txt"
  tar -tzf "${fixture_root}/${bundle}.tar.gz" | LC_ALL=C sort > "${bundle_listing}"
  mapfile -t bundled_files < "${bundle_listing}"
  if [ "${bundled_files[*]}" != "${expected_bundle_files[*]}" ]; then
    echo "unexpected nested-course ${bundle} paths: ${bundled_files[*]}" >&2
    exit 1
  fi
done
