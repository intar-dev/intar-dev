The task in three beats, all through the git loop from module 02:
1. Enable cnpg-operator.yaml and rustfs.yaml from the catalog (copy → commit → push).
2. Deliver the provided CNPG Cluster manifest (app-db) into the demo namespace via the repo; wait for "Cluster in healthy state"; get a psql prompt inside it and run SELECT 1.
3. RustFS speaks S3 on NodePort 30900 (access key cloudbox / secret cloudbox123): create a bucket, upload a file, generate a presigned URL, open it in the browser.

Wins to celebrate: the psql prompt (module win #1) and a presigned URL opening in a browser (win #2 — "you just handed out a download link with zero AWS").

Helper notes: the most common stall is pushing the Cluster manifest to the wrong directory — the README asks "where did module 02 put demo-namespace manifests?" on purpose. Presigned URL failures are usually a clock-skew or wrong-endpoint issue; hints cover both.

BREAK after this module — 10 minutes. Announce it now so people pace themselves.
