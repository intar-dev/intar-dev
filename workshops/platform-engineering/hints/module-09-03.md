# Hint 3: The S3 view of what happened

```bash
export AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1
aws --endpoint-url http://localhost:30900 s3 ls s3://images/originals/
aws --endpoint-url http://localhost:30900 s3 ls s3://images/thumbs/
aws --endpoint-url http://localhost:30900 s3 cp s3://images/meta/.json - | cat
```

The metadata JSON (dimensions, dominant color) is the resizer's proof of work — the
gallery page renders exactly this file. No `aws` CLI? The in-cluster pattern from
module 03's hint 4 works verbatim (endpoint `http://rustfs-svc.rustfs.svc.cluster.local:9000`).
