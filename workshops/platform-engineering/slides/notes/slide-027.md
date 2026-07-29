The digest-pinned rule isn't just conference pragmatism — it's the first platform-engineering lesson of the day. If your platform can't stand up without reaching the internet, it isn't your platform; it's a client of someone else's.

Concretely: the Intar checkpoint bootstrap validates every pinned image against its external registry; the git server will live in-cluster; ArgoCD never points at GitHub. Once images are pulled, the whole workshop works in airplane mode.

Hardware honesty, one more time: 16 GB RAM minimum with at least 10 GB allocatable to Docker; 32 GB is comfortable. The full platform idles around 8 GB inside the cluster. On 16 GB machines: close the Electron zoo. macOS: OrbStack or Docker Desktop with a raised memory limit. WSL2: raise it in .wslconfig — and WSL2 is our least-tested platform, so lifeboats apply.
