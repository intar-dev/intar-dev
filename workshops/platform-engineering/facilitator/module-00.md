# Facilitator notes — module 00

This is the safety net, not the plan — the prework email asked everyone to do this at home. The next 15 minutes exist for those who didn't, and for machines that changed since.

While the room runs checks, the presenters circulate. Anyone whose laptop fundamentally can't run it goes straight to a lifeboat (pair up, or devcontainer/Codespaces) — do NOT let anyone burn 45 minutes fighting their Docker install.


---

The digest-pinned rule isn't just conference pragmatism — it's the first platform-engineering lesson of the day. If your platform can't stand up without reaching the internet, it isn't your platform; it's a client of someone else's.

Concretely: the Intar checkpoint bootstrap validates every pinned image against its external registry; the git server will live in-cluster; ArgoCD never points at GitHub. Once images are pulled, the whole workshop works in airplane mode.

Hardware honesty, one more time: 16 GB RAM minimum with at least 10 GB allocatable to Docker; 32 GB is comfortable. The full platform idles around 8 GB inside the cluster. On 16 GB machines: close the Electron zoo. macOS: OrbStack or Docker Desktop with a raised memory limit. WSL2: raise it in .wslconfig — and WSL2 is our least-tested platform, so lifeboats apply.


---

Set the timer visibly. The task: run the pre-flight, fix what it flags (most common: Docker not running, or Docker memory limit below 10 GB), and run the module's verify.sh.

Already green because you did the prework? Perfect — you have 15 minutes of head start: skim lab/01-cluster/README.md, or help a neighbor. Helping a neighbor is the fastest way to learn this material.

Triage guidance for presenters/helpers: image pulls not done is the only unfixable-in-room problem (bandwidth) — those people pair up or go to Codespaces immediately. Everything else (memory limits, missing tools) is a 2-minute fix.

When ~90% of the room is green, move on — stragglers keep pulling in the background and module 01 doesn't need the images immediately.
