# Hint 3: Scale-to-zero is taking forever / never happens

The ksvc sets `autoscaling.knative.dev/window: "30s"` so idle detection is quick, but
scale-to-zero also waits the global grace period (~30s) — total ≈ 1–1.5 min of *no
requests*. Watch the decision-maker directly:
`kubectl -n knative-serving logs deploy/autoscaler --tail=20`. And make sure no terminal
is still curling in a loop.
