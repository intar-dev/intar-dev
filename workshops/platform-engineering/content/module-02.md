# Module 02 — GitOps: your cluster gets a git server and an opinion

## The goal

At the end of this module your cluster hosts its own git server (Gitea) and its own
delivery system (ArgoCD), and **git is the only way anything changes**. You prove it by
pushing a commit to the in-cluster repo and watching a namespace and a ConfigMap — with
your name in it — materialize without you touching `kubectl apply`.

## Why this matters

This is the architectural heart of the workshop. Everything from here on — databases,
platform APIs, serverless — arrives as a git commit that ArgoCD converges. Note the git
server is *inside* the cluster: your platform doesn't depend on GitHub, on the venue WiFi,
or on anyone's SaaS. That's "cloud on your terms" in one design decision. The pattern
(app-of-apps: one root Application that deploys other Applications) is exactly how real
platform teams bootstrap clusters.

## The task

1. Install the machinery and seed the repo:

   ```bash
   ./scripts/bootstrap-gitops.sh   # Gitea + ArgoCD into the cluster
   ./scripts/seed-gitea.sh         # pushes this repository into your in-cluster Gitea
   ```

2. Look around your cloud's control room:
   - Gitea: http://localhost:30300 — log in as `gitea_admin` / `cloudbox123`, find the
     `cloudbox/platform` repo.
   - ArgoCD: http://localhost:30080 — username `admin`; get the password from the cluster
     (hint 1). Find the root `platform` Application. What path in the repo does it watch?
     What single Application did it already create, and why is that dir called "wave 0"?

3. **Make a real change through git.** Clone the repo *from your Gitea* and, using the two
   template files in this lab directory:
   - `demo-app.yaml` → `gitops/apps/demo.yaml` (a new ArgoCD Application for your own stuff)
   - `welcome.yaml` → `gitops/components/demo/welcome.yaml` — put **your name** in `owner`.

   Commit, push, and watch ArgoCD do the rest. When did the `demo` namespace appear? Who
   created it?

4. Try to cheat: `kubectl -n demo edit configmap welcome` and change your name to something
   else. Wait up to ~5 minutes (or press Refresh→Sync in the UI). What happens, and why?

5. Run `./verify.sh`.

## Hints

## Check your work

```bash
./verify.sh
```

It checks: Gitea answers on :30300 and hosts `cloudbox/platform`; ArgoCD answers on
:30080; the root `platform` app points at your in-cluster Gitea (not GitHub) and is
Healthy (Synced is the happy path; sync is advisory); the wave-0 app (storage) is
healthy; and your `demo`
app delivered the `welcome` ConfigMap with a real name in it.

## Explain-back

Tell your neighbor: in step 4 your manual edit was reverted. Walk through *who* reverted
it and *how it knew* — repo, root app, demo app, self-heal. Bonus: why is the git server
being in-cluster a sovereignty feature and not just a demo trick?

## Going deeper

- Observability isn't running yet — it's an on-demand capability you enable later from the
  catalog (`gitops/catalog/grafana.yaml` plus the `victoria-*` and `otel-collector` items),
  not part of wave 0. You'll switch it on and find Grafana in the capstone (module 09).
- Delete `gitops/apps/demo.yaml` from the repo and push. The root app-of-apps runs with
  `prune: false` (it only ever *adds* the child Applications each module enables, and
  auto-pruning the newest child on a transient/stale sync once tore whole namespaces out
  from under a running lab), so it won't delete the `demo` *Application object* for you —
  remove it yourself with `kubectl -n argocd delete application demo`. Now look again: the
  namespace and ConfigMap are still there, **orphaned**. Deleting an Application doesn't
  cascade to its resources unless the Application carries the
  `resources-finalizer.argocd.argoproj.io` finalizer. Then restore `demo.yaml` (`git revert`
  the deletion) — the app-of-apps re-creates the Application and the orphans get re-adopted.
  (Re-run `./verify.sh` after!)
- Read the root app's manifest: `kubectl -n argocd get app platform -o yaml`. Find the
  sync-wave annotations on the children. What orders what?

## AI assistants welcome

Good module for it: ask your assistant to explain any manifest you push before you push it
— "what will ArgoCD do when this lands?" is exactly the review muscle GitOps needs.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/02-gitops/verify.sh`. Layered hints and the solution are released separately by Intar.
