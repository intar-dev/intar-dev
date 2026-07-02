import { eq } from "drizzle-orm";
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

export async function mutateStoredHostDesiredState(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
  mutator: DesiredStateMutator,
): Promise<HostDesiredStateV1> {
  const current = await loadOrCreateHostDesiredState(db, hostId, nowUnixMs);
  const next = mutateDesiredState(current, mutator, { nowUnixMs });
  if (next === current) {
    return current;
  }

  await db
    .insert(hostDesiredState)
    .values({
      hostId,
      version: next.version,
      docJson: next,
      createdAt: nowUnixMs,
      updatedAt: nowUnixMs,
    })
    .onConflictDoUpdate({
      target: hostDesiredState.hostId,
      set: {
        version: next.version,
        docJson: next,
        updatedAt: nowUnixMs,
      },
    });

  return next;
}
