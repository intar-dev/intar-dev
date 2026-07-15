import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifyHostBenchmarkLeaseSchema,
  describeHostBenchmarkLeaseSchema,
  rowsFromSingleWranglerExecution,
} from "./benchmark-contract-migration-core";

const websiteRoot = fileURLToPath(new URL("..", import.meta.url));
const wranglerBin = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const configPath = "wrangler.jsonc";
const migrationPath = "drizzle/0005_host_benchmark_admission_contract.sql";
const tableInfoQuery = "PRAGMA table_info('host_benchmark_leases')";
const triggerQuery = `
  SELECT name
  FROM sqlite_schema
  WHERE type = 'trigger'
  ORDER BY name
`;

await migrateProductionBenchmarkContractSchema();

async function migrateProductionBenchmarkContractSchema(): Promise<void> {
  const before = await readProductionSchema();
  const beforeClassification = classifyHostBenchmarkLeaseSchema(before);
  if (beforeClassification === "contract") {
    console.log(
      "Production host_benchmark_leases already has the exact contract schema and trigger set; skipping 0005.",
    );
    return;
  }
  if (beforeClassification !== "legacy") {
    throw new Error(
      `Refusing production migration: host_benchmark_leases has an unknown or partial schema (${describeHostBenchmarkLeaseSchema(before)}).`,
    );
  }

  console.log(
    "Production host_benchmark_leases has the exact legacy schema and trigger set; applying drained cutover 0005.",
  );
  await runWrangler([
    "d1",
    "execute",
    "DB",
    "--remote",
    "--file",
    migrationPath,
    "--config",
    configPath,
    "--yes",
    "--json",
  ]);

  const after = await readProductionSchema();
  if (classifyHostBenchmarkLeaseSchema(after) !== "contract") {
    throw new Error(
      `Production migration 0005 completed without the exact benchmark contract schema and trigger set (${describeHostBenchmarkLeaseSchema(after)}).`,
    );
  }
  console.log(
    "Verified the exact production benchmark admission contract schema and trigger set.",
  );
}

async function readProductionSchema(): Promise<{
  columns: unknown[];
  triggers: unknown[];
}> {
  const columns = await runSchemaQuery(tableInfoQuery);
  const triggers = await runSchemaQuery(triggerQuery);
  return { columns, triggers };
}

async function runSchemaQuery(query: string): Promise<unknown[]> {
  const stdout = await runWrangler([
    "d1",
    "execute",
    "DB",
    "--remote",
    "--command",
    query,
    "--config",
    configPath,
    "--json",
  ]);
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (error) {
    throw new Error("Wrangler schema query returned invalid JSON", {
      cause: error,
    });
  }
  return rowsFromSingleWranglerExecution(decoded);
}

async function runWrangler(arguments_: string[]): Promise<string> {
  const child = spawn("node", [wranglerBin, ...arguments_], {
    cwd: websiteRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (exitCode !== 0) {
    throw new Error(
      `Wrangler production D1 command failed with exit code ${exitCode}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  if (stderr) process.stderr.write(`${stderr}\n`);
  return stdout;
}
