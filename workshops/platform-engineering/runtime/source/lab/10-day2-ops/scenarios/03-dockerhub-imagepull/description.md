# Scenario 03 — spoiler

**Symptom:** `kubectl -n demo get pods -l app=demo-web` shows new pods in
`ErrImagePull` or `ImagePullBackOff`. `kubectl -n demo describe pod <pod>` shows Events
for a failed pull from `docker.io`, which is rate-limited or unreachable at the workshop
venue. In scenario 1 the image pulled and bad runtime configuration crashed the process;
in scenario 2 the image pulled and an undersized memory limit killed the process. Here
the container never starts.

**Root cause:** the release commit changed only the image registry host from `ghcr.io`
to `docker.io`; the repository path and digest stayed identical. This workshop's
architecture contract requires every workload image to be pinned, hosted on GHCR, and
declared in the signed external image lock precisely because Docker Hub is rate-limited at
the venue. See the [root repository guide](../../../../CLAUDE.md).

**Why this is realistic:** “use the canonical upstream registry” or “pull from source”
reads like routine cleanup, but it silently bypasses the workshop's digest-pinned external image contract. The
repository's [research grounding](../../../../docs/RESEARCH.md) says never to pull from
Docker Hub live: the whole room shares one NAT IP and therefore one anonymous quota,
documented there as 100 pulls per six hours. The deliberate mitigation is to host every
image on GHCR with a pinned reference and pre-pull it before the workshop.

**Diagnosis path this teaches:**

1. `kubectl -n demo get pods -l app=demo-web` → the new pods show `ErrImagePull` or
   `ImagePullBackOff`, not a running process with a restart history.
2. `kubectl -n demo describe pod <pod>` → read Events bottom-up and find the failed pull.
3. Read the exact registry, repository, and digest in the pull error; it starts with
   `docker.io/`.
4. Compare it with the Deployment's configured value:
   `kubectl -n demo get deploy demo-web -o jsonpath='{.spec.template.spec.containers[0].image}'`.
5. In a clone of `cloudbox/platform`,
   `git log --oneline -3 -- gitops/components/demo/demo-web.yaml` reveals the recent
   registry commit.
6. `git show <sha>` confirms that only the registry host changed; the path and digest
   remained byte-identical.

**Canonical fix:** revert the bad Git commit and push the revert — do not edit the live
Deployment, because ArgoCD will reconcile it back to Git.

```bash
git clone http://localhost:30300/cloudbox/platform.git
cd platform
git log --oneline -3 -- gitops/components/demo/demo-web.yaml
git revert <sha>
git push
```

Or run `./restore.sh 3`, which performs that same forward `git revert` workflow.

**Verify the fix:** `./verify.sh` requires every image reference in
`gitops/components/demo/demo-web.yaml` to start with `ghcr.io/`, requires the manifest to
match this module's baseline byte-for-byte, and requires a completed, stable `demo-web`
rollout. No pod may remain blocked on an image pull.

**Why `cloudbox/demo-app` is a dead end:** it is only Go SOURCE for module 07's
in-cluster build (seeded by `scripts/seed-gitea.sh`). Nothing in Kubernetes syncs it
directly, and it carries no deploy manifests — investigating it will not explain this
symptom.
