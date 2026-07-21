# Facilitator notes — module 06

First stretch module. From here on the room is self-paced: give the 3-minute framing, show the GO slide, and let people choose their path. Helpers keep roaming.


---

The concept: "serverless" was never literally about someone else's servers — it's about not paying for idle capacity and not managing replica counts. Knative Serving is the open-source engine behind most Kubernetes serverless offerings (Cloud Run implements its API): request-driven autoscaling, revisioned deploys, and the headline trick — scale to zero.

The magic moment this lab is built around: a Knative Service sits at ZERO pods. A curl arrives; the activator catches it, a pod cold-starts, answers the request, and after ~60–90 seconds of silence it's gone again. Two terminals — one watching pods, one curling — make the whole lifecycle visible: 0 → 1 → 0 around a 200 response.

Running this yourself demystifies the single most magic-looking cloud product there is. And it composes: module 09's capstone uses exactly this mechanism to wake an image resizer on demand.

Kourier is the ingress (lighter than Istio), on NodePort 31080; traffic routes by Host header — figuring out the ksvc's host is part of the lab (hint 2 if needed).


---

The task: enable knative-serving.yaml from the catalog (Serving + Kourier, NodePort 31080), deliver hello-ksvc.yaml the GitOps way — by now nobody should need telling where it goes — wait for READY True, then stage the moment:

- Terminal 1: kubectl -n demo get pods -w
- Terminal 2: curl -H "Host: " http://localhost:31080/

Watch the first request CREATE a pod (ask them to time the cold start), repeated requests hit it warm, and silence make it vanish.

After the terminal proof, point learners to the released **Knative** app button. It reaches the fixed port-31081 browser adapter through Stargate; the raw NodePort remains an in-guest terminal detail and is never publicly exposed.

Helper notes: the ksvc's URL/host is the usual stumble — kubectl get ksvc shows it (hint 2 covers it). Knative's webhook takes a minute to come up after enabling; ArgoCD retries until it's there — patience beats debugging for the first 90 seconds.

Explain-back: "what answered the FIRST request, given the pod didn't exist yet?" (The activator buffered it while signaling scale-up.)
