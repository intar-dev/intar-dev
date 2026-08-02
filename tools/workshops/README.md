# Workshop content tools

Workshop source acquisition is separate from normalization, generation, and
lock verification:

- `platform-engineering/acquire.ts` downloads the pinned upstream archive,
  verifies its SHA-256 and Apache-2.0 license digest, rejects unsafe archive
  paths, and writes an acquisition marker;
- `platform-engineering/normalize.ts` admits only the reviewed acquisition
  marker or an exact, clean Git checkout;
- `platform-engineering/generate.ts` converts the upstream lab and all 85 slides
  into native Intar content;
- the small `platform-engineering/overlays/` tree contains reviewed Intar-only
  adaptations;
- `platform-engineering/verify-lock.ts` hashes the raw tree, hydrated tree, and
  explicit overlay delta;
- `platform-engineering/hydrate.ts` composes those phases into
  `.work/workshops/platform-engineering`.

Hydration never embeds OCI layers. `images.lock` maps every externally pulled
image to an immutable digest. The resolver is review tooling only; changing a
source or image lock requires a reviewed lock update.

Generated content under `.work/` is disposable. The cleanup command may remove
it, but it never removes the root Bun cache, Cargo home, or root `target/`.
