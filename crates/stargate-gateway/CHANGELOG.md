# Changelog

## stargate/v0.15.1 (2026-11-25)

### Bug fixes

- **deps:** Bump libraries, cuenv and github actions to their latest releases (#549) (8d9ea6b4)

## stargate/v0.15.0 (2026-11-24)

### Features

- **jumper:** Run talos cluster labs on the desktop (#538) (e46fbc7d)

## stargate/v0.14.0 (2026-11-23)

### Features

- **talos:** Allow several control planes in a cluster (#533) (a1f2f435)

## stargate/v0.13.0 (2026-11-23)

### Features

- **talos:** Run talos cluster labs on the hosted agent (#528) (22b21dd6)

## stargate/v0.12.1 (2026-11-23)

### Bug fixes

- **deps:** Drop aws-lc-rs and use ring for all crypto (#519) (1f43eb6c)

## stargate/v0.12.0 (2026-11-23)

### Features

- **talos:** Run talos cluster labs on hosted and desktop runtimes (#509) (4eeb3200)

## stargate/v0.11.1 (2026-11-23)

### Bug fixes

- **deps:** Bump url past RUSTSEC-2026-0592 (#511) (03319a5a)

## stargate/v0.11.0 (2026-11-21)

### Features

- **intar-image-cli:** Build a machine image and boot it once (#439) (f10b3b10)

## stargate/v0.10.0 (2026-11-19)

### Breaking changes

- **intar-contracts:** [**breaking**] Move to image format 4 and build arm64 machine images (#425) (88130d03)

## stargate/v0.9.0 (2026-11-19)

### Features

- **kino:** Reach the host over TCP when boot.json says so (#414) (1f32333b)

### Bug fixes

- **intar-contracts:** Sort canonical JSON keys explicitly (#412) (82555a9c)

## stargate/v0.8.0 (2026-11-17)

### Features

- **intar-agent:** Let the site say which VMs may start from a snapshot (#369) (4a4eb4ce)

## stargate/v0.7.0 (2026-11-17)

### Breaking changes

- **intar-contracts:** [**breaking**] Replace the scenario format, guest contract and registry storage (#351) (137144dc)

## stargate/v0.6.2 (2026-10-28)

### Bug fixes

- **deps:** Bump every dependency to its latest release (#261) (d29f1aae)
- **deps:** Bump ctutils for RUSTSEC-2026-0385 and wire host admin to the current apis (#254) (68eaba88)

## stargate/v0.6.1 (2026-10-22)

### Bug fixes

- **deps:** Bump every dependency to its latest release (#248) (852817f2)

## stargate/v0.6.0 (2026-10-05)

### Features

- **stargate:** Share runs live through a public link (#234) (02f12d72)

## stargate/v0.5.0 (2026-10-01)

### Features

- **hosts:** Add shared organization servers (4a2b6ae0)
- **intar-contracts:** Add scenario source compile contracts (c456744e)
- **intar-contracts:** Pin the source result attempt and drop snapshot_ref (94685419)
