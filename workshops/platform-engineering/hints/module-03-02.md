# Hint 2: Delivering the database via git + watching it come up

Module 02's `demo` Application syncs everything under `gitops/components/demo/` into the
`demo` namespace — so:

```bash
cp /lab/03-data/postgres-cluster.yaml gitops/components/demo/
git add . && git commit -m "app-db postgres cluster" && git push
```

Watch it: `kubectl -n demo get cluster app-db -w` (a CNPG cluster does init → one pod →
healthy; first time takes a minute or two). If it sticks, `kubectl -n demo describe
cluster app-db` and `kubectl -n demo get pvc,events`.
