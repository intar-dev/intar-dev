# Layer 3 — the data services

RoleWe runRejectedThe tradeoff

Managed Postgres**cloudnativepg** **CloudNativePG 1.28.4**bitnami/stock PG · RDSA real control loop (failover, backup) vs. a bare pod — costs CRDs
Object storage (S3)**RustFS** **1.0.0-beta.8**MinIOApache-2.0, ~90 MB — but young; SeaweedFS is the rehearsed Plan B
OCI registry**Zot** **v2.1.18**Harbor · registry:2One CNCF binary + UI vs. a Postgres/Redis/Trivy fleet — fewer features
Storage class**local-path** **v0.0.36**Longhorn · Ceph CSINode-local, no snapshots/replication — right for one node

**CloudNativePG** *is* the RDS control loop, in your cluster: a `Cluster` CR reconciles into a primary + replica with backups and failover — bitnami's chart is just a Postgres pod. **RustFS** over MinIO because MinIO's community edition was gutted through 2025–26 in favour of proprietary AIStor — the exact roadmap risk this workshop is about (it's *not* a MinIO "successor"; it's an independent Apache-2.0 rewrite).
