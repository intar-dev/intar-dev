#!/usr/bin/env bash
# release.yml, job release, step "Resolve project".
set -euo pipefail
case "${PROJECT}" in
  intar-agent)
    manifest="crates/intar-agent/Cargo.toml"
    package="intar-agent"
    binary="intar-agent"
    tag_prefix="agent/"
    ;;
  intar-builder)
    manifest="crates/intar-builder/Cargo.toml"
    package="intar-builder"
    binary="intar-builder"
    tag_prefix="builder/"
    ;;
  intar-image-cli)
    manifest="crates/intar-image-cli/Cargo.toml"
    package="intar-image-cli"
    binary="intar-image-cli"
    tag_prefix="image-cli/"
    ;;
  kino)
    manifest="crates/kino/Cargo.toml"
    package="kino"
    binary="kino"
    tag_prefix="kino/"
    ;;
  stargate)
    manifest="crates/stargate-gateway/Cargo.toml"
    package="stargate-gateway"
    binary="stargate"
    tag_prefix="stargate/"
    ;;
  *)
    echo "unsupported project: ${PROJECT}" >&2
    exit 1
    ;;
esac
{
  echo "manifest=${manifest}"
  echo "package=${package}"
  echo "binary=${binary}"
  echo "tag_prefix=${tag_prefix}"
} >> "${GITHUB_OUTPUT}"
