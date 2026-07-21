The honest-ecosystem interlude — this audience fact-checks, so say it precisely:

MinIO was THE self-hosted S3 answer for a decade. Through 2025–26, its open-source community edition was discontinued: the management console was gutted in May 2025, community binary releases stopped in October 2025, and the repo was archived in April 2026 — still AGPL, but no longer developed — as the company focused on its proprietary AIStor product.

Two things NOT to say, because they're wrong: MinIO did not "go proprietary" or "relicense" — the AGPL code is still AGPL; it was discontinued, not relicensed. And RustFS is not "the successor" — it's an independent reimplementation under Apache 2.0 that happens to speak the same S3 API.

Why we chose RustFS anyway, with eyes open: Apache-2.0 license, ~90 MB idle footprint, presigned GET/PUT work. It's young (1.0 still in beta, a rough CVE history through late 2025) — acceptable for an ephemeral lab sandbox, and we say so out loud. Alternatives worth knowing: SeaweedFS (our rehearsed plan B), Garage, Ceph/Rook at scale.

The meta-lesson connects back to the "why" section: the roadmap risk from slide 3 isn't cloud-only — it applies to the open-source supply chain too. Owning your platform includes owning the choice of what replaces a discontinued dependency.
