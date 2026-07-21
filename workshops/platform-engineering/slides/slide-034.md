# The catalog: enabling a capability

```bash
cp gitops/catalog/rustfs.yaml gitops/apps/
git commit -am "enable rustfs" && git push
# ...then watch ArgoCD converge
```

- `gitops/catalog/` — every capability, ready-made
- `gitops/apps/` — what your platform runs
- Copy → commit → push → converge
