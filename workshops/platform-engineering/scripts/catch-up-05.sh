#!/usr/bin/env bash
# Trusted checkpoint reconstruction adapted from pinned module 05.
# Module 05 — "solution": inject every fault, then restore every fault.
# Used by CI to regression-test verify.sh (inject -> verify fails,
# restore -> verify passes). Humans should NOT run this — the module IS
# the diagnosing.
set -euo pipefail

DIR="/opt/platform-engineering-workshop/lab/05-debug-with-ai"

for n in 1 2 3 4; do
  "$DIR/inject.sh" "$n"
done

# Give the scenarios a moment to reach their broken steady-state.
sleep 30

"$DIR/restore.sh" all
