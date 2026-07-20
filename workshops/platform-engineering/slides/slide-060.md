# Two golden paths

    Platform team
    `git push` (config repo) → **ArgoCD** → converge.
Changing the platform. **GitOps.**

    App team
    `git push` (app repo) → **build** → deploy.
Shipping an app onto the platform. **CI/CD.**

Same Gitea, two reconcilers, two audiences — **GitOps is not the app team's deploy path.**
