# Source and image contract

This workshop is a native Intar port of
https://github.com/randax/Platform-Engineering-Workshop pinned at
`1b6fad43551a720b143d7a52799f81c4c89455cb`. The upstream work is Apache-2.0 licensed; the complete
license text is retained in `LICENSE` and is included in the deterministic
bundle.

The signed checkpoint bundle reconstructs a clean Debian 13 server. It installs
the learner-safe pinned repository at `/opt/platform-engineering-workshop`,
installs the pinned toolchain, and pulls container images from external
registries only by reviewed SHA-256 digest. No OCI layer, solution tree,
facilitator material, or presenter notes enter the reconstruction bundle. DNS,
TLS, and HTTPS registry checks are a mandatory checkpoint-00 gate. Stargate
reaches declared guest applications by SSH direct forwarding; no application
port is exposed directly on the Hetzner server.

The upstream custom Grafana image was not publicly pullable while this lock was
created. The direct-cloud adaptation therefore pins stock Grafana, uses its
built-in Prometheus and Jaeger datasources, and installs the signed VictoriaLogs
datasource plugin from its exact release archive after verifying the reviewed
SHA-256 digest. Plugin retrieval fails closed if the archive or digest changes.

The source importer intentionally converts Slidev HTML/Vue presentation syntax
to Intar's finite native Markdown layouts and separates every HTML speaker-note
comment into its corresponding presenter-notes file. The generated deck must
remain exactly 85 slides. CI regenerates the raw import from the pinned commit
and locks both trees plus their explicit Intar-adaptation delta; an intentional
source or adaptation change must update that reviewed lock.
