# Changelog

## desktop/v0.1.0 (2026-11-21)

The first release of the desktop app: run a lab's machine on your own computer.

For a Mac with Apple silicon, macOS 13 or later. The app is not notarized yet: after the download, macOS refuses the first open. Move Intar to the Applications folder, try to open it once, then allow it under System Settings, Privacy & Security, "Open Anyway".

### Features

- Sign in with your intar account, and see your courses and their lectures.
- Start a lecture's lab on this computer: the app downloads the machine's image, boots it with its own QEMU, and shows the lab's tasks as they are solved.
- A terminal in the machine, whose sessions are saved for the run's replay.
- The app offers its own updates and installs them.
