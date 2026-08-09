import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  agentHosts,
  imageBuilds,
  runtimeExecutions,
  scenarioRuns,
  workshopPublications,
} from "@/db/schema";

export async function deleteAgentHostPreservingHistory(
  db: DrizzleD1Database,
  input: { hostId: string; userId: string },
): Promise<boolean> {
  // Keep these guards identical on both statements. A D1 batch rolls back on
  // SQL errors, but a guarded DELETE that changes zero rows still commits.
  const eligibilityGuards = () => [
    noRunHistory(db, input.hostId),
    noActiveWorkshopRuntimes(db, input.hostId),
    noActiveImageBuilds(db, input.hostId),
    noNonDetachableWorkshopPublications(db, input.hostId),
  ];

  // The FK stays RESTRICT so unsupported deletion paths fail closed. This
  // transaction detaches only finished audit rows before deleting their host.
  const [, deletedHosts] = await db.batch([
    db
      .update(workshopPublications)
      .set({ builderHostId: null })
      .where(
        and(
          eq(workshopPublications.builderHostId, input.hostId),
          detachableWorkshopPublication(),
          exists(
            db
              .select({ id: agentHosts.id })
              .from(agentHosts)
              .where(
                and(
                  eq(agentHosts.id, input.hostId),
                  eq(agentHosts.userId, input.userId),
                ),
              ),
          ),
          ...eligibilityGuards(),
        ),
      ),
    db
      .delete(agentHosts)
      .where(
        and(
          eq(agentHosts.id, input.hostId),
          eq(agentHosts.userId, input.userId),
          ...eligibilityGuards(),
          notExists(
            db
              .select({ id: workshopPublications.id })
              .from(workshopPublications)
              .where(
                eq(workshopPublications.builderHostId, input.hostId),
              ),
          ),
        ),
      )
      .returning({ id: agentHosts.id }),
  ]);

  return deletedHosts.length > 0;
}

export function nonDetachableWorkshopPublication() {
  // Failed publications can still own paid verifier cleanup. Treat every
  // shape outside the two explicitly terminal combinations as unfinished.
  return sql`coalesce((${detachableWorkshopPublication()}), 0) = 0`;
}

function detachableWorkshopPublication() {
  return or(
    and(
      eq(workshopPublications.status, "published"),
      eq(workshopPublications.certificationState, "verified"),
    ),
    and(
      eq(workshopPublications.status, "failed"),
      or(
        isNull(workshopPublications.certificationState),
        eq(workshopPublications.certificationState, "failed"),
      ),
    ),
  );
}

function noRunHistory(db: DrizzleD1Database, hostId: string) {
  return notExists(
    db
      .select({ runId: scenarioRuns.runId })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.hostId, hostId)),
  );
}

function noActiveWorkshopRuntimes(db: DrizzleD1Database, hostId: string) {
  return notExists(
    db
      .select({ executionId: runtimeExecutions.id })
      .from(runtimeExecutions)
      .where(
        and(
          eq(runtimeExecutions.hostId, hostId),
          eq(runtimeExecutions.domainKind, "workshop"),
          inArray(runtimeExecutions.state, [
            "queued",
            "provisioning",
            "ready",
            "archiving",
          ]),
        ),
      ),
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

function noNonDetachableWorkshopPublications(
  db: DrizzleD1Database,
  hostId: string,
) {
  return notExists(
    db
      .select({ id: workshopPublications.id })
      .from(workshopPublications)
      .where(
        and(
          eq(workshopPublications.builderHostId, hostId),
          nonDetachableWorkshopPublication(),
        ),
      ),
  );
}
