#!/usr/bin/env bash
# image-ops workflow, tools-build job, "Install Rust toolchain" step.
rustup toolchain install 1.97.0 --profile minimal
rustup target add --toolchain 1.97.0 x86_64-unknown-linux-musl
