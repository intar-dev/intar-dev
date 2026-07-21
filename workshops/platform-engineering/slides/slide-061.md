# One console, every capability

  ![Builds page — BuildKit CPU/memory above the live Argo Workflows runs](../assets/console/builds-dark.png)
  ![Streams page — JetStream messages/bytes + connections](../assets/console/streams-dark.png)
  ![Buckets page — RustFS pod CPU/memory](../assets/console/buckets-dark.png)

Builds · Streams · Buckets — each with a live **Monitoring** panel off the same OTel stack. NATS gets a prometheus-nats-exporter sidecar; RustFS has no metrics endpoint, so it falls back to the generic per-namespace pod signal — honestly labelled.
