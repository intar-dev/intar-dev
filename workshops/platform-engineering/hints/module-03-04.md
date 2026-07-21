# Hint 4: The S3 part with aws CLI

```bash
export AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1
aws --endpoint-url http://localhost:30900 s3 mb s3://app-assets
echo "hello from my own cloud" > hello.txt
aws --endpoint-url http://localhost:30900 s3 cp hello.txt s3://app-assets/
URL="$(aws --endpoint-url http://localhost:30900 s3 presign s3://app-assets/hello.txt --expires-in 3600)"
curl -fsS "$URL"
```

`localhost` is correct for these terminal/API calls inside the Intar guest. For browser
exploration, open **RustFS** from the workshop app buttons and find `app-assets/hello.txt`.

The pinned guest also supports running the sequence in the cluster (`verify.sh` wants
the uploaded object too, not just the bucket):

```bash
kubectl -n demo run s3 --rm -i --restart=Never \
  --image=public.ecr.aws/aws-cli/aws-cli:2.27.49 \
  --env AWS_ACCESS_KEY_ID=cloudbox --env AWS_SECRET_ACCESS_KEY=cloudbox123 \
  --env AWS_REGION=us-east-1 \
  --command -- /bin/sh -c '
    set -e
    EP=http://rustfs-svc.rustfs.svc.cluster.local:9000
    aws --endpoint-url $EP s3 mb s3://app-assets 2>/dev/null || true
    echo "hello from my own cloud" > /tmp/hello.txt
    aws --endpoint-url $EP s3 cp /tmp/hello.txt s3://app-assets/hello.txt
    aws --endpoint-url $EP s3 presign s3://app-assets/hello.txt --expires-in 3600'
```
