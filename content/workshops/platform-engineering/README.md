# Platform Engineering Workshop source

This directory is the reviewable, content-addressed source of the Workshop. It
does not commit the 400+ upstream and generated files.

- `locks/source.lock.json` pins the upstream Git revision, archive digest,
  license, and license digest.
- `locks/images.lock` and `locks/mise.lock` pin external runtime inputs.
- `overlays/` contains the small, reviewed Intar adaptations applied after a
  deterministic import.

Run `just hydrate` from the repository root. The generated v2 Workshop is
written to `.work/workshops/platform-engineering`; validation and publication
consume that directory. Run `just check-hydrated` for the complete hydration,
manifest, and application-routing validation. CI repeats hydration and checks
the entire raw tree, adapted tree, changed-file count, source license, and all
digests.

Generated Workshop trees are disposable. The shared Bun and Cargo caches are
not part of hydration or cleanup.
