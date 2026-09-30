#!/usr/bin/env bash
# release.yml, job web-pins, step "Open the website pin pull request".
# Points the website's scenario compiler at the published intar-image-cli
# release that main's manifest names: its version, the published archive
# digests, and the digest of the base-images.hcl it ships.
set -euo pipefail
version="$(sed -n 's/^version = "\([^"]*\)".*/\1/p' crates/intar-image-cli/Cargo.toml | head -n 1)"
tag="image-cli/v${version}"
draft="$(gh release view "${tag}" --json isDraft --jq .isDraft)"
if [ "${draft}" != false ]; then
  echo "${tag} is not published yet; a later run pins the website once it is."
  exit 0
fi
sums="$(mktemp -d)/checksums.txt"
gh release download "${tag}" --pattern "intar-image-cli_${version}_checksums.txt" --output "${sums}"
base_images_sha256="$(git show "${tag}^{commit}:content/scenarios/base-images.hcl" | sha256sum | cut -d ' ' -f 1)"
VERSION="${version}" SUMS="${sums}" BASE_IMAGES_SHA256="${base_images_sha256}" python3 - <<'PY'
import json
import os
import pathlib
import re

version = os.environ["VERSION"]
digests = {}
for line in pathlib.Path(os.environ["SUMS"]).read_text().splitlines():
    digest, name = line.split("  ", 1)
    match = re.fullmatch(rf"intar-image-cli_{re.escape(version)}_(linux_amd64|linux_arm64)\.tar\.gz", name)
    if match and re.fullmatch(r"[0-9a-f]{64}", digest):
        digests[match[1]] = digest
if sorted(digests) != ["linux_amd64", "linux_arm64"]:
    raise SystemExit(f"published checksums lack an archive digest: {digests}")
pins = {
    "PLATFORM_BASE_IMAGES_SHA256": os.environ["BASE_IMAGES_SHA256"],
    "SCENARIO_COMPILER_CLI_VERSION": version,
    "SCENARIO_COMPILER_CLI_SHA256": json.dumps(digests, separators=(",", ":"), sort_keys=True),
}
path = pathlib.Path("apps/web/wrangler.jsonc")
text = path.read_text()
for key, value in pins.items():
    text, count = re.subn(
        rf'^(\s*"{key}": )"(?:[^"\\]|\\.)*"(,?)$',
        lambda m: m[1] + json.dumps(value) + m[2],
        text,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise SystemExit(f"{path} must set {key} on exactly one line, found {count}")
path.write_text(text)
PY
if git diff --quiet -- apps/web/wrangler.jsonc; then
  echo "The website already pins intar-image-cli ${version}."
  exit 0
fi

branch="release/web-pins"
title="chore(web): pin the scenario compiler to intar-image-cli ${version}"
bot="${APP_SLUG}[bot]"
bot_id="$(gh api "users/${bot}" --jq .id)"
git config user.name "${bot}"
git config user.email "${bot_id}+${bot}@users.noreply.github.com"
gh auth setup-git --hostname github.com
git checkout -B "${branch}"
git commit --quiet -m "${title}" -- apps/web/wrangler.jsonc
tools/workflows/release/push-bot-branch.sh "${branch}"
body="The website deploy picks up the ${tag} release: its version, the published archive digests, and the digest of its base-images.hcl."
pr="$(gh pr list --head "${branch}" --base main --state open --json number --jq '.[0].number // empty')"
if [ -n "${pr}" ]; then
  gh pr edit "${pr}" --title "${title}" --body "${body}"
else
  gh pr create --base main --head "${branch}" --title "${title}" --body "${body}"
fi
