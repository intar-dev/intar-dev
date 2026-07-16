import { env } from "cloudflare:workers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sha256Hex } from "@/control-plane/auth";
import { agentBootstrapTokens, agentHosts, scenarioRuns } from "@/db/schema";
import { buildStoredBridgeStatus, type AgentHostRow } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { retireHostRuntime } from "@/lib/host-runtime-wake";
import { createAppId, createShortAppId } from "@/lib/id";
import { requireOrganizationRole } from "@/lib/organizations";

const HOST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface OrganizationRunnerRecord {
  id: string;
  name: string;
  role: "agent";
  disabled: boolean;
  scenarioEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  status: ReturnType<typeof buildStoredBridgeStatus>;
  recentRuns: Array<{
    runId: string;
    scenarioId: string;
    state: string;
    createdAt: number;
    updatedAt: number;
  }>;
}

export async function listOrganizationRunners(params: {
  organizationId: string;
  userId: string;
}): Promise<OrganizationRunnerRecord[]> {
  await requireOrganizationRole(params);
  const db = drizzle(env.DB);
  const hosts = await db
    .select(hostSelection())
    .from(agentHosts)
    .where(eq(agentHosts.organizationId, params.organizationId))
    .orderBy(desc(agentHosts.createdAt));

  return Promise.all(hosts.map((host) => serializeRunner(host)));
}

export async function createOrRotateOrganizationRunner(params: {
  organizationId: string;
  actorUserId: string;
  name?: string;
  runnerId?: string;
  baseUrl: string;
}): Promise<{
  runner: OrganizationRunnerRecord;
  bridgeConfigToml: string;
  bootstrapTokenExpiresAt: null;
}> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const db = drizzle(env.DB);
  let host = params.runnerId
    ? await loadOrganizationRunner(params.organizationId, params.runnerId)
    : null;
  if (params.runnerId && !host) {
    throw appError(404, "runner_not_found", "runner not found");
  }

  if (!host) {
    const name = normalizeRunnerName(params.name);
    const existing = await db
      .select(hostSelection())
      .from(agentHosts)
      .where(
        and(
          eq(agentHosts.organizationId, params.organizationId),
          eq(agentHosts.name, name),
        ),
      )
      .limit(1);
    host = existing[0] ?? null;
    if (!host) {
      const now = Date.now();
      const id = await allocateRunnerId(name);
      await db.insert(agentHosts).values({
        id,
        userId: params.actorUserId,
        organizationId: params.organizationId,
        name,
        role: "agent",
        scenarioEnabled: true,
        disabled: false,
        connected: false,
        createdAt: now,
        updatedAt: now,
      });
      host = await loadOrganizationRunner(params.organizationId, id);
    }
  }
  if (!host) {
    throw appError(500, "runner_create_failed", "failed to create runner");
  }
  if (host.role !== "agent") {
    throw appError(
      409,
      "organization_builder_forbidden",
      "organizations can only register scenario runners",
    );
  }

  const token = createBootstrapToken();
  const now = Date.now();
  await db.batch([
    db
      .update(agentBootstrapTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(agentBootstrapTokens.hostId, host.id),
          isNull(agentBootstrapTokens.revokedAt),
        ),
      ),
    db.insert(agentBootstrapTokens).values({
      id: createAppId(),
      hostId: host.id,
      tokenHash: await sha256Hex(token),
      expiresAt: null,
      revokedAt: null,
      createdAt: now,
    }),
  ]);

  return {
    runner: await serializeRunner(host),
    bootstrapTokenExpiresAt: null,
    bridgeConfigToml: buildBridgeConfigToml({
      baseUrl: params.baseUrl,
      hostId: host.id,
      bootstrapToken: token,
    }),
  };
}

export async function setOrganizationRunnerDisabled(params: {
  organizationId: string;
  actorUserId: string;
  runnerId: string;
  disabled: boolean;
}): Promise<OrganizationRunnerRecord> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const db = drizzle(env.DB);
  const updated = await db
    .update(agentHosts)
    .set({ disabled: params.disabled, updatedAt: Date.now() })
    .where(
      and(
        eq(agentHosts.id, params.runnerId),
        eq(agentHosts.organizationId, params.organizationId),
      ),
    )
    .returning(hostSelection());
  if (!updated[0]) {
    throw appError(404, "runner_not_found", "runner not found");
  }
  return serializeRunner(updated[0]);
}

export async function deleteOrganizationRunner(params: {
  organizationId: string;
  actorUserId: string;
  runnerId: string;
}): Promise<void> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const db = drizzle(env.DB);
  const runs = await db
    .select({ runId: scenarioRuns.runId })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.hostId, params.runnerId))
    .limit(1);
  if (runs.length) {
    throw appError(
      409,
      "runner_has_run_history",
      "runner has scenario run history and cannot be deleted",
    );
  }
  const deleted = await db
    .delete(agentHosts)
    .where(
      and(
        eq(agentHosts.id, params.runnerId),
        eq(agentHosts.organizationId, params.organizationId),
      ),
    )
    .returning({ id: agentHosts.id });
  if (!deleted.length) {
    throw appError(404, "runner_not_found", "runner not found");
  }
  try {
    await retireHostRuntime(params.runnerId);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "organization_runner_retirement_failed",
        runnerId: params.runnerId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function loadOrganizationRunner(
  organizationId: string,
  runnerId: string,
): Promise<(AgentHostRow & { role: "agent" | "builder" }) | null> {
  const rows = await drizzle(env.DB)
    .select(hostSelection())
    .from(agentHosts)
    .where(
      and(
        eq(agentHosts.id, runnerId),
        eq(agentHosts.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function serializeRunner(
  host: AgentHostRow,
): Promise<OrganizationRunnerRecord> {
  const recentRuns = await drizzle(env.DB)
    .select({
      runId: scenarioRuns.runId,
      scenarioId: scenarioRuns.scenarioId,
      state: scenarioRuns.state,
      createdAt: scenarioRuns.createdAt,
      updatedAt: scenarioRuns.updatedAt,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.hostId, host.id))
    .orderBy(desc(scenarioRuns.createdAt))
    .limit(5);
  return {
    id: host.id,
    name: host.name,
    role: "agent",
    disabled: Boolean(host.disabled),
    scenarioEnabled: Boolean(host.scenario_enabled),
    createdAt: host.created_at,
    updatedAt: host.updated_at,
    status: buildStoredBridgeStatus(host),
    recentRuns,
  };
}

function hostSelection() {
  return {
    id: agentHosts.id,
    user_id: agentHosts.userId,
    name: agentHosts.name,
    role: agentHosts.role,
    disabled: agentHosts.disabled,
    scenario_enabled: agentHosts.scenarioEnabled,
    connected: agentHosts.connected,
    connected_at: agentHosts.connectedAt,
    disconnected_at: agentHosts.disconnectedAt,
    last_heartbeat_at: agentHosts.lastHeartbeatAt,
    last_inventory_at: agentHosts.lastInventoryAt,
    active_session_id: agentHosts.activeSessionId,
    agent_version: agentHosts.agentVersion,
    inventory_json: agentHosts.inventoryJson,
    created_at: agentHosts.createdAt,
    updated_at: agentHosts.updatedAt,
  };
}

async function allocateRunnerId(name: string): Promise<string> {
  const db = drizzle(env.DB);
  const base = toSafeKey(name) || "runner";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = `${base}-${createShortAppId()}`.slice(0, 64);
    const existing = await db
      .select({ id: agentHosts.id })
      .from(agentHosts)
      .where(eq(agentHosts.id, candidate))
      .limit(1);
    if (!existing.length && HOST_ID_PATTERN.test(candidate)) return candidate;
  }
  throw new Error("failed to allocate runner id");
}

function normalizeRunnerName(input?: string): string {
  return input?.trim().slice(0, 80) || "organization-runner";
}

function toSafeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function createBootstrapToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildBridgeConfigToml(input: {
  baseUrl: string;
  hostId: string;
  bootstrapToken: string;
}): string {
  return [
    "[bridge]",
    "enabled = true",
    `base_url = ${tomlString(input.baseUrl)}`,
    `host_id = ${tomlString(input.hostId)}`,
    `bootstrap_token = ${tomlString(input.bootstrapToken)}`,
    "heartbeat_interval_seconds = 30",
  ].join("\n");
}
