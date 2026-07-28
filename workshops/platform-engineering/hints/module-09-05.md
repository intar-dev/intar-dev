# Hint 5: Enabling observability, then finding the trace in Grafana

The Victoria observability stack is an on-demand capability — enable it from the catalog
first (all five Applications go in one push):

```bash
cp gitops/catalog/victoria-metrics.yaml gitops/catalog/victoria-logs.yaml \
   gitops/catalog/victoria-traces.yaml gitops/catalog/grafana.yaml \
   gitops/catalog/otel-collector.yaml gitops/apps/
git add . && git commit -m "module 09: enable observability" && git push
kubectl -n observability get pods   # victoria-metrics/-logs/-traces, grafana, otel-collector (agents + gateway)
```

Then open Grafana at **http://localhost:30030** (NodePort — no port-forward needed) →
Explore → data source **VictoriaTraces** (the Jaeger datasource) → Search. Upload a fresh
image (traces are easiest to find seconds after you make them), then look for the
uploader/resizer service names and open the newest trace: one waterfall, portal to
thumbnail, with the Broker hop in the middle.
