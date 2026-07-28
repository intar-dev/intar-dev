# Layer 2 — how everything ships

RoleWe runRejectedThe tradeoff

Git server**gitea** **Gitea 1.26.1**external GitHubOne more pod, but the write-path is digest-pinned and *yours*
GitOps engine**argocd** **Argo CD v3.4.5**Flux · manual kubectlDrift detection + self-heal; app-of-apps is one-cluster, not fleet

- **Gitea in the cluster**, not GitHub: attendees can't push to our GitHub, and ~50 clusters polling anonymously through one venue NAT hit GitHub's per-IP limits. Single-pod SQLite, push-to-create, seeded by a Job. ArgoCD points *only* here — the whole loop is edit → push → converge, and it uses only declared external registries.
- **ArgoCD app-of-apps + sync waves** over Flux (more controllers, less legible to teach) or raw `kubectl` (no reconciliation). Plain `install.yaml` with server-side apply beats Helm for teaching. The most-missed step: restore the `Application` health check in `argocd-cm`, or the waves don't gate.
