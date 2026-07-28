The concept: what you're buying from a hyperscaler's managed database is software that provisions, monitors, fails over, and backs up. A Kubernetes operator like CloudNativePG IS that software — the same control loop that would run behind AWS's console runs in your cluster instead. Declare a Cluster resource, get a supervised Postgres with failover and backup hooks.

CloudNativePG specifically: CNCF project, originally from EDB, arguably the most production-adopted Postgres operator. This isn't a toy pick.

Same story for object storage: S3 is an API, and RustFS implements it — buckets, multipart, presigned URLs. In the lab they'll create a bucket, upload a file, and generate a presigned URL that works in their browser: handing someone a download link with zero AWS involved.

Everything arrives via the module-02 loop: enable cnpg-operator and rustfs from the catalog, then deliver a Cluster manifest through the demo component in git. psql into your own DBaaS is the visible win.
