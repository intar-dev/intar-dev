# Module 03 — Data services: Postgres and S3, on your terms

## The goal

At the end of this module your platform offers two managed data services, both delivered
via git: a PostgreSQL database (CloudNativePG operator) you can `psql` into, and an
S3-compatible object store (RustFS) where you can create a bucket and share a working
presigned URL. `./verify.sh` proves all of it.

## Why this matters

"Managed database" is the single most-bought cloud product, and the thing teams miss most
when leaving a hyperscaler. An operator like CloudNativePG *is* the managed service — the
software that would run behind AWS's console runs in your cluster instead: provisioning,
failover, backups as Kubernetes resources. Same story for object storage. Today you become
the RDS and S3 team — and it's less magic than its price tag suggests.

## The task

Everything goes through the git workflow from module 02 (your Gitea clone).

1. **Enable the two platform components.** The repo has a catalog of ready-made ArgoCD
   Applications in `gitops/catalog/` — enabling one means copying it into `gitops/apps/`
   and pushing. Enable `cnpg-operator.yaml` and `rustfs.yaml`. Watch them come up.

2. **Self-service a database.** This lab dir has a reference manifest,
   [`postgres-cluster.yaml`](postgres-cluster.yaml) — a CNPG `Cluster` named `app-db`.
   Read it (note `storageClass` and `instances`), then deliver it into the `demo`
   namespace *via your repo* (where did module 02 put demo-namespace manifests?).
   Wait for `Cluster in healthy state`, then get a psql prompt in it and run `SELECT 1`.

3. **Claim your object storage.** RustFS speaks S3 on NodePort **30900**
   (access key `cloudbox`, secret `cloudbox123`). Using the `aws` CLI (or `mc`, or a
   3-line script — dealer's choice): create a bucket `app-assets`, upload any file, and
   generate a **presigned URL**, save it, and prove it with `curl --fail` from the same
   learner terminal. The S3 API NodePort is guest-local and intentionally not exposed as a
   workspace application. In the browser, open **RustFS** under **Workspace applications**
   to inspect the bucket and object.

4. Run `./verify.sh`.

## Hints

## Check your work

```bash
./verify.sh
```

It checks: the cnpg-operator and rustfs ArgoCD apps are Healthy (Synced is the happy path; sync is advisory); the CNPG operator
deployment is up; `app-db` reports healthy with 1/1 ready instances; `SELECT 1` actually
returns 1 from inside the database; RustFS answers S3 on :30900; and bucket `app-assets`
exists with at least one object.

## Explain-back

Tell your neighbor: when you pushed `postgres-cluster.yaml`, list the chain of actors that
turned 30 lines of YAML into a running Postgres (git → ? → ? → pods, PVC, Services,
Secrets). Which of those actors did *you* install, and via what?

## Going deeper

- Kill the database pod (`kubectl -n demo delete pod app-db-1`) and watch the operator
  rebuild it. Where did the data survive?
- Scale to `instances: 3` **via git**, watch replicas join, then check
  `kubectl -n demo get cluster app-db -o yaml` for who's primary. Scale back down (RAM!).
- RustFS is beta software with a rough CVE history — we run it as an ephemeral lab
  sandbox. Discuss: what would *you* need to see before running an S3 clone in prod?
  (This is a real platform-team decision, not a rhetorical one.)

## A note on honesty

MinIO's open-source edition was discontinued in 2025 (not "relicensed"). RustFS is an
independent Apache-2.0 reimplementation of the S3 API — not a MinIO successor. We picked
it to show the *pattern*: S3 is a protocol, and you can self-host a speaker of it.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/03-data/verify.sh`. Layered hints and the solution are released separately by Intar.
