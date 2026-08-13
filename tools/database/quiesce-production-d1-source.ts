#!/usr/bin/env bun

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CloudflareD1RestClient } from "./d1-rest-client";
import { runProductionD1SourceQuiescence } from "./production-d1-source-quiescence";

export const SOURCE_QUIESCENCE_CONFIRMATION = "QUIESCE SOURCE CAPABILITIES";

interface CliOptions {
  mode: "dry-run" | "apply";
  sourceDatabaseId: string;
  confirmedSourceDatabaseId: string;
  confirmation: string;
  evidencePath: string;
}

if (import.meta.main) {
  try {
    const cli = parseArguments(process.argv.slice(2));
    if (existsSync(cli.evidencePath)) {
      throw new Error(`evidence path already exists: ${cli.evidencePath}`);
    }
    const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
    const token =
      process.env.CLOUDFLARE_D1_TOKEN?.trim() ||
      requiredEnvironment("CLOUDFLARE_API_TOKEN");
    const result = await runProductionD1SourceQuiescence({
      mode: cli.mode,
      accountId,
      sourceDatabaseId: cli.sourceDatabaseId,
      source: new CloudflareD1RestClient({
        accountId,
        databaseId: cli.sourceDatabaseId,
        token,
      }),
    });
    writeFileSync(cli.evidencePath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        ok: true,
        mode: result.mode,
        status: result.status,
        sourceDatabaseId: result.sourceDatabaseId,
        evidence: cli.evidencePath,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function parseArguments(args: readonly string[]): CliOptions {
  let mode: CliOptions["mode"] | undefined;
  let sourceDatabaseId: string | undefined;
  let confirmedSourceDatabaseId: string | undefined;
  let confirmation: string | undefined;
  let evidencePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run" || argument === "--apply") {
      if (mode) throw new Error("pass exactly one of --dry-run or --apply");
      mode = argument === "--dry-run" ? "dry-run" : "apply";
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    switch (argument) {
      case "--source-database-id":
        sourceDatabaseId = databaseId(value, argument);
        break;
      case "--confirm-source-database-id":
        confirmedSourceDatabaseId = databaseId(value, argument);
        break;
      case "--confirmation":
        confirmation = value;
        break;
      case "--evidence":
        evidencePath = resolve(value);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!mode) throw new Error("pass exactly one of --dry-run or --apply");
  if (!sourceDatabaseId) throw new Error("--source-database-id is required");
  if (!confirmedSourceDatabaseId) {
    throw new Error("--confirm-source-database-id is required");
  }
  if (sourceDatabaseId !== confirmedSourceDatabaseId) {
    throw new Error("confirmed source database ID does not match");
  }
  if (confirmation !== SOURCE_QUIESCENCE_CONFIRMATION) {
    throw new Error(
      `--confirmation must be exactly ${SOURCE_QUIESCENCE_CONFIRMATION}`,
    );
  }
  if (!evidencePath) throw new Error("--evidence is required");
  return {
    mode,
    sourceDatabaseId,
    confirmedSourceDatabaseId,
    confirmation,
    evidencePath,
  };
}

function databaseId(value: string, option: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error(`${option} must be a UUID`);
  }
  return normalized;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
