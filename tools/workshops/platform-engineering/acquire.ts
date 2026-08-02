#!/usr/bin/env bun

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { loadSourceLock, sha256 } from "./lock";

const outputRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: bun tools/workshops/platform-engineering/acquire.ts OUTPUT_DIRECTORY");
}

if (existsSync(outputRoot)) {
  const metadata = lstatSync(outputRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`acquisition output must be a real directory: ${outputRoot}`);
  }
  if (readdirSync(outputRoot).length !== 0) {
    throw new Error(`acquisition output must be empty: ${outputRoot}`);
  }
} else {
  mkdirSync(outputRoot, { recursive: true });
}

const lock = loadSourceLock();
const response = await fetch(lock.archiveUrl, {
  headers: { Accept: "application/gzip" },
  redirect: "follow",
});
if (!response.ok) {
  throw new Error(`source archive request failed with HTTP ${response.status}`);
}
const finalUrl = new URL(response.url);
if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password) {
  throw new Error("source archive redirected to an unsafe URL");
}

const archive = new Uint8Array(await response.arrayBuffer());
const archiveDigest = sha256(archive);
if (archiveDigest !== lock.archiveSha256) {
  throw new Error(
    `source archive digest mismatch: observed ${archiveDigest}, expected ${lock.archiveSha256}`,
  );
}

const archivePath = join(outputRoot, ".source.tar.gz");
await Bun.write(archivePath, archive);
const listing = Bun.spawnSync(["tar", "-tzf", archivePath]);
if (listing.exitCode !== 0) {
  throw new Error(`source archive listing failed: ${listing.stderr.toString().trim()}`);
}
for (const entry of listing.stdout.toString().split("\n").filter(Boolean)) {
  if (entry.startsWith("/") || entry.split("/").includes("..")) {
    throw new Error(`source archive contains an unsafe path: ${entry}`);
  }
}

const extraction = Bun.spawnSync([
  "tar",
  "-xzf",
  archivePath,
  "--strip-components=1",
  "-C",
  outputRoot,
]);
if (extraction.exitCode !== 0) {
  throw new Error(`source archive extraction failed: ${extraction.stderr.toString().trim()}`);
}

const licensePath = join(outputRoot, lock.licensePath);
const licenseDigest = sha256(readFileSync(licensePath));
if (licenseDigest !== lock.licenseSha256) {
  throw new Error(
    `source license digest mismatch: observed ${licenseDigest}, expected ${lock.licenseSha256}`,
  );
}

writeFileSync(
  join(outputRoot, ".intar-source-lock.json"),
  `${JSON.stringify({
    schemaVersion: lock.schemaVersion,
    repository: lock.repository,
    revision: lock.revision,
    archiveSha256: lock.archiveSha256,
    license: lock.license,
    licenseSha256: lock.licenseSha256,
  }, null, 2)}\n`,
  { mode: 0o444 },
);

process.stdout.write(
  `Acquired ${lock.repository}@${lock.revision} (${archiveDigest}) into ${outputRoot}\n`,
);
