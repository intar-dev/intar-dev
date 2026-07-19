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
Scenario curriculum can be authored independently in an optional root
[`courses.hcl`](docs/course-catalogs.md) manifest.

Scenario-host operators should follow the
[Cloud Hypervisor jailer operations guide](docs/scenario-host-jailer.md),
including the exact fractional-CPU contract and separate unprivileged
doctor/root self-test readiness gates.
