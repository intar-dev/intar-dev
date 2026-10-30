#!/bin/sh
# Dispatches a GitHub workflow on main, waits for that exact run to succeed,
# and prints its run id. The swamp rollout workflows call it from the
# repository root: sh tools/swamp/dispatch-workflow.sh <file> [-f key=value]...
set -eu
workflow="$1"
shift
out=$(gh workflow run "${workflow}" --repo intar-dev/intar-dev --ref main "$@" 2>&1) || {
  printf '%s\n' "${out}" >&2
  exit 1
}
url=$(printf '%s\n' "${out}" | grep -Eo 'https://github.com/[^ ]+/actions/runs/[0-9]+' | tail -n 1)
if [ -z "${url}" ]; then
  printf 'gh printed no run URL:\n%s\n' "${out}" >&2
  exit 1
fi
id="${url##*/}"
gh run watch "${id}" --repo intar-dev/intar-dev --exit-status --interval 10 >&2
printf '%s' "${id}"
