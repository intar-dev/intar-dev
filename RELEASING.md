# Releasing and rolling out

How a change becomes a release, and how a release reaches a host. The
workflows behind it are described in [`ci/README.md`](ci/README.md).

## Releasing

The agent, builder, image CLI, kino, Stargate, and the desktop app
(`intar-desktop`, tagged `desktop/vX.Y.Z`; its crate and program are `jumper`)
are released as GitHub releases tagged `<prefix>/vX.Y.Z`. Nothing is
published to crates.io or any other registry. The desktop app's release is a
macOS bundle for Apple silicon, built on a Mac by
`tools/workflows/release/build-jumper-macos.sh`; every other product is a
Linux archive.

- **On every merge:** main moves only through the merge queue, and each push
  runs the Release workflow. git-cliff reads the Conventional Commits since each
  product's latest `<prefix>/v*` tag, scoped to the paths in
  `tools/workflows/release/products.json`. Main takes only squash merges
  named after the pull request title ("Merge settings" in `ci/README.md`), so
  each commit is a pull request title, which CI's `pr-title` job checks. A
  `feat` bumps the minor version, and a `fix`, `perf`, `refactor`, or `build`
  bumps the patch version. A breaking change bumps the minor version while a
  product is on 0.x. Other types, such as `chore`, `ci` or `docs`, release
  nothing. The root `Cargo.toml` and `Cargo.lock` belong to no product, so a
  `feat(deps)`, `fix(deps)`, or `build(deps)` commit that changes either of
  them, with or without other files, also counts for each product that ships
  what it changed (`tools/workflows/release/deps-commits.py`): a `Cargo.lock`
  package in the dependency closure of the product's crates, including the
  jailer and jailerd in the agent's archive, or a `[workspace.dependencies]`
  entry those crates use directly. Any other root `Cargo.toml` change, such as
  a profile or a patch, counts for every product.
- **Versions live in tags.** Nothing commits a version: the build sets the
  version it releases in its checkout's `Cargo.toml` and `Cargo.lock`. The
  product versions in the manifests on main stay at the last version a release
  pull request set, and say nothing about the current release. The release
  notes are the GitHub release's, written by git-cliff; the `CHANGELOG.md`
  files are the history from before.
- **Build, then tag.** The workflow opens a draft release for each new
  version, builds and smoke-tests it from the merged commit, and only then
  tags that commit, attests the payload, and publishes the release. CI already
  ran the checks in the merge queue, the rust lane's workspace gate and the
  app lane's for the desktop app, so the build runs them again only for a
  commit that never passed CI there. A failed build tags nothing: the next
  merge, a re-run, or a dispatch from main plans it again. A tag whose publish
  failed is rebuilt and published by the next run. A version below the
  product's latest tag is never tagged.
- **Dry run:** a pull request that changes the release build (`tools/workflows/release/`,
  `ci/workflows/release.cue` and the rest of the list in
  `tools/workflows/ci/release-plan.sh`) builds and smoke-tests the products
  the change reaches with the release build's own steps: one product for a
  script only its build runs, every product otherwise. The merge queue does
  not build them again.
- **After a release,** the workflow stores a new Kino release in the registry
  and deploys the website again. The deploy pins the newest published releases
  (`tools/deploy/release-pins.ts`): the scenario compiler, the release that
  installed desktop apps are offered, and the Kino pins, each only when the
  release is on main and its files carry the release workflow's attestation,
  and a Kino only once the registry stores its artifact.
- **Holding a release back:** mark it as a prerelease (`gh release edit
  <tag> --prerelease`) and deploy (`gh workflow run deploy.yml --ref main`);
  the website pins the release before it.

Never bump a product version, edit a product `CHANGELOG.md`, or create a
product tag as part of other work, and never push a tag by hand. A Rust
dependency update, such as a security fix in the root `Cargo.lock`, ships when
it is a `fix(deps)` pull request, as described above, even when it also
changes the code the update needs.

The kernel and QEMU workflows need a GitHub App to push their pin pull
requests, because pushes made with the workflow's own token do not run CI. To
set it up:

1. Create the `intar-release` GitHub App with contents and pull requests read
   and write, and install it only on this repository.
2. Create the `release-pr` environment and limit its deployment branches to
   `main`.
3. In that environment, add the app's client ID as the `RELEASE_APP_CLIENT_ID`
   variable and a private key as the `RELEASE_APP_PRIVATE_KEY` secret.

## Rolling out

The release workflow is the only place a tool is built: every product, Kino
included, is built by the same steps and ships only as its GitHub release.
Kino's release is the guest build that runs inside scenario VMs. No workflow
installs a tool on a host. Rollouts run from an operator's machine, by hand or
through an agent, and take the release straight from GitHub:

```bash
gh release download <prefix>/vX.Y.Z --repo intar-dev/intar-dev --dir release
```

In `release`, `sha256sum --check --ignore-missing <binary>_X.Y.Z_checksums.txt`
checks the downloads. `gh attestation verify <archive> --repo intar-dev/intar-dev`
checks that this repository's release workflow built them; releases published
before the workflow attested them have no attestation. Then:

- **Desktop app:** nothing to do. The website deploy that follows the release
  offers it to installed apps, which install it themselves. The
  download is `intar-desktop_X.Y.Z_macos_arm64.zip`; on a Mac, check it with
  `shasum -a 256 --check intar-desktop_X.Y.Z_checksums.txt`.
- **Agent on a personal host:** `sudo intar-host update`, or
  `--version X.Y.Z` for a specific release. It downloads the release from GitHub
  itself; see `deploy/personal-metal/README.md`.
- **Agent on a platform host:** the release's `deploy/install.sh` installs it,
  and refuses while the agent or any VM still runs.
  1. Unpack the checked archive as root into
     `/var/lib/intar/releases/agent-vX.Y.Z` (mode 0700), and check it with
     `sha256sum --check --strict deploy/SHA256SUMS` there. Unpack the running
     release the same way, as the rollback target.
  2. Dispatch image-ops `gate-drained`, and check that no
     `intar-vm-*.service` unit is left.
  3. `systemctl stop intar-agent`, then `sh deploy/install.sh` in the new
     release directory.
  4. `/usr/lib/intar/intar-jailerd-self-test`, then the agent doctor as
     `intar-agent` (the command `install.sh` prints), on the new binaries,
     then `systemctl start intar-agent`. Later boots re-run the self-test by
     themselves through `intar-jailerd-boot-check.service`, which `install.sh`
     enables; it disables the older hand-written `intar-platform-check`.
     If that boot check failed, jailerd runs but admits nothing: `systemctl
     stop intar-agent`, fix the cause, repeat this step, then `systemctl
     reset-failed intar-jailerd-boot-check`.
  5. Check that the installed binaries match the release and that the journal
     shows `bridge v9 handshake complete` with no warnings. Then dispatch
     image-ops `gate-open`, unless a later step of a larger rollout opens it.

  If a check fails, stop the agent and run `install.sh` from the rollback
  release's directory instead. A rollback release without
  `deploy/intar-jailerd-boot-check.service` also needs that unit disabled and
  removed from `/etc/systemd/system`, and, where the host has the hand-written
  `intar-platform-check`, that unit enabled and restarted in step 4's place. `install.sh` sets the Cloud Hypervisor path and
  hash in `/etc/intar-jailerd/config.toml` to its own release's; a rollback to
  a release that still pinned v53.0, whose installer leaves the config alone, also needs both
  lines set back by hand to that release's `deploy/config.example.toml`.

  `swamp workflow run agent-rollout --input version=X.Y.Z --input
  rollback_version=<running X.Y.Z>`, run from the repository root after
  `swamp extension install`, runs these steps; `--input gate_open=false`
  leaves the gate drained at the end. It stops for approval before
  the drain and again before a rollback; after each
  `swamp workflow approve agent-rollout <step>`,
  `swamp workflow resume agent-rollout` continues the run.
- **Builder:** on the builder host, write the config the new binary reads with
  `sudo python3 deploy/migrate-epoch-config.py builder --print > config.toml` from
  the unpacked archive (it drops the keys the release retired) and run the new
  binary's `sudo ./intar-builder doctor --config config.toml`. Wait
  until the host is idle: the latest `applied builder desired state` journal line
  shows `"desired_builds":0`, and nothing matches `pgrep -f '^/usr/bin/qemu'`.
  Then, while the service still runs, run
  `sudo python3 deploy/migrate-epoch-config.py builder` (it keeps the previous
  file as `/etc/intar-builder/config.toml.pre-epoch`, and the running binary
  reads the result too), `systemctl stop intar-builder`, keep the old binary as
  `/usr/local/bin/intar-builder.pre-vX.Y.Z`, `install -m 0755` the new one,
  start the service, and check the journal for the handshake and the desired
  state with no warnings. The binary has no `--version`; tell releases apart by
  their SHA-256. `swamp workflow run builder-rollout --input version=X.Y.Z`
  runs these steps and stops for approval before the install and again before
  a rollback; after each `swamp workflow approve builder-rollout <step>`,
  `swamp workflow resume builder-rollout` continues the run.
- **Stargate:** see "Rolling out" in `deploy/stargate/README.md`.
- **Kino:** hosts put the pinned Kino on each new VM's run disk, so a Kino
  release that keeps the guest contract needs no drain: running VMs keep
  theirs. The release workflow stores the release's Kino artifact in the
  registry and deploys the website, which pins it; without a stored artifact
  the pin stays on the one before. Should storing fail, re-run the failed job
  or dispatch `release.yml` from main.
- **Image CLI:** nothing to do; the website deploy that follows the release
  pins it.
