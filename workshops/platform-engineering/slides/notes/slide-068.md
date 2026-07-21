The verification trilogy — and the observability payoff for the whole day:

1. The watch: kubectl -n pipeline get pods -w in one terminal, upload a photo in the Gallery in the other. The uploader cold-starts to catch the file, then — a beat later — the resizer materializes to handle an event nobody visibly sent. Ask the room to count the actors between browser and that second pod.
2. The storage view: the Gallery (refresh) shows the thumbnail and its metadata; raw S3 shows originals/, thumbs/, and meta/.json in the images bucket — module 03 muscle memory with the aws CLI against :30900.
3. The flourish: enable the on-demand Victoria observability stack (VictoriaMetrics/Logs/Traces + Grafana + the OTel Collector — a catalog capability, not something running since minute one), then open the released **Grafana** app → Explore → VictoriaTraces and see portal → uploader → broker → resizer as ONE waterfall. Distributed tracing across an event-driven, scale-from-zero chain — inside one workspace. This is the "now observe what you built" moment: you turn observability on and immediately point it at the pipeline you just wired.

Hint 5 covers enabling the stack and the VictoriaTraces (Jaeger) navigation for anyone new to traces; hint 2 has the hop-by-hop event-debugging path (uploader logs → trigger status → broker filter logs) if no resizer appears.
