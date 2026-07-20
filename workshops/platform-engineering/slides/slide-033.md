# The loop you'll use all day

```mermaid
flowchart LR
  edit["edit YAML"] --> push["git push"]
  push --> gitea["Gitea
in-cluster"]
  gitea --> argo["ArgoCD v3
app-of-apps"]
  argo --> k8s["cluster
converges"]
  k8s -.->|"observe, repeat"| edit
```

- Git is the **only** way anything changes
- Your git server runs **inside** the cluster

 **Cloud parallel:** no product to buy — where a hyperscaler gives you a console + CLI, GitOps makes git the single control plane (the same Argo/Flux that runs on managed clusters).
