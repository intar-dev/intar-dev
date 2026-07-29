# Hint 1: ArgoCD admin password + finding my way in the UI

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

In the UI, open the `platform` app — the tree view shows every child Application it
manages. `spec.source.path` (App details → Manifest) is the watched path: `gitops/apps`.
