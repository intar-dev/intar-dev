The missing half of the "how does everyone use this platform" story, and the answer to a question sharp attendees carry all day: if everything is GitOps, how does an app developer ship THEIR code?

Two golden paths, and they are NOT the same path:
- The PLATFORM team changes the platform by committing to the config repo (cloudbox/platform.git); ArgoCD reconciles. That's the GitOps you've done in every module.
- The APP team ships an app by pushing to THEIR OWN repo in the same Gitea, which gets built (the module-07 Argo Workflow + BuildKit → Zot) and deployed. That's CI/CD — a different repo, a different reconciler, a different audience.

The console makes the second one self-service: New Application → "Build from a repo" → point at your Gitea repo, and it builds and deploys as an Application (workload + database + bucket), the app-team counterpart to the golden-path XR. Same "git push and it happens" feeling, but it is emphatically NOT GitOps — GitOps is the platform team's plane (DR-0004). Gitea wearing two hats — config store for the platform, source host for apps — is the thing that ties the whole day together.

And for the "I have nothing yet" start: New Application → "Start from a template" → the console calls Gitea's generate API to fork the demo app into a fresh repo of your own (cloudbox/), then builds and deploys it — no context-switch into Gitea's UI. That's the ONE place the console writes to the git plane, and it's a deliberate exception (DR-0004 amendment): scaffolding your own app repo is a one-time bootstrap of YOUR space, not a change to the platform. Clone it, change the code, push, hit Redeploy — the iterate loop from there is build-and-roll, never a console commit.

Security beat worth 20 seconds: the console only builds registered in-cluster Gitea repos, never a free-form URL — because a build is arbitrary code execution and a server-side fetch of a user URL is an SSRF path to your credentials. Real platforms (Nais, GitHub Actions) scope builds to team-owned repos for exactly this reason.
