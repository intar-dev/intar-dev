# Layer 5 — messaging & observability

RoleWe runRejectedThe tradeoff

Durable messaging**nats** **NATS 2.12 + JetStream**Kafka · RabbitMQThe durable primitive in ~15 MB of Go vs. GBs of JVM/Erlang
Observability**victoriametrics** **grafana** **opentelemetry** **Victoria stack + OTel**kube-prometheus-stack · otel-lgtm · LGTMAssembled from parts — but ~1 GiB, not several, and it fits

**NATS JetStream** gives durable streams on a PVC for a rounding error of Kafka's RAM. The observability layer is the sharpest tradeoff: **OTel Collector** (agent DaemonSet + gateway) feeding **VictoriaMetrics** (PromQL), **VictoriaLogs** (Loki API) and **VictoriaTraces** (Jaeger API), fronted by **Grafana** with *built-in* datasources — no plugins to fetch, so it stays offline. VM's columnar TSDB + `vmrange` histograms hold the whole thing to **~1 GiB** where kube-prometheus-stack or a full Grafana LGTM would want several — and unlike single-pod otel-lgtm, there's a *real* collector, so more than three apps actually emit telemetry.
