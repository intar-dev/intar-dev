# Scenario 02 — spoiler

**Symptom:** `kubectl -n demo get pods -l app=demo-web` shows the `demo-web` pods
restarting repeatedly, with the `RESTARTS` count continuing to climb. Describing an
affected pod shows `Last State: Terminated`, `Reason: OOMKilled`, and `Exit Code: 137`.

**Root cause:** the rightsizing commit set the `web` container's memory allocation to
`8Mi` — well below what the Go HTTP server binary actually needs to run and serve
traffic. The kernel OOM-killer inside the container's cgroup kills the process once it
exceeds that allocation. Kubelet restarts it, and the process is killed again on the
next request burst or garbage-collection cycle, producing a cadence rather than a single
startup crash.

**Diagnosis path this teaches:**

1. `kubectl -n demo get pods -l app=demo-web` → the pods may look healthy briefly, but
   their `RESTARTS` counts keep climbing.
2. `kubectl -n demo describe pod <pod>` → the prior container state is terminated with
   reason `OOMKilled` and exit code 137.
3. Read `lastState.terminated.reason` and the exit code rather than stopping at the
   current `Running` or `CrashLoopBackOff` state.
4. Compare the `web` container's configured memory allocation against what the Go binary
   actually needs to run and serve traffic — the 8Mi allocation is far below its real
   working set.
5. In a clone of `cloudbox/platform`,
   `git log --oneline -3 -- gitops/components/demo/demo-web.yaml` reveals the recent
   rightsizing commit.
6. `git show <sha>` confirms that the commit changed only the `web` container's memory
   allocation, nothing else.

**Canonical fix:** revert the bad Git commit and push the revert — do not edit the live
Deployment, because ArgoCD will reconcile it back to Git.

```bash
git clone http://localhost:30300/cloudbox/platform.git
cd platform
git log --oneline -3 -- gitops/components/demo/demo-web.yaml
git revert <sha>
git push
```

Or run `./restore.sh 2`, which performs that same forward `git revert` workflow.

**Verify the fix:** `./verify.sh` requires a clean `gitops/components/demo/demo-web.yaml`
(matching this module's own baseline byte-for-byte), a completed `demo-web` rollout, and
two pod-status samples over a stability window. Neither sample may show
`CrashLoopBackOff` or a previous `OOMKilled` termination, and restart counts must not
increase between samples.

**This is not an image-pull problem:** the image reference is unchanged and still pulls
successfully. `OOMKilled` is a resource-limit signature; `ImagePullBackOff` is an image
retrieval signature. They are different failures and belong to different scenarios in
this lab.

**Why `cloudbox/demo-app` is a dead end:** it is only Go SOURCE for module 07's
in-cluster build (seeded by `scripts/seed-gitea.sh`). Nothing in Kubernetes syncs it
directly, and it carries no deploy manifests — investigating it will not explain this
symptom.
