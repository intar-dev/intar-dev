# Intar

Intar teaches systems operation through courses. A course is a list of
lectures, and a lecture can link to a scenario: real virtual machines with
something broken in them. The learner repairs them over a terminal, and checks
that run inside the machines decide when the repair is done. It runs at
[intar.dev](https://intar.dev).

This repository holds the whole platform: the website and control plane, the
programs that run on the hosts and inside the machines, the desktop app, and
the workflows that check, release and deploy them.

## The parts

| Part | Runs on | What it does | Code |
| --- | --- | --- | --- |
| Website and control plane | Cloudflare Workers, with D1, R2 and Durable Objects | The learner UI, accounts and organizations, the course catalog, the image registry, and the desired state of every host | [`apps/web`](apps/web) |
| Agent | A scenario host, unprivileged | Holds a WebSocket to the control plane, pulls the images a run needs, and asks jailerd for the machines its desired state names | [`crates/intar-agent`](crates/intar-agent) |
| jailerd and jailer | A scenario host, as root | The only root part of a host. Creates each run's network and starts each machine as a Cloud Hypervisor VM in its own jail, under a hard CPU limit | [`crates/intar-jailerd`](crates/intar-jailerd), `crates/intar-jailer`, `crates/intar-jailer-protocol` |
| Kino | Inside every machine | Runs the scenario's checks, records the learner's SSH sessions, and is the `intar` command the learner types | [`crates/kino`](crates/kino), `crates/intar-kino-proto` |
| Stargate | The gateway host, `intar.app` | The way into a running machine: SSH, the browser terminal, and the web apps a scenario exposes | `crates/stargate-gateway`, `crates/stargate-core`, [`deploy/stargate`](deploy/stargate) |
| Image CLI | A scenario repository's pipeline, or an author's computer | Validates a scenario repository, builds its machine images and pushes them to the registry | `crates/intar-image-cli`, with `intar-image-scenario`, `intar-image-build` and `intar-image-upload` |
| Builder | A builder host | Builds the images of a scenario source whose repository does not build its own | [`crates/intar-builder`](crates/intar-builder) |
| Desktop app | The learner's Mac (Apple silicon) | Runs a lab's machines on the learner's own computer, under QEMU, instead of on a host | [`apps/jumper`](apps/jumper), with `crates/zpm`, `crates/subspace` and `crates/dhd` |

A run on a host goes like this:

1. The learner starts a lecture's scenario on the website. The control plane
   reserves CPU on a host and writes the run into that host's desired state.
2. The host's agent receives the new desired state over its WebSocket, pulls
   the machine images from the registry, and asks jailerd to start the
   machines.
3. The learner reaches the machines through Stargate, from the browser
   terminal or with their own SSH client.
4. Kino evaluates the scenario's checks in each machine. A lecture is
   complete once a run of its scenario finishes with every check passed.
5. When the run ends, the agent deletes the machines and uploads the recorded
   sessions, which the website replays.

A run in the desktop app skips the host: the app downloads the same images and
starts them with its own QEMU.

## Layout

| Path | Contents |
| --- | --- |
| `apps/web` | The website and control plane. [README](apps/web/README.md) |
| `apps/jumper` | The desktop app. [README](apps/jumper/README.md) |
| `crates` | The Rust workspace: the products above and the crates they share |
| `crates/intar-contracts` | Every wire and guest contract. The website's TypeScript types are generated from it |
| `content` | The scenario repository this repository ships. [README](content/README.md) |
| `docs` | The documentation site, [docs.intar.dev](https://docs.intar.dev). A placeholder so far |
| `deploy` | What a host needs beside the binaries: [personal hosts](deploy/personal-metal/README.md), [Stargate](deploy/stargate/README.md), [observability](deploy/observability/README.md) |
| `ci` | The GitHub Actions workflows, written in CUE. [README](ci/README.md) |
| `tools` | The scripts the tasks and workflows run, and their tests |
| `patches` | Patches Bun applies to two dependencies. [README](patches/README.md) |
| `workflows`, `extensions`, `models`, `vaults` | The [swamp](https://github.com/swamp-club/swamp) workflows that roll a release out to a host |
| `env.cue` | Every repository task |

Crates not named in the table above:

| Crate | Purpose |
| --- | --- |
| `intar-contracts-typegen` | Writes `apps/web/src/generated/` from `intar-contracts` |
| `cloud-hypervisor-client` | Client of the Cloud Hypervisor API, used by the agent and jailerd |
| `intar-observability` | Service logs for journald and the optional trace exporter, shared by the host programs |

## Setting up

You need:

- [rustup](https://rustup.rs). `rust-toolchain.toml` pins the toolchain, and
  cargo installs it by itself.
- [Bun](https://bun.sh), the version in `packageManager` in `package.json`.
- Node.js, the version in `apps/web/.node-version`.
- [cuenv](https://github.com/cuenv/cuenv), the version in `cue.mod/module.cue`.
- [cargo-nextest](https://nexte.st), for `verify` and the lanes.

Some tasks need more: `build-kino-guest` needs
[cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild), the `security`
lane needs `cargo-audit` and `shellcheck`, and a few checks need `python3`.

```sh
cuenv task install-js   # bun install, from the lockfile
cuenv task check        # cargo check, and the JavaScript checks
cuenv task test         # cargo test, and the website's tests
```

## Working in the repository

`cuenv task` lists every task. The ones used most:

| Task | What it runs |
| --- | --- |
| `fmt` | `cargo fmt` |
| `clippy` | Clippy for the workspace, with `-D warnings` |
| `verify` | The Rust gate: formatting, Clippy, and the tests |
| `lanes.<name>` | Exactly what the CI lane `<name>` runs: `rust`, `security`, `images`, `web`, `kino`, `app` or `docs` |
| `ci-changes` | Which lanes your branch needs |
| `ci` | Every lane |
| `generate-contracts` | Regenerates `apps/web/src/generated/` after a change to `intar-contracts` |
| `validate-images` | Validates `content` as a scenario repository |
| `sync-check` | Fails when `.github/workflows` differs from what `ci/workflows/*.cue` renders |
| `clean-generated` | Removes build output. It keeps `node_modules/`, the Bun and Cargo caches, and `target/` |

To run the website, see [`apps/web/README.md`](apps/web/README.md). To run the
desktop app, see [`apps/jumper/README.md`](apps/jumper/README.md).

Things that are easy to get wrong:

- **Generated files.** `apps/web/src/generated/` comes from
  `cuenv task generate-contracts`, `.github/workflows/*.yml` from
  `cuenv sync codegen`, and `apps/web/migrations/` from
  `bun run --cwd apps/web db:generate`. Edit the source, never the output.
- **Pull request titles.** Main takes only squash merges named after the pull
  request title, and the releases are versioned from those titles. A title is
  a Conventional Commit with one scope, such as `fix(web): keep the session on
  reload`. CI's `pr-title` job checks it.
- **Versions and changelogs.** A product's version, `CHANGELOG.md` and tags
  belong to the release pull request. Don't change them in other work.

[`AGENTS.md`](AGENTS.md) has the rest of the conventions. It is written for
coding agents and holds for people too.

## Releasing

Every push to main rebuilds the `release/next` pull request, which bumps each
product that changed and writes its changelog. Merging it tags and publishes
the releases on GitHub. Nothing is installed on a host by a workflow: an
operator rolls a release out. [`RELEASING.md`](RELEASING.md) describes both.

## License

[MIT](LICENSE). Two files of the desktop app are Apache-2.0; see
[`apps/jumper/LICENSE-APACHE`](apps/jumper/LICENSE-APACHE).
