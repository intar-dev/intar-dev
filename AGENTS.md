# Intar Agent Guidance

## Scope and delivery

- Check the working-copy status first and preserve unrelated changes. Isolate work when that helps protect existing edits.
- Work within the user's requested scope. Complete the requested work; report adjacent issues as follow-ups unless they block the requested result. Prefer targeted edits over broad rewrites when a focused change will do.
- Before non-trivial implementation work, create a branch and open a draft PR with a plan in its description, unless the user directs otherwise. Read-only investigation, planning, and review do not need a branch or PR.
- When creating or editing a PR with `gh`, use real newlines in Markdown bodies and verify the rendered title and description with `gh pr view`.
- Once implementation and required checks are complete, update the PR title and description to summarize the finished work and plan, then mark the draft ready. After pushing, monitor CI and resolve failures caused by the change until all checks are green.
- Intar runs in production with user data. Before changing external contracts, persisted data, or database migrations, inspect current callers and storage behavior.

## Coordination and review

- Match coordination to the task. Delegate bounded, independent work when it improves coverage or speed; keep one agent responsible for integration. Keep small tasks direct.
- For material design or risk changes, use an independent architecture review before implementation and when a material assumption changes. Ask the reviewer to challenge boundaries, contracts, data flow, security, concurrency, integration, and verification.
- After integration, consider a read-only adversarial review for material changes. Report only in-scope, actionable findings with a concrete failure path and evidence. Omit style preferences, speculation, duplicates, and already-covered behavior. Resolve actionable findings and stop when the relevant review lenses support `CLEAN`.
- Choose verification based on the change and match each claim to its evidence. A formatter, parser, test, build, runtime check, and live result prove different things; avoid unrelated repeated checks and report material limits.

## Workspace conventions

- Use the root Cargo workspace. Do not reintroduce nested per-project Cargo locks or toolchain pins.
- Use the default shared Cargo cache and the root workspace target directory. Do not create component-specific `CARGO_HOME` directories.
- JavaScript and TypeScript packages use the root Bun workspace and lockfile. Do not add nested lockfiles or cross-project relative imports. The documentation site in `docs/` is a standalone Bun project with its own lockfile.
- For JavaScript and TypeScript work, use Bun and `bunx`; do not use npm, Yarn, or pnpm for installs, scripts, or CI.
- Shared wire and guest contracts belong in `crates/intar-contracts`. Regenerate web outputs with `cuenv task generate-contracts`; never edit `apps/web/src/generated/` by hand.
- The kino protobuf source belongs to `crates/intar-kino-proto/proto/kino/v1/probes.proto`.
- `apps/web/AGENTS.md` contains website, Worker, and database migration guidance.
- Repository tasks live in `env.cue` and run with `cuenv task <name>`; `cuenv task` lists them. Workflow step tasks belong to the `intar-ci` project in `ci/env.cue` and run with `cuenv task -p ci --package ci <name>`. Every workflow except `scenario-publish.yml` is rendered from `ci/workflows/*.cue`, typed by the `ci/gha` library and pinned through `ci/gha/pins.cue`, with `cuenv sync codegen`. Edit the CUE, never the YAML; `cuenv task sync-check` fails when they drift. `scenario-publish.yml` is an external contract and stays hand-written. `ci/README.md` describes the workflows, the lanes, and pin bumps.
- `ci.yml` checks every pull request and every push to main; its `ci-ok` job is the one required check. The lanes are defined once in `ci/workflows/lanes.cue`. Once CI passes on main's tip, `deploy.yml` deploys the website and docs builds its `web` and `docs` lanes uploaded, and `release.yml` tags and publishes releases.
- Use Conventional Commits with one scope, for example `fix(web): ...`, `feat(intar-agent): ...`, or `chore(stargate): ...`. Use a lowercase subject after the colon, and mark breaking changes with `!`.

## Releasing

- Product releases come from the bot-maintained `release/next` pull request (see "Releasing" in README.md). Never bump a product version in `Cargo.toml` or `Cargo.lock`, edit a product `CHANGELOG.md`, or create a `<prefix>/v*` tag as part of other work. To release a version other than the one the release pull request proposes, change it in a pull request of its own.
- Nothing is published to crates.io or any other registry.
- A workspace crate that a product builds from, and a file it compiles in or packages, belongs in that product's paths in `tools/workflows/release/products.json`; `bun test tools/ci` checks it.

## Rust quality

- Local and CI Clippy checks MUST use `-D warnings` (`cuenv task clippy`). Do not add `#[allow(...)]`, `#![allow(...)]`, or Clippy-specific suppressions unless necessary and justified. Prefer removing dead code, exercising it, or narrowing visibility.
- The workspace lints forbid `unsafe` code and deny `unwrap()`, `dbg!`, and `todo!()`. Handle or propagate errors explicitly.
- Format Rust changes with `cuenv task fmt`. `cuenv task verify` runs the formatting, Clippy, and test gate. `cuenv task lanes.<name>` runs exactly what that CI lane runs, `cuenv task ci` runs every lane, and `cuenv task ci-changes` shows which lanes a change needs.
