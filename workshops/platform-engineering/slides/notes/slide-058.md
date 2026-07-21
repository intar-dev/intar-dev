The write-model slide (DR-0004), and the answer to the governance question the previous slide planted. A platform has two write paths, and the skill is knowing which is which — split by AUDIENCE, not mixed per action.

Platform plane — GitOps: installing a capability, editing the catalog, granting the portal an RBAC scope. Low-frequency, high-blast-radius changes that genuinely want a git history and a one-command rollback. This is where GitOps earns its cost. You do it with git on the CLI, and the console just reflects the result (the Components and Access pages light up) — you never bounce into Gitea's web UI.

Tenant plane — Console-direct: create a database, deploy a function, spin up a project. High-frequency, low-blast-radius self-service that wants instant feedback. It goes straight to the Kubernetes API — exactly what the New Database form did a minute ago, and it's absent from Gitea on purpose. That's not a bug; it's the right plane for the job.

kubectl is the third, orthogonal thing: it inspects (and rescues) either plane — the muscle from modules 01-05.

The one deliberately clever move we did NOT make: having the console write to Gitea behind your back (console → commit → ArgoCD → cluster). It sounds elegant — audit trail for everything — but it pays git's latency and moving parts on the one thing a console is uniquely good at, immediate self-service, to buy an audit trail a single-user lab doesn't need. Right pattern, wrong context. When you build projects later, "New project" is console-direct too — behind a scoped ClusterRole you granted it once, via git. Grant via git; act via console.
