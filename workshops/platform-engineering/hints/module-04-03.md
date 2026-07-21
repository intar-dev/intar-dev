# Hint 3: It's stuck — where do I look?

In dependency order:

1. `kubectl -n crossplane-system get pods` — is Crossplane itself up?
2. `kubectl get functions.pkg.crossplane.io` — is `function-patch-and-transform` Healthy?
3. `kubectl -n demo describe workshopdatabase my-db` — composition errors land in events.
   "cannot compose resources" usually means the function name in the Composition doesn't
   match the installed Function.
4. RBAC: if events say *forbidden*, Crossplane lacks rights on the composed kind
   (`postgresql.cnpg.io` / `batch`) — the crossplane catalog app ships that ClusterRole;
   is it synced?
5. The composed pieces themselves: `kubectl -n demo describe cluster my-db-pg`,
   `kubectl -n demo logs job/my-db-bucket`.
