The task in three beats, all through the git loop from module 02:
1. Enable cnpg-operator.yaml and rustfs.yaml from the catalog (copy → commit → push).
2. Deliver the provided CNPG Cluster manifest (app-db) into the demo namespace via the repo; wait for "Cluster in healthy state"; get a psql prompt inside it and run SELECT 1.
3. RustFS speaks S3 on guest-local NodePort 30900 (access key cloudbox / secret cloudbox123): create a bucket, upload a file, generate a presigned URL, and verify it with `curl` in the learner terminal. Use **Workspace applications → RustFS** for browser inspection.

Wins to celebrate: the psql prompt (module win #1) and a presigned URL returning the uploaded object inside the learner terminal (win #2). Then use the authorized RustFS application to show that the same object exists in the browser.

Helper notes: the most common stall is pushing the Cluster manifest to the wrong directory — the README asks "where did module 02 put demo-namespace manifests?" on purpose. Presigned URL failures are usually clock-skew or wrong-endpoint issues; the check must run in the learner terminal because port 30900 is guest-local.

BREAK after this module — 10 minutes. Announce it now so people pace themselves.
