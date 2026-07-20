# Hint 1: What does "enable from the catalog" concretely look like?

In your Gitea clone:

```bash
cp gitops/catalog/cnpg-operator.yaml gitops/apps/
cp gitops/catalog/rustfs.yaml       gitops/apps/
git add . && git commit -m "enable cnpg + rustfs" && git push
```

Then watch `kubectl -n argocd get applications -w` (or the UI — Refresh to skip the poll).
The operator lands in ns `cnpg-system`, RustFS in ns `rustfs`.
