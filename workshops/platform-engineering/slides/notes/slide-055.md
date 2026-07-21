Presenter demo first (~5 min): enable both catalog apps on the projector workspace, copy the busybox base from checkpoint 00's guest-local mirror into Zot, submit the build workflow, and follow it to Succeeded. Prove the artifact twice: query Zot's OCI API and open the declared **Zot Registry** app. Then run the freshly built image via GitOps.

Then self-paced for those who want it: the same flow with the tiny app in lab/07-ci/app/ (a Dockerfile + one HTML page, already in everyone's Gitea because the whole repo was seeded).

The two beats to narrate during the demo:
1. The workflow's build step is just a pod — show it in kubectl get pods -n builds while it runs.
2. The registry answer: curl Zot's /v2/_catalog and show the same repository through its Intar app button. "Your registry. Your build. No Docker Hub, no GitHub Actions, no external anything."

Helper note for self-paced attempts: workflow stuck in Pending is usually the PSA label question from the README; build failures inside BuildKit are the deep end — that's what restore/`catch-up.sh 7` and the demo recording are for.
