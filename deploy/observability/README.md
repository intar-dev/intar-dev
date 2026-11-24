# Intar observability

The hosts and the website send their metrics, logs and traces to Grafana
Cloud. This directory holds everything that is not in a product's code: the
[Alloy](https://grafana.com/docs/alloy/latest/) collector configuration for a
host (`config.alloy`) and the scripts that install it, the four dashboards,
and the alert rules.

## Dashboards

Four linked dashboards in the **Intar operations** folder cover the main checks:

| Dashboard | Use it to check | Repository file |
| --- | --- | --- |
| [Operations](https://intar.grafana.net/d/intar-operations) | Host collection, active alerts, CPU, memory, disk, critical services and export queues | `dashboard.json` |
| [Security](https://intar.grafana.net/d/intar-security) | SSH rejections and accepted logins, source IPs, web audit and privilege activity | `security-dashboard.json` |
| [VM performance](https://intar.grafana.net/d/intar-vm-performance) | Learner wait, boot phase cost, archive work, VM failures and traces | `vm-performance-dashboard.json` |
| [App performance](https://intar.grafana.net/d/intar-app-performance) | Browser web vitals, Worker span rate and latency, errors and traces | `app-performance-dashboard.json` |

The dashboards refresh every minute. Operations starts with one hour; the other
views start with six hours. Navigation links keep the selected time range.
Operations and Security have a host filter. VM host, Builder and Gateway use
consistent colors. App performance links to the existing Frontend Observability
sessions for `intar-web`.

Counts cover the selected time range unless a panel names a rolling window.
Browser percentiles use received measurements. Boot percentiles use only records
with structured phase timings and combine samples across runs. The phase chart
shows means, which can be added; do not add percentiles. Completed boot samples
are not an active VM count. Worker rate charts count server spans, including
binding operations, and are not billable request counters. Trace tables show a
bounded search result, not every matching trace. No samples means no matching
record; it is not a measured zero. Failure panels use text patterns and need review.

Import each JSON file with Grafana's **New > Import dashboard** action. Select
**Intar operations**, retain the UID, and overwrite the existing dashboard when
updating it. No application release or host restart is needed. The dashboard
files use the datasource UIDs `grafanacloud-prom`, `grafanacloud-logs` and
`grafanacloud-traces`, and the exporter target labels use the jobs
`integrations/unix` and `integrations/self`. Use these names when writing
queries.

Notifications remain in Grafana only. The existing `empty` contact point has no
integrations. Dashboard changes do not change the six alert rules or their receiver.

## What is collected

Alloy 1.19.2 runs on these persistent hosts:

| Host identity | Services |
| --- | --- |
| `agent-01-fsz7cpce` | agent, jailerd |
| `builder-01-el81wm4u` | builder, BuildKit, legacy workshop builder, Actions runner |
| `stargate` | Stargate, cloudflared |

Host metrics, selected service journals, Linux auth/authpriv journals, kernel
logs, and systemd lifecycle events are live. Both Cloudflare destinations are
live: `intar-grafana-logs` and `intar-grafana-traces`. The Worker sends native
request, Durable Object and custom operation traces.
Both signals use `persist: false`: Grafana receives the data, and Cloudflare
does not store a second copy. Logs and traces retain a 100% sampling rate.
The audit events, browser telemetry and Rust exporters are deployed.

`enable-service-tracing.sh` configures the local OTLP endpoint for each
installed Rust service. It does not restart services; the setting applies from
their next start.

## Security and VM coverage

- Linux SSH failures and successes, invalid users, PAM events, sudo and su.
  Authentication facilities 4 and 10 cover events from session scopes. Service
  collection excludes these facilities to prevent duplicate ingestion. Sudo
  `COMMAND` arguments are removed before export.
- Web authentication requests, rejected API requests, rate limits, agent
  authentication and actual admitted session creation. OAuth error redirects are
  failures even when their HTTP status is 302. Records contain bounded route
  names, outcome, status, user ID where available, Cloudflare client IP, country,
  ASN and ray ID. Authentication request acceptance is not proof of a new login.
- Stargate public-key rejection reason and fingerprint, admitted SSH sessions,
  and browser terminal admission failures. Keys, terminal tokens and terminal
  contents are excluded from new events.
- Service availability/restarts, disk space, memory, CPU and I/O pressure,
  kernel OOM/I/O errors, and PID 1 unit exits. Agent logs report VM boot phases,
  readiness failures, cleanup and archive retries. Journals from learner VMs,
  serial output, recordings, and learner files are not collected.

Rejection counts identify suspicious activity; one rejection is not proof of an
attack. Inspect the source address, affected account, event reason and subsequent
accepted sessions. Upstream GitHub/SSO identity-provider audit logs are separate
and are not exported by this integration.

## Traces and performance

The Worker uses native `cloudflare:workers` spans for request dispatch, auth,
scenario allocation, boot capacity waits, desired-state publication, host
reconciliation/bridge messages, and image build scheduling. Cloudflare adds
binding I/O spans. Error messages, SQL arguments and request bodies are not
added by the custom span helper.

`intar-observability` adds JSON service logs and an optional OTLP trace exporter
for the agent, builder, jailerd, and Stargate. Spans cover VM creation, image
preparation, hypervisor launch, guest readiness, archives, builds/publication,
and SSH authentication/channel setup and terminal admission/session duration. The queue holds at most 2048 spans;
exports use batches of 256, a five-second schedule and a two-second HTTP timeout.
Initialization failure keeps service logs available. SDK span events are disabled
so that existing free-form log messages are not copied into traces. Keep the
service log filter at `info` to retain these spans.

Faro reports browser request traces, web vitals, error source locations and
existing VM boot performance marks. Boot stage spans include the run ID. Collection runs only on `https://intar.dev`.
The public collector ID is origin restricted and is not a Grafana API token.
The filter preserves Faro's internal sampling flag until the SDK removes it
before transport. It removes user metadata, URL queries/fragments, arbitrary
path values, request headers, console output, DOM click data and exception text.
It retains compiled JS chunk locations for diagnosis. CI uses `GITHUB_SHA` as
browser release identity. Source map upload is not configured.

Cloudflare currently does not propagate its native trace IDs outside Cloudflare.
Browser, Worker, and host traces are separate trace trees. Use run/VM/build IDs
in host logs and spans to connect the work across asynchronous boundaries.
End-to-end W3C propagation through the bridge protocol remains a separate change;
do not describe the current setup as one distributed trace from browser to VM.
Cloudflare infrastructure/custom metrics also need a separate platform integration.

## Alert rules

`alert-rules.json` contains six rules, evaluated every minute in the
`Intar operations` folder/group. Thresholds are: fewer than three reporting
hosts for two minutes; a stopped critical service for one minute; less than 10%
free disk or memory for five minutes; more than 20 rejection-related login
records in five minutes for one minute; and kernel/VM failure patterns.

All rules use the `empty` receiver with no integrations. They remain visible and
can enter Firing state in Grafana without an external notification. No-data and
query errors have separate visible states. The login rule counts log records,
which can include multiple records from one attempt. It is a triage signal.

## Host installation and credentials

Use the official Alloy 1.19.2 amd64 Debian package. `install-alloy.sh` checks its
SHA-256, refuses to replace an existing installation, installs the packaged unit,
and sets resource limits. Supply a private directory containing `config.alloy`
and `grafana-cloud-token`, plus the stable host ID. Use
`enable-service-tracing.sh HOST_ID` to configure installed application units for
their next start. Review existing drop-ins before applying it.

The raw token needs stack-restricted `logs:write`, `metrics:write`, and
`traces:write`. Keep `/etc/alloy/grafana-cloud-token` owned by `root:alloy`, mode
`0640`. The Alloy user needs the `adm` and `systemd-journal` groups. The OTLP base
is `https://otlp-gateway-prod-eu-west-2.grafana.net/otlp`; Basic authentication uses
username `1827603` and the raw token as the password. An OTLP header variable is
`Authorization=Basic <base64 of 1827603:raw-token>`. Do not include braces or the
literal text `base64(...)`.

Alloy reads the credential with secret `local.file`. The top-level basic auth
fields work around Alloy 1.19.2's client-auth-only runtime failure. No credential
is included in repository configuration. Cloudflare stores its own headers in
the two account-level destinations. The Worker does not need a token binding.

Alloy HTTP management listens on `127.0.0.1:12345`; application OTLP/HTTP listens
on `127.0.0.1:4318`. Each signal has a persistent 16 MiB queue; storage metadata
adds overhead. Queues reject new data when full. Retries stop after 15 minutes.
The file queue requires `--stability.level=public-preview`. Resource limits are
MemoryHigh 384 MiB, MemoryMax 512 MiB and CPUQuota 50%.

## References

- [Alloy journal collection](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.journal/)
- [Cloudflare native custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
- [Cloudflare trace limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/)
- [OpenTelemetry Rust exporter](https://docs.rs/opentelemetry-otlp/0.32.0/opentelemetry_otlp/)
- [Faro setup](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/instrument/faro/)

Dashboard references: [LogQL metric queries](https://grafana.com/docs/loki/latest/query/metric_queries/), [TraceQL metric functions](https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/functions/), and [Web Vitals thresholds](https://web.dev/articles/vitals).
