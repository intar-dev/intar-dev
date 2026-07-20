# Your registry, your builds

```mermaid
flowchart LR
  gitea["Gitea
app source"] --> wf["Argo Workflow"]
  wf --> bk["BuildKit
rootless pod"]
  bk --> zot["Zot registry
:30500"]
  zot --> deploy["Deployment
runs your image"]
```

- CI is just pods with filesystem tricks
- Git → build → push → deploy: all in-cluster

 **Cloud parallel:** CodeBuild + ECR · Cloud Build + Artifact Registry — the whole build-and-ship pipeline, running inside your own cluster with zero external services.
