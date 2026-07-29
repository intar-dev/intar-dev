The stretch tier, framed as "the cloud doesn't stop at databases":

- Serverless: scale-to-zero request-driven containers. Knative is the open engine underneath a lot of what you'd recognize — it's literally what Google Cloud Run is built on.
- Messaging: durable queues and streams — what makes async reliable. NATS JetStream is the lightweight open answer (≈ SQS/SNS/EventBridge/Pub-Sub): it's the durable counterpart to module 09's in-memory broker, and the queue the golden-path Application XR requests with `spec.queue`.
- CI + registry: the build-and-ship half of a cloud. You'll build a container INSIDE your cluster with Argo Workflows + BuildKit and push it to your own Zot registry — no Docker Hub, no cloud build minutes.
- Console: even the web console is just software reading an API. The Cloudbox Console is ~6k lines of Go over the Kubernetes API — and you'll read its source in module 08 (the Workshop page you've been watching all day is ~100 of them).

Say the tiering honestly: "Core is 00–05 and it's a complete cloud on its own. Everything on this second table is for the fast 20% and for your couch tonight — it's all public and nothing later depends on it."
