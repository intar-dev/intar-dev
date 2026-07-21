# Full solution

```bash
WORKSHOP="$(git rev-parse --show-toplevel)"
cd ~/cloudbox-platform
cp gitops/catalog/knative-serving.yaml gitops/apps/
cp "$WORKSHOP/lab/06-serverless/hello-ksvc.yaml" gitops/components/demo/
git add . && git commit -m "module 06: knative + hello ksvc" && git push

kubectl -n demo get ksvc hello -w      # until READY True
HOST="$(kubectl -n demo get ksvc hello -o jsonpath='{.status.url}' | sed 's|http://||')"

kubectl -n demo get pods -w &          # watcher
curl -H "Host: $HOST" http://localhost:31080/    # cold start!
sleep 90                                # silence...
kubectl -n demo get pods                # gone again
kill %1

cd "$WORKSHOP/lab/06-serverless" && ./verify.sh
```
