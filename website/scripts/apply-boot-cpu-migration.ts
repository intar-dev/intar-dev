import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifyHostCpuReservationSchema,
  describeHostCpuReservationSchema,
  tableInfoRowsFromWranglerJson,
} from "./boot-cpu-migration-core";

const websiteRoot = fileURLToPath(new URL("..", import.meta.url));
const wranglerBin = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const configPath = "wrangler.jsonc";
const migrationPath = "drizzle/0003_boot_cpu_reservation_phases.sql";
const tableInfoQuery = "PRAGMA table_info('host_cpu_reservations')";

await migrateProductionBootCpuSchema();

async function migrateProductionBootCpuSchema(): Promise<void> {
  const before = await readProductionSchema();
  const beforeClassification = classifyHostCpuReservationSchema(before);

  if (beforeClassification === "boot_phase") {
    console.log(
      "Production host_cpu_reservations already has the exact boot-phase schema; skipping 0003.",
    );
    return;
  }
  if (beforeClassification !== "legacy") {
    throw new Error(
      `Refusing production migration: host_cpu_reservations has an unknown or partial schema (${describeHostCpuReservationSchema(before)}).`,
    );
  }

  console.log(
    "Production host_cpu_reservations has the exact legacy schema; applying drained cutover 0003.",
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
  const afterClassification = classifyHostCpuReservationSchema(after);
  if (afterClassification !== "boot_phase") {
    throw new Error(
      `Production migration 0003 completed without the exact boot-phase schema (${describeHostCpuReservationSchema(after)}).`,
    );
  }
  console.log(
    "Verified the exact production boot-phase host_cpu_reservations schema.",
  );
}

async function readProductionSchema(): Promise<unknown[]> {
  const stdout = await runWrangler([
    "d1",
    "execute",
    "DB",
    "--remote",
    "--command",
    tableInfoQuery,
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
  return tableInfoRowsFromWranglerJson(decoded);
}

async function runWrangler(arguments_: string[]): Promise<string> {
  const child = spawn(process.execPath, [wranglerBin, ...arguments_], {
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
    child.once("exit", (code) => resolve(code ?? 1));
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
