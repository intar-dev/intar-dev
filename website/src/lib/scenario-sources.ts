import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { scenarioSources } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

export interface ScenarioSourceRecord {
  id: string;
  scenarioId: string;
  hcl: string;
  status: "draft" | "published";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

const SCENARIO_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HCL_MAX_BYTES = 256 * 1024;

export async function listScenarioSources(): Promise<
  Array<Omit<ScenarioSourceRecord, "hcl">>
> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: scenarioSources.id,
      scenarioId: scenarioSources.scenarioId,
      status: scenarioSources.status,
      createdBy: scenarioSources.createdBy,
      createdAt: scenarioSources.createdAt,
      updatedAt: scenarioSources.updatedAt,
    })
    .from(scenarioSources)
    .orderBy(desc(scenarioSources.updatedAt));
  return rows;
}

export async function getScenarioSource(
  scenarioId: string,
): Promise<ScenarioSourceRecord | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioSources)
    .where(eq(scenarioSources.scenarioId, scenarioId))
    .limit(1);
  return rows[0] ?? null;
}

// Upsert per scenario id — the editor always saves the whole document.
export async function saveScenarioSource(params: {
  scenarioId: string;
  hcl: string;
  userId: string;
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
  const now = Date.now();
  const id = createAppId();

  await db
    .insert(scenarioSources)
    .values({
      id,
      scenarioId,
      hcl: params.hcl,
      status: "draft",
      createdBy: params.userId,
    })
    .onConflictDoUpdate({
      target: scenarioSources.scenarioId,
      set: { hcl: params.hcl, updatedAt: now },
    });

  const saved = await getScenarioSource(scenarioId);
  if (!saved) {
    throw appError(500, "save_failed", "failed to save scenario source");
  }
  return saved;
}

export async function deleteScenarioSource(scenarioId: string): Promise<void> {
  const db = drizzle(env.DB);
  await db
    .delete(scenarioSources)
    .where(eq(scenarioSources.scenarioId, scenarioId));
}
