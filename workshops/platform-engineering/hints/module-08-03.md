# Hint 3: The portal is up but a page errors

Each page is one API call — the error names the resource it couldn't read.

1. `kubectl -n portal logs deploy/portal --tail=20` — RBAC denials and API errors land here.
2. A `workshopdatabases.platform.cloudbox.io not found` error means module 04 isn't in
   place — the portal is a *view* on the platform API; it can't invent one. A
   `... is forbidden` error means the grant from step 3 is missing: is
   `portal-access.yaml` in `gitops/components/demo/` and the `demo` app synced?
3. The Gallery page needs RustFS (module 03) and shows an empty grid until module 09
   creates the `images` bucket — empty is fine, an error is not.
