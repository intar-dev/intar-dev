# Scenario 01 — spoiler

**Symptom:** the new `demo-web` ReplicaSet never becomes Ready. Its pods repeatedly
restart with `CrashLoopBackOff`, while pods from the previous ReplicaSet can remain up.

**Root cause:** the release commit changed the `PORT` environment value from a valid
port to `8080-canary`. The deployed image (`ghcr.io/knative/helloworld-go` — the same
pre-pulled image module 06's `hello-ksvc.yaml` uses) reads `PORT` and starts with
`log.Fatal(http.ListenAndServe(fmt.Sprintf(":%s", port), nil))`. Go's `net.Listen`
rejects `:8080-canary` as an address, `log.Fatal` exits the process, and every new
replica crashes on startup. This is configuration poisoning, not an image pull failure;
the container image reference was never changed.

The default rolling-update strategy protects some availability here. Because the new
ReplicaSet's pods never become Ready, Kubernetes does not finish scaling down the old
ReplicaSet. After the Deployment's progress deadline elapses, its Progressing condition
becomes false with reason `ProgressDeadlineExceeded`.

**Diagnosis path this teaches:**

1. `kubectl -n demo get all` → the Deployment is stuck and the newest pods are restarting.
2. `kubectl -n demo describe pod <new-pod>` → Events show the repeated restarts and
   `CrashLoopBackOff` backoff.
3. `kubectl -n demo logs <new-pod> --previous` → the process reports the listen error
   for `:8080-canary` immediately before exiting.
4. Inspect the configured environment with
   `kubectl -n demo get deploy demo-web -o jsonpath='{.spec.template.spec.containers[0].env}'`.
   `kubectl -n demo rollout history deploy/demo-web` also establishes that a rollout
   recently started.
5. In a clone of `cloudbox/platform`, `git log --oneline -3 -- gitops/components/demo/demo-web.yaml`
   reveals the suspicious release commit; `git show <sha>` proves it changed only `PORT`
   in `gitops/components/demo/demo-web.yaml`.

**Canonical fix:** revert the bad Git commit and push the revert — do not edit the live
Deployment, because ArgoCD will reconcile it back to Git.

```bash
git clone http://localhost:30300/cloudbox/platform.git
cd platform
git log --oneline -3 -- gitops/components/demo/demo-web.yaml
git revert <sha>
git push
```

Or run `./restore.sh 1`, which performs that same forward `git revert` workflow.

**Verify the fix:** `./verify.sh` requires a clean `gitops/components/demo/demo-web.yaml`
(matching this module's own baseline byte-for-byte — not just "no poison substring") and
a completed, stable `demo-web` rollout. The replacement pods must be healthy with no
`CrashLoopBackOff` or accumulating restart count.

**Why `cloudbox/demo-app` is a dead end:** it is only Go SOURCE for module 07's
in-cluster build (seeded by `scripts/seed-gitea.sh`). Nothing in Kubernetes syncs it
directly, and it carries no deploy manifests — investigating it will not explain this
symptom.
