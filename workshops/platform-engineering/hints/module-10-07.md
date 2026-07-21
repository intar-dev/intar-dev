# Hint 3: Connect the previous process state to the resource budget

Describe one restarting pod and read `Last State`, `Reason`, and `Exit Code`. Then inspect
the `web` container's configured memory allocation in the Git-managed Deployment:

```bash
kubectl -n demo describe pod
kubectl -n demo get deploy demo-web \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="web")].resources}'
git clone http://localhost:30300/cloudbox/platform.git && cd platform
git log --oneline -3 -- gitops/components/demo/demo-web.yaml
git show
```

Compare the configured memory allocation with what the Go binary actually needs to run
and serve traffic. The current state may be `Running`; the previous terminated state
records why kubelet had to restart it.
