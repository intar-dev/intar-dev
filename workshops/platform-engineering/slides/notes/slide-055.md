Presenter demo first (~5 min): enable both catalog apps on the projector cluster, submit the build workflow, follow it to Succeeded, then prove the artifact is real by querying Zot's OCI API (/v2/ endpoints on NodePort 30500) — and run the freshly built image via GitOps.

Then self-paced for those who want it: the same flow with the tiny app in lab/07-ci/app/ (a Dockerfile + one HTML page, already in everyone's Gitea because the whole repo was seeded).

The two beats to narrate during the demo:
1. The workflow's build step is just a pod — show it in kubectl get pods -n builds while it runs.
2. The registry answer: curl Zot's /v2/_catalog and there's the image. "Your registry. Your build. No Docker Hub, no GitHub Actions, no external anything."

Helper note for self-paced attempts: workflow stuck in Pending is usually the PSA label question from the README; build failures inside BuildKit are the deep end — that's what restore/`catch-up.sh 7` and the demo recording are for.
