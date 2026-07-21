Two deliberate constraints, and they're the whole safety story of the module.

Eyes: the k8s-agent's tool server is scoped read-only at the RBAC layer, not just prompted to behave — kagent-tools.rbac.readOnly: true swaps its ClusterRole to get/list/watch on pods, events, logs, deployments, and friends. Say plainly: the vendored Agent CR (rendered straight from the upstream k8s-agent chart, which exposes no toolNames/systemPrompt override) still lists the write verbs (apply/patch/delete/exec) and a "Modification Tools" prompt section — the agent can still ask. It just never gets a yes: --read-only at the tool server and the read-only ClusterRole both refuse the call at the API server. The write verbs aren't gone from the prompt; they're refused by the platform every time. Point at the values file — this is something attendees can read, not folklore about "well-behaved agents."

Hands: even with perfect read access, the optional agent never writes anything, anywhere — no auto-remediation exists in this module, full stop. Its hypothesis comes with an explicit kill-test, the learner verifies it against the live cluster (same discipline as module 05), and the fix is always a Git revert the learner runs. That's the GitOps write path from module 02, reused, never bypassed.

Worth an honest aside: the Kagent controller's API — REST and A2A — has no authentication in-cluster by default; it assumes a trusted network. V1 exposes neither that API nor Kagent's UI through Stargate. The declared Cloudbox Console is the only browser surface for an opted-in comparison. A real deployment needs an authenticated proxy the moment the API crosses a trust boundary.

Land the motto here, verbatim — it's the one line to leave hanging: the agent gets eyes; git keeps the hands.
