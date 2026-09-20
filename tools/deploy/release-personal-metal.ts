#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CloudflareD1RestClient, type D1WriteClient } from "../database/d1-rest-client";
import { applyGeneratedMigrations } from "../database/apply-generated-migrations";
import { verifyGeneratedD1Schema } from "../database/generated-d1-schema";
import { assertion, closeMetalGates, closedMetalGates, completeMetalRetirement, loadMetalRetirementEvidence, retireMetalFleet, verifyMetalCollectorHold, verifyRetiredMetalFleet, type MetalRetirementEvidence, type MetalReleaseArtifacts } from "../database/retire-metal-fleet";

interface FleetChecks {
  revision: string;
  stoppedHostIds: string[];
  gatewayRoutes: number;
  gatewaySessions: number;
  hosts: Array<{ id: string; role: "agent" | "builder"; agentVersion: string; doctorPassed: boolean; imagesReady: boolean; gatewayPassed: boolean }>;
  personalMetalProof?: PersonalMetalProof;
}
interface PersonalMetalProof {
  revision: string;
  installerPassed: boolean;
  ownershipPassed: boolean;
  browserNatPassed: boolean;
  nativeSshNatPassed: boolean;
  workspaceAppsNatPassed: boolean;
  evidencePath: string;
}
interface GateOpeningResult {
  databaseId: string;
  revision: string;
  platformRegistration: "open";
  personalRegistration: "open" | "drained";
  admission: "open" | "drained";
  personalMetalProof?: PersonalMetalProof & { evidenceSha256: string };
}
const PERSONAL_METAL_CHECKS = ["installerPassed", "ownershipPassed", "browserNatPassed", "nativeSshNatPassed", "workspaceAppsNatPassed"] as const;
interface ReleaseInput {
  artifacts?: MetalReleaseArtifacts;
  action: "deploy" | "open-platform-registration" | "open-admission";
  client: D1WriteClient;
  databaseId: string;
  revision: string;
  evidenceDir: string;
  deploy: (maintenance: boolean) => Promise<void>;
  collector: (action: "hold" | "release") => Promise<void>;
  proveMaintenance: () => Promise<void>;
  drainRequests: () => Promise<void>;
  retireRuntime: (hostId: string) => Promise<void>;
  evidence?: MetalRetirementEvidence;
  checks?: FleetChecks;
}

/** Reopening is a separate command. Each committed action has durable evidence. */
export async function releasePersonalMetal(input: ReleaseInput) {
  const { client, action } = input;
  const artifacts = input.artifacts;
  if (artifacts && (!/^[1-9][0-9]*$/.test(artifacts.buildArtifactId) ||
      !/^sha256:[0-9a-f]{64}$/.test(artifacts.buildArtifactDigest) || !/^[0-9a-f]{64}$/.test(artifacts.guestToolsPinSha256))) {
    throw new Error("invalid release artifact identity");
  }
  // Bind recovery and gate opening to the exact build and injected tools pin.
  // Preserve the direct CLI identity when no CI artifact record is supplied.
  const identity = { databaseId: input.databaseId, revision: input.revision, ...(artifacts ? { artifacts } : {}),
    operationId: createHash("sha256").update(JSON.stringify(["personal-metal-release-v1", input.databaseId, input.revision,
      ...(artifacts ? [artifacts.buildArtifactId, artifacts.buildArtifactDigest, artifacts.guestToolsPinSha256] : [])])).digest("hex") };
  const saved = await loadMetalRetirementEvidence(client, identity);
  if (action === "deploy") {
    if (saved?.complete) {
      // Recover a lost response or deploy.json. Never close gates or touch the
      // fresh fleet when this operation has already finished.
      await verifyGeneratedD1Schema(client);
      await verifyRetiredMetalFleet(client, saved.evidence.hostIds);
      return saved.evidence;
    }
    if (saved) await client.batch([assertion(closedMetalGates)]);
    else await closeMetalGates(client);
    try {
      await input.collector("hold");
    } catch {
      // The application collector endpoint is deliberately fenced by 503.
      // Resume only with both a live maintenance fence and the durable hold.
      await input.proveMaintenance();
      await verifyMetalCollectorHold(client);
    }
    let retirement = saved?.evidence;
    if (!retirement) {
      await input.deploy(true);
      await input.drainRequests();
      await input.proveMaintenance();
      await client.batch([assertion("NOT EXISTS (SELECT 1 FROM image_registry_operation_writers WHERE released_at IS NULL)")]);
      const migrations = await applyGeneratedMigrations(client);
      await retireMetalFleet(client, Date.now(), { ...identity, migrations });
      retirement = (await loadMetalRetirementEvidence(client, identity))!.evidence;
    }
    await input.proveMaintenance();
    await verifyRetiredMetalFleet(client, retirement.hostIds);
    for (const hostId of retirement.hostIds) await input.retireRuntime(hostId);
    await input.proveMaintenance();
    await verifyRetiredMetalFleet(client, retirement.hostIds);
    return completeMetalRetirement(client, retirement);
  }

  const { evidence, checks } = input;
  if (!evidence || !saved?.complete || JSON.stringify(evidence) !== JSON.stringify(saved.evidence) ||
      !checks || checks.revision !== input.revision || checks.gatewayRoutes !== 0 || checks.gatewaySessions !== 0 ||
      !Array.isArray(checks.stoppedHostIds) || [...checks.stoppedHostIds].sort().join("\n") !== [...evidence.hostIds].sort().join("\n")) {
    throw new Error("matching retirement evidence and stopped-host/gateway checks are required");
  }
  const gate = action === "open-platform-registration" ? "platform_metal_registration" : "personal_metal_registration";
  const completed = (await client.query("SELECT evidence_json FROM runtime_operation_gates WHERE key = ?", [gate])).rows[0]?.evidence_json;
  if (completed != null) {
    const record = JSON.parse(String(completed)) as { operationId: string; action: string; result?: GateOpeningResult };
    if (record.operationId !== identity.operationId || record.action !== action ||
        record.result?.databaseId !== input.databaseId || record.result?.revision !== input.revision ||
        record.result.platformRegistration !== "open" ||
        record.result.personalRegistration !== (action === "open-admission" ? "open" : "drained") ||
        record.result.admission !== (action === "open-admission" ? "open" : "drained")) {
      throw new Error("gate evidence does not match this release action and database");
    }
    // A lost response must not redeploy, recheck a now-busy fleet, or reopen
    // gates that an operator has since closed. Return the committed result.
    return record.result;
  }
  const gateEvidence = (result: GateOpeningResult) => JSON.stringify({ operationId: identity.operationId, action, result });
  await verifyGeneratedD1Schema(client);
  await verifyRetiredMetalFleet(client, evidence.hostIds);
  await client.batch([assertion("EXISTS (SELECT 1 FROM runtime_operation_gates WHERE key = 'personal_metal_retirement' AND state = 'open')")]);
  if (action === "open-platform-registration") {
    await client.batch([assertion(closedMetalGates)]);
    await input.deploy(false);
    const result: GateOpeningResult = { databaseId: input.databaseId, revision: input.revision, platformRegistration: "open", personalRegistration: "drained", admission: "drained" };
    await client.batch([
      assertion(closedMetalGates),
      { sql: "UPDATE runtime_operation_gates SET state = 'open', evidence_json = ?, updated_at = ? WHERE key = 'platform_metal_registration'", params: [gateEvidence(result), Date.now()] },
    ]);
    return result;
  }
  const personalProof = checks.personalMetalProof;
  if (!personalProof || personalProof.revision !== input.revision) throw new Error("personal metal proof for the release revision is required");
  for (const check of PERSONAL_METAL_CHECKS) {
    if (personalProof[check] !== true) throw new Error(`personal metal proof requires ${check}=true`);
  }
  if (typeof personalProof.evidencePath !== "string" || !personalProof.evidencePath.trim()) throw new Error("personal metal supporting evidence is required");
  if (!Array.isArray(checks.hosts) || !checks.hosts.some(host => host.role === "agent") || !checks.hosts.some(host => host.role === "builder")) {
    throw new Error("a fresh platform agent and builder must pass the fleet checks");
  }
  if (new Set(checks.hosts.map(host => host.id)).size !== checks.hosts.length) throw new Error("fleet checks contain duplicate host IDs");
  const guards = [{ sql: "SELECT CASE WHEN (SELECT count(*) FROM agent_hosts WHERE scope = 'platform' AND disabled = 0) = ? THEN 0 ELSE abs(-9223372036854775808) END", params: [checks.hosts.length] }, assertion("(SELECT count(*) FROM runtime_operation_gates WHERE key IN ('image_cutover', 'personal_metal_registration') AND state = 'drained') = 2"), assertion("EXISTS (SELECT 1 FROM runtime_operation_gates WHERE key = 'platform_metal_registration' AND state = 'open')")];
  for (const host of checks.hosts) {
    if (evidence.hostIds.includes(host.id) || !host.doctorPassed || !host.imagesReady || !host.gatewayPassed || !host.agentVersion) {
      throw new Error(`fresh fleet checks failed: ${host.id}`);
    }
    // Repeat the live eligibility checks in the gate-opening transaction.
    guards.push({
      sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM agent_hosts h JOIN host_actual_state a ON a.host_id = h.id
        WHERE h.id = ? AND h.scope = 'platform' AND h.role = ? AND h.agent_version = ?
          AND h.disabled = 0 AND h.connected = 1 AND h.active_session_id IS NOT NULL
          AND h.credential_generation > 0 AND (h.role = 'builder' OR h.scenario_enabled = 1)
          AND h.created_at >= (SELECT updated_at FROM runtime_operation_gates WHERE key = 'platform_metal_registration')
          AND h.last_heartbeat_at >= CAST(unixepoch('subsecond') * 1000 AS INTEGER) - 60000
          AND a.updated_at >= CAST(unixepoch('subsecond') * 1000 AS INTEGER) - 60000
          AND EXISTS (SELECT 1 FROM agent_bootstrap_tokens t WHERE t.host_id = h.id
            AND t.credential_generation = h.credential_generation AND t.revoked_at IS NULL)
        ) THEN 0 ELSE abs(-9223372036854775808) END`,
      params: [host.id, host.role, host.agentVersion],
    });
  }
  await client.batch(guards);
  // Save the operator report and its attestation before any admission opens.
  // Keep the bytes, not only a link that can change or disappear afterward.
  const supportingEvidence = readFileSync(resolve(personalProof.evidencePath));
  if (!supportingEvidence.length) throw new Error("personal metal supporting evidence is empty");
  const evidencePath = resolve(input.evidenceDir, "personal-metal-proof.evidence");
  writeFileSync(evidencePath, supportingEvidence, { flag: "wx", mode: 0o600 });
  const storedProof = { ...personalProof, evidencePath, evidenceSha256: createHash("sha256").update(supportingEvidence).digest("hex") };
  writeFileSync(resolve(input.evidenceDir, "personal-metal-proof.json"), JSON.stringify(storedProof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await input.collector("release");
  const result: GateOpeningResult = { databaseId: input.databaseId, revision: input.revision, platformRegistration: "open", personalRegistration: "open", admission: "open", personalMetalProof: storedProof };
  await client.batch([
    ...guards,
    { sql: "UPDATE runtime_operation_gates SET state = 'open', updated_at = ? WHERE key IN ('image_cutover', 'personal_metal_registration') AND state = 'drained'", params: [Date.now()] },
    { sql: "UPDATE runtime_operation_gates SET evidence_json = ? WHERE key = 'personal_metal_registration'", params: [gateEvidence(result)] },
  ]);
  return result;
}

if (import.meta.main) {
  try {
    const [action, configPath, databaseId, secretsPath, evidenceDir, checksPath] = process.argv.slice(2);
    if (!["deploy", "open-platform-registration", "open-admission"].includes(action ?? "") || !configPath || !databaseId || !secretsPath || !evidenceDir) {
      throw new Error("usage: bun tools/deploy/release-personal-metal.ts <deploy|open-platform-registration|open-admission> <built-wrangler.json> <database-id> <secrets.json> <evidence-dir> [fleet-checks.json]");
    }
    const revision = required("GITHUB_SHA");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config.vars?.CONTROL_PLANE_MAINTENANCE !== (action === "deploy" ? "on" : "off")) throw new Error("config maintenance mode does not match the requested action");
    if (config.d1_databases?.find((binding: { binding: string }) => binding.binding === "DB")?.database_id !== databaseId) throw new Error("config database ID does not match");
    let artifacts: MetalReleaseArtifacts | undefined;
    if (process.env.PERSONAL_METAL_RELEASE_INPUTS_FILE) {
      const receipt = JSON.parse(readFileSync(process.env.PERSONAL_METAL_RELEASE_INPUTS_FILE, "utf8"));
      const pin = config.vars?.SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON;
      if (receipt.revision !== revision || typeof pin !== "string" || !pin) throw new Error("release inputs do not match the configuration");
      artifacts = { buildArtifactId: receipt.buildArtifactId, buildArtifactDigest: receipt.buildArtifactDigest,
        guestToolsPinSha256: createHash("sha256").update(pin).digest("hex") };
    }
    const secret = JSON.parse(readFileSync(secretsPath, "utf8")).CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET;
    if (typeof secret !== "string" || secret.length < 32) throw new Error("maintenance secret is required");
    const root = resolve(import.meta.dir, "../..");
    const outputRoot = resolve(evidenceDir);
    if (existsSync(resolve(outputRoot, `${action}.json`))) throw new Error("action evidence already exists; use the next release action");
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    const attempt = resolve(outputRoot, `${action}-${Date.now()}`);
    mkdirSync(attempt, { mode: 0o700 });
    const run = (script: string, args: string[], extra: Record<string, string> = {}) => {
      const result = spawnSync("bash", [resolve(root, script), ...args], {
        cwd: root, stdio: "inherit", env: { ...process.env, CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: secret, ...extra },
      });
      if (result.status !== 0) throw new Error(`${script} failed; gates remain closed`);
    };
    const client = new CloudflareD1RestClient({ accountId: required("CLOUDFLARE_ACCOUNT_ID"), databaseId,
      token: process.env.CLOUDFLARE_D1_TOKEN?.trim() || required("CLOUDFLARE_API_TOKEN") });
    const evidence = action === "deploy" ? undefined : JSON.parse(readFileSync(resolve(outputRoot, "deploy.json"), "utf8"));
    const checks = checksPath ? JSON.parse(readFileSync(checksPath, "utf8")) : undefined;
    const proof = await releasePersonalMetal({ action: action as ReleaseInput["action"], client, databaseId, revision, evidenceDir: attempt, evidence, checks, artifacts,
      deploy: async maintenance => run("tools/deploy/deploy-web.sh", [resolve(configPath), databaseId, resolve(secretsPath), resolve(attempt, "web.json")], { WEB_DEPLOY_LABEL: maintenance ? "metal-closed" : "metal-registration" }),
      collector: async phase => run("tools/deploy/registry-cleanup-gate.sh", [phase, process.env.REGISTRY_CLEANUP_MODE || "report-only", resolve(attempt, `collector-${phase}.json`)]),
      drainRequests: async () => { await new Promise(resolve => setTimeout(resolve, 60_000)); },
      proveMaintenance: async () => {
        const response = await fetch("https://intar.dev/api/control-plane-maintenance-probe", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (response.status !== 503 || (await response.json() as { code?: string }).code !== "maintenance") throw new Error("maintenance fence is not closed");
      },
      retireRuntime: async hostId => {
        const response = await fetch("https://intar.dev/api/maintenance/personal-metal/retire", {
          method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify({ hostId }), signal: AbortSignal.timeout(30_000),
        });
        const body = await response.json() as { ok?: boolean; hostId?: string; alarmCleared?: boolean };
        if (!response.ok || body.ok !== true || body.hostId !== hostId || body.alarmCleared !== true) throw new Error(`runtime retirement failed: ${hostId}`);
      },
    });
    writeFileSync(resolve(outputRoot, `${action}.json`), JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`${action} complete. Evidence: ${outputRoot}/${action}.json`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
