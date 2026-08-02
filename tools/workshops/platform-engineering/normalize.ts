import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkshopSourceLock } from "./lock";

export function assertPinnedSource(source: string, lock: WorkshopSourceLock): void {
  const sourceRoot = resolve(source);
  const metadata = lstatSync(sourceRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`pinned source must be a real directory: ${sourceRoot}`);
  }

  const markerPath = join(sourceRoot, ".intar-source-lock.json");
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    for (const [key, expected] of Object.entries({
      schemaVersion: lock.schemaVersion,
      repository: lock.repository,
      revision: lock.revision,
      archiveSha256: lock.archiveSha256,
      license: lock.license,
      licenseSha256: lock.licenseSha256,
    })) {
      if (marker[key] !== expected) {
        throw new Error(`pinned source marker ${key} does not match the reviewed lock`);
      }
    }
    return;
  }

  const revision = runGit(sourceRoot, ["rev-parse", "HEAD"]);
  if (revision !== lock.revision) {
    throw new Error(`source checkout is ${revision || "unknown"}; expected ${lock.revision}`);
  }
  const status = runGit(sourceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status) {
    throw new Error("pinned source checkout has local changes");
  }
}

function runGit(root: string, args: string[]): string {
  const command = Bun.spawnSync(["git", "-C", root, ...args]);
  if (command.exitCode !== 0) {
    throw new Error(command.stderr.toString().trim() || "git source inspection failed");
  }
  return command.stdout.toString().trim();
}
