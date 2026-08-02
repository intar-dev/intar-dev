#!/usr/bin/env bun

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ProviderCapabilities } from "@intar/provider-contracts";
import { assertProviderCapabilities } from "@intar/provider-testkit";

type LiveCapabilities = {
  hetzner: ProviderCapabilities<"hetzner_cloud">;
  gcp: ProviderCapabilities<"gcp_compute">;
};

const root = resolve(import.meta.dir, "../..");
if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error("Live provider capability probe requires protected Cloudflare credentials");
}
const evidencePath = resolve(
  process.argv[2] ?? join(root, ".work/provider-capabilities.json"),
);
const probeRoot = join(root, "tools/providers/live-capability-probe");
const runtimeRoot = await mkdtemp(join(tmpdir(), "intar-provider-capability-probe-"));
const runNumber = Number.parseInt(process.env.GITHUB_RUN_ID ?? "", 10);
const port = Number.isSafeInteger(runNumber) ? 18_000 + (runNumber % 1_000) : 18_976;
const endpoint = `http://127.0.0.1:${port}/capabilities`;
const probeName = `intar-provider-capability-probe-${process.env.GITHUB_RUN_ID ?? process.pid}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}`;

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
    join(probeRoot, "wrangler.jsonc"),
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
  const capabilities = await waitForCapabilities(endpoint, child);
  assertExactKeys(capabilities.hetzner, "hetzner");
  assertExactKeys(capabilities.gcp, "gcp");
  assertProviderCapabilities(capabilities.hetzner, "hetzner_cloud");
  assertProviderCapabilities(capabilities.gcp, "gcp_compute");

  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      schemaVersion: 1,
      sourceSha: process.env.GITHUB_SHA ?? null,
      observedAt: new Date().toISOString(),
      transport: "wrangler_dev_remote_service_binding",
      capabilities,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(`Validated deployed provider RPC capabilities; evidence: ${evidencePath}`);
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
    Bun.sleep(5_000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

async function waitForCapabilities(
  url: string,
  process: Bun.Subprocess,
): Promise<LiveCapabilities> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Remote capability probe exited with ${process.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`Probe returned HTTP ${response.status}`);
      return await response.json() as LiveCapabilities;
    } catch (error) {
      lastError = error;
      await Bun.sleep(1_000);
    }
  }
  throw new Error("Timed out calling deployed provider capabilities", {
    cause: lastError,
  });
}

function assertExactKeys(value: object, provider: string): void {
  const actual = Object.keys(value).sort().join(",");
  const expected = ["operations", "protocolVersion", "providerKind"].sort().join(",");
  if (actual !== expected) {
    throw new Error(`${provider} capabilities shape mismatch: ${actual}`);
  }
}
