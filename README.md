# intar-dev

Monorepo for the intar platform:

- `crates/` contains the Rust workspace for the agent, kino, stargate, and shared contracts.
- `website/` contains the Cloudflare-hosted web/control plane.

Common commands:

```sh
just generate-contracts
just verify
bun --cwd website test
```

`scenarios/` is intentionally reserved for the scenario content subtree.

Scenario-host operators should follow the breaking
[Cloud Hypervisor jailer rollout](docs/scenario-host-jailer.md), including the
exact fractional-CPU contract and separate unprivileged doctor/root self-test
readiness gates.
