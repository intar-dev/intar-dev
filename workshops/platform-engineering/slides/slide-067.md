# Two ways to coordinate services

    Choreography · this module
    Services react to *events*. The uploader emits a fact; the Broker routes it. No central brain — add a consumer, nobody rewires.
**= Knative Eventing**  (≈ EventBridge)

    Orchestration · module 07
    One controller drives a *defined sequence* — step 1→2→3, retries, a visual DAG. You already ran it: your CI build.
**= Argo Workflows**  (≈ Step Functions)

Two shapes of multi-service coordination — and your platform ships **both**.
