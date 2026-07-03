import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { hostDesiredState } from "@/db/schema";
import type { HostDesiredStateV1 } from "@/generated/bridge";
import {
  createEmptyHostDesiredState,
  mutateDesiredState,
  type DesiredStateMutator,
} from "@/lib/desired-state";

export async function loadOrCreateHostDesiredState(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<HostDesiredStateV1> {
  const rows = await db
    .select({ docJson: hostDesiredState.docJson })
    .from(hostDesiredState)
    .where(eq(hostDesiredState.hostId, hostId))
    .limit(1);
  const existing = rows[0]?.docJson;
  if (existing) {
    return existing;
  }

  const doc = createEmptyHostDesiredState({ hostId, nowUnixMs });
  await db
    .insert(hostDesiredState)
    .values({
      hostId,
      version: doc.version,
      docJson: doc,
      createdAt: nowUnixMs,
      updatedAt: nowUnixMs,
    })
    .onConflictDoNothing();

  const insertedRows = await db
    .select({ docJson: hostDesiredState.docJson })
    .from(hostDesiredState)
    .where(eq(hostDesiredState.hostId, hostId))
    .limit(1);
  return insertedRows[0]?.docJson ?? doc;
}

const MUTATE_DESIRED_STATE_MAX_ATTEMPTS = 5;

export async function mutateStoredHostDesiredState(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
  mutator: DesiredStateMutator,
): Promise<HostDesiredStateV1> {
  // Optimistic concurrency: the doc is mutated by worker routes and the host
  // runtime DO alarm concurrently, and an unconditional write would silently
  // drop one side's version bump. The update only lands when the version we
  // read is still current; otherwise reload and re-apply the mutator.
  for (let attempt = 0; attempt < MUTATE_DESIRED_STATE_MAX_ATTEMPTS; attempt++) {
    const current = await loadOrCreateHostDesiredState(db, hostId, nowUnixMs);
    const next = mutateDesiredState(current, mutator, { nowUnixMs });
    if (next === current) {
      return current;
    }

    const updated = await db
      .update(hostDesiredState)
      .set({
        version: next.version,
        docJson: next,
        updatedAt: nowUnixMs,
      })
      .where(
        and(
          eq(hostDesiredState.hostId, hostId),
          eq(hostDesiredState.version, current.version),
        ),
      )
      .returning({ version: hostDesiredState.version });
    if (updated.length > 0) {
      return next;
    }
  }

  throw new Error(
    `desired-state mutation for host ${hostId} lost ${MUTATE_DESIRED_STATE_MAX_ATTEMPTS} version races`,
  );
}
