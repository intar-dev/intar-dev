#!/usr/bin/env bun

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CloudflareD1RestClient } from "./d1-rest-client";
import {
  verifyGeneratedD1Schema,
  type GeneratedSchemaExpectation,
} from "./generated-d1-schema";

if (import.meta.main) {
  try {
    const options = parseGeneratedSchemaArguments(process.argv.slice(2));
    if (existsSync(options.evidencePath)) {
      throw new Error(`evidence path already exists: ${options.evidencePath}`);
    }
    const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
    const token =
      process.env.CLOUDFLARE_D1_TOKEN?.trim() ||
      requiredEnvironment("CLOUDFLARE_API_TOKEN");
    const client = new CloudflareD1RestClient({
      accountId,
      databaseId: options.databaseId,
      token,
    });
    const proof = await verifyGeneratedD1Schema(client, {
      expectation: options.expectation,
    });
    const evidence = {
      ...proof,
      accountId,
      databaseId: options.databaseId,
      verifiedAt: new Date().toISOString(),
    };
    writeFileSync(
      options.evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        ok: true,
        databaseId: options.databaseId,
        schemaSha256: proof.schemaSha256,
        evidence: options.evidencePath,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function parseGeneratedSchemaArguments(args: readonly string[]): {
  databaseId: string;
  expectation: GeneratedSchemaExpectation;
  evidencePath: string;
} {
  let databaseId: string | undefined;
  let expectation: GeneratedSchemaExpectation | undefined;
  let evidencePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    switch (argument) {
      case "--database-id":
        if (!uuid(value)) throw new Error("--database-id must be a lowercase UUID");
        databaseId = value;
        break;
      case "--expect":
        if (value !== "full" && value !== "observed-ledger-prefix") {
          throw new Error("--expect must be full or observed-ledger-prefix");
        }
        expectation = value;
        break;
      case "--evidence":
        evidencePath = resolve(value);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!databaseId) throw new Error("--database-id is required");
  if (!expectation) throw new Error("--expect is required");
  if (!evidencePath) throw new Error("--evidence is required");
  return { databaseId, expectation, evidencePath };
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
    value,
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
