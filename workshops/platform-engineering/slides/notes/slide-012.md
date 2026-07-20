The map of the whole day — the comparison table you just showed, now as one running system. You'll return to this exact diagram in the closing, when every box is up and green across the room. Walk it bottom-up, one layer per beat:

1. Docker inside the dedicated Debian 13 Intar guest is the "datacenter".
2. Talos Linux v1.13 nodes run as containers — an immutable, API-only OS purpose-built for Kubernetes (module 01). Cilium does networking in eBPF; there is no kube-proxy in this cluster at all.
3. Gitea + Argo CD are the heart (module 02): the git server lives IN the cluster, and Argo CD delivers everything below it from that git repo. Nothing depends on GitHub or live internet.
4. The platform services: CloudNativePG for managed Postgres, RustFS for S3-compatible object storage (module 03), Crossplane v2 for the self-service API (module 04).
5. The stretch tier: Knative serverless (06), in-cluster CI with BuildKit and the Zot registry (07), the Cloudbox Console portal (08), and observability — the Victoria stack (VictoriaMetrics/Logs/Traces + Grafana) plus the OTel Collector — enabled on-demand as the module 09 capstone, not running from minute one.

Key sentence to land before moving on: "Everything below ArgoCD arrives as a git commit. That's the mechanic you'll use all day."

Don't explain any component deeply here — each gets its own module framing. Now hand over to the mechanics: how today actually works.
