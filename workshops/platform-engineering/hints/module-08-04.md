# Full solution

```bash
WORKSHOP="$(git rev-parse --show-toplevel)"
cd ~/cloudbox-platform   # your Gitea clone

cp gitops/catalog/portal.yaml gitops/apps/
cp "$WORKSHOP/lab/08-portal/portal-access.yaml" gitops/components/demo/
git add . && git commit -m "module 08: enable the cloudbox console + grant it demo access" && git push

kubectl -n portal rollout status deploy/portal --timeout=300s
open http://localhost:30600            # explore, then: Databases → New database
                                       # name: console-db, size: small → Create

kubectl -n demo get workshopdatabase console-db -w    # until SYNCED + READY
kubectl -n demo get cluster console-db-pg             # the real database behind the form

cd "$WORKSHOP/lab/08-portal" && ./verify.sh
```

(No UI handy? The form is sugar over the API — `kubectl apply` the same 10-line
`WorkshopDatabase` YAML from module 04 with name `console-db`, which is exactly what
`solve.sh` does.)
