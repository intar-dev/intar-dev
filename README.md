# intar-dev

Monorepo for the intar platform:

- `crates/` contains the Rust workspace for the agent, kino, stargate, and shared contracts.
- `apps/web/` contains the Cloudflare-hosted web/control plane and its private
  auxiliary provider Workers.
- `packages/` contains the provider-neutral TypeScript contracts and testkit.
- `content/` contains authored Course, Scenario, and Workshop source locks.

Common commands:

```sh
bun install --frozen-lockfile
just check
just test
just build
just check-hydrated
just check-generated
```

`just clean-generated` removes only allowlisted repository output. It preserves
the root `node_modules/`, Bun cache, Cargo cache, and root `target/`.

`content/scenarios/` contains Scenario source. Scenario curriculum can be
authored independently in an optional
[`content/courses.hcl`](docs/authoring/course-catalogs.md) manifest.

Scenario-host operators should follow the
[Cloud Hypervisor jailer operations guide](docs/operations/scenario-host-jailer.md),
including the exact fractional-CPU contract and separate unprivileged
doctor/root self-test readiness gates.
