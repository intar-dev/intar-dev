# Fault 04 — spoiler (the AI trap)

**Symptom:** `orders-api` in `faultlab-04` logs `ERROR: connection to inventory-db:5432
failed` — but only *some* of the time. Roughly every other check succeeds. The postgres
pod is Running, Ready, and its logs are clean.

**Root cause:** the `session-cache` Deployment was copy-pasted from the database
deployment and its pod template still carries the label `app: inventory-db`. The
`inventory-db` Service selects `app: inventory-db` — so its endpoints contain **two**
pods: the real postgres *and* the cache (which is not listening on 5432 at all). Every
connection that lands on the cache pod is refused. ~50% failure, no unhealthy pod
anywhere.

## Why this is the AI trap

Feed the symptom ("connection to inventory-db:5432 failed, postgres pod is healthy") plus
the *manifests of the client, service, and database* to an LLM and the high-probability
answers are all plausible and all wrong:

- "The Service port/targetPort doesn't match" — it does.
- "Postgres isn't ready / crash-looping; add a readinessProbe to the database" — it's
  been Ready the whole time, and probing the DB changes nothing.
- "It's a DNS / NetworkPolicy issue" — fresh off fault 03, doubly tempting. There is no
  policy in this namespace, and drops would time out rather than get refused.
- "Postgres max_connections exhausted" — it's one client.

The manifests the operator would *think to share* don't contain the bug — the cache
deployment looks unrelated, so neither humans nor assistants get shown it. Text-level
reasoning cannot find this fault. Only live state can.

## The falsification discipline (what this fault teaches)

Every claim above dies against one live observation:

1. **"Wrong port" dies against intermittency.** A wrong port fails 100% of the time.
   `kubectl -n faultlab-04 logs deploy/orders-api | tail -20` → alternating OK/ERROR.
   *Any* diagnosis that would fail deterministically is falsified before you touch YAML.
2. **"DB not ready" dies against the pod.** `kubectl -n faultlab-04 get pods` → Running,
   Ready 1/1, 0 restarts, for as long as the fault has existed.
3. **The real evidence:** `kubectl -n faultlab-04 get endpoints inventory-db` → **two
   addresses** for a single-replica database. That line is the whole incident.
4. Who's the impostor? `kubectl -n faultlab-04 get pods -l app=inventory-db -o wide` →
   postgres *and* session-cache.

**Fix:** remove the copy-pasted `app: inventory-db` label from the cache pod template
(see `fix.yaml`; the Deployment's own selector uses `role: cache`, so the template-label
change rolls out cleanly). Alternatives that also work: tighten the Service selector to
`role: database`.

**Lesson:** an agent's (or your own) diagnosis is a *hypothesis*. Before acting: ask
"what would I observe if this were true — and is that what I observe?" One `kubectl get
endpoints` beats a hundred lines of confident explanation. Selector/label collisions are
invisible in per-file review; the cluster is the only place they exist.

**Verify the fix:** ~10 consecutive `OK` lines in the client logs, and
`kubectl -n faultlab-04 get endpoints inventory-db` showing exactly one address.
