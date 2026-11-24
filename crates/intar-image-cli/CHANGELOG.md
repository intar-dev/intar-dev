# Changelog

## image-cli/v0.22.0 (2026-11-24)

### Features

- **jumper:** Run talos cluster labs on the desktop (#538) (e46fbc7d)

## image-cli/v0.21.0 (2026-11-23)

### Features

- **talos:** Allow several control planes in a cluster (#533) (a1f2f435)

## image-cli/v0.20.0 (2026-11-23)

### Features

- **talos:** Run talos cluster labs on the hosted agent (#528) (22b21dd6)

## image-cli/v0.19.1 (2026-11-23)

### Bug fixes

- **deps:** Drop aws-lc-rs and use ring for all crypto (#519) (1f43eb6c)
- **deps:** Use ring for intar-image-build's downloads (#526) (961aa258)

## image-cli/v0.19.0 (2026-11-23)

### Features

- **talos:** Run talos cluster labs on hosted and desktop runtimes (#509) (4eeb3200)

## image-cli/v0.18.0 (2026-11-23)

### Breaking changes

- **intar-image-scenario:** [**breaking**] Refuse a scenario that no lecture names (#504) (b892d147)

### Bug fixes

- **deps:** Bump url past RUSTSEC-2026-0592 (#511) (03319a5a)

## image-cli/v0.17.0 (2026-11-21)

### Features

- **intar-image-cli:** Set up a Linux arm64 computer (#497) (6ed7a964)

## image-cli/v0.16.0 (2026-11-21)

### Features

- **zpm:** Run the app's own QEMU and update it and the guest kernel weekly (#436) (9ddd53f3)

## image-cli/v0.15.0 (2026-11-21)

### Features

- **intar-image-build:** Download the guest kernel that CI built instead of compiling it (#427) (c490d008)
- **intar-image-cli:** Build a machine image and boot it once (#439) (f10b3b10)
- **intar-image-cli:** Plan a pipeline's images and push one (#449) (ccac1158)
- **intar-image-cli:** Set up the build tools on a runner (#450) (8dd481a9)

### Bug fixes

- **intar-builder:** Wait out a registry that refuses writers instead of failing the build (#430) (06df8c76)
- **intar-builder:** Keep the arm64 image through a restart and run one emulated build at a time (#432) (90e6ebdc)
- **intar-image-cli:** Let a job's cache volume fill before it evicts checkpoints (#452) (ed2ba581)

## image-cli/v0.14.0 (2026-11-19)

### Breaking changes

- **intar-contracts:** [**breaking**] Move to image format 4 and build arm64 machine images (#425) (88130d03)

## image-cli/v0.13.0 (2026-11-19)

### Features

- **kino:** Reach the host over TCP when boot.json says so (#414) (1f32333b)

### Bug fixes

- **intar-contracts:** Sort canonical JSON keys explicitly (#412) (82555a9c)

## image-cli/v0.12.0 (2026-11-17)

### Features

- **intar-agent:** Let the site say which VMs may start from a snapshot (#369) (4a4eb4ce)

## image-cli/v0.11.0 (2026-11-17)

### Breaking changes

- **intar-contracts:** [**breaking**] Replace the scenario format, guest contract and registry storage (#351) (137144dc)

## image-cli/v0.10.3 (2026-10-28)

### Bug fixes

- **deps:** Bump every dependency to its latest release (#261) (d29f1aae)

## image-cli/v0.10.2 (2026-10-23)

### Bug fixes

- **deps:** Bump ctutils for RUSTSEC-2026-0385 and wire host admin to the current apis (#254) (68eaba88)

## image-cli/v0.10.1 (2026-10-22)

### Bug fixes

- **deps:** Bump every dependency to its latest release (#248) (852817f2)

## image-cli/v0.10.0 (2026-10-05)

### Features

- **stargate:** Share runs live through a public link (#234) (02f12d72)
