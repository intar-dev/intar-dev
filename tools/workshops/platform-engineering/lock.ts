import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface WorkshopSourceLock {
  schemaVersion: 1;
  repository: string;
  revision: string;
  archiveUrl: string;
  archiveSha256: string;
  license: "Apache-2.0";
  licensePath: string;
  licenseSha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;

export function loadSourceLock(
  path = resolve(
    import.meta.dir,
    "../../../content/workshops/platform-engineering/locks/source.lock.json",
  ),
): WorkshopSourceLock {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`source lock must be a JSON object: ${path}`);
  }
  const value = parsed as Record<string, unknown>;
  const lock: WorkshopSourceLock = {
    schemaVersion: expect(value, "schemaVersion", 1),
    repository: expectString(value, "repository"),
    revision: expectString(value, "revision"),
    archiveUrl: expectString(value, "archiveUrl"),
    archiveSha256: expectString(value, "archiveSha256"),
    license: expect(value, "license", "Apache-2.0"),
    licensePath: expectString(value, "licensePath"),
    licenseSha256: expectString(value, "licenseSha256"),
  };
  if (!REVISION.test(lock.revision)) throw new Error("source lock revision is invalid");
  if (!SHA256.test(lock.archiveSha256)) throw new Error("source archive digest is invalid");
  if (!SHA256.test(lock.licenseSha256)) throw new Error("source license digest is invalid");
  const archive = new URL(lock.archiveUrl);
  const repository = new URL(lock.repository);
  if (archive.protocol !== "https:" || repository.protocol !== "https:") {
    throw new Error("source lock URLs must use HTTPS");
  }
  if (archive.username || archive.password || repository.username || repository.password) {
    throw new Error("source lock URLs must not contain credentials");
  }
  if (lock.licensePath !== "LICENSE") {
    throw new Error("the pinned Apache-2.0 license must remain at LICENSE");
  }
  return lock;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`source lock ${key} must be a non-empty string`);
  }
  return field;
}

function expect<T extends string | number>(
  value: Record<string, unknown>,
  key: string,
  expected: T,
): T {
  if (value[key] !== expected) {
    throw new Error(`source lock ${key} must equal ${JSON.stringify(expected)}`);
  }
  return expected;
}
