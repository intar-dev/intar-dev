# Agent Notes

- Use the root Cargo workspace. Do not reintroduce nested per-project Cargo locks or toolchain pins.
- Shared wire and guest contracts belong in `crates/intar-contracts`; regenerate website outputs with `just generate-contracts`.
- The kino protobuf source belongs to `crates/intar-kino-proto/proto/kino/v1/probes.proto`.
- Stardrive is mothballed: keep `go test ./...` green, but do not restore release automation or Homebrew formula files.
