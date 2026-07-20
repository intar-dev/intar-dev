# Hint 2: Watching the composed stack appear

After pushing the example XR:

```bash
kubectl -n demo get workshopdatabase my-db          # or: kubectl -n demo get wdb
kubectl -n demo describe workshopdatabase my-db      # events show composed resources
kubectl -n demo get cluster,job,pods                 # the real things it made
crossplane beta trace workshopdatabase my-db -n demo # the whole tree, if crossplane CLI is installed
```

`SYNCED True / READY False` while the database boots is normal — readiness bubbles up
from the CNPG cluster's own Ready condition. Give it 2–3 minutes.
