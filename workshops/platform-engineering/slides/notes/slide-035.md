Two scripts install the machinery: bootstrap-gitops.sh puts Gitea and ArgoCD into the cluster; seed-gitea.sh pushes this repository into the in-cluster Gitea (the cloudbox/platform repo).

Then the lab: explore both UIs, answer the README's questions about the root Application and sync waves, and make a real change through git — the demo Application plus a welcome ConfigMap with YOUR name as owner.

The win to celebrate on the projector: someone's namespace appearing in ArgoCD's UI seconds after their push. Ask the room: "who touched kubectl apply? Nobody? That's GitOps."

Explain-back: "why is the git server inside the cluster — what breaks if we'd used GitHub instead?" (Answer: runtime internet dependency, SaaS dependency, and the sovereignty story.)

From this point on catch-up.sh works for every module — it force-pushes canonical state to their Gitea. Anyone stuck at 30 min: catch up, don't stall; the concepts land in 03–04 again.
