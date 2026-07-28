The AI segment, meeting the moment head-on. Recommended flow for at least fault 4: run make-readonly-kubeconfig.sh to give an agent read-only eyes on the cluster (a 4-hour token), then point Claude Code / kubectl-ai / k8sgpt at the fault namespace.

The prompt pattern that works, from the lab README: "Investigate namespace faultlab-04 and give me (1) your root-cause hypothesis in one sentence, (2) the exact kubectl commands whose output would prove it, (3) your confidence." Then the HUMAN runs those commands against the real cluster and passes verdict.

Fault 4 is engineered so the obvious AI diagnosis is plausible AND wrong — don't reveal how. The deliverable is not the fix; it's the sentence "the agent claimed X; I checked Y; the claim was right/wrong because Z." Verification of agent output is the 2026 skill, and this is a rep of it.

No agent handy? Pair up: one person plays "confident AI" and states a diagnosis from the manifests alone; the other falsifies it against the cluster. Same muscle.

Spoiler hygiene: each fault dir has description.md — that IS the spoiler; don't open it until you've committed to a diagnosis in writing.
