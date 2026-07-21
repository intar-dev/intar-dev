# Full solution

```bash
./scripts/bootstrap-gitops.sh
./scripts/seed-gitea.sh

WORKSHOP="$(git rev-parse --show-toplevel)"
git clone http://gitea_admin:cloudbox123@localhost:30300/cloudbox/platform.git /tmp/platform
cd /tmp/platform
cp "$WORKSHOP/lab/02-gitops/demo-app.yaml" gitops/apps/demo.yaml
mkdir -p gitops/components/demo
sed 's/CHANGE ME/Ada Lovelace/' "$WORKSHOP/lab/02-gitops/welcome.yaml" \
  > gitops/components/demo/welcome.yaml
git add . && git commit -m "demo app with welcome configmap" && git push

# watch it land (ArgoCD polls ~3min; force it via UI Refresh if impatient)
kubectl -n argocd get applications -w   # until demo is Synced/Healthy
kubectl -n demo get configmap welcome -o yaml
```
