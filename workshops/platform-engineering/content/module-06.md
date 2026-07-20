# Module 06 (stretch) — Serverless: scale from zero, on your hardware

## The goal

At the end of this module a Knative Service runs on your platform with **zero pods** —
until you `curl` it, at which point a pod cold-starts, answers, and a minute later is
gone again. You prove it by watching the pod count go 0 → 1 → 0 around a 200 response.

## Why this matters

"Serverless" was never about someone else's servers — it's about *not paying for idle*
and *not managing replicas*. Knative Serving is the open-source engine behind most
Kubernetes serverless offerings (including Cloud Run's API): request-driven autoscaling,
revisioned deploys, scale-to-zero. Running it yourself demystifies the single most
magic-looking cloud product there is.

## The task

1. Enable `knative-serving.yaml` from the catalog (installs Knative Serving + the Kourier
   ingress, reachable on NodePort **31080**).
2. Deploy [`hello-ksvc.yaml`](hello-ksvc.yaml) from this lab dir the GitOps way (you know
   where it goes by now). Wait until the ksvc reports `READY True` and note its URL.
3. **The moment.** Arrange two terminals:
   - one watching pods: `kubectl -n demo get pods -w`
   - one to curl through Kourier. Traffic is routed by the `Host` header — figure out
     what host your ksvc got (hint 2), then:
     `curl -H "Host: " http://localhost:31080/`

   Watch the first request *create* a pod (cold start — how long did it take?), repeat
   requests hit it warm, and ~60–90s of silence make it disappear. Once the service is
   warm, open the released **Knative** app button in the workshop room to see the same
   response through Intar's fixed browser adapter.
4. Run `./verify.sh`.

## Hints

## Check your work

```bash
./verify.sh
```

It checks: the knative-serving app is Healthy (Synced is the happy path; sync is advisory) and its deployments are up; ksvc
`hello` is Ready; a curl through Kourier (:31080, correct Host header) returns 200 with
the expected body; and — after a quiet period — that the revision has scaled to zero pods
(this check waits up to ~2 minutes, be patient).

## Explain-back

Tell your neighbor: between your `curl` hitting :31080 and a `Hello ...!` coming back
from a pod that didn't exist — what had to happen, in order? (Ingress → ? → pod; who
buffered your request while the pod started?)

## Going deeper

- Deploy a change (edit `TARGET` via git). Knative keeps both revisions — find them
  (`kubectl -n demo get revisions`) and split traffic 50/50 between them in the ksvc spec.
- Load it: `for i in $(seq 1 200); do curl -s -H "Host: $HOST" http://localhost:31080/ & done; wait`
  — watch the autoscaler add pods. What controls the max?
- Set `autoscaling.knative.dev/min-scale: "1"` and explain when you'd pay that cost on
  purpose (hint: what did your first curl's latency look like?).

`localhost` in the commands above is guest-local terminal traffic. Browser traffic uses
the declared **Knative** app; learners never open arbitrary workspace ports.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/06-serverless/verify.sh`. Layered hints and the solution are released separately by Intar.
