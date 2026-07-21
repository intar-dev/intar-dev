A headline teaching point, and the first place today where "verify what the assistant says" gets concrete.

Crossplane v2 (GA in 2025) restructured the core model:
- Claims are GONE. In v1 you had cluster-scoped XRs plus namespaced Claims proxying them; in v2 you simply create namespaced XRs directly. Simpler — but it means nearly every blog post, tutorial, and Stack Overflow answer out there describes an API that no longer exists.
- Compositions are pipeline-mode only, and they can emit plain Kubernetes resources DIRECTLY — our composition outputs a CNPG Cluster and a Job with no provider-kubernetes wrapping. In v1 you needed a provider for that.

Field guide for the room: if you (or your AI assistant) see `kind: Claim`, `claimNames` in an XRD, or a top-level `resources:` list in a Composition — you are reading the past. The lab README carries the same warning.

This lands twice: it's a real operational skill (knowing which major version your sources describe), and it foreshadows module 05's theme — plausible, confident, out-of-date answers are exactly what agents produce when their training data lags the ecosystem.
