# Kagent: agents as Kubernetes resources

    An agent is a CRD
    `kagent.dev/v1alpha2 Agent` — a controller reconciles it into a Deployment. Versioned in git like everything else shipped today.

    Delivered like every capability
    `gitops/catalog/kagent.yaml` → `gitops/apps/` → push → ArgoCD converges. CNCF Sandbox project, pinned in `scripts/versions.env` like everything else; only `k8s-agent` enabled.

One more CRD your platform reconciles — nothing new to learn to install it.
