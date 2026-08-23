#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export interface WranglerVersionUpload {
  versionId: string;
}

export interface WranglerVersionDeploy {
  deploymentId: string;
}

export interface WranglerDeploy {
  versionId: string;
}

export function parseWranglerNdjson(contents: string): unknown[] {
  const lines = contents.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("Wrangler output must not be empty");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Wrangler output line ${index + 1} is not valid JSON`);
    }
  });
}

export function assertWranglerVersionUpload(
  events: unknown,
  expectedWorkerName: string,
): WranglerVersionUpload {
  const records = outputRecords(events);
  rejectCommandFailures(records);
  const event = oneEvent(records, "version-upload");
  assertOutputVersion(event);
  if (text(event.worker_name, "version-upload worker_name") !== expectedWorkerName) {
    throw new Error("Wrangler uploaded a version for an unexpected Worker");
  }
  if (event.worker_name_overridden !== false) {
    throw new Error("Wrangler unexpectedly overrode the Worker name");
  }
  return { versionId: uuid(event.version_id, "version-upload version_id") };
}

export function assertWranglerVersionDeploy(
  events: unknown,
  expectedWorkerName: string,
): WranglerVersionDeploy {
  const records = outputRecords(events);
  rejectCommandFailures(records);
  const event = oneEvent(records, "version-deploy");
  assertOutputVersion(event);
  if (text(event.worker_name, "version-deploy worker_name") !== expectedWorkerName) {
    throw new Error("Wrangler deployed a version for an unexpected Worker");
  }
  return { deploymentId: uuid(event.deployment_id, "version-deploy deployment_id") };
}

export function assertWranglerDeploy(
  events: unknown,
  expectedWorkerName: string,
): WranglerDeploy {
  const records = outputRecords(events);
  rejectCommandFailures(records);
  const event = oneEvent(records, "deploy");
  assertOutputVersion(event);
  if (text(event.worker_name, "deploy worker_name") !== expectedWorkerName) {
    throw new Error("Wrangler deployed an unexpected Worker");
  }
  if (event.worker_name_overridden !== false) {
    throw new Error("Wrangler unexpectedly overrode the Worker name");
  }
  return { versionId: uuid(event.version_id, "deploy version_id") };
}

async function main(): Promise<void> {
  const [command, outputPath, workerName] = process.argv.slice(2);
  if (!outputPath || !workerName) usage();
  const events = parseWranglerNdjson(await readFile(outputPath, "utf8"));
  if (command === "version-upload") {
    process.stdout.write(`${JSON.stringify(assertWranglerVersionUpload(events, workerName))}\n`);
    return;
  }
  if (command === "version-deploy") {
    process.stdout.write(`${JSON.stringify(assertWranglerVersionDeploy(events, workerName))}\n`);
    return;
  }
  if (command === "deploy") {
    process.stdout.write(
      `${JSON.stringify(assertWranglerDeploy(events, workerName))}\n`,
    );
    return;
  }
  usage();
}

function outputRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw new TypeError("Wrangler output must be an array");
  return value.map((event, index) => record(event, `Wrangler output event ${index + 1}`));
}

function rejectCommandFailures(events: JsonRecord[]): void {
  if (events.some((event) => event.type === "command-failed")) {
    throw new Error("Wrangler reported a failed command");
  }
}

function oneEvent(events: JsonRecord[], type: string): JsonRecord {
  const matching = events.filter((event) => event.type === type);
  if (matching.length !== 1) {
    throw new Error(`Wrangler output must contain exactly one ${type} event`);
  }
  return matching[0]!;
}

function assertOutputVersion(event: JsonRecord): void {
  if (event.version !== 1) throw new Error("unsupported Wrangler output event version");
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${label} must be a lowercase UUID`);
  return parsed;
}

function usage(): never {
  throw new Error(
    "usage: tools/deploy/wrangler-output.ts deploy|version-upload|version-deploy <wrangler-output.ndjson> <worker-name>",
  );
}

if (import.meta.main) await main();
