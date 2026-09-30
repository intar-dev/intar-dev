#!/usr/bin/env bash
# Picks the CI lanes a change needs. Each argument is one lane: its name, then
# its path globs, separated by spaces (see ci/workflows/lanes.cue). A lane runs
# when a changed file matches one of its globs as a git :(glob) pathspec.
#
#   pull_request  The checkout is GitHub's merge commit, whose first parent is
#                 the base branch it merged into, so HEAD^1..HEAD is exactly
#                 the pull request. Should HEAD not be a merge commit, the base
#                 falls back to the event's base sha: that diff also holds the
#                 base branch's newer changes, which can add lanes, never drop
#                 one.
#   push, dispatch  Every lane.
#   local         The merge base with origin/main against the working tree.
#
# Writes name=true|false per lane, and base=<sha> for a pull request, to
# $GITHUB_OUTPUT, or to stdout outside GitHub Actions.
set -euo pipefail
out="${GITHUB_OUTPUT:-/dev/stdout}"
all=false
target=(HEAD)
case "${GITHUB_EVENT_NAME:-}" in
  pull_request)
    if git rev-parse --quiet --verify 'HEAD^2' >/dev/null; then
      base="$(git rev-parse 'HEAD^1')"
    else
      base="$(jq -er .pull_request.base.sha "${GITHUB_EVENT_PATH}")"
      if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
        git fetch --quiet --no-tags --depth=1 origin "${base}"
      fi
    fi
    echo "base=${base}" >>"${out}"
    ;;
  "")
    base="$(git merge-base origin/main HEAD)"
    target=()
    ;;
  *) all=true ;;
esac
for lane in "$@"; do
  read -r name rest <<<"${lane}"
  read -r -a globs <<<"${rest}"
  changed=true
  if [[ "${all}" == false ]] &&
    git diff --quiet "${base}" "${target[@]}" -- "${globs[@]/#/:(glob)}"; then
    changed=false
  fi
  echo "${name}=${changed}" >>"${out}"
done
