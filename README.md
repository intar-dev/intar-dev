# Intar

Intar is a platform for learning systems operation. A course is a list of
lectures, and a lecture can link to a scenario: real virtual machines with
something broken in them, which the learner repairs over a terminal. The
lecture explains the model; the scenario shows whether the learner can apply
it, because checks inside the machines decide when the repair is done.

It runs in production at [intar.dev](https://intar.dev), and this repository
is the whole platform.

## How it works

Intar runs in five places.

- **Cloudflare** hosts the website, which is also the control plane. It holds
  accounts, the course catalog and the image registry, and for every host a
  document of the runs that host should have.
- **A scenario host** runs the machines. An unprivileged agent keeps a
  WebSocket to the control plane and works toward that document. A small root
  daemon is the only thing that may start a machine, and starts each one as a
  VM in its own jail with a hard CPU limit. The agent cannot start one itself,
  so a compromised agent gets no further than the daemon's typed requests.
- **Inside each machine**, a program called Kino runs the scenario's checks,
  records the learner's SSH sessions for the replay, and is the `intar`
  command the learner types.
- **A gateway**, Stargate, is the way in to a running machine: SSH, the
  browser terminal, and web apps a scenario exposes.
- **The learner's own Mac** can take the place of the host. The desktop app
  downloads the same machine images and runs them locally.

The control plane never calls a scenario host. Hosts connect out, and a host that
reconnects asks for its document again and carries on from its own state.

Machine images are built from scenario repositories, normally in that
repository's own pipeline, and pulled by digest. [`content`](content/README.md)
is the scenario repository this repository ships.

## Building and testing

You need [rustup](https://rustup.rs), [Bun](https://bun.sh),
[cuenv](https://github.com/cuenv/cuenv) and
[cargo-nextest](https://nexte.st). The repository pins the versions: the
toolchain in `rust-toolchain.toml`, Bun in `package.json`, cuenv in
`cue.mod/module.cue`.

```sh
cuenv task install-js
cuenv task check
cuenv task test
```

Every task is in `env.cue`, and `cuenv task` lists them. `cuenv task verify`
is the Rust gate, and `cuenv task lanes.<name>` runs the steps of one CI lane.

## Where to read next

- To run the website locally: [`apps/web/README.md`](apps/web/README.md).
- To run the desktop app: [`apps/jumper/README.md`](apps/jumper/README.md).
- Before changing anything: [`AGENTS.md`](AGENTS.md). It has the rules on
  generated files, pull request titles, versions and Rust lints, for people
  and coding agents alike.
- How CI, deploys and the merge queue work: [`ci/README.md`](ci/README.md).
- How a change becomes a release and reaches a host:
  [`RELEASING.md`](RELEASING.md).
- Running a host: [`deploy/personal-metal`](deploy/personal-metal/README.md)
  for your own server, [`deploy/stargate`](deploy/stargate/README.md) for the
  gateway, [`deploy/observability`](deploy/observability/README.md) for
  dashboards and alerts.

The host programs each have a README beside their code under `crates/`.

## License

[MIT](LICENSE). Two files of the desktop app are Apache-2.0; see
[`apps/jumper/LICENSE-APACHE`](apps/jumper/LICENSE-APACHE).
