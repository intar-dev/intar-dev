# Hint 3: Connect the pull Event to the Git-managed image

Describe one affected pod and read Events bottom-up. Compare the exact registry and image
string in the pull error with the Deployment and recent Git history:

```bash
kubectl -n demo describe pod
kubectl -n demo get deploy demo-web \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
git clone http://localhost:30300/cloudbox/platform.git && cd platform
git log --oneline -3 -- gitops/components/demo/demo-web.yaml
git show
```

Pay attention to the registry host as well as the repository path and digest. The
workshop pre-pulls the GHCR reference, not every equivalent registry location.
