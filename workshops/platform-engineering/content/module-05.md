# Module 05 — Break it, diagnose it, verify the diagnosis

## The goal

At the end of this module you have taken at least two injected faults from *symptom* to
*verified root cause* to *fix* — and for at least one of them you have written down a
diagnosis (yours or an AI agent's), then **proved or falsified it against the live
cluster before acting**. `./verify.sh` confirms every injected fault is actually fixed.

## Why this matters

Installing things teaches less per minute than debugging things — and in 2026, "debugging"
usually starts with asking an assistant. Assistants are excellent at Kubernetes triage and
*confidently wrong* just often enough to hurt. The skill of the decade is not prompting;
it is **verification**: treating every diagnosis — human or machine — as a hypothesis and
designing the one observation that would kill it. Fair warning: one fault below was
designed so that the obvious AI answer is plausible and wrong.

## The setup

Four faults, in increasing order of deviousness. Each gets its own namespace
(`faultlab-NN`), so your real platform is never touched.

| # | Scenario | Needs | Flavor |
|---|----------|-------|--------|
| 1 | `01-web-down` | module 01 | a deploy that never comes up |
| 2 | `02-db-stuck` | module 03 (CNPG) | a database frozen mid-birth |
| 3 | `03-db-unreachable` | module 01 | everything healthy, nothing connects |
| 4 | `04-db-flaky` | module 01 | works… sometimes. **The trap.** |

```bash
./inject.sh 1        # start here
./restore.sh 1       # apply the canonical fix / give up gracefully
./restore.sh clean   # delete all fault namespaces when done
```

Each fault dir has `description.md` — **that's the spoiler**, don't open it until you've
committed to a diagnosis. `fix.yaml`/`fix.sh` is the canonical repair.

## The task

For each fault you take on (do at least 1 and 4; all four if time allows):

1. `./inject.sh `, then look at the namespace. Find the *symptom* first
   (`get all`, logs) before hunting causes.
2. **Write down a one-sentence diagnosis** before fixing anything. Literally write it —
   sticky note, scratch file, whatever. "The pod can't X because Y."
3. **Verify it**: what would you observe on the live cluster if your sentence were true?
   Go observe exactly that. If the observation disagrees, your diagnosis is dead —
   write a new one. (This loop is the module.)
4. Fix it — live edit, `kubectl apply`, whatever you like. Re-check the symptom.
5. `./verify.sh` when you're done with all your faults.

### Optional external AI comparison

The two-fault path above is complete offline and requires no model, account, key, or
network. If you independently have an agent available, you may give it read-only eyes on
your cluster and make it do step 1–2 for you — then *you* do step 3 on its answer:

```bash
./make-readonly-kubeconfig.sh          # writes ./ai-readonly.kubeconfig (4h token)
# Supply that kubeconfig only to an assistant you already trust and operate.
```

A prompt that works well: *"Something is wrong in namespace faultlab-04. Investigate and
give me: (1) your root-cause hypothesis in one sentence, (2) the exact kubectl commands
whose output would prove it, (3) your confidence."* Then run those commands yourself,
against the real cluster, and pass verdict. The deliverable is not the fix — it's the
sentence **"the agent claimed X; I checked Y; the claim was right/wrong because Z."**

No agent handy is the expected offline case. Pair up: one of you plays "confident AI",
states a diagnosis from the manifests alone; the other falsifies it against the cluster.

## Hints

## Check your work

```bash
./verify.sh
```

For every fault namespace that exists it checks the *outcome* (the workload actually
works — availability, DB readiness, and for fault 4: repeated connection attempts, so a
half-fixed trap still fails), and that your platform (demo apps, ArgoCD health) survived
the session.

## Explain-back

Tell your neighbor about fault 4 (or your favorite): what was the *first* diagnosis on
the table, which single command killed or confirmed it, and what would have happened if
you'd applied the fix for the wrong diagnosis?

## Going deeper

- Optionally re-run fault 4 pointing your own agent at the cluster *with* read access —
  does live access change its answer versus manifest-only reasoning? (This is the whole
  argument for agentic tooling with real cluster eyes, and for keeping it read-only.)
- Design your own fault for your neighbor: same contract (`issue.yaml`, `fix.yaml`,
  `description.md`), must survive their agent's first guess. Hardest part: making it
  *fair*.
- If you already have `k8sgpt`, try `k8sgpt analyze --explain` across a fault namespace
  and grade its output. Do not install it or fetch a model for this workshop.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/05-debug-with-ai/verify.sh`. Layered hints and the solution are released separately by Intar.
