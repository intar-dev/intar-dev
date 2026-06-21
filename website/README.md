# intar website

The `website/` app is the learner UI and Cloudflare-based control plane for Intar.

## Architecture

Scenario control now follows a strict event-driven split:

- Write side: command handlers validate against projected state, append facts to `control_events`, and nudge durable workflow.
- Projection side: pure projectors rebuild read tables from the event log using explicit projector checkpoints.
- Workflow side: durable jobs own NetBird, launch, destroy, archive, and cleanup effects. Retries use `next_attempt_at`; workflow code does not sleep.
- Read side: APIs and UI reads come from projections only. Request paths no longer repair or mutate read models inline.

For scenario work, the source of truth is the event log. Read tables are disposable.

## Useful commands

Run from `website/`:

```bash
bun dev
bun run build
bunx wrangler d1 migrations apply DB --local --config wrangler.jsonc
```

## Worker configuration

The control plane expects these Worker secrets/vars:

- `AGENT_JWT_SECRET`
- `NETBIRD_API_TOKEN`
- `NETBIRD_API_BASE_URL` (default `https://api.netbird.io/api`)
- `NETBIRD_MGMT_URL` (optional, overrides the management URL used by the browser NetBird WASM client; default cloud UI is `https://app.netbird.io`)

`NETBIRD_API_TOKEN` must be issued for a NetBird service user with the `Admin` role so setup keys can be created through the API.
SSH command host targets in the dashboard are derived from the agent heartbeat (`primaryIpv4` first, then `primaryIpv6`).

## NetBird WASM assets

Browser SSH uses a pinned NetBird WASM artifact served from this app under `public/vendor/netbird`.
The WASM is stored as `netbird.wasm.gz` so it stays below the Workers 25 MiB per-asset limit.
