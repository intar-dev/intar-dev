# Hint 3: Getting a psql prompt (no client install needed)

Every CNPG pod contains psql, and local socket auth works for the postgres superuser:

```bash
kubectl -n demo exec -it app-db-1 -- psql -U postgres -d app
```

App credentials (for connecting like an application would, via the `app-db-rw` Service)
were generated for you: `kubectl -n demo get secret app-db-app -o yaml`. CNPG made
`app-db-rw` / `app-db-ro` / `app-db-r` Services — rw always points at the primary.
