# Facilitator notes — module 03

"Managed database" is the single most-bought cloud product — and the thing teams miss most when leaving a hyperscaler. This module makes each attendee the RDS team and the S3 team, for 35 minutes.


---

The concept: what you're buying from a hyperscaler's managed database is software that provisions, monitors, fails over, and backs up. A Kubernetes operator like CloudNativePG IS that software — the same control loop that would run behind AWS's console runs in your cluster instead. Declare a Cluster resource, get a supervised Postgres with failover and backup hooks.

CloudNativePG specifically: CNCF project, originally from EDB, arguably the most production-adopted Postgres operator. This isn't a toy pick.

Same story for object storage: S3 is an API, and RustFS implements it — buckets, multipart, presigned URLs. In the lab they create a bucket and upload a file, then verify a guest-local presigned URL with `curl` in the learner terminal. Browser inspection uses the separately authorized **RustFS** workspace application.

Everything arrives via the module-02 loop: enable cnpg-operator and rustfs from the catalog, then deliver a Cluster manifest through the demo component in git. psql into your own DBaaS is the visible win.


---

The honest-ecosystem interlude — this audience fact-checks, so say it precisely:

MinIO was THE self-hosted S3 answer for a decade. Through 2025–26, its open-source community edition was discontinued: the management console was gutted in May 2025, community binary releases stopped in October 2025, and the repo was archived in April 2026 — still AGPL, but no longer developed — as the company focused on its proprietary AIStor product.

Two things NOT to say, because they're wrong: MinIO did not "go proprietary" or "relicense" — the AGPL code is still AGPL; it was discontinued, not relicensed. And RustFS is not "the successor" — it's an independent reimplementation under Apache 2.0 that happens to speak the same S3 API.

Why we chose RustFS anyway, with eyes open: Apache-2.0 license, ~90 MB idle footprint, presigned GET/PUT work. It's young (1.0 still in beta, a rough CVE history through late 2025) — acceptable for an ephemeral lab sandbox, and we say so out loud. Alternatives worth knowing: SeaweedFS (our rehearsed plan B), Garage, Ceph/Rook at scale.

The meta-lesson connects back to the "why" section: the roadmap risk from slide 3 isn't cloud-only — it applies to the open-source supply chain too. Owning your platform includes owning the choice of what replaces a discontinued dependency.


---

The task in three beats, all through the git loop from module 02:
1. Enable cnpg-operator.yaml and rustfs.yaml from the catalog (copy → commit → push).
2. Deliver the provided CNPG Cluster manifest (app-db) into the demo namespace via the repo; wait for "Cluster in healthy state"; get a psql prompt inside it and run SELECT 1.
3. RustFS speaks S3 on guest-local NodePort 30900 (access key cloudbox / secret cloudbox123): create a bucket, upload a file, generate a presigned URL, and verify it with `curl` in the learner terminal. Use **Workspace applications → RustFS** for browser inspection.

Wins to celebrate: the psql prompt (module win #1) and a presigned URL returning the uploaded object inside the learner terminal (win #2). Then use the authorized RustFS application to show that the same object exists in the browser.

Helper notes: the most common stall is pushing the Cluster manifest to the wrong directory — the README asks "where did module 02 put demo-namespace manifests?" on purpose. Presigned URL failures are usually clock-skew or wrong-endpoint issues; the check must run in the learner terminal because port 30900 is guest-local.

BREAK after this module — 10 minutes. Announce it now so people pace themselves.


---

First break, roughly the 2-hour mark. Fill in the actual return time on the projector (or say it twice).

Keep the projector on Intar's synchronized break timer. On the private facilitator screen, open the roster-by-module live-verification view and check modules 00–03 without exposing participant identities.

Helpers: watch Intar's **Need help** queue. Claim unresolved requests and, when a learner needs canonical recovery, use the module-03 catch-up checkpoint through Intar rather than running hidden catch-up material in their terminal.
