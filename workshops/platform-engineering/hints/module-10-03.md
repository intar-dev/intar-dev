# Hint 3: Connect the process error to the Git change

Inspect the Deployment's container environment and recent rollout, then compare them
with the last few commits to `gitops/components/demo/demo-web.yaml` in a clone of
`cloudbox/platform` (**not** `cloudbox/demo-app` — that repo is unrelated Go source for
a different module, see the "Prerequisites" section above):

```bash
kubectl -n demo get deploy demo-web \
  -o jsonpath='{.spec.template.spec.containers[0].env}'
kubectl -n demo rollout history deploy/demo-web
git clone http://localhost:30300/cloudbox/platform.git && cd platform
git log --oneline -3 -- gitops/components/demo/demo-web.yaml
git show
```

The image still pulls. Look for configuration that controls what address the Go HTTP
server listens on.
