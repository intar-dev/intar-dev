default:
    @just --list

install-js:
    bun install --frozen-lockfile

fmt:
    cargo fmt --all

check-rust:
    cargo check --workspace

check-js:
    bun run check:imports
    bun run check:providers
    bun run check:deploy
    bun run check:database-migrations
    bun run --cwd apps/web types:cf:check
    bun run --cwd apps/web db:schema:check
    bun run --cwd apps/web/workers/providers/hetzner types:cf:check
    bun run --cwd apps/web/workers/providers/hetzner check
    bun run --cwd apps/web/workers/providers/gcp types:cf:check
    bun run --cwd apps/web/workers/providers/gcp check

check: check-rust check-js

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

test-rust: hydrate
    cargo test --workspace

test-js:
    bun run test

test: test-rust test-js

build-rust:
    cargo build --workspace

build-js:
    bun run build

build: build-rust build-js

verify: hydrate
    sh crates/intar-jailerd/tests/install-process-audit.sh crates/intar-jailerd/deploy/install.sh
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo nextest run --workspace

security:
    bun audit --audit-level=moderate
    cargo audit --deny warnings

generate-contracts:
    cargo run -p intar-contracts-typegen

generate: generate-contracts

check-generated-contracts:
    cargo run -p intar-contracts-typegen
    git diff --exit-code -- apps/web/src/generated

check-generated: generate
    git diff --exit-code -- apps/web/src/generated

hydrate:
    bun run hydrate

check-hydrated: hydrate
    cargo run --locked -p intar-workshop-cli -- validate .work/workshops/platform-engineering
    bun tools/workshops/check-app-routing.ts .work/workshops/platform-engineering

clean-generated:
    bun run clean:generated

build-kino-guest:
    cargo zigbuild --profile guest -p kino --target x86_64-unknown-linux-musl

validate-images:
    cargo run -p intar-image-cli -- validate

render-images scenario="" config="builder.sample.amd64.hcl":
    #!/usr/bin/env bash
    set -euo pipefail

    if [[ -n "{{scenario}}" ]]; then
      cargo run -p intar-image-cli -- render "{{scenario}}" --config "{{config}}"
    else
      cargo run -p intar-image-cli -- render --config "{{config}}"
    fi

build-images scenario="" config="builder.sample.amd64.hcl" no_upload="false":
    #!/usr/bin/env bash
    set -euo pipefail

    if [[ -n "{{scenario}}" ]]; then
      args=(build "{{scenario}}")
    else
      args=(build-all)
    fi
    args+=(--config "{{config}}")
    if [[ "{{no_upload}}" == "true" ]]; then
      args+=(--no-upload)
    fi

    cargo run -p intar-image-cli -- "${args[@]}"

bundle-images scenario="" config="builder.sample.amd64.hcl" rev="" no_upload="false" url="":
    #!/usr/bin/env bash
    set -euo pipefail

    args=(bundle)
    if [[ -n "{{scenario}}" ]]; then
      args+=("{{scenario}}")
    fi
    args+=(--config "{{config}}")
    if [[ -n "{{rev}}" ]]; then
      args+=(--rev "{{rev}}")
    fi
    if [[ -n "{{url}}" ]]; then
      args+=(--url "{{url}}")
    fi
    if [[ "{{no_upload}}" == "true" ]]; then
      args+=(--no-upload)
    fi

    cargo run -p intar-image-cli -- "${args[@]}"

live-e2e args="":
    cd apps/web && bun run e2e:live -- {{args}}
