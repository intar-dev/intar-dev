import { env } from "cloudflare:workers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { scenarioSources } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

export interface ScenarioSourceRecord {
  id: string;
  scenarioId: string;
  organizationId: string | null;
  hcl: string;
  status: "draft" | "published";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

const SCENARIO_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const HCL_MAX_BYTES = 256 * 1024;

export async function listScenarioSources(
  organizationId: string | null = null,
): Promise<Array<Omit<ScenarioSourceRecord, "hcl">>> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: scenarioSources.id,
      scenarioId: scenarioSources.scenarioId,
      organizationId: scenarioSources.organizationId,
      status: scenarioSources.status,
      createdBy: scenarioSources.createdBy,
      createdAt: scenarioSources.createdAt,
      updatedAt: scenarioSources.updatedAt,
    })
    .from(scenarioSources)
    .where(organizationScope(organizationId))
    .orderBy(desc(scenarioSources.updatedAt));
  return rows;
}

export async function getScenarioSource(
  scenarioId: string,
  organizationId: string | null = null,
): Promise<ScenarioSourceRecord | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioSources)
    .where(
      and(
        eq(scenarioSources.scenarioId, scenarioId),
        organizationScope(organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// Upsert per scenario id — the editor always saves the whole document.
export async function saveScenarioSource(params: {
  scenarioId: string;
  hcl: string;
  userId: string;
  organizationId?: string | null;
}): Promise<ScenarioSourceRecord> {
  const scenarioId = params.scenarioId.trim();
  if (!SCENARIO_ID_PATTERN.test(scenarioId)) {
    throw appError(
      400,
      "invalid_scenario_id",
      "scenario id must be lowercase alphanumeric with hyphens",
    );
  }
  if (!params.hcl.trim()) {
    throw appError(400, "empty_hcl", "scenario HCL is required");
  }
  if (new TextEncoder().encode(params.hcl).length > HCL_MAX_BYTES) {
    throw appError(400, "hcl_too_large", "scenario HCL exceeds 256 KiB");
  }

  const db = drizzle(env.DB);
  const organizationId = params.organizationId ?? null;
  const now = Date.now();
  const id = createAppId();

  await db
    .insert(scenarioSources)
    .values({
      id,
      scenarioId,
      organizationId,
      hcl: params.hcl,
      status: "draft",
      createdBy: params.userId,
    })
    .onConflictDoUpdate({
      target: scenarioSources.scenarioId,
      set: { hcl: params.hcl, updatedAt: now },
      setWhere: organizationScope(organizationId),
    });

  const saved = await getScenarioSource(scenarioId, organizationId);
  if (!saved) {
    throw appError(
      409,
      "scenario_id_conflict",
      "that scenario id belongs to another catalog",
    );
  }
  return saved;
}

export async function deleteScenarioSource(
  scenarioId: string,
  organizationId: string | null = null,
): Promise<void> {
  const db = drizzle(env.DB);
  await db
    .delete(scenarioSources)
    .where(
      and(
        eq(scenarioSources.scenarioId, scenarioId),
        organizationScope(organizationId),
      ),
    );
}

export function namespaceOrganizationScenarioSource(params: {
  organizationSlug: string;
  localScenarioId: string;
  hcl: string;
}): { scenarioId: string; hcl: string } {
  const localScenarioId = params.localScenarioId.trim();
  if (!SCENARIO_ID_PATTERN.test(localScenarioId)) {
    throw appError(
      400,
      "invalid_scenario_id",
      "scenario id must be lowercase alphanumeric with hyphens",
    );
  }
  const scenarioId = `${params.organizationSlug}-${localScenarioId}`;
  if (!SCENARIO_ID_PATTERN.test(scenarioId)) {
    throw appError(
      400,
      "scenario_id_too_long",
      "organization and scenario ids together must not exceed 128 characters",
    );
  }
  const declaration = /(^\s*scenario\s+")([a-zA-Z0-9._-]+)("\s*\{)/m;
  const match = params.hcl.match(declaration);
  if (!match) {
    throw appError(
      400,
      "scenario_declaration_missing",
      "scenario HCL must contain a scenario block with one label",
    );
  }
  if (match[2] !== localScenarioId) {
    throw appError(
      400,
      "scenario_id_mismatch",
      "the scenario block label must match the local scenario id",
    );
  }
  return {
    scenarioId,
    hcl: params.hcl.replace(declaration, `$1${scenarioId}$3`),
  };
}

function organizationScope(organizationId: string | null) {
  return organizationId
    ? eq(scenarioSources.organizationId, organizationId)
    : isNull(scenarioSources.organizationId);
}
