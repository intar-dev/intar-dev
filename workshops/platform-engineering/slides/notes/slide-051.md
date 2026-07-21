The concept: "serverless" was never literally about someone else's servers — it's about not paying for idle capacity and not managing replica counts. Knative Serving is the open-source engine behind most Kubernetes serverless offerings (Cloud Run implements its API): request-driven autoscaling, revisioned deploys, and the headline trick — scale to zero.

The magic moment this lab is built around: a Knative Service sits at ZERO pods. A curl arrives; the activator catches it, a pod cold-starts, answers the request, and after ~60–90 seconds of silence it's gone again. Two terminals — one watching pods, one curling — make the whole lifecycle visible: 0 → 1 → 0 around a 200 response.

Running this yourself demystifies the single most magic-looking cloud product there is. And it composes: module 09's capstone uses exactly this mechanism to wake an image resizer on demand.

Kourier is the ingress (lighter than Istio), on NodePort 31080; traffic routes by Host header — figuring out the ksvc's host is part of the lab (hint 2 if needed).
