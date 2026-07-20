Further-reading pointers, one line each — the repo README links all of them so nobody needs to photograph this slide:

- talos.dev and cilium.io — go deeper on the OS and eBPF layers; Talos on real hardware (or a stack of NUCs) is the natural next step after Talos-in-Docker.
- argo-cd.readthedocs.io and gitea — the app-of-apps and sync-wave patterns used today are documented ArgoCD idioms, not workshop inventions.
- cloudnative-pg.io — backups, PITR, and replicas are where the operator really starts earning its keep; rustfs.com for where RustFS goes post-1.0 (and SeaweedFS as the alternative we'd reach for).
- crossplane.io (make sure it says v2!), knative.dev, zotregistry.dev, backstage.io for the honest big-portal path, and the VictoriaMetrics stack (victoriametrics.com — VictoriaMetrics/VictoriaLogs/VictoriaTraces) fronted by Grafana and fed by the OpenTelemetry Collector for the on-demand observability layer.

Also plug the ecosystem around this audience: CNCF meetups, GDG Bergen, and Plattformpodden (Norwegian-language platform-engineering podcast Hans co-hosts) for continuing the conversation.
