#!/usr/bin/env bash
# The identity of each lane's inputs: a SHA-256 over the mode, blob id, and
# path of every tracked file its globs match, so two commits whose inputs are
# identical name the same build. Each argument is one lane, as for
# changed-lanes.sh: its name, then its path globs, separated by spaces.
#
# Writes name=<hash> per lane to $GITHUB_OUTPUT, or to stdout outside GitHub
# Actions.
set -euo pipefail
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  exec >>"${GITHUB_OUTPUT}"
fi
for lane in "$@"; do
  read -r name rest <<<"${lane}"
  read -r -a globs <<<"${rest}"
  hash="$(git ls-files --stage -- "${globs[@]/#/:(glob)}" | sha256sum | cut -d' ' -f1)"
  echo "${name}=${hash}"
done
