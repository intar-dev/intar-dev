# The rule underneath every pick

    **Pinned by digest**

    Every image is a `sha256:`, never `:latest` — a floating tag defeats reproducible external pulls.
    scripts/images.txt · check-consistency.sh enforces it

    **Externally pulled &amp; digest-pinned**

    Learner servers pull only declared manifests by digest over Hetzner egress; no OCI layer ships inside the checkpoint bundle.
    signed checkpoint bundle + external digest pulls

    **Assembled, not a blob**

    Hand-written minimal manifests where a Helm chart would drag in StatefulSets, sidecars, PDBs.
    rustfs · nats · grafana · victoria-*

    **Fits a 16 GB laptop**

    In-cluster total ≈ 7.5–8 GB; ≥10 GB to Docker. Every pick optimises for this ceiling.
    the constraint that shaped the whole stack

Change the constraints — a real datacenter, a compliance regime, a 10-person platform team — and some of these picks flip. **That** is the transferable skill: not the tools, but reading the tradeoff.
