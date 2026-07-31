# Full solution

```bash
WORKSHOP="$(git rev-parse --show-toplevel)"
cd ~/cloudbox-platform   # your Gitea clone from module 02 (used the remote-add path instead? cd into your workshop checkout)

cp gitops/catalog/cnpg-operator.yaml gitops/apps/
cp gitops/catalog/rustfs.yaml       gitops/apps/
cp "$WORKSHOP/lab/03-data/postgres-cluster.yaml" gitops/components/demo/
git add . && git commit -m "module 03: cnpg + rustfs + app-db" && git push

kubectl -n demo get cluster app-db -w        # until 'Cluster in healthy state'
kubectl -n demo exec -it app-db-1 -- psql -U postgres -d app -c 'SELECT 1;'

aws_s3() {
  docker run --rm --network host -i \
    -e AWS_ACCESS_KEY_ID=cloudbox \
    -e AWS_SECRET_ACCESS_KEY=cloudbox123 \
    -e AWS_REGION=us-east-1 \
    public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581 \
    --endpoint-url http://localhost:30900 "$@"
}
aws_s3 s3 mb s3://app-assets 2>/dev/null || true
printf 'hello from my own cloud\n' | aws_s3 s3 cp - s3://app-assets/hello.txt
PRESIGNED_URL="$(aws_s3 s3 presign s3://app-assets/hello.txt --expires-in 3600)"
curl --fail --show-error "$PRESIGNED_URL"
# Browser proof uses Workspace applications → RustFS; the S3 API URL is guest-local.

cd "$WORKSHOP/lab/03-data" && ./verify.sh
```
