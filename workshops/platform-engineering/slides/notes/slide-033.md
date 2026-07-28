The loop: edit → push → Gitea → ArgoCD → cluster. Say it twice; it's the muscle memory for the rest of the day.

The design decision worth dwelling on: the git server is IN the cluster. Your platform does not depend on GitHub, on the venue WiFi, or on anyone's SaaS. That's "cloud on your terms" expressed in one architecture choice. (It also means the workshop survives conference WiFi.)

ArgoCD v3 with the app-of-apps pattern: one root Application watches a directory in the repo and creates other Applications from it, in sync waves. This is genuinely how real platform teams bootstrap clusters — not a workshop simplification.

In the lab they'll poke both UIs: Gitea at localhost:30300 (gitea_admin / cloudbox123), ArgoCD at localhost:30080 (admin, password fetched from the cluster — that's hint 1). Then the real thing: clone the platform repo FROM their own Gitea, add an Application + a ConfigMap with their own name in it, push, and watch a namespace materialize without ever running kubectl apply.
