import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notExists,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  accessAllowlist,
  agentBootstrapTokens,
  agentHosts,
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  hostResourceReservations,
  imageBuilds,
  runtimeExecutions,
  scenarioRuns,
  workshopPublications,
} from "@/db/schema";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import { nonDetachableWorkshopPublication } from "@/lib/agent-host-deletion";

interface RetirePersonalHostInput {
  d1: D1Database;
  hostId: string;
  userId: string;
  betaAdmission: BetaAdmissionEpoch;
  now?: number;
}

/**
 * Removes a personal host from the active fleet without destroying the audit
 * identity referenced by historical runs, builds, and publications.
 *
 * The disabling update, credential revocation, and ephemeral-state cleanup are
 * one D1 batch. Every dependent statement is causally fenced on the exact
 * disabled host row, while the first update rechecks admission and all active
 * work at commit time.
 */
export async function retirePersonalHost(
  input: RetirePersonalHostInput,
): Promise<boolean> {
  const hostId = input.hostId.trim();
  const userId = input.userId.trim();
  const now = input.now ?? Date.now();
  if (!hostId || !userId || !Number.isSafeInteger(now) || now < 0) return false;

  const db = drizzle(input.d1);
  const exactAdmission = () =>
    exists(
      db
        .select({ userId: accessAllowlist.userId })
        .from(accessAllowlist)
        .where(
          and(
            eq(accessAllowlist.userId, userId),
            eq(accessAllowlist.state, "active"),
            eq(
              accessAllowlist.sourceInviteId,
              input.betaAdmission.sourceInviteId,
            ),
            eq(
              accessAllowlist.sourceLeaseId,
              input.betaAdmission.sourceLeaseId,
            ),
            eq(accessAllowlist.grantedAt, input.betaAdmission.grantedAt),
          ),
        ),
    );
  const noActiveWork = () => [
    notExists(
      db
        .select({ runId: scenarioRuns.runId })
        .from(scenarioRuns)
        .where(
          and(
            eq(scenarioRuns.hostId, hostId),
            isNotNull(scenarioRuns.activeKey),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: runtimeExecutions.id })
        .from(runtimeExecutions)
        .where(
          and(
            eq(runtimeExecutions.hostId, hostId),
            inArray(runtimeExecutions.state, [
              "queued",
              "provisioning",
              "ready",
              "archiving",
            ]),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: imageBuilds.id })
        .from(imageBuilds)
        .where(
          and(
            eq(imageBuilds.hostId, hostId),
            inArray(imageBuilds.status, ["assigned", "building"]),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: workshopPublications.id })
        .from(workshopPublications)
        .where(
          and(
            eq(workshopPublications.builderHostId, hostId),
            nonDetachableWorkshopPublication(),
          ),
        ),
    ),
    notExists(
      db
        .select({ runId: hostCpuReservations.runId })
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.hostId, hostId)),
    ),
    notExists(
      db
        .select({ executionId: hostResourceReservations.executionId })
        .from(hostResourceReservations)
        .where(
          and(
            eq(hostResourceReservations.hostId, hostId),
            inArray(hostResourceReservations.state, ["pending", "committed"]),
          ),
        ),
    ),
    notExists(
      db
        .select({ hostId: hostActualState.hostId })
        .from(hostActualState)
        .where(
          and(
            eq(hostActualState.hostId, hostId),
            sql`json_array_length(json_extract(${hostActualState.reportJson}, '$.vms')) > 0`,
          ),
        ),
    ),
  ];
  const causalRetiredHost = () =>
    exists(
      db
        .select({ id: agentHosts.id })
        .from(agentHosts)
        .where(
          and(
            eq(agentHosts.id, hostId),
            eq(agentHosts.userId, userId),
            isNull(agentHosts.organizationId),
            eq(agentHosts.disabled, true),
            eq(agentHosts.updatedAt, now),
            exactAdmission(),
          ),
        ),
    );

  const [retired] = await db.batch([
    db
      .update(agentHosts)
      .set({
        disabled: true,
        scenarioEnabled: false,
        connected: false,
        disconnectedAt: now,
        activeSessionId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentHosts.id, hostId),
          eq(agentHosts.userId, userId),
          isNull(agentHosts.organizationId),
          eq(agentHosts.disabled, false),
          eq(agentHosts.connected, false),
          isNull(agentHosts.activeSessionId),
          exactAdmission(),
          ...noActiveWork(),
        ),
      )
      .returning({ id: agentHosts.id }),
    db
      .update(agentBootstrapTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(agentBootstrapTokens.hostId, hostId),
          isNull(agentBootstrapTokens.revokedAt),
          causalRetiredHost(),
        ),
      ),
    db
      .delete(hostDesiredState)
      .where(and(eq(hostDesiredState.hostId, hostId), causalRetiredHost())),
    db
      .delete(hostActualState)
      .where(and(eq(hostActualState.hostId, hostId), causalRetiredHost())),
  ]);

  if (retired.length === 1) return true;

  // A repeated request is successful only when the exact owner/admission still
  // sees an already-disabled personal host. It also repairs any old active
  // bootstrap token left by a legacy retirement path.
  const existing = await db
    .select({ disabled: agentHosts.disabled })
    .from(agentHosts)
    .where(
      and(
        eq(agentHosts.id, hostId),
        eq(agentHosts.userId, userId),
        isNull(agentHosts.organizationId),
        eq(agentHosts.connected, false),
        isNull(agentHosts.activeSessionId),
        exactAdmission(),
        ...noActiveWork(),
      ),
    )
    .limit(1);
  if (!existing[0]?.disabled) return false;

  const disabledHost = exists(
    db
      .select({ id: agentHosts.id })
      .from(agentHosts)
      .where(
        and(
          eq(agentHosts.id, hostId),
          eq(agentHosts.userId, userId),
          isNull(agentHosts.organizationId),
          eq(agentHosts.disabled, true),
          eq(agentHosts.connected, false),
          isNull(agentHosts.activeSessionId),
          exactAdmission(),
          ...noActiveWork(),
        ),
      ),
  );
  await db.batch([
    db
      .update(agentBootstrapTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(agentBootstrapTokens.hostId, hostId),
          isNull(agentBootstrapTokens.revokedAt),
          disabledHost,
        ),
      ),
    db
      .delete(hostDesiredState)
      .where(and(eq(hostDesiredState.hostId, hostId), disabledHost)),
    db
      .delete(hostActualState)
      .where(and(eq(hostActualState.hostId, hostId), disabledHost)),
  ]);
  return true;
}
