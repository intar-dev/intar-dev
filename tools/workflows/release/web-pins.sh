#!/usr/bin/env bash
# release.yml, job web-pins, step "Open the website pin pull request".
# Points the website at the published releases that main's manifests name:
# the scenario compiler at intar-image-cli (its version and the published
# archive digests), and tools/deploy/kino-pin.json at the Kino artifact of the
# kino release (the digest image-ops kino-promote pushes it under).
set -euo pipefail
# A re-run keeps its run's commit. Only the run for main's tip may rewrite the
# pull request; a push that moved main has a run of its own that follows.
main="$(gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha)"
if [ "${main}" != "${GITHUB_SHA}" ]; then
  echo "main moved on to ${main}; its run pins the website."
  exit 0
fi
manifest_version() {
  sed -n 's/^version = "\([^"]*\)".*/\1/p' "$1" | head -n 1
}
published() {
  local draft
  draft="$(gh release view "$1" --json isDraft --jq .isDraft)" || exit 1
  [ "${draft}" = false ] || {
    echo "$1 is not published yet; a later run pins the website once it is."
    return 1
  }
}
# A tag is pinned only when its source speaks the contract HEAD's does: a
# release from before a contract change stays unpinned until its successor is
# published. Reads one constant from <rev>:<path>; empty when either is absent.
contract_const() {
  git show "$1:$2" 2>/dev/null | sed -n "$3" || true
}
compiler_sed='s/^pub const SOURCE_COMPILER_VERSION_V2: &str = "\([^"]*\)";$/\1/p'
guest_sed='s/^pub const GUEST_CONTRACT: u32 = \([1-9][0-9]*\);$/\1/p'
changes=()

version="$(manifest_version crates/intar-image-cli/Cargo.toml)"
tag="image-cli/v${version}"
compiler="$(contract_const HEAD crates/intar-contracts/src/source.rs "${compiler_sed}")"
if [ -z "${compiler}" ] || [ "$(contract_const "${tag}" crates/intar-contracts/src/source.rs "${compiler_sed}")" != "${compiler}" ]; then
  echo "${tag} does not compile ${compiler:-the current source format}; the website keeps its compiler pin."
elif published "${tag}"; then
  sums="$(mktemp -d)/checksums.txt"
  gh release download "${tag}" --pattern "intar-image-cli_${version}_checksums.txt" --output "${sums}"
  VERSION="${version}" SUMS="${sums}" python3 - <<'PY'
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
else
  # `wrangler types` types each var as its literal value and hashes the
  # config into the header, so the worker types follow the pins; CI's
  # types:cf:check fails otherwise.
  bun install --frozen-lockfile
  bun run --cwd apps/web types:cf
  changes+=("the scenario compiler to intar-image-cli ${version}")
fi
fi

# Guest VMs are x86_64, so the pin is the amd64 build. The guest contract is
# the one the tag's source was built for.
kino_version="$(manifest_version crates/kino/Cargo.toml)"
kino_tag="kino/v${kino_version}"
contract="$(contract_const HEAD crates/intar-contracts/src/guest.rs "${guest_sed}")"
if [ -z "${contract}" ] || [ "$(contract_const "${kino_tag}" crates/intar-contracts/src/guest.rs "${guest_sed}")" != "${contract}" ]; then
  echo "${kino_tag} is not built for guest contract ${contract:-of HEAD}; the website keeps its Kino pin."
elif published "${kino_tag}"; then
  kino_dir="$(mktemp -d)"
  gh release download "${kino_tag}" --dir "${kino_dir}" \
    --pattern "kino_${kino_version}_linux_amd64.tar.gz" \
    --pattern "kino_${kino_version}_checksums.txt"
  (cd "${kino_dir}" && sha256sum --check --strict --ignore-missing "kino_${kino_version}_checksums.txt")
  tar -xzf "${kino_dir}/kino_${kino_version}_linux_amd64.tar.gz" -C "${kino_dir}" ./kino
  digest="$(bun tools/deploy/kino-artifact.ts build --binary "${kino_dir}/kino" \
    --version "${kino_version}" --guest-contract "${contract}" --out "${kino_dir}/artifact" | jq -er .digest)"
  bun tools/deploy/kino-artifact.ts pin --file tools/deploy/kino-pin.json \
    --guest-contract "${contract}" --digest "${digest}"
  if git diff --quiet -- tools/deploy/kino-pin.json && git ls-files --error-unmatch tools/deploy/kino-pin.json >/dev/null 2>&1; then
    echo "The website already pins kino ${kino_version}."
  else
    changes+=("kino ${kino_version} (${digest}) for guest contract ${contract}")
  fi
fi

if [ "${#changes[@]}" -eq 0 ]; then
  exit 0
fi
summary="${changes[0]}"
if [ "${#changes[@]}" -eq 2 ]; then
  summary="${changes[0]} and ${changes[1]%% (*}"
fi

branch="release/web-pins"
title="chore(web): pin ${summary%% (*}"
bot="${APP_SLUG}[bot]"
bot_id="$(gh api "users/${bot}" --jq .id)"
git config user.name "${bot}"
git config user.email "${bot_id}+${bot}@users.noreply.github.com"
gh auth setup-git --hostname github.com
git checkout -B "${branch}"
git add -- apps/web/wrangler.jsonc apps/web/worker-configuration.d.ts
if [ -e tools/deploy/kino-pin.json ]; then
  git add -- tools/deploy/kino-pin.json
fi
git commit --quiet -m "${title}"
tools/workflows/release/push-bot-branch.sh "${branch}"
body="The website deploy picks up $(printf '%s; ' "${changes[@]}")a Kino pin counts only once image-ops kino-promote stored that artifact."
pr="$(gh pr list --head "${branch}" --base main --state open --json number --jq '.[0].number // empty')"
if [ -n "${pr}" ]; then
  gh pr edit "${pr}" --title "${title}" --body "${body}"
else
  gh pr create --base main --head "${branch}" --title "${title}" --body "${body}"
fi
