# Changelog

## desktop/v0.5.0 (2026-11-23)

### Features

- **talos:** Allow several control planes in a cluster (#533) (a1f2f435)

## desktop/v0.4.0 (2026-11-23)

### Features

- **talos:** Run talos cluster labs on the hosted agent (#528) (22b21dd6)

### Bug fixes

- **jumper:** Quit when the window closes and add a menu bar (#530) (c5b9385f)

## desktop/v0.3.1 (2026-11-23)

### Bug fixes

- **deps:** Drop aws-lc-rs and use ring for all crypto (#519) (1f43eb6c)

## desktop/v0.3.0 (2026-11-23)

### Features

- **jumper:** Open the window filling the screen (#518) (30abf40c)

## desktop/v0.2.0 (2026-11-23)

### Features

- **jumper:** Sign and notarize the app, and align its controls with the website (#508) (0f296807)
- **jumper:** Show lectures, checks, hints and solutions like the website (#513) (cac73eb2)
- **jumper:** Show run history, recaps and replays like the website (#514) (70f4a030)

### Bug fixes

- **jumper:** Send typed and composed text to the terminal through an input handler (#510) (dfaf4ecd)
- **deps:** Bump url past RUSTSEC-2026-0592 (#511) (03319a5a)

## desktop/v0.1.0 (2026-11-21)

The first release of the desktop app: run a lab's machine on your own computer.

For a Mac with Apple silicon, macOS 13 or later. The app is not notarized yet: after the download, macOS refuses the first open. Move Intar to the Applications folder, try to open it once, then allow it under System Settings, Privacy & Security, "Open Anyway".

### Features

- Sign in with your intar account, and see your courses and their lectures.
- Start a lecture's lab on this computer: the app downloads the machine's image, boots it with its own QEMU, and shows the lab's tasks as they are solved.
- A terminal in the machine, whose sessions are saved for the run's replay.
- The app offers its own updates and installs them.
