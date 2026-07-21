# Full solution

```bash
WORKSHOP="$(git rev-parse --show-toplevel)"
cd ~/cloudbox-platform
cp gitops/catalog/zot.yaml            gitops/apps/
cp gitops/catalog/argo-workflows.yaml gitops/apps/
git add . && git commit -m "module 07: zot + argo-workflows" && git push
# wait for both apps Healthy in ArgoCD

# seed YOUR registry from checkpoint 00's guest-local mirror
MISE_OFFLINE=1 crane copy --insecure \
  localhost:5001/library/busybox:1.37.0 localhost:30500/library/busybox:1.37.0

kubectl create -f "$WORKSHOP/lab/07-ci/workflow-run.yaml"
kubectl -n builds get workflows -w              # until Succeeded

curl -s http://localhost:30500/v2/_catalog | jq .   # hello-site is there
# Open the released Zot Registry app button for the browser view.

cp "$WORKSHOP/lab/07-ci/hello-site.yaml" gitops/components/demo/
git add . && git commit -m "module 07: run hello-site" && git push
kubectl -n demo rollout status deploy/hello-site

kubectl -n demo port-forward svc/hello-site 8087:80 &
curl -s http://localhost:8087/ | grep hello-site
kill %1
cd "$WORKSHOP/lab/07-ci" && ./verify.sh
```
