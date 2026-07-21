Presenter architecture walkthrough, ~5 minutes. V1 intentionally declares no Backstage
workspace application, so do not enable `backstage.yaml`, expose port 30700, or invent an
undeclared route.

Trace the loop on the slide instead: catalog entity → software template → new in-cluster
Gitea repo → Argo CD Application → running pods. Open the released Gitea and Argo CD
apps only if you want to ground those two hops in the learner's live platform.

Narrate what to watch for: the template wires together git, CI/CD, and the catalog. That
integration glue is the real, ongoing work of operating Backstage. The comparison lands
after attendees built the same self-service shape in module 04 and put Cloudbox's form in
front of it here: same shape, industrial strength, industrial weight.
