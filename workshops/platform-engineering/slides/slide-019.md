# The rule underneath every pick

    **Pinned &amp; sealed**

    Explicit source versions are resolved to immutable hashes during publication; `:latest` is rejected.
    scripts/images.txt · builder cold-boot verification

    **Pre-pulled &amp; offline**

    Nothing is fetched in the live session — no CDN, no Grafana plugin download, no Docker Hub live pull.
    sealed checkpoint 00 → guest-local mirror

    **Assembled, not a blob**

    Hand-written minimal manifests where a Helm chart would drag in StatefulSets, sidecars, PDBs.
    rustfs · nats · grafana · victoria-*

    **Fits a 16 GiB Intar guest**

    In-cluster total ≈ 7.5–8 GiB; 4 vCPU, 16 GiB RAM, 100 GiB disk declared. Every pick optimises for this ceiling.
    the constraint that shaped the whole stack

Change the constraints — a real datacenter, a compliance regime, a 10-person platform team — and some of these picks flip. **That** is the transferable skill: not the tools, but reading the tradeoff.
