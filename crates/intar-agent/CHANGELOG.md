# Changelog

## agent/v0.29.0 (2026-11-23)

### Features

- **talos:** Allow several control planes in a cluster (#533) (a1f2f435)

## agent/v0.28.0 (2026-11-23)

### Features

- **talos:** Run talos cluster labs on the hosted agent (#528) (22b21dd6)

## agent/v0.27.1 (2026-11-23)

### Bug fixes

- **deps:** Drop aws-lc-rs and use ring for all crypto (#519) (1f43eb6c)

## agent/v0.27.0 (2026-11-23)

### Features

- **talos:** Run talos cluster labs on hosted and desktop runtimes (#509) (4eeb3200)

## agent/v0.26.1 (2026-11-23)

### Bug fixes

- **deps:** Bump url past RUSTSEC-2026-0592 (#511) (03319a5a)

## agent/v0.26.0 (2026-11-21)

### Features

- **intar-image-cli:** Build a machine image and boot it once (#439) (f10b3b10)

## agent/v0.25.0 (2026-11-19)

### Breaking changes

- **intar-contracts:** [**breaking**] Move to image format 4 and build arm64 machine images (#425) (88130d03)

### Features

- **jumper:** Upload a local run's session recordings (#421) (020922cd)
- **intar-agent:** Read images of the next image format too (#424) (85bee57c)

## agent/v0.24.0 (2026-11-19)

### Features

- **kino:** Reach the host over TCP when boot.json says so (#414) (1f32333b)

### Bug fixes

- **intar-contracts:** Sort canonical JSON keys explicitly (#412) (82555a9c)

## agent/v0.23.2 (2026-11-18)

### Bug fixes

- **intar-agent:** Scrub only what a kino pull stores (#406) (97245581)

## agent/v0.23.1 (2026-11-18)

### Bug fixes

- **intar-agent:** Take a snapshot only after the lab's ready scripts pass (#389) (a23ffea5)

## agent/v0.23.0 (2026-11-18)

### Features

- **intar-agent:** Keep snapshots a week and capture them again before they expire (#387) (f29045f3)

## agent/v0.22.2 (2026-11-18)

### Bug fixes

- **intar-agent:** Report a host's CPU as free while a lab starts (#385) (75b8d9a7)

## agent/v0.22.1 (2026-11-18)

### Performance

- **intar-jailerd:** Give back the empty pages of a snapshot's memory file (#383) (546f60d9)

## agent/v0.22.0 (2026-11-17)

### Features

- **intar-agent:** Let the site say which VMs may start from a snapshot (#369) (4a4eb4ce)

## agent/v0.21.0 (2026-11-17)

### Features

- **intar-agent:** Start labs from a per-host snapshot (#365) (31d9b9d3)

## agent/v0.20.1 (2026-11-17)

### Bug fixes

- **intar-jailer:** Let a guest reboot reopen its log files (#363) (315c0683)

## agent/v0.20.0 (2026-11-17)

### Breaking changes

- **intar-contracts:** [**breaking**] Replace the scenario format, guest contract and registry storage (#351) (137144dc)

## agent/v0.19.2 (2026-10-28)

### Bug fixes

- **deps:** Bump every dependency to its latest release (#261) (d29f1aae)
- **deps:** Bump ctutils for RUSTSEC-2026-0385 and wire host admin to the current apis (#254) (68eaba88)

## agent/v0.19.1 (2026-10-22)

### Bug fixes

- **deps:** Patch the new audit advisories and check pull requests in a merge queue (#245) (3539442f)
- **deps:** Bump every dependency to its latest release (#248) (852817f2)

## agent/v0.19.0 (2026-10-05)

### Features

- **stargate:** Share runs live through a public link (#234) (02f12d72)

## agent/v0.18.0 (2026-10-05)

### Features

- **intar-agent:** Record when each check first passes and write it into the session cast as an asciicast marker, so replays show verified checks on the track (523e6d48)

## agent/v0.17.0 (2026-10-01)

### Features

- **intar-contracts:** Add scenario source compile contracts (c456744e)
- **intar-contracts:** Pin the source result attempt and drop snapshot_ref (94685419)
