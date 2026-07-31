# Facilitator notes — module 05

The last core module, and the one designed for 2026: debugging on a live system, with or without an AI agent — and treating every diagnosis as a hypothesis until the cluster confirms it.


---

The philosophy slide. Installing things teaches less per minute than debugging things — that's why fault injection is a core module, not a stretch.

The loop we're drilling:
1. Find the SYMPTOM first (get all, logs) before hunting causes.
2. Write down a one-sentence diagnosis — literally write it: "the pod can't X because Y". Unwritten diagnoses mutate to fit whatever you find next.
3. Before fixing anything, ask: if this sentence were true, what exactly would I observe on the live cluster? Design the observation that would falsify it.
4. Go observe. If reality disagrees, the diagnosis is dead — write a new one. This loop IS the module.

Four faults, escalating deviousness, each in its own faultlab-NN namespace so the real platform is never at risk: a deploy that never comes up, a database frozen mid-birth, everything-healthy-nothing-connects, and "works... sometimes."

Verify against the running system, never against text — that's design principle #6, and it applies equally to your own hunches and to anything an agent tells you.


---

The AI segment, meeting the moment head-on. Recommended flow for at least fault 4: run make-readonly-kubeconfig.sh to give an agent read-only eyes on the cluster (a 4-hour token), then point Claude Code / kubectl-ai / k8sgpt at the fault namespace.

The prompt pattern that works, from the lab README: "Investigate namespace faultlab-04 and give me (1) your root-cause hypothesis in one sentence, (2) the exact kubectl commands whose output would prove it, (3) your confidence." Then the HUMAN runs those commands against the real cluster and passes verdict.

Fault 4 is engineered so the obvious AI diagnosis is plausible AND wrong — don't reveal how. The deliverable is not the fix; it's the sentence "the agent claimed X; I checked Y; the claim was right/wrong because Z." Verification of agent output is the 2026 skill, and this is a rep of it.

No agent handy? Pair up: one person plays "confident AI" and states a diagnosis from the manifests alone; the other falsifies it against the cluster. Same muscle.

Spoiler hygiene: each fault dir has description.md — that IS the spoiler; don't open it until you've committed to a diagnosis in writing.


---

The task: at least faults 1 and 4 (all four if time allows). inject.sh N seeds the fault; restore.sh N applies the canonical fix if you give up gracefully; restore.sh clean removes all fault namespaces afterwards.

House rule to repeat once more: one-sentence written diagnosis BEFORE any fix, then verify it against the cluster, then fix however you like — live edit, kubectl apply, agent-generated patch, all fine. verify.sh confirms every injected fault is actually fixed.

For fault 4, strongly nudge the agent-assisted path (or the pair version). Budget guidance: ~8 minutes on fault 1, the rest on fault 4.

Wrap-up moment for the core arc, worth saying from the front: "In five modules you built a cloud — an OS layer, GitOps delivery, data services, a self-service API — and then you debugged it like an SRE. Everything after the break is a bonus tier. Nothing depends on it; all of it is worth it."

Then the second break.


---

Second break, after the core arc. Celebrate briefly before releasing the room: everyone with a green module-05 verify has built and debugged a complete platform today.

Logistics to announce before the break:
- After the break we switch to stretch mode: modules 06–09 are self-paced, with short framing + demos from the front. Nothing later depends on them; pick your own adventure, or keep polishing the core.
- The last 30 minutes of the slot stay protected for open tinkering and questions regardless.
- Anyone behind: catch-up.sh 5 (or any earlier module) during the break; helpers are around.

Presenter prep during this break: keep Backstage disabled. Module 08 uses bundled screenshots for the comparison because Backstage is not a declared Intar workspace application in this revision.
