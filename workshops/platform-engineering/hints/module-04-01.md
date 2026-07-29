# Hint 1: The mechanics of shipping the API

In your Gitea clone:

```bash
cp gitops/catalog/crossplane.yaml gitops/apps/
mkdir -p gitops/components/platform-api
cp /lab/04-self-service/platform/*.yaml gitops/components/platform-api/
cp /lab/04-self-service/platform-api-app.yaml gitops/apps/platform-api.yaml
git add . && git commit -m "platform API: WorkshopDatabase" && git push
```

Crossplane takes ~1–2 min to install; the platform-api app retries until the CRDs exist.
Check: `kubectl get xrd` → `ESTABLISHED True`, and `kubectl get functions.pkg.crossplane.io`.
