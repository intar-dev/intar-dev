# Facilitator notes — module 10

Everything up to now has been day 1: build it, ship it, watch it come up green. Day 2 is
where platforms earn their keep—something that worked breaks after an ordinary-looking
Git change. The verified module is fully offline and human-led: signal, evidence, Git
diff, forward revert, live verification.

Three realistic faults land as plausible commits against `demo-web`: a bad release, an
OOM-inducing "rightsizing" change, and an image reference outside the baked mirror. The
third failure is intentional and deterministic while offline; no successful Docker Hub
request is part of the lab.

---

Use the escalation ladder without making AI mandatory:

1. **Signal:** the Cloudbox Console application detail says why the resource is unhealthy.
2. **Hint:** the deterministic cause-to-action hint narrows the next observation.
3. **Optional agent:** only learners who independently have network access and a provider
   credential may compare a read-only model diagnosis. It is never part of timing,
   completion, or recovery.

Most incidents should die at step 1 or 2. That is the design working. The workshop's
layered hints, solution reveal, helper-consent flow, and canonical checkpoint are the
complete offline support path.

---

The Kagent architecture remains useful to teach without calling a model. An Agent is a
GitOps-delivered CRD reconciled into a Deployment. The tool server and ClusterRole both
enforce read-only access. The CR may still name write tools, but the platform refuses
them. No auto-remediation exists: the learner verifies a hypothesis and performs the Git
revert.

Kagent's in-cluster API has no authentication by default, so v1 exposes neither its API
nor its UI through Stargate. If a learner opts into the external comparison, the only
browser surface is the declared **Cloudbox Console** app. External credentials,
availability, connectivity, and cost are outside the workshop contract.

Land the motto: **the agent gets eyes; Git keeps the hands**.

---

For the hands-on, inject scenario 1 twice (first seed, then fault), inspect the signal in
Cloudbox and the evidence in the terminal, and demand a one-sentence falsifiable
diagnosis before any fix. Celebrate the moment Git history identifies the exact bad
change. A `kubectl edit` may look green briefly, but Argo CD will restore the broken Git
state; only the forward revert is durable.

The verifier checks repository state separately from rollout health. Do not mark the
module verified for an agent transcript, a live-only edit, or a plausible explanation.
