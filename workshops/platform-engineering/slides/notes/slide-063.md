Presenter demo, ~5 minutes, on the projector cluster (backstage.yaml was pre-enabled during the second break — first boot is slow: ~2 GB CNOE image plus a CNPG database, which is precisely why this is a demo and not the hands-on).

The loop to show: guest sign-in at :30700 → catalog entities fed from Gitea → run a software template → chase the result through Gitea (:30300, a new repo appeared) → ArgoCD (:30080, a new Application) → pods running.

Narrate what to watch for: the template wires together git, CI/CD, and the catalog — that integration glue is the real, ongoing work of operating Backstage. The demo is deliberately placed AFTER attendees built the same self-service loop themselves in 04 and saw it fronted by a form minutes ago: same shape, industrial strength, industrial weight.

backstage.yaml stays in the catalog — anyone with RAM to spare can run this exact loop at home. That's the fair test of the build-vs-buy slide.
