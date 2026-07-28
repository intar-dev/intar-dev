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

export AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1
aws --endpoint-url http://localhost:30900 s3 mb s3://app-assets
echo "hello from my own cloud" > /tmp/hello.txt
aws --endpoint-url http://localhost:30900 s3 cp /tmp/hello.txt s3://app-assets/
aws --endpoint-url http://localhost:30900 s3 presign s3://app-assets/hello.txt --expires-in 3600
# open the printed URL in your browser

cd "$WORKSHOP/lab/03-data" && ./verify.sh
```
