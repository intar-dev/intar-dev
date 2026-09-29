#!/usr/bin/env bash
# image-ops workflow, cleanup job, "Run the delete campaign" step.
set -euo pipefail
evidence_dir="${RUNNER_TEMP}/intar-image-registry-cleanup"
# A run needs an idle collector and no unresolved sweep: no running GC
# row, no open upload session, and no unresolved writer. That is the
# same state the collector's own assertion reads before it deletes.
jq -e '.idle == true and .counts.running_gc_runs == 0 and .counts.open_sessions == 0 and .counts.pending_writers == 0' \
  "${evidence_dir}/state.json" >/dev/null
tools/deploy/registry-cleanup-gate.sh run delete \
  "${evidence_dir}/registry-cleanup-run.json"
