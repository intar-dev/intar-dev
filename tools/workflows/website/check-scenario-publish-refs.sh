#!/usr/bin/env bash
# Called by pin-production-config.sh with the built Worker configuration.
#
# The scenario source card shows a repository which ref of the reusable
# scenario-publish workflow to call. The Worker accepts a publish only from a
# workflow commit on SCENARIO_PUBLISH_WORKFLOW_SHAS, so each ref the card
# shows must resolve to a commit on that list: a tag by what it peels to on
# the remote, a commit by itself. A release that shows a ref the Worker would
# refuse is not deployed.
set -euo pipefail
config="$1"
remote="${SCENARIO_PUBLISH_REMOTE:-origin}"
shas=" $(jq -r '.vars.SCENARIO_PUBLISH_WORKFLOW_SHAS // ""' "${config}" | tr ',\n\t' '   ') "
# The first ref is shown to every source the builder builds for, so it must
# be there; the second is empty until the workflow's second version is out.
if ! jq -e '(.vars.SCENARIO_PUBLISH_WORKFLOW_REF // "") != ""' "${config}" >/dev/null; then
  echo "the artifact names no scenario-publish workflow ref for the source card" >&2
  exit 1
fi
refs="$(jq -r '
  [.vars.SCENARIO_PUBLISH_WORKFLOW_REF, .vars.SCENARIO_PUBLISH_PIPELINE_WORKFLOW_REF]
  | map(select(. != null and . != "")) | unique | .[]
' "${config}")"
while IFS= read -r ref; do
  if [[ "${ref}" =~ ^[0-9a-f]{40}$ ]]; then
    commit="${ref}"
  elif [[ "${ref}" =~ ^scenario-publish-v[0-9]+$ ]]; then
    # An annotated tag lists its commit on the `^{}` line; a lightweight one
    # has only its own. A pattern matches by the end of a ref's path, so the
    # names are compared whole.
    commit="$(git ls-remote "${remote}" "refs/tags/${ref}" "refs/tags/${ref}^{}" |
      awk -v tag="refs/tags/${ref}" '
        $2 == tag "^{}" { peeled = $1 } $2 == tag { plain = $1 } END { print (peeled ? peeled : plain) }')"
    if [[ -z "${commit}" ]]; then
      echo "the scenario-publish ref ${ref} is not a tag on ${remote}" >&2
      exit 1
    fi
  else
    echo "the scenario-publish ref ${ref} is neither a scenario-publish-vN tag nor a commit" >&2
    exit 1
  fi
  if [[ "${shas}" != *" ${commit} "* ]]; then
    echo "the scenario-publish ref ${ref} resolves to ${commit}, which SCENARIO_PUBLISH_WORKFLOW_SHAS does not list" >&2
    exit 1
  fi
done <<< "${refs}"
