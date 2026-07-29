This is how every single module works, so learn it once:

1. Each lab README says "make your cluster reach state X" and roughly where to look. It deliberately does NOT hand you 12 commands to paste — pasting teaches nothing.
2. Hints escalate from a guiding question to the exact command, in collapsed blocks. Open as many as you need; nobody is counting and there's no penalty. The last hint is always the full solution — using it is fine, understanding it is required.
3. verify.sh is the finish line: it runs many small checks against your RUNNING cluster (never against your files), prints a green check per pass and an actionable FAIL per miss, exits 0 when the outcome is true.
4. catch-up.sh N force-pushes the canonical end-state for module N to your in-cluster Gitea and lets ArgoCD converge — scripted state, not hope. Broke something interesting? That's fine, catch-up exists precisely so you can experiment fearlessly.

Also mention explain-backs: at each module boundary, two minutes, tell your neighbor WHY it works. A fix you can't explain isn't done yet.
