# The operator **is** the managed service

- RDS = Postgres + provisioning + failover + backups
- CloudNativePG does exactly that, in-cluster
- Provisioning, failover, backups — as K8s resources
- Same story for S3: RustFS speaks the API
- Less magic than the price tag suggests
