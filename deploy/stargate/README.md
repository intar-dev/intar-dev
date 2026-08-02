# Stargate deployment assets

Stargate implementation remains in the root Rust workspace under
`crates/stargate-core` and `crates/stargate-gateway`. This directory contains
only deployment assets:

- `cloudflared/` contains the administered Tunnel ingress examples;
- `systemd/` contains the service unit;
- `stargate.toml.example` documents the production configuration contract;
- `scripts/` contains the constrained host-side deployment entrypoints used by
  protected GitHub Actions.

Changes are drain-first. Before replacing the binary or Tunnel rules, stop new
terminal/application issuance and prove active routes are drained. The
workspace application base domain remains `intar.app`; the default bootstrap
TTL is 60 seconds and browser session TTL is 900 seconds.
