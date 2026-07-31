# Facilitator notes — module 08

The portal module — and the second honest-ecosystem interlude of the day (build vs. buy). Everything built so far is APIs and YAML: perfect for platform engineers, invisible to everyone else. A portal is how a platform gets adopted.


---

Demystification slide. The industry reflex is "portal = Backstage = big adoption project". But mechanically, a portal is a web app making REST calls to the Kubernetes API — and the Cloudbox Console proves it in ~6k lines of plain Go and htmx (one vendored .js file, no build step, no framework), small enough to read end to end.

Walk the architecture in one breath: internal/kube/client.go authenticates with nothing but the pod's mounted ServiceAccount token; a scoped read-only ClusterRole covers the surfaces it renders — the ArgoCD apps, CNPG clusters, ksvcs, and pods/nodes/events/workloads it lists, not read-all (check it: kubectl describe clusterrole portal-read); internal/kube/resources.go lists ArgoCD Applications, CNPG Clusters, and Knative Services as dynamic resources; the "New database" form POST in internal/web/databases.go builds a WorkshopDatabase object and creates it — about 20 lines that replace a whole portal product's scaffolder, because module 04's XRD and Composition already did the hard part.

That's the lesson stated on the slide: the portal has no special powers. Your platform already had the API; the portal is a form in front of it.

The star task in the lab: create console-db through the form, then prove it's real the module-04 way — kubectl get workshopdatabase, then watch the composed CNPG cluster boot. And the follow-up worth savoring: this database did NOT go through git (check who created it, and note it's absent from Gitea). Governance question for the explain-back: should a portal write to git instead? Real platform teams argue about exactly this.


---

The write-model slide (DR-0004), and the answer to the governance question the previous slide planted. A platform has two write paths, and the skill is knowing which is which — split by AUDIENCE, not mixed per action.

Platform plane — GitOps: installing a capability, editing the catalog, granting the portal an RBAC scope. Low-frequency, high-blast-radius changes that genuinely want a git history and a one-command rollback. This is where GitOps earns its cost. You do it with git on the CLI, and the console just reflects the result (the Components and Access pages light up) — you never bounce into Gitea's web UI.

Tenant plane — Console-direct: create a database, deploy a function, spin up a project. High-frequency, low-blast-radius self-service that wants instant feedback. It goes straight to the Kubernetes API — exactly what the New Database form did a minute ago, and it's absent from Gitea on purpose. That's not a bug; it's the right plane for the job.

kubectl is the third, orthogonal thing: it inspects (and rescues) either plane — the muscle from modules 01-05.

The one deliberately clever move we did NOT make: having the console write to Gitea behind your back (console → commit → ArgoCD → cluster). It sounds elegant — audit trail for everything — but it pays git's latency and moving parts on the one thing a console is uniquely good at, immediate self-service, to buy an audit trail a single-user lab doesn't need. Right pattern, wrong context. When you build projects later, "New project" is console-direct too — behind a scoped ClusterRole you granted it once, via git. Grant via git; act via console.


---

Projects make the namespace-as-tenant idea visible. The selector in the top bar is exactly the scope switcher every cloud console has — pick a project, and Databases/Functions/Applications all list and create inside that namespace.

The interesting part is "New project." It's a console-direct action (per the previous slide's rule — tenant self-service goes straight to the API), but it needs to do something privileged: create a namespace AND grant the portal access to it. So the escalation is bounded by RBAC: you hand the portal, once via git, a tightly scoped grant — it may create namespaces and rolebindings, and it may `bind` exactly one ClusterRole (portal-tenant), nothing else. That `bind` verb is the Kubernetes escalation guard: without it, an account can't create a binding to a role it doesn't already fully hold. So the portal can stand up a tenant, but it can't grant itself cluster-admin — the security lesson stays intact.

That's the whole platform in one feature: the capability is granted declaratively in git (scoped, auditable, reviewable), and the action is immediate self-service in the console. Grant via git; act via console.


---

The missing half of the "how does everyone use this platform" story, and the answer to a question sharp attendees carry all day: if everything is GitOps, how does an app developer ship THEIR code?

Two golden paths, and they are NOT the same path:
- The PLATFORM team changes the platform by committing to the config repo (cloudbox/platform.git); ArgoCD reconciles. That's the GitOps you've done in every module.
- The APP team ships an app by pushing to THEIR OWN repo in the same Gitea, which gets built (the module-07 Argo Workflow + BuildKit → Zot) and deployed. That's CI/CD — a different repo, a different reconciler, a different audience.

The console makes the second one self-service: New Application → "Build from a repo" → point at your Gitea repo, and it builds and deploys as an Application (workload + database + bucket), the app-team counterpart to the golden-path XR. Same "git push and it happens" feeling, but it is emphatically NOT GitOps — GitOps is the platform team's plane (DR-0004). Gitea wearing two hats — config store for the platform, source host for apps — is the thing that ties the whole day together.

And for the "I have nothing yet" start: New Application → "Start from a template" → the console calls Gitea's generate API to fork the demo app into a fresh repo of your own (cloudbox/), then builds and deploys it — no context-switch into Gitea's UI. That's the ONE place the console writes to the git plane, and it's a deliberate exception (DR-0004 amendment): scaffolding your own app repo is a one-time bootstrap of YOUR space, not a change to the platform. Clone it, change the code, push, hit Redeploy — the iterate loop from there is build-and-roll, never a console commit.

Security beat worth 20 seconds: the console only builds registered in-cluster Gitea repos, never a free-form URL — because a build is arbitrary code execution and a server-side fetch of a user URL is an SSRF path to your credentials. Real platforms (Nais, GitHub Actions) scope builds to team-owned repos for exactly this reason.


---

The console isn't one page — it's a front door for every capability the attendee stood up. Each self-service and platform page carries its own Monitoring panel fed by the same VictoriaMetrics/Logs/Traces stack: Builds shows BuildKit's resource use in the builds namespace (watch it spike during a build) above the live Argo Workflows runs; Streams reads JetStream throughput and connections through a prometheus-nats-exporter sidecar (NATS core only speaks JSON on :8222, so the sidecar is what makes it Prometheus-scrapable); Buckets has no exporter to lean on — RustFS exposes no /metrics — so it shows the generic per-namespace pod CPU/memory and says so on the page. The honesty is the point: a real console shows you what it can measure and is upfront about what it can't. Every panel queries the metrics store only on page load (never the 5-second htmx poll) and degrades to "no data yet" when observability is switched off.

One more IA beat worth calling out: lists are for triage, detail pages are for diagnosis. Applications and Functions each have a DETAIL page, and when one isn't Ready the console shows the CAUSE a `kubectl describe` would — the failing conditions, the pod-level trouble (ImagePullBackOff, CrashLoopBackOff…), and an opinionated cause→action hint ("the image can't be pulled — check the tag", "read its logs"). The console reads the conditions *with* you instead of just flashing a red dot.


---

The build-vs-buy interlude — be honest in both directions, because "bespoke always" is as wrong as "Backstage by default".

Bespoke won HERE because the platform is small and the audience is the builder: everything fits on one screen, the source is readable over coffee, and there's no team to staff. Those conditions are real in small orgs and internal tools — and they're exactly the conditions that vanish at scale.

Backstage earns its weight when you need: the plugin ecosystem (ArgoCD, PagerDuty, Sonar, cost insights — integrations you'd otherwise write AND maintain), a catalog with real ownership metadata across dozens of teams and hundreds of services, and TechDocs/scaffolder golden paths with an ecosystem behind them.

The costs are real too: roughly 2 GB of Node.js plus a Postgres, YAML-heavy configuration, and — the big one — typically a team that owns it. The closing line, verbatim from the lab: a portal is a PRODUCT decision, not a default.

Next slide: use the bundled Backstage screenshots to make the comparison concrete without provisioning an undeclared application.


---

Facilitator comparison, ~5 minutes, using the bundled Backstage screenshots. Do not enable backstage.yaml in the hosted session: it has no declared Intar workspace route.

Use the bundled screenshots to trace Backstage's conceptual loop: catalog entity → software template → new Gitea repository → ArgoCD Application → running workload. Backstage is not a declared Intar workspace application in this revision.

Narrate what to watch for: the template wires together git, CI/CD, and the catalog — that integration glue is the real, ongoing work of operating Backstage. The demo is deliberately placed AFTER attendees built the same self-service loop themselves in 04 and saw it fronted by a form minutes ago: same shape, industrial strength, industrial weight.

Keep backstage.yaml disabled in hosted sessions. The pinned source remains available for a separately sized, explicitly routed workshop revision.


---

The task: enable portal.yaml (lands in ns portal in seconds — one small Go binary), open **Cloudbox Console** under **Workspace applications**, and for each page answer "which Kubernetes API is this?" — they installed every one of them today.

Star task: create console-db (size small) via the New database form, then prove it with kubectl: the WorkshopDatabase XR, and the composed CNPG cluster booting with -w. Then the governance question: this one didn't go through git — find the evidence, keep the thought for the explain-back.

Finish by actually reading the source — apps/portal/ is a few dozen small Go files (internal/kube/client.go for the API, one file per page under internal/web/) and a set of templates; ask them to find the 20 lines behind the form in internal/web/databases.go. "After today you can read every line of your platform's front door" is the sentence to leave hanging.

Open the Console's Workshop page now. It becomes available with module 08 and summarizes live cluster state; compare it with Intar's native verification view used earlier. The page is implemented in `workshop.go` in roughly 100 lines.
