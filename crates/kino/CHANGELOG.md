# Changelog

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
