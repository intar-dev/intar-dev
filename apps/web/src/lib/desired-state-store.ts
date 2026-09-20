import { and, eq, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { agentHosts, hostDesiredState } from "@/db/schema";
import type { HostDesiredStateV2 } from "@/generated/bridge";
import {
  createEmptyHostDesiredState,
  mutateDesiredState,
  type DesiredStateMutator,
  validateStoredHostDesiredState,
} from "@/lib/desired-state";

export async function loadOrCreateHostDesiredState(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<HostDesiredStateV2> {
  const [host] = await db.select({ scope: agentHosts.scope, ownerUserId: agentHosts.userId })
    .from(agentHosts).where(eq(agentHosts.id, hostId)).limit(1);
  if (!host || !host.scope || !host.ownerUserId) throw new Error("host ownership is not enrolled");
  for (let attempt = 0; attempt < MUTATE_DESIRED_STATE_MAX_ATTEMPTS; attempt++) {
    const rows = await db
      .select({
        version: hostDesiredState.version,
        docJson: hostDesiredState.docJson,
      })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, hostId))
      .limit(1);
    const existing = rows[0];
    if (existing) {
      const desired = validateStoredHostDesiredState({
        document: existing.docJson,
        hostId,
        rowVersion: existing.version,
        nowUnixMs,
      });
      if (desired.scope !== host.scope || desired.owner_user_id !== host.ownerUserId) {
        throw new Error("stored desired state has wrong host owner");
      }
      return desired;
    }

    const doc = createEmptyHostDesiredState({ hostId, nowUnixMs, scope: host.scope, ownerUserId: host.ownerUserId });
    const inserted = await db
      .insert(hostDesiredState)
      .values({
        hostId,
        version: doc.version,
        docJson: doc,
        createdAt: nowUnixMs,
        updatedAt: nowUnixMs,
      })
      .onConflictDoNothing()
      .returning({ version: hostDesiredState.version });
    if (inserted.length > 0) {
      return doc;
    }
  }

  throw new Error(
    `desired-state load for host ${hostId} lost ${MUTATE_DESIRED_STATE_MAX_ATTEMPTS} version races`,
  );
}

const MUTATE_DESIRED_STATE_MAX_ATTEMPTS = 5;

export interface HostDesiredStateWriteGuard {
  condition: SQL;
  assertSatisfied: () => Promise<void>;
}

export async function mutateStoredHostDesiredState(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
  mutator: DesiredStateMutator,
  initialState?: HostDesiredStateV2,
  writeGuard?: HostDesiredStateWriteGuard,
): Promise<HostDesiredStateV2> {
  // Optimistic concurrency: the doc is mutated by worker routes and the host
  // runtime DO alarm concurrently, and an unconditional write would silently
  // drop one side's version bump. The update only lands when the version we
  // read is still current; otherwise reload and re-apply the mutator.
  for (let attempt = 0; attempt < MUTATE_DESIRED_STATE_MAX_ATTEMPTS; attempt++) {
    const current =
      attempt === 0 && initialState?.host_id === hostId
        ? initialState
        : await loadOrCreateHostDesiredState(db, hostId, nowUnixMs);
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
          writeGuard?.condition,
        ),
      )
      .returning({ version: hostDesiredState.version });
    if (updated.length > 0) {
      return next;
    }
    await writeGuard?.assertSatisfied();
  }

  throw new Error(
    `desired-state mutation for host ${hostId} lost ${MUTATE_DESIRED_STATE_MAX_ATTEMPTS} version races`,
  );
}
