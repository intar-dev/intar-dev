#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CloudflareD1RestClient,
  type D1StatementResult,
  type D1WriteClient,
} from "./d1-rest-client";

const COUNT_SQL = [
  "SELECT count(*) AS count FROM runtime_executions WHERE domain_kind <> 'scenario'",
  "SELECT count(*) AS count FROM runtime_executions WHERE domain_kind = 'scenario'",
  "SELECT count(*) AS count FROM runtime_vms vm JOIN runtime_executions execution ON execution.id = vm.execution_id WHERE execution.domain_kind = 'scenario'",
  "SELECT count(*) AS count FROM runtime_artifacts artifact JOIN runtime_executions execution ON execution.id = artifact.execution_id WHERE execution.domain_kind = 'scenario'",
] as const;

export async function purgeRemovedRuntimeDomains(client: D1WriteClient) {
  const before = await client.batchRead?.([
    ...COUNT_SQL.map((sql) => ({ sql })),
    {
      sql: "SELECT count(*) AS count FROM runtime_executions child JOIN runtime_executions parent ON parent.id = child.source_execution_id WHERE child.domain_kind = 'scenario' AND parent.domain_kind <> 'scenario'",
    },
  ]);
  if (!before || before.length !== 5) {
    throw new Error("D1 returned an incomplete runtime cleanup preflight");
  }
  const crossDomainSources = count(before[4]!);
  if (crossDomainSources !== 0) {
    throw new Error("scenario runtime history depends on a removed runtime domain");
  }

  const after = await client.batch([
    { sql: "DELETE FROM runtime_executions WHERE domain_kind <> 'scenario'" },
    ...COUNT_SQL.map((sql) => ({ sql })),
  ]);
  if (after.length !== 5) {
    throw new Error("D1 returned an incomplete runtime cleanup result");
  }

  const evidence = {
    removedBefore: count(before[0]!),
    removed: after[0]?.changes ?? null,
    removedAfter: count(after[1]!),
    scenarioExecutionsBefore: count(before[1]!),
    scenarioExecutionsAfter: count(after[2]!),
    scenarioVmsBefore: count(before[2]!),
    scenarioVmsAfter: count(after[3]!),
    scenarioArtifactsBefore: count(before[3]!),
    scenarioArtifactsAfter: count(after[4]!),
    crossDomainSources,
  };
  if (
    evidence.removedAfter !== 0 ||
    evidence.scenarioExecutionsBefore !== evidence.scenarioExecutionsAfter ||
    evidence.scenarioVmsBefore !== evidence.scenarioVmsAfter ||
    evidence.scenarioArtifactsBefore !== evidence.scenarioArtifactsAfter
  ) {
    throw new Error("runtime cleanup changed scenario data");
  }
  return evidence;
}

if (import.meta.main) {
  try {
    const databaseId = requiredEnvironment("CLOUDFLARE_DATABASE_ID");
    const evidencePath = resolve(requiredEnvironment("RUNTIME_PURGE_EVIDENCE"));
    const client = new CloudflareD1RestClient({
      accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
      databaseId,
      token:
        process.env.CLOUDFLARE_D1_TOKEN?.trim() ||
        requiredEnvironment("CLOUDFLARE_API_TOKEN"),
    });
    const evidence = await purgeRemovedRuntimeDomains(client);
    writeFileSync(
      evidencePath,
      `${JSON.stringify({ databaseId, ...evidence }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function count(result: D1StatementResult): number {
  const value = result.rows[0]?.count;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("D1 returned an invalid runtime cleanup count");
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
