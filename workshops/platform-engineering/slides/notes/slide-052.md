The task: enable knative-serving.yaml from the catalog (Serving + Kourier, NodePort 31080), deliver hello-ksvc.yaml the GitOps way — by now nobody should need telling where it goes — wait for READY True, then stage the moment:

- Terminal 1: kubectl -n demo get pods -w
- Terminal 2: curl -H "Host: " http://localhost:31080/

Watch the first request CREATE a pod (ask them to time the cold start), repeated requests hit it warm, and silence make it vanish.

After the terminal proof, point learners to the released **Knative** app button. It reaches the fixed port-31081 browser adapter through Stargate; the raw NodePort remains an in-guest terminal detail and is never publicly exposed.

Helper notes: the ksvc's URL/host is the usual stumble — kubectl get ksvc shows it (hint 2 covers it). Knative's webhook takes a minute to come up after enabling; ArgoCD retries until it's there — patience beats debugging for the first 90 seconds.

Explain-back: "what answered the FIRST request, given the pod didn't exist yet?" (The activator buffered it while signaling scale-up.)
