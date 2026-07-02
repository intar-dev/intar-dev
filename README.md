# intar-dev

Monorepo for the intar platform:

- `crates/` contains the Rust workspace for the agent, kino, stargate, and shared contracts.
- `website/` contains the Cloudflare-hosted web/control plane.
- `stardrive/` contains the mothballed Go cluster tooling that remains testable.

Common commands:

```sh
just generate-contracts
just verify
bun --cwd website test
go test ./...
```

`scenarios/` is intentionally reserved for the scenario content subtree.
