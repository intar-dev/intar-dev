# Module 07 (stretch) — CI on your terms: build inside the cluster

## The goal

At the end of this module your cluster builds its own container images: an Argo Workflow
runs BuildKit (rootless) *inside* the cluster, builds the tiny app in [`app/`](app/) from
your in-cluster Gitea, pushes it to your in-cluster Zot registry, and a Deployment runs
it. Git, build, the learner registry, and deployment all stay inside the learner VM; only declared digest-pinned base images come from external registries.

> **Honesty note:** this is the least-rehearsed path in the workshop (rootless BuildKit
> on Talos is pioneer territory — nobody has published this combo). It's a presenter demo
> first, self-paced lab second. If it fights you, watch the demo, file the scars, move on.

## Why this matters

CI is the last thing teams believe they can self-host ("we need GitHub Actions!").
But a build is just a pod with elevated filesystem tricks: BuildKit replaced the archived
Kaniko as the 2026 in-cluster answer, and a registry is a single binary (Zot, CNCF).
Once *build → push → deploy* closes inside your platform, the loop is fully yours.

## The task

1. Enable **two** catalog apps: `zot.yaml` (registry, NodePort 30500) and
   `argo-workflows.yaml` (workflow engine + the `build-and-push` WorkflowTemplate in
   ns `builds` — a namespace labeled PSA-privileged because rootless BuildKit needs an
   unconfined seccomp profile; find that label and understand why it's there).
2. Look at [`app/`](app/) — a Dockerfile and one HTML file. Your Gitea repo already
   contains it (it was seeded with the whole workshop repo). Notice the `FROM` line:
   it pulls the base image from *your* Zot, not from Docker Hub — your platform builds
   FROM your own registry, dependent on digest-pinned external pulls.
3. **Seed the base image**: pull busybox into YOUR registry (host-side, against Zot's
   NodePort). `crane copy` doesn't read your local docker — it's a registry-to-registry
   copy that pulls busybox from Docker Hub and pushes it straight into Zot:

   ```bash
   crane copy --insecure \
     docker.io/library/busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028 localhost:30500/library/busybox:1.37.0
   ```

   That's the platform-team move: you decide what base images exist in your cloud.
4. Submit a build with [`workflow-run.yaml`](workflow-run.yaml) and follow it to
   `Succeeded`. Then prove the artifact is real: ask Zot's API what's in the registry
   (NodePort 30500, standard OCI `/v2/` endpoints).
5. Run the image: deliver [`hello-site.yaml`](hello-site.yaml) via GitOps, then curl the
   page it serves.
6. Run `./verify.sh`.

## Hints

## Check your work

```bash
./verify.sh
```

It checks: zot and argo-workflows apps Healthy (Synced is the happy path; sync is advisory); Zot's API answering on :30500;
at least one `build-hello-site-*` workflow **Succeeded**; the `hello-site` image present
in Zot's catalog; and the hello-site Deployment Available and serving the page.

## Explain-back

Tell your neighbor: list every network hop in your pipeline (git clone from ? → build
runs where? → push to ? → kubelet pulls from ?). How many of those left your learner VM?
That's the sovereignty argument in one answer.

## Going deeper

- Change `index.html` (v2!), push to Gitea, build `:v2`, and roll `hello-site` to it via
  git. You've reinvented a release pipeline — how would you trigger the build on push?
  (Gitea has webhooks; Argo has Events. At-home project.)
- Inspect the build pod's securityContext while a build runs. What does
  `--oci-worker-no-process-sandbox` trade away, and why did the `builds` namespace need
  the PSA `privileged` label on a Talos cluster?
- Point the module-06 ksvc at `localhost:30500/hello-site:v1` — serverless serving of a
  self-built image (the cluster's Knative config already skips tag-resolution for the
  Zot registry names; find that setting in `config-deployment`).

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/07-ci/verify.sh`. Layered hints and the solution are released separately by Intar.
