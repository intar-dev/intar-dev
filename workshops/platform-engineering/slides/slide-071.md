# The escalation ladder: signal → hint → optional agent

```mermaid
flowchart LR
  signal["Signal
Console flags it unhealthy"] --> hint["Hint
cause → action, one click deeper"]
  hint --> agent["Optional agent
Compare a read-only hypothesis"]
```

- Most incidents die at step 1 or 2 — that's the design working
- Escalate only when the hint isn't enough
- Step 3 needs your own provider; it is never required
