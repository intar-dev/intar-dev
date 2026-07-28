# Fault 03 — spoiler

**Symptom:** `orders-api` in `faultlab-03` logs `ERROR: cannot reach inventory-db:5432`
every 5 seconds. The database pod is Running and Ready. The Service exists and has
endpoints. DNS resolves. Everything *looks* fine — connections just silently die.

**Root cause:** the `CiliumNetworkPolicy` `protect-inventory-db` allows ingress only from
pods labeled `app: orders` — but the client pods are labeled `app: orders-api`. Attaching
*any* ingress policy to an endpoint default-denies everything not explicitly allowed, so
the client's SYNs are dropped on the floor. Timeouts, not refusals — the network says
nothing.

**Diagnosis path this teaches:**

1. `kubectl -n faultlab-03 logs deploy/orders-api` → errors, but the target pod is healthy.
2. Rule out the usual suspects: `kubectl -n faultlab-03 get endpoints inventory-db`
   (has an IP!), `kubectl -n faultlab-03 exec deploy/orders-api -- getent hosts inventory-db`
   (resolves!). Healthy pod + endpoint + DNS + **timeout** ⇒ suspect policy.
3. Who has policies? `kubectl get ciliumnetworkpolicies -A` / `kubectl get netpol -A`.
4. Read it against the live labels:
   `kubectl -n faultlab-03 get pods --show-labels` — the allowlist says `app=orders`,
   nothing carries that label.
5. Watch the verdict happen (the smoking gun, straight from the eBPF datapath):
   ```bash
   kubectl -n kube-system exec ds/cilium -c cilium-agent -- \
     cilium-dbg monitor --type drop
   ```
   → `Policy denied ... faultlab-03/orders-api -> faultlab-03/inventory-db ... 5432`.
   (If Hubble is enabled on your cluster: `hubble observe --verdict DROPPED -n faultlab-03`.)
6. Fix the selector (or the pod labels) — in `fix.yaml` the policy allows `app: orders-api`.

**Lesson:** network policies fail *silently by design* — no events, no error strings, the
pod and Service look perfect. When healthy things can't talk and connections time out
(rather than get refused), go read policies and ask the datapath itself.

**Verify the fix:** `kubectl -n faultlab-03 exec deploy/orders-api -- pg_isready -h inventory-db -t 3`
and the logs flip to `OK: database reachable`.
