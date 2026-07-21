# Hint 1: Enabling, and what "up" looks like

In your Gitea clone:

```bash
cp gitops/catalog/portal.yaml gitops/apps/
git add . && git commit -m "enable the cloudbox console" && git push
kubectl -n portal get pods -w    # one small pod
```

It's up when the in-guest check `curl -s http://localhost:30600/healthz` answers `ok`.
For browser access, open **Cloudbox Console** from Intar's workshop app buttons. The
portal needs the `demo` namespace and the module-04 platform API to exist — it *is* the
UI for them.
