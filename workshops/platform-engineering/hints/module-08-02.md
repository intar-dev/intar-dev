# Hint 2: The form did something — where did it go?

The form POSTs to the portal, which creates a `WorkshopDatabase` in ns `demo` — from
there it's the module-04 machinery, so the module-04 commands apply:

```bash
kubectl -n demo get workshopdatabase                  # or: kubectl -n demo get wdb
kubectl -n demo describe workshopdatabase console-db  # composition events
kubectl -n demo get cluster,job,pods                  # the composed stack
```

`SYNCED True / READY False` while Postgres boots is normal; give it 2–3 minutes.
