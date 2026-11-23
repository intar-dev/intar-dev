# Changelog

## kino/v0.15.0 (2026-11-23)

### Features

- **talos:** Allow several control planes in a cluster (#533) (a1f2f435)

## kino/v0.14.0 (2026-11-23)

### Features

- **talos:** Run talos cluster labs on the hosted agent (#528) (22b21dd6)

## kino/v0.13.1 (2026-11-23)

### Bug fixes

- **deps:** Drop aws-lc-rs and use ring for all crypto (#519) (1f43eb6c)

## kino/v0.13.0 (2026-11-23)

### Features

- **talos:** Run talos cluster labs on hosted and desktop runtimes (#509) (4eeb3200)

## kino/v0.12.1 (2026-11-23)

### Bug fixes

- **deps:** Bump url past RUSTSEC-2026-0592 (#511) (03319a5a)

## kino/v0.12.0 (2026-11-21)

### Features

- **intar-image-cli:** Build a machine image and boot it once (#439) (f10b3b10)

## kino/v0.11.0 (2026-11-19)

### Breaking changes

- **intar-contracts:** [**breaking**] Move to image format 4 and build arm64 machine images (#425) (88130d03)

## kino/v0.10.0 (2026-11-19)

### Features

- **kino:** Reach the host over TCP when boot.json says so (#414) (1f32333b)

### Bug fixes

- **intar-contracts:** Sort canonical JSON keys explicitly (#412) (82555a9c)

## kino/v0.9.1 (2026-11-18)

### Performance

- **kino:** Run a lab's ready scripts together on their first attempt (#381) (6b6db34a)

## kino/v0.9.0 (2026-11-17)

### Features

- **intar-agent:** Let the site say which VMs may start from a snapshot (#369) (4a4eb4ce)

## kino/v0.8.0 (2026-11-17)

### Features

- **intar-agent:** Start labs from a per-host snapshot (#365) (31d9b9d3)

## kino/v0.7.1 (2026-11-17)

### Bug fixes

- **kino:** Report a readiness script only when its result changes (#360) (65ed8e3f)

## kino/v0.7.0 (2026-11-17)

### Features

- **kino:** Start the lab at once and check it more often (#357) (36357744)

## kino/v0.6.0 (2026-11-17)

### Breaking changes

- **intar-contracts:** [**breaking**] Replace the scenario format, guest contract and registry storage (#351) (137144dc)

## kino/v0.5.2 (2026-10-28)

### Bug fixes

- **deps:** Bump every dependency to its latest release (#261) (d29f1aae)
- **deps:** Bump ctutils for RUSTSEC-2026-0385 and wire host admin to the current apis (#254) (68eaba88)

## kino/v0.5.1 (2026-10-22)

### Bug fixes

- **deps:** Patch the new audit advisories and check pull requests in a merge queue (#245) (3539442f)
- **deps:** Bump every dependency to its latest release (#248) (852817f2)

## kino/v0.5.0 (2026-10-05)

### Features

- **stargate:** Share runs live through a public link (#234) (02f12d72)

## kino/v0.4.0 (2026-10-01)

### Breaking changes

- **runtime:** [**breaking**] Enforce declared CPU limits from VM startup (cb03be98)
- [**breaking**] Replace organization metal with personal servers (8a48a22a)

### Features

- **hosts:** Add shared organization servers (4a2b6ae0)
- **intar-contracts:** Add scenario source compile contracts (c456744e)
- **intar-contracts:** Pin the source result attempt and drop snapshot_ref (94685419)
