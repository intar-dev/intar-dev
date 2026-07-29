The task: enable knative-eventing.yaml (the Broker/Trigger machinery in ns knative-eventing) and picture-pipeline.yaml (ns pipeline: Broker, uploader + resizer as cluster-local ksvcs, the Trigger, and a Job creating the images bucket) — both can go in one push; Eventing's webhook takes a minute and the pipeline app retries until it's up, same dance as module 06.

Readiness check before the moment: kubectl -n pipeline get broker,trigger,ksvc all Ready — and note the pod count: with no traffic, both ksvcs sit at zero.

Then stage the two terminals, upload at localhost:30600/gallery, and work through the three proofs from the previous slide. verify.sh seals it.

Anyone finishing this has run the full arc: platform built by git commits, storage and databases self-hosted, a self-service API, a portal, and an event-driven serverless pipeline traced end to end. Send them to the closing section victorious — and remind the room the last 30 minutes are protected tinkering time.
