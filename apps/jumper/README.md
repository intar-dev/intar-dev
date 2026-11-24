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

## Layout

The window is drawn with [GPUI](https://www.gpui.rs). Nothing in the UI waits
on the network: it sends commands to the engine and receives events.

| Path | Contents |
| --- | --- |
| `src/main.rs` | The window and its screens |
| `src/ui` | The widgets: the terminal view, the replay player, Markdown, the text input, the theme |
| `src/state.rs` | What the window shows and how events change it. No GPUI, so it is tested without a window |
| `src/engine.rs` | Everything that waits on the network, on its own tokio runtime |
| `src/pull.rs` | Downloads a run's images from Intar's registry by digest into the local cache |
| `src/local.rs` | The run's machines on this computer: started through zpm, watched through Kino's reports, stopped with the run |
| `src/terminal.rs` | The SSH session to a machine and the grid its output is drawn from |
| `src/qemu.rs` | Finds the QEMU the app ships with |
| `src/secrets.rs` | The sign-in, in the system keychain |
| `src/update.rs` | Replaces the app with a newer release |

Three workspace crates do the work that is not specific to the window:

- [`crates/zpm`](../../crates/zpm) builds QEMU's command line and owns the
  process. It has a small CLI of its own (`cargo run -p zpm -- --help`) to
  boot a machine by hand.
- [`crates/subspace`](../../crates/subspace) is the client of the app's API on
  the website: the browser sign-in and local runs.
- [`crates/dhd`](../../crates/dhd) reads recorded sessions and renders their
  replays, as the agent does on a host.

The QEMU itself is built and pinned by `qemu.yml`; see
[`ci/README.md`](../../ci/README.md).

## License

MIT, except `src/ui/theme.rs` and `src/ui/text_input.rs`, which are
Apache-2.0 ([`LICENSE-APACHE`](LICENSE-APACHE)).
