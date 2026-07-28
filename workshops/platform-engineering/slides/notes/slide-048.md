The task: at least faults 1 and 4 (all four if time allows). inject.sh N seeds the fault; restore.sh N applies the canonical fix if you give up gracefully; restore.sh clean removes all fault namespaces afterwards.

House rule to repeat once more: one-sentence written diagnosis BEFORE any fix, then verify it against the cluster, then fix however you like — live edit, kubectl apply, agent-generated patch, all fine. verify.sh confirms every injected fault is actually fixed.

For fault 4, strongly nudge the agent-assisted path (or the pair version). Budget guidance: ~8 minutes on fault 1, the rest on fault 4.

Wrap-up moment for the core arc, worth saying from the front: "In five modules you built a cloud — an OS layer, GitOps delivery, data services, a self-service API — and then you debugged it like an SRE. Everything after the break is a bonus tier. Nothing depends on it; all of it is worth it."

Then the second break.
