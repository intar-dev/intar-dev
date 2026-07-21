The loop: edit → push → Gitea → ArgoCD → cluster. Say it twice; it's the muscle memory for the rest of the day.

The design decision worth dwelling on: the git server is IN the cluster. Your platform does not depend on GitHub, live internet, or anyone's SaaS. That's "cloud on your terms" expressed in one architecture choice. It also makes the live workshop path fully offline.

ArgoCD v3 with the app-of-apps pattern: one root Application watches a directory in the repo and creates other Applications from it, in sync waves. This is genuinely how real platform teams bootstrap clusters — not a workshop simplification.

In the lab they open Gitea and Argo CD through their released Intar app buttons (Gitea: gitea_admin / cloudbox123; Argo CD: admin, password fetched from the cluster — that's hint 1). Then the real thing: clone the platform repo FROM their own Gitea using the guest-local URL, add an Application + a ConfigMap with their own name in it, push, and watch a namespace materialize without ever running kubectl apply.
