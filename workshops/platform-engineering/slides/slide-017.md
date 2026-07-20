# Layer 4 — self-service & compute

RoleWe runRejectedThe tradeoff

Self-service API**crossplane** **Crossplane v2.3.3**Helm/operators · Crossplane v1Namespaced XRs compose real K8s resources — needs per-group RBAC
Serverless**knative** **Knative v1.22**plain Deployments · KEDAScale-to-zero + request buffering — an activator in the path
In-cluster CI**argo-workflows** **Argo Workflows v4.0.7 + BuildKit**Tekton · external CIRootless image builds, no cloud — needs a PSA-privileged namespace

**Crossplane v2** is why self-service is one YAML: Claims are gone, you create a **namespaced XR directly**, and pipeline compositions emit arbitrary K8s resources — the composition literally composes a CNPG `Cluster`. **Knative** gives scale-to-zero (it's what Cloud Run is built on); plain Deployments are always-on and KEDA won't buffer the first request. **BuildKit** because Kaniko was archived June 2025 — rootless, pushes to your own Zot, fully in-cluster.
