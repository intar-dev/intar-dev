# Live E2E Proof

This check is the deployed proof required by the refactor plan. It exercises the
Worker, D1 catalog, R2 image registry, host desired-state cache, agent, Stargate,
guest terminal path, network isolation, teardown, and R2 run artifacts.

## Prerequisites

- The website Worker is deployed with the current build.
- At least one Linux/KVM agent host is registered, connected, enabled for
  scenarios, and reporting KVM, vsock, nftables, and reflink support.
- The scenario image has been built locally or by CI and the builder manifest is
  available as `*.qcow2.manifest.json`.
- You have an authenticated admin browser cookie for the deployed website.
- You have the registry publish token.

## Build A Scenario Image

For a local no-upload build that the live harness will publish:

```sh
just build-images broken-nginx builder.sample.amd64.hcl true
```

The build writes a qcow2 and manifest under `dist/`, for example:

```text
dist/broken-nginx-webserver-amd64.qcow2
dist/broken-nginx-webserver-amd64.qcow2.manifest.json
```

## Run The Proof

Use environment variables so shell history does not capture the cookie or token.

```sh
export INTAR_LIVE_BASE_URL="https://intar.dev"
export INTAR_LIVE_COOKIE="better-auth.session_token=..."
export INTAR_IMAGE_PUBLISH_TOKEN="..."
export INTAR_LIVE_MANIFESTS="$PWD/dist/broken-nginx-webserver-amd64.qcow2.manifest.json"

just live-e2e
```

For a pinned host:

```sh
export INTAR_LIVE_HOST_ID="host-id-from-dashboard"
just live-e2e
```

For cross-run isolation, provide a second enabled scenario. The harness starts it
on the same host, collects its guest IPs from the admin host API, and verifies the
primary run cannot connect to those guest SSH ports. It also checks the reverse
direction.

```sh
export INTAR_LIVE_CROSS_RUN_SCENARIO_ID="other-enabled-scenario"
just live-e2e
```

To add extra forbidden guest-side TCP targets that must not be reachable:

```sh
export INTAR_LIVE_FORBIDDEN_IPS="10.77.99.10,10.77.99.11"
just live-e2e
```

## What It Proves

The harness fails unless all of these are true:

- `/registry/v1/publish` accepts the manifest and uploads images into R2.
- The host reports the published image as cache `ready`.
- The host reports KVM, vsock, nftables, and reflink support.
- A run starts and reaches terminal-ready inside the warm-start budget.
- Each VM has a reported SSH host key and gets a browser Stargate route.
- Guest terminal probes cannot reach link-local metadata or the host gateway.
- Optional cross-run guest IPs are unreachable over TCP port 22.
- Teardown reaches `completed`.
- At least one archived artifact is readable from the Worker/R2 artifact route.

The default warm-start budget is `10000` milliseconds. Override only when
diagnosing:

```sh
just live-e2e "--warm-start-ms 15000"
```
