# Facilitator notes — module 09

The capstone. It earns the name because it uses everything built today at once: GitOps delivers it (02), RustFS stores it (03), Knative scales it from zero (06), the portal fronts it (08), and observability watches the whole chain. The one new concept is Knative Eventing.


---

The new concept is Knative Eventing: a Broker and Triggers — the open-source shape of the S3-events → SQS → Lambda pattern everyone knows from AWS.

Walk the flow left to right: the Gallery page posts the photo to the uploader (a Knative service that itself cold-starts to receive it). The uploader writes the original to the images bucket in RustFS, then emits a CloudEvent — type dev.cloudbox.image.uploaded — to the Broker. The Broker consults its Triggers; one filters on exactly that type and subscribes the resizer. The resizer — which is NOT RUNNING — wakes from zero, fetches the original, writes a thumbnail and a metadata JSON (dimensions, dominant color), and goes back to sleep.

The architectural point on the slide: the uploader doesn't know the resizer exists. It emits a fact; the Broker routes it to whoever subscribed. Adding a second consumer (a virus scanner, an ML tagger) would be one more Trigger — no uploader change. That decoupling is the whole point of event-driven architecture, and today it runs on a laptop, readable end to end.

Demystifier worth saying: a CloudEvent is just an HTTP POST with five ce-* headers — the lab has them read those headers in the resizer's logs.


---

A conceptual beat worth 60 seconds. The room just built choreography; name it, and name its opposite — because "how do I coordinate services?" has two canonical answers and a platform engineer should know when to reach for each.

Choreography (this capstone): event-driven, decoupled. Services emit and subscribe to facts; no component knows the topology. Resilient and extensible (add a Trigger, not a code change) — but the flow is emergent, harder to see end to end. Knative Eventing is the open-source shape of EventBridge / SQS→Lambda.

Orchestration: a central workflow drives an explicit sequence with retries, branching, and a visual execution graph. Easier to reason about and observe; more coupling to the orchestrator. AWS Step Functions is the reference — and the open analog is Argo Workflows, which you ALREADY ran in module 07: your in-cluster CI build is an Argo DAG. Same engine, same visual graph, no new tool.

The takeaway: you don't pick a winner — mature platforms offer both, and the skill is choosing. (We deliberately didn't build a dedicated orchestration module — it'd be a tangent in a platform-assembly workshop — but the engine and the concept are both already here.)


---

The verification trilogy — and the observability payoff for the whole day:

1. The watch: kubectl -n pipeline get pods -w in one terminal, upload a photo in the Gallery in the other. The uploader cold-starts to catch the file, then — a beat later — the resizer materializes to handle an event nobody visibly sent. Ask the room to count the actors between browser and that second pod.
2. The storage view: the Gallery (refresh) shows the thumbnail and its metadata; raw S3 shows originals/, thumbs/, and meta/.json in the images bucket — module 03 muscle memory with the aws CLI against :30900.
3. The flourish: enable the on-demand Victoria observability stack (VictoriaMetrics/Logs/Traces + Grafana + the OTel Collector — a catalog capability, not something running since minute one), then find the upload's trace in Grafana at http://localhost:30030 → Explore → VictoriaTraces and see portal → uploader → broker → resizer as ONE waterfall. Distributed tracing across an event-driven, scale-from-zero chain — on a laptop. This is the "now observe what you built" moment: you turn observability on and immediately point it at the pipeline you just wired.

Hint 5 covers enabling the stack and the VictoriaTraces (Jaeger) navigation for anyone new to traces; hint 2 has the hop-by-hop event-debugging path (uploader logs → trigger status → broker filter logs) if no resizer appears.


---

The task: enable knative-eventing.yaml (the Broker/Trigger machinery in ns knative-eventing) and picture-pipeline.yaml (ns pipeline: Broker, uploader + resizer as cluster-local ksvcs, the Trigger, and a Job creating the images bucket) — both can go in one push; Eventing's webhook takes a minute and the pipeline app retries until it's up, same dance as module 06.

Readiness check before the moment: kubectl -n pipeline get broker,trigger,ksvc all Ready — and note the pod count: with no traffic, both ksvcs sit at zero.

Then stage the two terminals, upload at localhost:30600/gallery, and work through the three proofs from the previous slide. verify.sh seals it.

Anyone finishing this has run the full arc: platform built by git commits, storage and databases self-hosted, a self-service API, a portal, and an event-driven serverless pipeline traced end to end. Send them to the closing section victorious — and remind the room the last 30 minutes are protected tinkering time.
