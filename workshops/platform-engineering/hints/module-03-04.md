# Hint 4: The S3 part with aws CLI

```bash
export AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1
aws --endpoint-url http://localhost:30900 s3 mb s3://app-assets
echo "hello from my own cloud" > hello.txt
aws --endpoint-url http://localhost:30900 s3 cp hello.txt s3://app-assets/
aws --endpoint-url http://localhost:30900 s3 presign s3://app-assets/hello.txt --expires-in 3600
```

No `aws` on your machine? Run the whole sequence in the cluster instead (`verify.sh`
wants the uploaded object too, not just the bucket):

```bash
kubectl -n demo run s3 --rm -i --restart=Never \
  --image=public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581 \
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
