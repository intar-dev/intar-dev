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
- Shared wire and guest contracts belong in `crates/intar-contracts`. Regenerate web outputs with `just generate-contracts`; never edit `apps/web/src/generated/` by hand.
- The kino protobuf source belongs to `crates/intar-kino-proto/proto/kino/v1/probes.proto`.
- `apps/web/AGENTS.md` contains website, Worker, and database migration guidance.
- Use Conventional Commits with one scope, for example `fix(web): ...`, `feat(intar-agent): ...`, or `chore(stargate): ...`. Use a lowercase subject after the colon, and mark breaking changes with `!`.

## Rust quality

- Local and CI Clippy checks MUST use `-D warnings` (`just clippy`). Do not add `#[allow(...)]`, `#![allow(...)]`, or Clippy-specific suppressions unless necessary and justified. Prefer removing dead code, exercising it, or narrowing visibility.
- The workspace lints forbid `unsafe` code and deny `unwrap()`, `dbg!`, and `todo!()`. Handle or propagate errors explicitly.
- Format Rust changes with `just fmt`. `just verify` runs the formatting, Clippy, and test checks that CI runs.
