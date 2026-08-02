# Agent Notes

- Use the root Cargo workspace. Do not reintroduce nested per-project Cargo locks or toolchain pins.
- Shared wire and guest contracts belong in `crates/intar-contracts`; regenerate web outputs with `just generate-contracts`.
- JavaScript and TypeScript packages use the root Bun workspace and lockfile. Do not add nested lockfiles or cross-project relative imports.
- Use the default shared Cargo cache and the root workspace target directory. Do not create component-specific `CARGO_HOME` directories.
- The kino protobuf source belongs to `crates/intar-kino-proto/proto/kino/v1/probes.proto`.
