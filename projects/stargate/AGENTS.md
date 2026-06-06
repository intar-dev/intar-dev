# AGENTS.md

## Stargate Working Rules

This workspace is Rust-first and opinionated. Changes should feel like they belong in a modern `edition = "2024"` codebase: small types, explicit boundaries, sharp error stories, and boringly reliable tooling.

## Non-Negotiables

1. After making changes, run `just verify` from the repository root.
2. Pin dependency versions exactly. Use `=x.y.z`, not `"x.y.z"`, `^x.y.z`, `~x.y.z`, or `*`.
3. Follow conventional commits and make the body useful.
4. Keep the codebase aligned with the current workspace style instead of introducing a second style.

## Modern Rust Style

- Target Rust 2024 idioms and keep code compatible with the workspace `rust-version`.
- Prefer `workspace = true` for shared internal policy and feature alignment when a dependency already lives in `[workspace.dependencies]`.
- Keep modules focused. Push protocol, config, persistence, and transport concerns to their own types instead of building large multifunction files.
- Use `struct` and `enum` names that describe domain intent, not plumbing details.
- Prefer `Result<T, E>` with explicit domain errors in library code.
- Use `thiserror` for typed domain errors and reserve `anyhow` for binaries, task orchestration, and integration edges.
- Add context to fallible operations with `Context` / `with_context` when crossing IO, parsing, network, or process boundaries.
- Prefer `tracing` over ad hoc prints. Emit structured fields that help explain failures.
- Keep async code cancellation-safe and avoid hidden blocking in async paths.
- Avoid `unwrap`, `expect`, and `todo!` outside tests unless there is a short, defensible reason.
- Keep functions readable before clever. Favor clear control flow and locally obvious ownership over abstraction for its own sake.
- Avoid unnecessary clones, but do not contort the code to save trivial allocations.
- `unsafe` is forbidden unless the maintainer explicitly asks for it.

## Dependency Policy

- Add new third-party dependencies in the workspace root when they are shared across crates.
- Pin every dependency exactly with `=`. Example: `serde = { version = "=1.0.228", features = ["derive"] }`.
- Pin crate-local dependencies exactly too. Do not loosen versions in leaf manifests.
- Keep feature sets minimal and intentional. Turn off default features when they are not needed.
- Do not mix multiple version requirements for the same crate family unless there is a demonstrated need.
- If you touch dependency versions, make the pinning style more consistent in the files you edit.

## Workflow

- Start from the repository root unless a task clearly belongs to a single crate.
- Make the smallest coherent change that fully solves the task.
- When behavior changes, update or add tests close to the affected crate.
- Before finishing any task, run `just verify`.
- `just verify` is the default completion gate because it covers formatting, clippy, and tests in one command.
