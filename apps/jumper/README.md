# Intar desktop app

The desktop app runs a lab's machines on the learner's own computer instead of
on an Intar host. The learner signs in, picks a lecture, and the app downloads
the machine images, starts them under QEMU, and opens a terminal to them. The
checks, hints, solutions and replays are the ones the website shows.

The crate and the program are `jumper`. The product is released as
`intar-desktop`, a macOS bundle for Apple silicon, and that is the only
platform it ships for so far.

## Running a development build

On a Mac with Apple silicon, from the repository root:

```sh
cuenv task jumper-qemu   # once, and again whenever the pinned QEMU changes
cargo run -p jumper
```

The app runs only the QEMU it ships with, never one on `PATH`.
`cuenv task jumper-qemu` downloads that pinned build, checks its SHA-256, and
puts it in `target/debug/qemu`, where a development build looks for it. For a
release build, run `cuenv task jumper-qemu -- release` and
`cargo run --release -p jumper`.

Environment variables for development:

| Variable | Effect |
| --- | --- |
| `INTAR_URL` | The Intar the app talks to, instead of `https://intar.dev`; for example a local Worker |
| `INTAR_QEMU` | The directory of the QEMU to run, for a program that is not beside one, such as a test |
| `INTAR_RELEASES` | Another place to download app updates from, to try an update against a stand-in |

The sign-in is kept in the system keychain, one entry per `INTAR_URL`, and
never on disk.

## Checks

```sh
cuenv task clippy-app   # Clippy for jumper and zpm
cuenv task test-app     # their tests, with cargo-nextest
cuenv task lanes.app    # both, and the bundle: what CI's app lane runs on macOS
```

`cuenv task bundle-app` builds `target/release/bundle/Intar.app` the way a
release does (`tools/workflows/release/build-jumper-macos.sh`) and boots a
guest with the QEMU in it. That bundle is only a check. The one people install
is built by the release workflow; see [`RELEASING.md`](../../RELEASING.md).

## How the code is split

The window is drawn with [GPUI](https://www.gpui.rs), and nothing in it waits
on the network. `src/engine.rs` runs everything that does, on its own tokio
runtime; the window sends it commands and receives events. `src/state.rs`
turns those events into what the window shows and has no GPUI in it, so it is
tested without a window.

Running a machine is not in this crate. `crates/zpm` builds QEMU's command
line and owns the process, and has a small CLI of its own
(`cargo run -p zpm -- --help`) to boot a machine by hand. `crates/subspace` is the client of
the website's API, and `crates/dhd` renders replays, shared with the host
agent so both produce the same files.

The QEMU itself is built and pinned by `qemu.yml`; see
[`ci/README.md`](../../ci/README.md).

## License

MIT, except `src/ui/theme.rs` and `src/ui/text_input.rs`, which are
Apache-2.0 ([`LICENSE-APACHE`](LICENSE-APACHE)).
