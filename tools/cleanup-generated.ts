#!/usr/bin/env bun

import { existsSync, lstatSync, rmSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const generatedPaths = [
  ".work",
  "apps/web/.astro",
  "apps/web/dist",
  "apps/web/workers/providers/hetzner/.wrangler/dry-run",
  "apps/web/workers/providers/gcp/.wrangler/dry-run",
  "tools/providers/live-capability-probe/.wrangler",
] as const;

for (const portable of generatedPaths) {
  const path = resolve(repositoryRoot, portable);
  const rel = relative(repositoryRoot, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel !== portable) {
    throw new Error(`refusing unsafe generated path: ${path}`);
  }
  if (!existsSync(path)) continue;
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`refusing to remove non-directory generated path: ${path}`);
  }
  rmSync(path, { recursive: true, force: false });
  process.stdout.write(`Removed ${portable}\n`);
}

process.stdout.write(
  "Preserved root target/, node_modules/, the Bun cache, and the shared Cargo cache.\n",
);
