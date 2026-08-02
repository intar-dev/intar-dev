import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  workshopEvents,
  workshopSessionRuntimeSelections,
  workshopSessions,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { requireOrganizationRole } from "@/lib/organizations";
import { getWorkshopCostProjection } from "./cost-storage";

export async function overrideWorkshopSessionCostCeiling(input: {
  organizationId: string;
  sessionId: string;
  actorUserId: string;
  now?: number;
}): Promise<{
  sessionId: string;
  overriddenAt: number;
  overriddenBy: string;
}> {
  const role = await requireOrganizationRole({
    organizationId: input.organizationId,
    userId: input.actorUserId,
  });
  if (role !== "owner") {
    throw appError(
      403,
      "organization_owner_required",
      "organization owner role required",
    );
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      organizationId: workshopSessions.organizationId,
      providerKind: workshopSessionRuntimeSelections.providerKind,
      overrideAt: workshopSessionRuntimeSelections.grossCeilingOverrideAt,
    })
    .from(workshopSessions)
    .innerJoin(
      workshopSessionRuntimeSelections,
      eq(workshopSessionRuntimeSelections.sessionId, workshopSessions.id),
    )
    .where(
      and(
        eq(workshopSessions.id, input.sessionId),
        eq(workshopSessions.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  if (row.providerKind === "agent_kvm") {
    throw appError(
      409,
      "workshop_cost_ceiling_not_applicable",
      "agent KVM sessions do not use cloud cost ceilings",
    );
  }
  if (row.overrideAt !== null) {
    throw appError(
      409,
      "workshop_cost_ceiling_already_overridden",
      "workshop cost ceiling already has an owner override",
    );
  }
  const projection = await getWorkshopCostProjection({
    sessionId: input.sessionId,
  });
  if (
    projection.latestForecast?.exceedsBudgetCeiling !== true &&
    projection.live?.overBudgetCeiling !== true
  ) {
    throw appError(
      409,
      "workshop_cost_ceiling_not_exceeded",
      "workshop cost ceiling is not currently exceeded",
    );
  }
  const now = input.now ?? Date.now();
  await db.batch([
    db
      .update(workshopSessionRuntimeSelections)
      .set({
        grossCeilingOverrideAt: now,
        grossCeilingOverrideBy: input.actorUserId,
        updatedAt: now,
      })
      .where(eq(workshopSessionRuntimeSelections.sessionId, input.sessionId)),
    db.insert(workshopEvents).values({
      id: createAppId(),
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      type: "runtime_provider.cost_ceiling_overridden",
      payloadJson: { providerKind: row.providerKind },
      createdAt: now,
    }),
  ]);
  return {
    sessionId: input.sessionId,
    overriddenAt: now,
    overriddenBy: input.actorUserId,
  };
}
