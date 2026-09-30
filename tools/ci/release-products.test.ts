import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// A product is released when git-cliff sees a change under one of its path
// globs, so every workspace crate its binaries build from must be listed.
const root = resolve(import.meta.dir, "../..");
const products: { project: string; manifest: string; paths: string[] }[] =
  JSON.parse(
    readFileSync(join(root, "tools/workflows/release/products.json"), "utf8"),
  );
// Binaries a product's archive ships besides its own (build-release-artifacts.sh).
const shipped: Record<string, string[]> = {
  "intar-agent": ["crates/intar-jailer", "crates/intar-jailerd"],
};

type Dependencies = Record<string, string | { path?: string }>;
type Manifest = {
  dependencies?: Dependencies;
  "build-dependencies"?: Dependencies;
  target?: Record<string, Manifest>;
};

function crates(crate: string, seen: Set<string>): Set<string> {
  if (seen.has(crate)) return seen;
  seen.add(crate);
  const manifest = Bun.TOML.parse(
    readFileSync(join(root, crate, "Cargo.toml"), "utf8"),
  ) as Manifest;
  const tables = [manifest, ...Object.values(manifest.target ?? {})].flatMap(
    (table) => [table.dependencies, table["build-dependencies"]],
  );
  for (const table of tables) {
    for (const dependency of Object.values(table ?? {})) {
      if (typeof dependency !== "object" || !dependency.path) continue;
      const path = relative(root, resolve(root, crate, dependency.path));
      // The prepared libnbd bindings live in target/, outside the repository.
      if (path.startsWith("crates/")) crates(path, seen);
    }
  }
  return seen;
}

test.each(products)(
  "$project releases on every crate it builds from",
  (product) => {
    const seen = new Set<string>();
    for (const crate of [
      dirname(product.manifest),
      ...(shipped[product.project] ?? []),
    ]) {
      crates(crate, seen);
    }
    for (const crate of seen) expect(product.paths).toContain(`${crate}/**`);
  },
);
