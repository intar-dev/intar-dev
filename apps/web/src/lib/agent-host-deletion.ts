import {
  and,
  eq,
  inArray,
  notExists,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  agentHosts,
  imageBuilds,
  scenarioRuns,
} from "@/db/schema";

export async function deleteAgentHostPreservingHistory(
  db: DrizzleD1Database,
  input: { hostId: string; userId: string },
): Promise<boolean> {
  // Keep these guards identical on both statements. A D1 batch rolls back on
  // SQL errors, but a guarded DELETE that changes zero rows still commits.
  const eligibilityGuards = () => [
    noRunHistory(db, input.hostId),
    noActiveImageBuilds(db, input.hostId),
  ];

  // The FK stays RESTRICT so unsupported deletion paths fail closed. This
  // transaction detaches only finished audit rows before deleting their host.
  const deletedHosts = await db
    .delete(agentHosts)
    .where(
      and(
        eq(agentHosts.id, input.hostId),
        eq(agentHosts.userId, input.userId),
        ...eligibilityGuards(),
      ),
    )
    .returning({ id: agentHosts.id });

  return deletedHosts.length > 0;
}

function noRunHistory(db: DrizzleD1Database, hostId: string) {
  return notExists(
    db
      .select({ runId: scenarioRuns.runId })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.hostId, hostId)),
  );
}

function noActiveImageBuilds(db: DrizzleD1Database, hostId: string) {
  return notExists(
    db
      .select({ buildId: imageBuilds.id })
      .from(imageBuilds)
      .where(
        and(
          eq(imageBuilds.hostId, hostId),
          inArray(imageBuilds.status, ["assigned", "building"]),
        ),
      ),
  );
}
