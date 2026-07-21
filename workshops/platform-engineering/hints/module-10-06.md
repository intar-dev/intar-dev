# Hint 2: Treat the restart count as evidence

What does the restart **count** tell you that the `CrashLoopBackOff` reason does not?
Watch it for long enough to distinguish a one-off restart from a process that repeatedly
crosses the same failure boundary:

```bash
kubectl -n demo get pods -l app=demo-web -w
```
