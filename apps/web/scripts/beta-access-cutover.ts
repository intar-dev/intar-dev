import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  betaCutoverOperationalPreflightQueries,
  buildBetaResetSql,
} from "./beta-access-cutover-lib";

interface CutoverArguments {
  remote: boolean;
  adminUserId: string;
  exportPath: string;
  confirmed: boolean;
  targetSpecified: boolean;
}

const cwd = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArguments(process.argv.slice(2));

if (!args.confirmed) {
  fail("Pass --confirm-pure-replacement to acknowledge the destructive cutover.");
}
if (!args.adminUserId) fail("Pass --admin-user-id <existing Better Auth user id>.");
if (!args.exportPath) fail("Pass --export <new checkpoint.sql path>.");
if (!args.targetSpecified) fail("Pass exactly one of --remote or --local.");
if (!isAbsolute(args.exportPath)) fail("The checkpoint path must be absolute.");
await assertNewCheckpointPath(args.exportPath);

if (args.remote) await assertRemoteMaintenanceFence();
await runWrangler([
  "d1",
  "export",
  "DB",
  args.remote ? "--remote" : "--local",
  "--output",
  args.exportPath,
  "--skip-confirmation",
]);

const preflight = await d1Query(`
  SELECT 'provider_account_duplicate' AS issue,
         provider_id || ':' || account_id AS identity,
         COUNT(*) AS duplicate_count
  FROM account
  GROUP BY provider_id, account_id
  HAVING COUNT(*) > 1
  UNION ALL
  SELECT 'github_user_duplicate' AS issue,
         user_id AS identity,
         COUNT(*) AS duplicate_count
  FROM account
  WHERE provider_id = 'github'
  GROUP BY user_id
  HAVING COUNT(*) > 1
`);
if (preflight.length > 0) {
  fail(`Account uniqueness preflight failed: ${JSON.stringify(preflight)}`);
}

const operationalState: Record<string, unknown>[] = [];
for (const query of betaCutoverOperationalPreflightQueries()) {
  operationalState.push(...(await d1Query(query)));
}
if (operationalState.length > 0) {
  fail(
    `Drain scenario runs, personal agents, and workshop routes before cutover: ${JSON.stringify(operationalState)}`,
  );
}

const adminRows = await d1Query(`
  SELECT user.id, user.username, account.account_id
  FROM user
  INNER JOIN account
    ON account.user_id = user.id AND account.provider_id = 'github'
  WHERE user.id = ${sqlString(args.adminUserId)}
    AND length(user.id) BETWEEN 1 AND 255
    AND length(trim(account.account_id)) BETWEEN 1 AND 255
    AND instr(
      ',' || replace(lower(coalesce(user.role, '')), ' ', '') || ',',
      ',admin,'
    ) > 0
    AND coalesce(user.banned, 0) = 0
    AND user.username IS NOT NULL
    AND length(user.username) BETWEEN 1 AND 39
    AND user.username NOT GLOB '*[^A-Za-z0-9-]*'
    AND user.username NOT LIKE '-%'
    AND user.username NOT LIKE '%-'
    AND user.username NOT LIKE '%--%'
  LIMIT 1
`);
if (adminRows.length !== 1) {
  fail(
    "Bootstrap user must be an unbanned Better Auth admin with one GitHub account and a valid GitHub username snapshot.",
  );
}

const baseline = await readFile(
  resolve(cwd, "migrations/0000_clean_multicloud.sql"),
  "utf8",
);
const inviteLifecycleMigration = await readFile(
  resolve(cwd, "migrations/0003_archive_access_invites.sql"),
  "utf8",
);
const now = Date.now();
const resetSql = buildBetaResetSql(
  `${baseline}\n--> statement-breakpoint\n${inviteLifecycleMigration}`,
  now,
);
const temporarySql = resolve(
  "/tmp",
  `intar-beta-access-cutover-${randomUUID()}.sql`,
);

try {
  await writeFile(temporarySql, resetSql, { encoding: "utf8", mode: 0o600 });
  await runWrangler([
    "d1",
    "execute",
    "DB",
    args.remote ? "--remote" : "--local",
    "--file",
    temporarySql,
    "--yes",
  ]);
} finally {
  await unlink(temporarySql).catch(() => undefined);
}

const foreignKeyProblems = await d1Query("PRAGMA foreign_key_check");
if (foreignKeyProblems.length > 0) {
  fail(`Foreign-key check failed after reset: ${JSON.stringify(foreignKeyProblems)}`);
}

const rawCode = `intar_beta_${randomBytes(32).toString("base64url")}`;
const codeHash = createHash("sha256").update(rawCode).digest("hex");
const codePrefix = rawCode.slice(0, "intar_beta_".length + 8);
const inviteId = `bootstrap_${randomUUID().replaceAll("-", "")}`;
await runWrangler([
  "d1",
  "execute",
  "DB",
  args.remote ? "--remote" : "--local",
  "--command",
  `INSERT INTO access_invite_codes (
     id, code_hash, code_prefix, kind, state, label, created_by,
     created_at, expires_at, version, updated_at
   ) VALUES (
     ${sqlString(inviteId)}, ${sqlString(codeHash)}, ${sqlString(codePrefix)},
     'bootstrap_admin', 'pending', 'cutover bootstrap', NULL,
     ${now}, ${now + 14 * 24 * 60 * 60 * 1000}, 1, ${now}
   )`,
  "--yes",
]);

const origin = await configuredOrigin();
console.log("Beta tables and credentials were replaced successfully.");
console.log("The bootstrap link below is shown once. Store it securely:");
console.log(`${origin}/join#invite=${rawCode}`);

async function assertRemoteMaintenanceFence(): Promise<void> {
  const origin = await configuredOrigin();
  const response = await fetch(`${origin}/api/cutover-maintenance-probe`, {
    headers: { accept: "application/json" },
  }).catch(() => null);
  const body = (await response?.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  if (response?.status !== 503 || body?.code !== "maintenance") {
    fail("Remote Worker is not fenced by BETA_ACCESS_MAINTENANCE=on.");
  }
}

async function configuredOrigin(): Promise<string> {
  const config = await readFile(resolve(cwd, "wrangler.jsonc"), "utf8");
  const match = config.match(/"BETTER_AUTH_URL"\s*:\s*"([^"]+)"/u);
  if (!match?.[1]) fail("BETTER_AUTH_URL is missing from wrangler.jsonc.");
  return new URL(match[1]).origin;
}

async function assertNewCheckpointPath(path: string): Promise<void> {
  try {
    await stat(path);
    fail("The checkpoint path already exists; choose a new protected path.");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

async function d1Query(command: string): Promise<Record<string, unknown>[]> {
  const output = await runWrangler([
    "d1",
    "execute",
    "DB",
    args.remote ? "--remote" : "--local",
    "--command",
    command,
    "--json",
    "--yes",
  ], false);
  const parsed = JSON.parse(output) as Array<{
    results?: Record<string, unknown>[];
  }>;
  return parsed.flatMap((entry) => entry.results ?? []);
}

async function runWrangler(
  command: string[],
  inheritOutput = true,
): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn("bunx", ["wrangler", ...command], {
      cwd,
      stdio: inheritOutput ? "inherit" : ["ignore", "pipe", "inherit"],
    });
    let output = "";
    if (!inheritOutput) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`Wrangler exited with status ${exitCode ?? "unknown"}.`));
        return;
      }
      resolveOutput(output);
    });
  }).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : "Wrangler execution failed."),
  );
}

function parseArguments(values: string[]): CutoverArguments {
  const result: CutoverArguments = {
    remote: true,
    adminUserId: "",
    exportPath: "",
    confirmed: false,
    targetSpecified: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--local" || value === "--remote") {
      if (result.targetSpecified) fail("Pass only one cutover target.");
      result.remote = value === "--remote";
      result.targetSpecified = true;
    }
    else if (value === "--confirm-pure-replacement") result.confirmed = true;
    else if (value === "--admin-user-id") result.adminUserId = values[++index] ?? "";
    else if (value === "--export") result.exportPath = values[++index] ?? "";
    else fail(`Unknown argument: ${value}`);
  }
  return result;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
