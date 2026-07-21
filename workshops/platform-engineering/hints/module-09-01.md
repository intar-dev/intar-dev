# Hint 1: Enabling, and what "ready" looks like

In your Gitea clone:

```bash
cp gitops/catalog/knative-eventing.yaml gitops/apps/
cp gitops/catalog/picture-pipeline.yaml gitops/apps/
git add . && git commit -m "module 09: eventing + picture pipeline" && git push

kubectl -n knative-eventing get pods        # controller, webhook, broker ingress/filter, imc-*
kubectl -n pipeline get broker,trigger,ksvc # all Ready True
kubectl -n pipeline get job                 # create-images-bucket → Completions 1/1
```

Eventing's webhook takes a minute; the pipeline app retries until it's up (same dance as
module 06). Both can go in one push.
