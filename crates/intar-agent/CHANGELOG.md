# Changelog

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
