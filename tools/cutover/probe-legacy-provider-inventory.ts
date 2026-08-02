#!/usr/bin/env bun

import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [databaseName, databaseId, outputArgument] = process.argv.slice(2);
if (
  !databaseName ||
  !/^[a-z0-9][a-z0-9-]{0,62}$/.test(databaseName) ||
  !databaseId ||
  !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(databaseId) ||
  !outputArgument
) {
  throw new Error(
    "usage: probe-legacy-provider-inventory.ts <database-name> <database-id> <evidence.json>",
  );
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error("legacy provider inventory probe requires protected Cloudflare credentials");
}

const root = resolve(import.meta.dir, "../..");
const outputPath = resolve(outputArgument);
const runtimeRoot = await mkdtemp(join(tmpdir(), "intar-legacy-provider-probe-"));
const runNumber = Number.parseInt(process.env.GITHUB_RUN_ID ?? "", 10);
const port = Number.isSafeInteger(runNumber) ? 19_000 + (runNumber % 1_000) : 19_976;
const endpoint = `http://127.0.0.1:${port}/inventory`;
const probeName = `intar-legacy-provider-inventory-${process.env.GITHUB_RUN_ID ?? process.pid}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}`;
const configPath = join(runtimeRoot, "wrangler.jsonc");
await writeFile(
  configPath,
  `${JSON.stringify({
    name: probeName,
    main: join(root, "tools/cutover/legacy-provider-inventory-probe/src/index.ts"),
    compatibility_date: "2026-07-09",
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      { binding: "LEGACY_DB", database_name: databaseName, database_id: databaseId },
    ],
    services: [
      {
        binding: "HCLOUD_PROVIDER_SERVICE",
        service: "intar-hcloud-provider",
        entrypoint: "HcloudProviderService",
      },
    ],
  }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const child = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--remote",
    "--name",
    probeName,
    "--port",
    String(port),
    "--config",
    configPath,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(runtimeRoot, "wrangler-logs"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  },
);
const stdout = new Response(child.stdout).text();
const stderr = new Response(child.stderr).text();

try {
  const evidence = await waitForEvidence(endpoint, child);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(outputPath, 0o600);
  assertProvenEmpty(evidence);
  console.log(`Proved the legacy Hetzner project is empty; evidence: ${outputPath}`);
} catch (error) {
  child.kill("SIGTERM");
  const [capturedStdout, capturedStderr] = await Promise.all([stdout, stderr]);
  if (capturedStdout.trim()) console.error(capturedStdout.trim());
  if (capturedStderr.trim()) console.error(capturedStderr.trim());
  throw error;
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    child.exited,
    Bun.sleep(5_000).then(() => child.kill("SIGKILL")),
  ]);
}

async function waitForEvidence(url: string, process: Bun.Subprocess): Promise<unknown> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`remote legacy provider probe exited with ${process.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.headers.get("x-intar-legacy-provider-probe") !== "live") {
        throw new Error("legacy provider probe marker is missing");
      }
      const evidence = await response.json();
      if (response.status !== 200 && response.status !== 409) {
        throw new Error(`legacy provider probe returned HTTP ${response.status}`);
      }
      return evidence;
    } catch (error) {
      lastError = error;
      await Bun.sleep(1_000);
    }
  }
  throw new Error("timed out calling the legacy provider inventory probe", {
    cause: lastError,
  });
}

function assertProvenEmpty(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy provider evidence is not an object");
  }
  const evidence = value as Record<string, unknown>;
  if (
    evidence.schemaVersion !== 1 ||
    evidence.transport !== "legacy_encrypted_credential_via_provider_service_binding" ||
    evidence.provenEmpty !== true ||
    typeof evidence.connectionCount !== "number" ||
    evidence.connectionCount < 1 ||
    !Array.isArray(evidence.connections) ||
    evidence.connections.length !== evidence.connectionCount
  ) {
    throw new Error("legacy provider inventory is not proven empty");
  }
}
