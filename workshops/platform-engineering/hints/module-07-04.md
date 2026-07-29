# Full solution

```bash
WORKSHOP="$(git rev-parse --show-toplevel)"
cd ~/cloudbox-platform
cp gitops/catalog/zot.yaml            gitops/apps/
cp gitops/catalog/argo-workflows.yaml gitops/apps/
git add . && git commit -m "module 07: zot + argo-workflows" && git push
# wait for both apps Healthy in ArgoCD

# seed YOUR registry with the pre-pulled base image (host → Zot NodePort)
crane copy --insecure \
  docker.io/library/busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028 localhost:30500/library/busybox:1.37.0

kubectl create -f "$WORKSHOP/lab/07-ci/workflow-run.yaml"
kubectl -n builds get workflows -w              # until Succeeded

curl -s http://localhost:30500/v2/_catalog | jq .   # hello-site is there

cp "$WORKSHOP/lab/07-ci/hello-site.yaml" gitops/components/demo/
git add . && git commit -m "module 07: run hello-site" && git push
kubectl -n demo rollout status deploy/hello-site

kubectl -n demo port-forward svc/hello-site 8087:80 &
curl -s http://localhost:8087/ | grep hello-site
kill %1
cd "$WORKSHOP/lab/07-ci" && ./verify.sh
```
