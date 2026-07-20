# Full solution

```bash
WORKSHOP="$(git rev-parse --show-toplevel)"
cd ~/cloudbox-platform   # your Gitea clone from module 02 (used the remote-add path instead? cd into your workshop checkout)

cp gitops/catalog/crossplane.yaml gitops/apps/
mkdir -p gitops/components/platform-api
cp "$WORKSHOP/lab/04-self-service/platform/xrd.yaml"         gitops/components/platform-api/
cp "$WORKSHOP/lab/04-self-service/platform/composition.yaml" gitops/components/platform-api/
cp "$WORKSHOP/lab/04-self-service/platform-api-app.yaml"     gitops/apps/platform-api.yaml
cp "$WORKSHOP/lab/04-self-service/examples/my-database.yaml" gitops/components/demo/
git add . && git commit -m "module 04: platform API + first WorkshopDatabase" && git push

kubectl get xrd -w                                   # until ESTABLISHED
kubectl -n demo get workshopdatabase my-db -w        # until SYNCED + READY
kubectl -n demo get cluster,job                      # my-db-pg + my-db-bucket
cd "$WORKSHOP/lab/04-self-service" && ./verify.sh
```
