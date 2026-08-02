#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const projectRoots = [
  "apps/web/workers/providers/hetzner",
  "apps/web/workers/providers/gcp",
  "packages/provider-contracts",
  "packages/provider-worker-core",
  "packages/provider-testkit",
  "packages/workshop-contracts",
  "apps/web",
]
  .map((path) => resolve(repositoryRoot, path))
  .filter(existsSync)
  .sort((left, right) => right.length - left.length);

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".astro"]);
const ignoredDirectories = new Set([
  ".git",
  ".wrangler",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const violations: string[] = [];

for (const projectRoot of projectRoots) visit(projectRoot, projectRoot);

if (violations.length) {
  process.stderr.write(
    `Cross-project relative imports are forbidden:\n${violations.map((value) => `- ${value}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(`Checked import boundaries for ${projectRoots.length} projects\n`);

function visit(directory: string, projectRoot: string): void {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`project source must be a real directory: ${directory}`);
  }
  for (const name of readdirSync(directory).sort()) {
    if (ignoredDirectories.has(name)) continue;
    const path = join(directory, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      visit(path, projectRoot);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(extname(path))) continue;
    checkFile(path, projectRoot);
  }
}

function checkFile(path: string, projectRoot: string): void {
  const source = readFileSync(path, "utf8");
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)(["'])(\.\.?\/[^"']+)\1/gu;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2];
    if (!specifier) continue;
    const resolved = resolve(dirname(path), specifier);
    const escape = relative(projectRoot, resolved);
    if (escape === ".." || escape.startsWith(`..${sep}`)) {
      violations.push(
        `${relative(repositoryRoot, path)} imports ${specifier}, which escapes ${relative(repositoryRoot, projectRoot)}`,
      );
    }
  }
}
