#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const workRoot = join(repositoryRoot, ".work");
const outputRoot = resolve(
  process.argv[2] ?? join(workRoot, "workshops/platform-engineering"),
);
const sourceRoot = join(workRoot, "sources/platform-engineering");
const rawRoot = join(workRoot, "workshops/platform-engineering.raw");
const overlaysRoot = join(
  repositoryRoot,
  "content/workshops/platform-engineering/overlays",
);

for (const path of [outputRoot, sourceRoot, rawRoot]) assertInsideWorkRoot(path);
mkdirSync(dirname(outputRoot), { recursive: true });
mkdirSync(dirname(sourceRoot), { recursive: true });

resetGeneratedDirectory(sourceRoot);
resetGeneratedDirectory(rawRoot);
resetGeneratedDirectory(outputRoot);

await run("acquire.ts", [sourceRoot]);
await run("generate.ts", [sourceRoot, rawRoot]);
cpSync(rawRoot, outputRoot, { recursive: true, force: false, errorOnExist: true });
applyOverlays(overlaysRoot, outputRoot);
await run("verify-lock.ts", [rawRoot, outputRoot]);

process.stdout.write(`Hydrated reviewed Workshop content at ${outputRoot}\n`);

function assertInsideWorkRoot(path: string): void {
  const portable = relative(workRoot, resolve(path));
  if (
    !portable ||
    portable === ".." ||
    portable.startsWith(`..${sep}`)
  ) {
    throw new Error(`generated path must be a child of ${workRoot}: ${path}`);
  }
}

function resetGeneratedDirectory(path: string): void {
  assertInsideWorkRoot(path);
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`refusing to replace non-directory generated path: ${path}`);
    }
    rmSync(path, { recursive: true, force: false });
  }
}

function applyOverlays(source: string, destination: string): void {
  const metadata = lstatSync(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`overlay root must be a real directory: ${source}`);
  }
  visit(source, destination);

  function visit(currentSource: string, currentDestination: string): void {
    mkdirSync(currentDestination, { recursive: true });
    for (const name of readdirSync(currentSource).sort()) {
      const from = join(currentSource, name);
      const to = join(currentDestination, name);
      const entry = lstatSync(from);
      if (entry.isSymbolicLink()) throw new Error(`overlay contains a symlink: ${from}`);
      if (entry.isDirectory()) {
        visit(from, to);
      } else if (entry.isFile()) {
        cpSync(from, to, { force: true });
      } else {
        throw new Error(`overlay contains a non-file entry: ${from}`);
      }
    }
  }
}

async function run(script: string, args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, script), ...args], {
    cwd: repositoryRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${script} failed with exit code ${exitCode}`);
}
