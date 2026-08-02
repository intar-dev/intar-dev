#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";

const orderedKeys = [
  "protocol",
  "service",
  "binary_sha256",
  "terminal_routes",
  "workspace_app_routes",
  "browser_sessions",
  "workspace_app_base_domain",
  "workspace_app_bootstrap_ttl_seconds",
  "workspace_app_session_ttl_seconds",
  "workspace_app_migrations",
] as const;

type PlanKey = (typeof orderedKeys)[number];

export interface StargateDrainEvidence {
  schema_version: 1;
  operation: "stargate-drain";
  protocol: 1;
  service: "active";
  binary_sha256: string;
  counts: {
    terminal_routes: number;
    workspace_app_routes: number;
    browser_sessions: number;
  };
  configuration: {
    workspace_app_base_domain: "intar.app";
    workspace_app_bootstrap_ttl_seconds: 60;
    workspace_app_session_ttl_seconds: 900;
    workspace_app_migrations: "ready";
  };
  healthy: true;
  drained: true;
}

export function assertDrainedStargatePlan(
  output: string,
): StargateDrainEvidence {
  const values = parseExactPlan(output);
  const terminalRoutes = canonicalCount(
    values.terminal_routes,
    "terminal_routes",
  );
  const workspaceAppRoutes = canonicalCount(
    values.workspace_app_routes,
    "workspace_app_routes",
  );
  const browserSessions = canonicalCount(
    values.browser_sessions,
    "browser_sessions",
  );

  if (values.protocol !== "1") {
    throw new Error("Stargate plan protocol must be exactly 1");
  }
  if (values.service !== "active") {
    throw new Error("Stargate service must be active");
  }
  if (!/^[0-9a-f]{64}$/.test(values.binary_sha256)) {
    throw new Error("Stargate binary SHA-256 is malformed");
  }
  if (values.workspace_app_base_domain !== "intar.app") {
    throw new Error("Stargate workspace application base domain is unhealthy");
  }
  if (values.workspace_app_bootstrap_ttl_seconds !== "60") {
    throw new Error("Stargate bootstrap TTL is unhealthy");
  }
  if (values.workspace_app_session_ttl_seconds !== "900") {
    throw new Error("Stargate browser-session TTL is unhealthy");
  }
  if (values.workspace_app_migrations !== "ready") {
    throw new Error("Stargate workspace application migrations are not ready");
  }
  if (terminalRoutes !== 0 || workspaceAppRoutes !== 0 || browserSessions !== 0) {
    throw new Error("Stargate still has live routes or browser sessions");
  }

  return {
    schema_version: 1,
    operation: "stargate-drain",
    protocol: 1,
    service: "active",
    binary_sha256: values.binary_sha256,
    counts: {
      terminal_routes: terminalRoutes,
      workspace_app_routes: workspaceAppRoutes,
      browser_sessions: browserSessions,
    },
    configuration: {
      workspace_app_base_domain: "intar.app",
      workspace_app_bootstrap_ttl_seconds: 60,
      workspace_app_session_ttl_seconds: 900,
      workspace_app_migrations: "ready",
    },
    healthy: true,
    drained: true,
  };
}

function parseExactPlan(output: string): Record<PlanKey, string> {
  if (output.includes("\r")) {
    throw new Error("Stargate plan must use canonical LF line endings");
  }
  const lines = output.endsWith("\n")
    ? output.slice(0, -1).split("\n")
    : output.split("\n");
  if (lines.length !== orderedKeys.length || lines.some((line) => line.length === 0)) {
    throw new Error("Stargate plan must contain exactly the canonical ten lines");
  }

  const parsed = {} as Record<PlanKey, string>;
  orderedKeys.forEach((expectedKey, index) => {
    const line = lines[index]!;
    const separator = line.indexOf("=");
    if (separator <= 0 || line.indexOf("=", separator + 1) !== -1) {
      throw new Error(`Stargate plan line ${index + 1} is malformed`);
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key !== expectedKey || value.length === 0) {
      throw new Error(`Stargate plan line ${index + 1} is not canonical`);
    }
    parsed[expectedKey] = value;
  });
  return parsed;
}

function canonicalCount(value: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const [inputPath, evidencePath] = process.argv.slice(2);
  if (!inputPath || !evidencePath || process.argv.length !== 4) {
    throw new Error("usage: stargate-plan.ts <plan-output> <evidence.json>");
  }
  const evidence = assertDrainedStargatePlan(await readFile(inputPath, "utf8"));
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
}

if (import.meta.main) await main();
