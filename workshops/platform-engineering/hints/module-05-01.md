# Hint 1: A triage order that almost always works

1. `kubectl -n  get all` — what's *not* green?
2. Pod not Running/Ready → `kubectl describe pod` and read the **Events** bottom-up,
   then `kubectl logs` (add `--previous` after crashes).
3. Pod `Pending` → it's a scheduling/resources/volumes problem, not a code problem.
   Describe it; then follow whatever it references (PVC? node? quota?).
4. Everything green but connections fail → stop staring at pods. Check `endpoints`,
   then DNS, then network policies. Timeout ≠ refused: timeouts smell of policy/firewall,
   refusals smell of "nothing listening there".
