#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const PINNED_REVISION = "1b6fad43551a720b143d7a52799f81c4c89455cb";
const EXPECTED_RAW_TREE_SHA256 =
  "b10b73f4652d22be1e654dbf9c668ea2381fbe1f950d1f62172a430e6d343ecc";
const EXPECTED_ADAPTED_TREE_SHA256 =
  "5fc7cb5da3e5204997a6997db1b37c5df59a8e94643943ca448f652e62775a8f";
const EXPECTED_OVERLAY_SHA256 =
  "e343f56cbe959b5c4b70025bb26c888be5dead31b14a1f8cd7e1bfb47a3a7edd";
const EXPECTED_CHANGED_FILES = 3;

const rawRoot = resolve(process.argv[2] ?? "");
const adaptedRoot = resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error(
    "usage: bun scripts/check-platform-engineering-workshop-import.ts RAW_IMPORT ADAPTED_TREE",
  );
}

const raw = snapshot(rawRoot);
const adapted = snapshot(adaptedRoot);
const rawTree = digestTree(raw);
const adaptedTree = digestTree(adapted);
const overlay = digestOverlay(raw, adapted);

const actual = {
  rawTreeSha256: rawTree,
  adaptedTreeSha256: adaptedTree,
  overlaySha256: overlay.sha256,
  changedFiles: overlay.changedFiles,
};
const expected = {
  rawTreeSha256: EXPECTED_RAW_TREE_SHA256,
  adaptedTreeSha256: EXPECTED_ADAPTED_TREE_SHA256,
  overlaySha256: EXPECTED_OVERLAY_SHA256,
  changedFiles: EXPECTED_CHANGED_FILES,
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  process.stderr.write(
    `Platform Engineering Workshop import drifted from ${PINNED_REVISION}.\n` +
      `Expected: ${JSON.stringify(expected, null, 2)}\n` +
      `Actual:   ${JSON.stringify(actual, null, 2)}\n` +
      "Review the pinned import and every Intar adaptation before updating this lock.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `Verified pinned import ${PINNED_REVISION}: ${raw.size} raw files, ` +
    `${adapted.size} adapted files, ${overlay.changedFiles} explicit adaptations\n`,
);

interface SnapshotEntry {
  executable: boolean;
  sha256: string;
}

function snapshot(root: string): Map<string, SnapshotEntry> {
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`snapshot root must be a real directory: ${root}`);
  }
  const entries = new Map<string, SnapshotEntry>();
  visit(root);
  return entries;

  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const metadata = lstatSync(absolute);
      const portable = relative(root, absolute).split(sep).join("/");
      if (metadata.isSymbolicLink()) {
        throw new Error(`import tree contains a symlink: ${portable}`);
      }
      if (metadata.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`import tree contains a non-file entry: ${portable}`);
      }
      entries.set(portable, {
        executable: (metadata.mode & 0o111) !== 0,
        sha256: sha256(readFileSync(absolute)),
      });
    }
  }
}

function digestTree(entries: Map<string, SnapshotEntry>): string {
  const digest = createHash("sha256");
  for (const [path, entry] of [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    digest.update(path);
    digest.update("\0");
    digest.update(entry.executable ? "x" : "-");
    digest.update("\0");
    digest.update(entry.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function digestOverlay(
  raw: Map<string, SnapshotEntry>,
  adapted: Map<string, SnapshotEntry>,
): { sha256: string; changedFiles: number } {
  const paths = [...new Set([...raw.keys(), ...adapted.keys()])].sort();
  const digest = createHash("sha256");
  let changedFiles = 0;
  for (const path of paths) {
    const before = raw.get(path);
    const after = adapted.get(path);
    if (
      before?.executable === after?.executable &&
      before?.sha256 === after?.sha256
    ) {
      continue;
    }
    changedFiles += 1;
    digest.update(path);
    digest.update("\0");
    digest.update(entryLock(before));
    digest.update("\0");
    digest.update(entryLock(after));
    digest.update("\0");
  }
  return { sha256: digest.digest("hex"), changedFiles };
}

function entryLock(entry: SnapshotEntry | undefined): string {
  if (!entry) return "missing";
  return `${entry.executable ? "x" : "-"}:${entry.sha256}`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
