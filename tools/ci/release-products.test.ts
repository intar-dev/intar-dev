import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// A product is released when git-cliff sees a change under one of its path
// globs, so every workspace crate its binaries build from, and every file they
// compile in or package, must be covered.
const root = resolve(import.meta.dir, "../..");
const products: { project: string; manifest: string; paths: string[] }[] =
  JSON.parse(
    readFileSync(join(root, "tools/workflows/release/products.json"), "utf8"),
  );
// Binaries a product's archive ships besides its own (build-release-artifacts.sh).
const shipped: Record<string, string[]> = {
  "intar-agent": ["crates/intar-jailer", "crates/intar-jailerd"],
};
// Files outside the crates that decide what a product's archive holds: the
// agent's Cloud Hypervisor binary is pinned in build-release-artifacts.sh.
const packaged: Record<string, string[]> = {
  "intar-agent": ["tools/workflows/release/build-release-artifacts.sh"],
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

// Files a crate compiles in with include_str! or include_bytes!. Test code
// never ships: tests/ and tests.rs files, and an inline test module, which
// Clippy's items_after_test_module keeps last in its file.
function embedded(crate: string): string[] {
  const files: string[] = [];
  for (const file of new Bun.Glob("**/*.rs").scanSync(join(root, crate))) {
    if (/(^|\/)tests(\/|\.rs$)/.test(file)) continue;
    const [source = ""] = readFileSync(join(root, crate, file), "utf8").split(
      /#\[cfg\(test\)\]\s*mod \w+\s*\{/,
    );
    for (const [, path] of source.matchAll(
      /include_(?:str|bytes)!\(\s*"([^"]+)"/g,
    )) {
      files.push(relative(root, resolve(root, crate, dirname(file), path)));
    }
  }
  return files;
}

test.each(products)(
  "$project releases on every crate and file it builds from",
  (product) => {
    const seen = new Set<string>();
    for (const crate of [
      dirname(product.manifest),
      ...(shipped[product.project] ?? []),
    ]) {
      crates(crate, seen);
    }
    for (const crate of seen) expect(product.paths).toContain(`${crate}/**`);
    const files = [
      ...[...seen].flatMap(embedded),
      ...(packaged[product.project] ?? []),
    ];
    const uncovered = files.filter(
      (file) => !product.paths.some((glob) => new Bun.Glob(glob).match(file)),
    );
    expect(uncovered).toEqual([]);
  },
);
