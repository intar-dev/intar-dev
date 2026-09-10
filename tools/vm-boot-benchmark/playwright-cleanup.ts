import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserType, Page } from "../../apps/web/node_modules/@playwright/test";

const requireFromWeb = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = requireFromWeb("@playwright/test") as {
  chromium: BrowserType;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

interface CleanupOptions {
  origin: string;
  storageState: string;
  runId: string;
  timeoutMs: number;
}

interface CleanupResult {
  schemaVersion: 1;
  runId: string;
  destroyAcceptedUnixMs: number | null;
  completedUnixMs: number;
  state: "absent" | "terminal";
  phase?: "completed" | "failed";
  polls: number;
}

const USAGE = `Usage:
  bun tools/vm-boot-benchmark/playwright-cleanup.ts \\
    --origin <https://intar.example> \\
    --storage-state <playwright-storage-state.json> \\
    --run-id <server-scenario-run-id> [--timeout-ms <milliseconds>]`;

export function parseCleanupArguments(argv: string[]): CleanupOptions {
  const values = new Map<string, string>();
  const known = new Set(["origin", "storage-state", "run-id", "timeout-ms"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const equalsAt = argument.indexOf("=");
    const key = argument.slice(2, equalsAt === -1 ? undefined : equalsAt);
    if (!known.has(key)) throw new Error(`unknown option: --${key}`);
    if (values.has(key)) throw new Error(`option supplied more than once: --${key}`);
    const value =
      equalsAt === -1 ? argv[++index] : argument.slice(equalsAt + 1);
    if (!value || value.startsWith("--")) {
      throw new Error(`option requires a value: --${key}`);
    }
    values.set(key, value);
  }

  const required = (key: string) => {
    const value = values.get(key)?.trim();
    if (!value) throw new Error(`missing required option: --${key}`);
    return value;
  };
  const timeoutMs = Number(values.get("timeout-ms") ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be an integer of at least 1000");
  }
  const storageState = resolve(required("storage-state"));
  if (!existsSync(storageState)) throw new Error("--storage-state does not exist");

  return {
    origin: normalizeOrigin(required("origin")),
    storageState,
    runId: requireSafeRunId(required("run-id")),
    timeoutMs,
  };
}

function normalizeOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--origin must be an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("--origin must be a plain HTTP(S) origin");
  }
  return url.origin;
}

function requireSafeRunId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value)) {
    throw new Error("--run-id contains unsupported characters");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function terminalStatus(value: unknown): "completed" | "failed" | null {
  const status = asRecord(value);
  const phase = status?.phase;
  const vms = Array.isArray(status?.vms) ? status.vms : null;
  if ((phase !== "completed" && phase !== "failed") || !vms) return null;
  return vms.every((vm) => {
    const vmPhase = asRecord(vm)?.phase;
    return vmPhase === "completed";
  })
    ? phase
    : null;
}

function remainingTimeout(deadlineUnixMs: number) {
  const remaining = deadlineUnixMs - Date.now();
  if (remaining <= 0) throw new Error("cleanup timed out");
  return remaining;
}

async function destroyRun(page: Page, runId: string) {
  return page.evaluate(async (targetRunId: string) => {
    const response = await fetch(
      `/api/scenarios/runs/${encodeURIComponent(targetRunId)}/destroy`,
      { method: "POST", credentials: "include" },
    );
    const body = (await response.json().catch(() => null)) as unknown;
    const record =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    return {
      status: response.status,
      accepted: record?.accepted === true,
      acceptedUnixMs:
        typeof record?.acceptedAt === "number" ? record.acceptedAt : null,
    };
  }, runId);
}

async function readStatus(page: Page, runId: string) {
  return page.evaluate(async (targetRunId: string) => {
    const response = await fetch(
      `/api/scenarios/runs/${encodeURIComponent(targetRunId)}/status`,
      { credentials: "include", cache: "no-store" },
    );
    const body = (await response.json().catch(() => null)) as unknown;
    const record =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    return { status: response.status, statusBody: record?.status ?? null };
  }, runId);
}

export async function cleanupScenarioRun(options: CleanupOptions): Promise<CleanupResult> {
  const deadlineUnixMs = Date.now() + options.timeoutMs;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: options.storageState });
  const page = await context.newPage();

  try {
    await page.goto(options.origin, {
      waitUntil: "domcontentloaded",
      timeout: remainingTimeout(deadlineUnixMs),
    });
    const destroy = await destroyRun(page, options.runId);
    if (destroy.status === 404) {
      return {
        schemaVersion: 1,
        runId: options.runId,
        destroyAcceptedUnixMs: null,
        completedUnixMs: Date.now(),
        state: "absent",
        polls: 0,
      };
    }
    if (!destroy.accepted) {
      throw new Error(`scenario destroy request failed (HTTP ${destroy.status})`);
    }

    for (let polls = 1; ; polls += 1) {
      const current = await readStatus(page, options.runId);
      if (current.status === 404) {
        return {
          schemaVersion: 1,
          runId: options.runId,
          destroyAcceptedUnixMs: destroy.acceptedUnixMs,
          completedUnixMs: Date.now(),
          state: "absent",
          polls,
        };
      }
      if (current.status !== 200) {
        throw new Error(`scenario status request failed (HTTP ${current.status})`);
      }
      const phase = terminalStatus(current.statusBody);
      if (phase) {
        return {
          schemaVersion: 1,
          runId: options.runId,
          destroyAcceptedUnixMs: destroy.acceptedUnixMs,
          completedUnixMs: Date.now(),
          state: "terminal",
          phase,
          polls,
        };
      }
      await page.waitForTimeout(Math.min(POLL_MS, remainingTimeout(deadlineUnixMs)));
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await cleanupScenarioRun(parseCleanupArguments(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "cleanup failed";
    process.stderr.write(`playwright cleanup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
