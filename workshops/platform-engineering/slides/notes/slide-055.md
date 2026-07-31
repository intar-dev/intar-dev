Presenter demo first (~5 min): use a facilitator workspace only when that facilitator is explicitly enrolled with a workspace; otherwise use a consenting participant's shared workspace. Enable both catalog apps, submit the build workflow, follow it to Succeeded, then prove the artifact through Zot's guest-local OCI API and run the freshly built image via GitOps.

Then self-paced for those who want it: the same flow with the tiny app in lab/07-ci/app/ (a Dockerfile + one HTML page, already in everyone's Gitea because the whole repo was seeded).

The two beats to narrate during the demo:
1. The workflow's build step is just a pod — show it in kubectl get pods -n builds while it runs.
2. The registry answer: curl Zot's /v2/_catalog and there's the image. "Your registry and your build output stay here. Digest-pinned base images still arrive through the declared external registries."

Helper note for self-paced attempts: workflow stuck in Pending is usually the PSA label question from the README; build failures inside BuildKit are the deep end — that's what restore/`catch-up.sh 7` and the demo recording are for.
