import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentBootstrapTokens, agentHosts,
  imageBuilds, runtimeExecutions, user,
} from "@/db/schema";

/** Invalidate a platform host even if its creator or control socket is gone. */
export async function revokePlatformHost(input: {
  d1: D1Database;
  hostId: string;
  actorUserId: string;
}): Promise<boolean> {
  const db = drizzle(input.d1);
  const now = Date.now();
  const currentAdmin = exists(db.select({ id: user.id }).from(user)
    .where(and(
      eq(user.id, input.actorUserId),
      isNull(user.deletedAt),
      sql`coalesce(${user.banned}, 0) = 0`,
      sql`instr(',' || replace(lower(coalesce(${user.role}, '')), ' ', '') || ',', ',admin,') > 0`,
    )));
  const revokedHost = exists(db.select({ id: agentHosts.id }).from(agentHosts)
    .where(and(
      eq(agentHosts.id, input.hostId),
      eq(agentHosts.scope, "platform"),
      eq(agentHosts.disabled, true),
      currentAdmin,
    )));
  const [hosts] = await db.batch([
    db.update(agentHosts).set({
      disabled: true,
      scenarioEnabled: false,
      // Repeated cleanup attempts must not create new credential generations.
      credentialGeneration: sql`case when ${agentHosts.disabled} = 0 then ${agentHosts.credentialGeneration} + 1 else ${agentHosts.credentialGeneration} end`,
      connected: false,
      activeSessionId: null,
      disconnectedAt: now,
      updatedAt: now,
    }).where(and(
      eq(agentHosts.id, input.hostId),
      eq(agentHosts.scope, "platform"),
      currentAdmin,
    )).returning({ id: agentHosts.id }),
    db.update(agentBootstrapTokens).set({ revokedAt: now }).where(and(
      eq(agentBootstrapTokens.hostId, input.hostId),
      isNull(agentBootstrapTokens.revokedAt),
      revokedHost,
    )),
    db.update(imageBuilds).set({
      status: "failed", phase: "failed", error: "Platform host access was revoked.", updatedAt: now,
    }).where(and(
      eq(imageBuilds.hostId, input.hostId),
      inArray(imageBuilds.status, ["assigned", "building"]),
      revokedHost,
    )),
    // An execution not yet issued a workload lease needs no grace period.
    // Keep all existing deadlines unchanged, including on repeated requests.
    db.update(runtimeExecutions).set({ leaseExpiresAt: now, updatedAt: now }).where(and(
      eq(runtimeExecutions.hostId, input.hostId),
      isNull(runtimeExecutions.leaseExpiresAt),
      sql`${runtimeExecutions.state} <> 'archived'`,
      revokedHost,
    )),
  ]);
  return hosts.length === 1;
}
