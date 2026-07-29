# Canonical solution for module 05

This is adapted from the pinned upstream `solve.sh` for Intar's digest-pinned external runtime. Reveal it only after the learner has chosen to see the solution.

```bash
#!/usr/bin/env bash
# Module 05 — "solution": inject every fault, then restore every fault.
# Used by CI to regression-test verify.sh (inject -> verify fails,
# restore -> verify passes). Humans should NOT run this — the module IS
# the diagnosing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for n in 1 2 3 4; do
  "$DIR/inject.sh" "$n"
done

# Give the scenarios a moment to reach their broken steady-state.
sleep 30

"$DIR/restore.sh" all
```
