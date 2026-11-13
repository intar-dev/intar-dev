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
  listing="$(tar -tzf "${archive}" | sed 's|^\./||' | grep -v '^$')"
  if [ "${listing}" != "intar-image-cli" ]; then
    echo "unexpected paths in ${archive}: ${listing}" >&2
    exit 1
  fi
  tar -xzf "${archive}" -C "${extract_dir}"
  test -x "${extract_dir}/intar-image-cli"
done

cli="${smoke_root}/amd64/intar-image-cli"
test "$("${cli}" --version)" = "intar-image-cli ${VERSION}"

# The frozen scenario-publish argv: `validate` and `bundle` from the root.
repo="${smoke_root}/repo"
bash tools/image-build/stage-example.sh "${repo}"
cd "${repo}"
digest="$("${cli}" validate | sed -n 's/^compile digest: //p')"
if ! [[ "${digest}" =~ ^p[0-9a-f]{8}$ ]]; then
  echo "validate printed no compile digest" >&2
  exit 1
fi
"${cli}" fmt --check
"${cli}" spec broken-nginx --verify >/dev/null
"${cli}" bundle \
  --rev "git-1-0123456789abcdef0123456789abcdef01234567-${digest}" \
  --output "${smoke_root}/source-bundle.json.gz" \
  --no-upload

gzip -dc "${smoke_root}/source-bundle.json.gz" | jq -e '
  .compiler == "intar-source-compiler-v2"
  and ([.scenarios[].slug] == ["broken-nginx"])
  and ([.course_catalog.courses[].lectures[] | select(.scenario_id != null) | .scenario_id] == ["broken-nginx"])
' >/dev/null
