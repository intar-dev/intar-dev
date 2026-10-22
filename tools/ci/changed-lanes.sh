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
#                 one. The release pull request (release/next, its head
#                 committed by the release app), rebuilt after every merge,
#                 runs no lane: the merge queue checks it in full.
#   merge_group   A lane the queue's commit changed against the event's base
#                 sha, the commit the group merges onto, but only when main
#                 also changed it after the pull request's merge base with
#                 main. The pull request's own run, which ci-ok required to
#                 pass before it queued, checked the lane against a main at
#                 least that new, so the lane's inputs are the same unless main
#                 changed them since. Every lane the group changed when the
#                 pull request's head is unavailable, does not merge into the
#                 group's exact tree, or comes from the release app.
#                 <lane>_touched says whether the group changed the lane.
#   schedule      No lane: ci.yml picks the daily run's lanes itself.
#   dispatch      Every lane.
#   local         The merge base with origin/main against the working tree.
#
# Writes name=true|false per lane, and base=<sha> for a pull request or a
# merge group, to $GITHUB_OUTPUT, or to stdout outside GitHub Actions.
set -euo pipefail
# Not >>/dev/stdout: on Linux that reopens fd 1, which fails for a socket.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  exec >>"${GITHUB_OUTPUT}"
fi
# The release app commits release/next. A commit that only claims to be its
# makes the merge queue check more, never less.
from_release_app() {
  [[ "$(git log -1 --format=%ae "$1" 2>/dev/null)" == *"+intar-release[bot]@users.noreply.github.com" ]]
}
all=false
none=false
target=(HEAD)
tested=""
queued=false
case "${GITHUB_EVENT_NAME:-}" in
  pull_request)
    if git rev-parse --quiet --verify 'HEAD^2' >/dev/null; then
      base="$(git rev-parse 'HEAD^1')"
      if [[ "${GITHUB_HEAD_REF:-}" == release/next ]] && from_release_app 'HEAD^2'; then
        none=true
      fi
    else
      base="$(jq -er .pull_request.base.sha "${GITHUB_EVENT_PATH}")"
      if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
        git fetch --quiet --no-tags --depth=1 origin "${base}"
      fi
    fi
    echo "base=${base}"
    ;;
  merge_group)
    base="$(jq -er .merge_group.base_sha "${GITHUB_EVENT_PATH}")"
    if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
      git fetch --quiet --no-tags --depth=1 origin "${base}"
    fi
    echo "base=${base}"
    queued=true
    # The pull request's number from GitHub's queue branch, and its head from
    # the public repository; a push to the pull request leaves the queue.
    number="$(jq -r '.merge_group.head_ref // ""' "${GITHUB_EVENT_PATH}" |
      sed -n 's|^refs/heads/gh-readonly-queue/[^/]*/pr-\([0-9][0-9]*\)-[0-9a-f]*$|\1|p')"
    if [[ -n "${number}" ]] &&
      git fetch --quiet --no-tags --filter=blob:none origin "+refs/pull/${number}/head:refs/intar/queued" 2>/dev/null; then
      tested="$(git merge-base refs/intar/queued "${base}" 2>/dev/null || true)"
      # That head is what the queue merged only when merging it again gives
      # the group's tree.
      if [[ -z "${tested}" ]] || from_release_app refs/intar/queued ||
        [[ "$(git merge-tree --write-tree --merge-base "${tested}" "${base}" refs/intar/queued 2>/dev/null | head -n 1)" != "$(git rev-parse 'HEAD^{tree}')" ]]; then
        tested=""
      fi
    fi
    ;;
  schedule) none=true ;;
  "")
    base="$(git merge-base origin/main HEAD)"
    target=()
    ;;
  *) all=true ;;
esac
for lane in "$@"; do
  read -r name rest <<<"${lane}"
  read -r -a globs <<<"${rest}"
  pathspecs=("${globs[@]/#/:(glob)}")
  changed=true
  if [[ "${none}" == true ]] || { [[ "${all}" == false ]] &&
    git diff --quiet "${base}" "${target[@]}" -- "${pathspecs[@]}"; }; then
    changed=false
  fi
  if [[ "${queued}" == true ]]; then
    echo "${name}_touched=${changed}"
    # Any commit on main since, even one a later commit reverted: the pull
    # request's run may have seen it.
    if [[ -n "${tested}" && -z "$(git log -1 --format=%H "${tested}..${base}" -- "${pathspecs[@]}")" ]]; then
      changed=false
    fi
  fi
  echo "${name}=${changed}"
done
