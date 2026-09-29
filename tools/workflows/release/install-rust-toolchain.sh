#!/usr/bin/env bash
# release.yml, job release, step "Install Rust toolchain".
rustup toolchain install 1.97.0 --profile minimal
rustup component add --toolchain 1.97.0 rustfmt clippy
rustup target add --toolchain 1.97.0 x86_64-unknown-linux-musl aarch64-unknown-linux-musl
rustup show active-toolchain
