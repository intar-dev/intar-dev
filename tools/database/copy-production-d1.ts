#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CloudflareD1RestClient } from "./d1-rest-client";
import {
  runProductionD1Copy,
  verifySourceUnchangedAfterCopy,
} from "./production-d1-copy";

interface CliOptions {
  mode: "dry-run" | "apply" | "verify-source-unchanged";
  sourceDatabaseId: string;
  targetDatabaseId: string;
  evidencePath: string;
  pageSize?: number;
  maxRowsPerTable?: number;
  maxTotalRows?: number;
  cutoverAt?: number;
  copyEvidencePath?: string;
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
    const source = new CloudflareD1RestClient({
      accountId,
      databaseId: cli.sourceDatabaseId,
      token,
    });
    const result =
      cli.mode === "verify-source-unchanged"
        ? await verifySourceUnchangedAfterCopy({
            source,
            sourceDatabaseId: cli.sourceDatabaseId,
            targetDatabaseId: cli.targetDatabaseId,
            copyEvidence: JSON.parse(
              readFileSync(cli.copyEvidencePath!, "utf8"),
            ) as unknown,
            settle: async () => {
              await new Promise((resolve) => setTimeout(resolve, 2_000));
            },
          })
        : await runProductionD1Copy({
            mode: cli.mode,
            accountId,
            sourceDatabaseId: cli.sourceDatabaseId,
            targetDatabaseId: cli.targetDatabaseId,
            source,
            target: new CloudflareD1RestClient({
              accountId,
              databaseId: cli.targetDatabaseId,
              token,
            }),
            pageSize: cli.pageSize,
            maxRowsPerTable: cli.maxRowsPerTable,
            maxTotalRows: cli.maxTotalRows,
            cutoverAt: cli.cutoverAt,
          });
    writeFileSync(cli.evidencePath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        ok: true,
        mode: cli.mode,
        status: result.status,
        copiedRows: "copiedRows" in result ? result.copiedRows : undefined,
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
  let targetDatabaseId: string | undefined;
  let evidencePath: string | undefined;
  let pageSize: number | undefined;
  let maxRowsPerTable: number | undefined;
  let maxTotalRows: number | undefined;
  let cutoverAt: number | undefined;
  let copyEvidencePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (
      argument === "--dry-run" ||
      argument === "--apply" ||
      argument === "--verify-source-unchanged"
    ) {
      const nextMode =
        argument === "--dry-run"
          ? "dry-run"
          : argument === "--apply"
            ? "apply"
            : "verify-source-unchanged";
      if (mode) {
        throw new Error(
          "pass exactly one of --dry-run, --apply, or --verify-source-unchanged",
        );
      }
      mode = nextMode;
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
      case "--target-database-id":
        targetDatabaseId = databaseId(value, argument);
        break;
      case "--evidence":
        evidencePath = resolve(value);
        break;
      case "--page-size":
        pageSize = integerArgument(value, argument);
        break;
      case "--max-rows-per-table":
        maxRowsPerTable = integerArgument(value, argument);
        break;
      case "--max-total-rows":
        maxTotalRows = integerArgument(value, argument);
        break;
      case "--cutover-at":
        cutoverAt = integerArgument(value, argument);
        break;
      case "--copy-evidence":
        copyEvidencePath = resolve(value);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!mode) {
    throw new Error(
      "pass exactly one of --dry-run, --apply, or --verify-source-unchanged",
    );
  }
  if (!sourceDatabaseId) throw new Error("--source-database-id is required");
  if (!targetDatabaseId) throw new Error("--target-database-id is required");
  if (sourceDatabaseId === targetDatabaseId) {
    throw new Error("source and target D1 database IDs must be different");
  }
  if (!evidencePath) throw new Error("--evidence is required");
  if (mode === "verify-source-unchanged") {
    if (!copyEvidencePath) throw new Error("--copy-evidence is required");
    if (!existsSync(copyEvidencePath)) {
      throw new Error(`copy evidence does not exist: ${copyEvidencePath}`);
    }
    if (
      pageSize !== undefined ||
      maxRowsPerTable !== undefined ||
      maxTotalRows !== undefined ||
      cutoverAt !== undefined
    ) {
      throw new Error("source verification bounds come only from copy evidence");
    }
  } else if (copyEvidencePath) {
    throw new Error("--copy-evidence is only valid with --verify-source-unchanged");
  }

  return {
    mode,
    sourceDatabaseId,
    targetDatabaseId,
    evidencePath,
    pageSize,
    maxRowsPerTable,
    maxTotalRows,
    cutoverAt,
    copyEvidencePath,
  };
}

function databaseId(value: string, argument: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    )
  ) {
    throw new Error(`${argument} must be a lowercase D1 UUID`);
  }
  return value;
}

function integerArgument(value: string, argument: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${argument} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${argument} must be a positive safe integer`);
  }
  return parsed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
