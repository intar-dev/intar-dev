The task: enable kagent.yaml from the catalog (same push-to-Gitea dance as every capability today), pick one of three scenarios and inject it (inject.sh 1|2|3 — a bad rollback, an OOMKilling "rightsizing" commit, or a Docker Hub image reference that ImagePullBackOffs at the rate-limited venue), then open the affected Application's detail page in the Console and click "Open investigation."

Beat 1 runs entirely digest-pinned against qwen3:4b on host-side Ollama (never in-cluster, so it doesn't compete with the cluster's memory) — the point isn't to get a right answer, it's to watch the previous slide's table happen live: a plausible first tool call, then a loop, a dropped thread, or a malformed follow-up. Write down how it fails — that's the deliverable, same spirit as module 05's "agent claimed X" exercise.

Beat 2 is one git push: switch the same ModelConfig to the free OpenCode Zen key from the module 00 prep (or a personal Claude/OpenAI key as the documented fallback), and re-run the investigation — same fault, same Case file, now a real hypothesis with a kill-test. Verify it against the cluster, then fix it with the git revert the Case file hands you.

16 GB learner VM callout, say it out loud: the local model doesn't fit alongside the running cluster on the minimum spec — go straight to beat 2, the README says so plainly, no twenty minutes lost discovering it. And the standing fallback if Kagent itself misbehaves on the day: module 05's bring-your-own-agent flow works identically, no platform dependency.

Screenshot note for whoever refreshes this deck: swap in a real Case file capture from the Console once the module-10 Console slice lands — the interactive prototype is the placeholder reference for now.
