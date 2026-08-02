import { and, asc, eq, lte } from "drizzle-orm";
import {
  workshopSessions,
  workshopTemplateRevisions,
} from "@/db/schema";
import type { FeatureToggleService } from "@/lib/feature-toggles";
import {
  isWorkshopsEnabledForOrganization,
  workshopFeatureToggleService,
} from "./feature-flag";
import { appendWorkshopEvent, workshopDb } from "./shared";
import { refreshWorkshopSessionProviderPreflight } from "./session-provider";

const MAX_DUE_LOBBIES_PER_TICK = 100;

export interface WorkshopAutoLobbyResult {
  due: number;
  opened: number;
  disabled: number;
  conflicted: number;
  providerBlocked: number;
}

/**
 * Opens scheduled workshop lobbies from canonical D1 state. The versioned
 * update also releases every gate module, so a crash cannot leave an open
 * lobby without its pre-session material.
 */
export async function openDueWorkshopLobbies(options: {
  now?: number;
  featureToggles?: FeatureToggleService;
} = {}): Promise<WorkshopAutoLobbyResult> {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("auto-lobby time must be a Unix millisecond timestamp");
  }
  const featureToggles =
    options.featureToggles ?? workshopFeatureToggleService();
  const db = workshopDb();
  const due = await db
    .select({
      id: workshopSessions.id,
      organizationId: workshopSessions.organizationId,
      version: workshopSessions.version,
      releasedModuleIds: workshopSessions.releasedModuleIdsJson,
      manifest: workshopTemplateRevisions.manifestJson,
    })
    .from(workshopSessions)
    .innerJoin(
      workshopTemplateRevisions,
      eq(workshopSessions.templateRevisionId, workshopTemplateRevisions.id),
    )
    .where(
      and(
        eq(workshopSessions.state, "draft"),
        lte(workshopSessions.lobbyOpensAt, now),
      ),
    )
    .orderBy(asc(workshopSessions.lobbyOpensAt), asc(workshopSessions.id))
    .limit(MAX_DUE_LOBBIES_PER_TICK);

  const result: WorkshopAutoLobbyResult = {
    due: due.length,
    opened: 0,
    disabled: 0,
    conflicted: 0,
    providerBlocked: 0,
  };
  for (const session of due) {
    if (
      !(await isWorkshopsEnabledForOrganization(
        session.organizationId,
        featureToggles,
      ))
    ) {
      result.disabled += 1;
      continue;
    }
    try {
      await refreshWorkshopSessionProviderPreflight({
        sessionId: session.id,
        trigger: "lobby_refresh",
      });
    } catch {
      result.providerBlocked += 1;
      continue;
    }
    const gateModuleIds = session.manifest.modules
      .filter((module) => module.tier === "gate")
      .map((module) => module.id);
    const releasedModuleIds = [
      ...new Set([...session.releasedModuleIds, ...gateModuleIds]),
    ];
    const nextVersion = session.version + 1;
    const updated = await db
      .update(workshopSessions)
      .set({
        state: "lobby",
        version: nextVersion,
        releasedModuleIdsJson: releasedModuleIds,
        updatedAt: now,
      })
      .where(
        and(
          eq(workshopSessions.id, session.id),
          eq(workshopSessions.state, "draft"),
          eq(workshopSessions.version, session.version),
        ),
      )
      .returning({ id: workshopSessions.id });
    if (!updated[0]) {
      result.conflicted += 1;
      continue;
    }
    await appendWorkshopEvent(db, {
      organizationId: session.organizationId,
      sessionId: session.id,
      type: "session.lobby",
      payload: {
        previousState: "draft",
        version: nextVersion,
        currentModuleId: null,
        currentSlideId: null,
        timerEndsAt: null,
        automatic: true,
        releasedGateModuleIds: gateModuleIds,
      },
      createdAt: now,
    });
    result.opened += 1;
  }
  return result;
}
