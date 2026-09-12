# Intar observability

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
files use the existing Prometheus, Loki and Tempo datasource UIDs.

Notifications remain in Grafana only. The existing `empty` contact point has no
integrations. Dashboard changes do not change the six alert rules or their receiver.

## Collection and release state

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

The 2026-09-12 release uses web commit `41a0ecff`, agent `v0.12.18` (including
jailerd), builder `v0.10.3`, and Stargate `v0.2.12`. The five paused boot
optimization files were excluded. `enable-service-tracing.sh` configures the
local OTLP endpoint for each installed Rust service. The script does not restart
services. Follow the release and drain procedures before replacing host binaries.

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

Faro 2.11 reports browser request traces, web vitals, error source locations and
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

## Validation

The four dashboards were saved and checked in Grafana on 2026-09-12. Live checks
covered host metrics, the host filter, authentication counts and source ranking,
boot phase values, browser measurements, and TraceQL rates and percentiles.
The VM trace link opened its span tree. Empty failure and exception panels had
no matching records. The dashboard JSON also passed layout, datasource, panel ID
and query reference checks. These checks did not require a service restart.

On 2026-09-12, all three host targets and all three systemd collectors reported
success in Grafana. Live Worker logs and traces were visible in Loki and Tempo.
A collector restart on each host preserved application process IDs, restored
readiness and left all export queues empty.

Release CI passed 589 web unit tests, 298 Worker tests, the Chromium smoke test,
and 819 Rust workspace tests. Cloudflare type generation, Astro checking/build,
UI bundle budgets, Clippy, dependency audits and Alloy validation also passed.
The local Rust HTTP receiver probe verified `/v1/traces`, service/host identity,
final-batch flush inside Tokio, and exclusion of log text from traces.

The agent package passed the eight-VM privileged isolation self-test and agent
doctor. Builder doctor passed. The protected Stargate deployment verified its
backup, drained routes, service readiness and public routing. Its temporary
operator window was closed after deployment. The production run gate is open.

Two fresh Broken Nginx runs reached working browser terminals. Run
`falsxih191w9wz6pric5ju58` completed its first command round trip in 8.089
seconds. Run `cb4ofjdtnd5o12sticy86k92` completed it in 9.202 seconds. These
are release checks, not a speed comparison. Grafana stored browser boot spans,
Worker custom spans, jailerd image preparation spans and the web security
rejection event. Stargate exported terminal admission and session spans.

Agent `v0.12.18` initializes its TLS provider before trace exporter setup.
The regression test starts the real agent binary and passed in CI and the release
package. Grafana stored the second run's agent trace
`0ff639d2ab3acff36d756583afe40d3a`: `vm_create` took 4.20 seconds, with
`vm.launch` and `vm.wait_ready` child spans. Its `vm.archive` trace took 6.24
seconds. The same run ID selected its browser boot spans and the Worker POST
trace, which took 2.01 seconds.

Both runs were ended and their artifacts were uploaded. No VM, populated VM
cgroup, or active Stargate route remained. The builder exporter is enabled,
but no new image build was started for these checks.

Release evidence:

- [Website deployment and live health](https://github.com/intar-dev/intar-dev/actions/runs/34699085769)
- [Agent package and privileged release checks](https://github.com/intar-dev/intar-dev/actions/runs/34700383010)
- [Builder package](https://github.com/intar-dev/intar-dev/actions/runs/34699098725)
- [Stargate package](https://github.com/intar-dev/intar-dev/actions/runs/34699294698)
- [Stargate deployment](https://github.com/intar-dev/intar-dev/actions/runs/34699563802)
- [Run gate reopened](https://github.com/intar-dev/intar-dev/actions/runs/34701050390)

Actual datasource UIDs are `grafanacloud-prom`, `grafanacloud-logs`, and
`grafanacloud-traces`. Exporter target labels use jobs `integrations/unix` and
`integrations/self`. Use these names when writing queries.

## References

- [Alloy journal collection](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.journal/)
- [Cloudflare native custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
- [Cloudflare trace limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/)
- [OpenTelemetry Rust exporter](https://docs.rs/opentelemetry-otlp/0.32.0/opentelemetry_otlp/)
- [Faro setup](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/instrument/faro/)

Dashboard references: [LogQL metric queries](https://grafana.com/docs/loki/latest/query/metric_queries/), [TraceQL metric functions](https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/functions/), and [Web Vitals thresholds](https://web.dev/articles/vitals).
