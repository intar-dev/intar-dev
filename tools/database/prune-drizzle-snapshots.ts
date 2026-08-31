#!/usr/bin/env bun

import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export function pruneDrizzleSnapshots(metadataRoot: string): void {
  const snapshots = readdirSync(metadataRoot)
    .filter((name) => /^\d{4}_snapshot\.json$/u.test(name))
    .sort();
  if (snapshots.length === 0) throw new Error("Drizzle generated no snapshot");
  for (const name of snapshots.slice(0, -1)) rmSync(join(metadataRoot, name));
}

if (import.meta.main) {
  pruneDrizzleSnapshots(
    resolve(import.meta.dir, "../../apps/web/migrations/meta"),
  );
}
