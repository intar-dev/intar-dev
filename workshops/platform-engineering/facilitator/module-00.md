# Facilitator notes — module 00

The lobby gate is part of the plan: each checked-in learner receives a dedicated Intar workspace. Use these 15 minutes to prove that checkpoint 00 finished and the pinned runtime is healthy before the core workshop starts.

While Intar provisions and checks the learner VMs, presenters watch the roster and help queue. A failed workspace is a provider or bootstrap problem: inspect its named probes, then restore checkpoint 00 or recreate it through Intar instead of repairing it manually.


---

The digest-pinned rule is the first platform-engineering lesson of the day: external dependencies must be explicit, immutable, and observable. Digest pins prevent tag drift; they do not pretend DNS, TLS, registries, or provider egress have disappeared.

Concretely: the Intar checkpoint bootstrap validates every pinned image against its external registry; the git server then lives in-cluster and Argo CD never points at GitHub. Uncached or restored generations still require working registry egress, and the browser session still requires Intar connectivity.

Capacity honesty: this revision pins one CPX42 per learner. Its 16 GiB RAM covers the roughly 7.5–8 GiB in-cluster workload plus Talos, Docker, and operating-system headroom. Intar blocks provisioning if the pinned type, price, quota, or required location is unavailable; never resize or substitute it silently.


---

Set the timer visibly. The task: check in, wait for the Intar workspace to become ready, open its terminal, and run the module verifier. Treat Docker, resource, registry, or agent failures as provisioning failures.

Already green when the lobby opens? Perfect — use the remaining preflight time to skim lab/01-cluster/README.md, or help a neighbor. Helping a neighbor is the fastest way to learn this material.

Triage guidance for presenters/helpers: use the facilitator roster, named probe state, and help queue. Registry, quota, location, guest-kernel, or bootstrap failures belong in the Intar recovery path; do not move learners to an untracked runtime.

Move on only when the facilitator preflight shows enough ready seats for the room. Keep late workspaces visible in the lobby and use checkpoint recovery for learners who join after the release.
