#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

interface ActiveWorkerVersion {
  versionId: string;
  databaseId: string;
}

export interface ActiveWorkerRuntimeVersion extends ActiveWorkerVersion {
  sessionNamespaceId: string;
}

function assertActiveWorkerVersion(
  deployment: unknown,
  version: unknown,
  expectedDatabaseId: string,
  expectedVersionId?: string,
): ActiveWorkerVersion {
  const deploymentRecord = record(deployment, "deployment");
  const versions = array(deploymentRecord.versions, "deployment.versions");
  if (versions.length !== 1) {
    throw new Error("production must have exactly one active Worker version");
  }
  const active = record(versions[0], "deployment.versions[0]");
  const versionId = text(active.version_id, "deployment version_id");
  if (number(active.percentage, "deployment percentage") !== 100) {
    throw new Error("the active Worker version must receive exactly 100 percent traffic");
  }
  if (expectedVersionId && versionId !== expectedVersionId) {
    throw new Error("the active Worker version does not match the expected version");
  }

  const versionRecord = record(version, "version");
  if (text(versionRecord.id, "version.id") !== versionId) {
    throw new Error("the inspected Worker version is not the active version");
  }
  const resources = record(versionRecord.resources, "version.resources");
  const bindings = array(resources.bindings, "version.resources.bindings");
  const dbBindings = bindings
    .map((binding, index) => record(binding, `version.resources.bindings[${index}]`))
    .filter((binding) => binding.type === "d1" && binding.name === "DB");
  if (dbBindings.length !== 1) {
    throw new Error("the Worker version must have exactly one D1 binding named DB");
  }
  const databaseId = text(dbBindings[0]!.id, "DB binding id");
  if (databaseId !== expectedDatabaseId) {
    throw new Error("the active Worker DB binding does not match the expected database");
  }
  return { versionId, databaseId };
}

export function assertActiveWorkerRuntimeVersion(
  deployment: unknown,
  version: unknown,
  expectedDatabaseId: string,
  expectedSessionNamespaceId: string,
  expectedVersionId?: string,
): ActiveWorkerRuntimeVersion {
  const active = assertActiveWorkerVersion(
    deployment,
    version,
    expectedDatabaseId,
    expectedVersionId,
  );
  return {
    ...active,
    sessionNamespaceId: assertSessionNamespaceBinding(
      version,
      expectedSessionNamespaceId,
    ),
  };
}

function assertSessionNamespaceBinding(
  version: unknown,
  expectedSessionNamespaceId: string,
): string {
  const versionRecord = record(version, "version");
  const resources = record(versionRecord.resources, "version.resources");
  const bindings = array(resources.bindings, "version.resources.bindings");
  const sessionBindings = bindings
    .map((binding, index) => record(binding, `version.resources.bindings[${index}]`))
    .filter(
      (binding) => binding.type === "kv_namespace" && binding.name === "SESSION",
    );
  if (sessionBindings.length !== 1) {
    throw new Error("the Worker version must have exactly one KV binding named SESSION");
  }
  const namespaceId = text(
    sessionBindings[0]!.namespace_id,
    "SESSION namespace id",
  );
  if (namespaceId !== expectedSessionNamespaceId) {
    throw new Error(
      "the Worker SESSION binding does not match the expected namespace",
    );
  }
  return namespaceId;
}

async function main(): Promise<void> {
  const [deploymentPath, versionPath, databaseId, sessionNamespaceId, expectedVersionId] =
    process.argv.slice(2);
  if (!deploymentPath || !versionPath || !databaseId || !sessionNamespaceId) usage();
  const result = assertActiveWorkerRuntimeVersion(
    JSON.parse(await readFile(deploymentPath, "utf8")),
    JSON.parse(await readFile(versionPath, "utf8")),
    databaseId,
    sessionNamespaceId,
    expectedVersionId || undefined,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function usage(): never {
  throw new Error(
    "usage: tools/deploy/worker-version.ts <deployment.json> <version.json> <database-id> <session-namespace-id> [version-id]",
  );
}

if (import.meta.main) await main();
