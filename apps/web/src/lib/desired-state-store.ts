import { and, eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { agentHosts, hostDesiredState } from "@/db/schema";
import type { HostDesiredStateV2 } from "@/generated/bridge";
import { BRIDGE_PROTOCOL_VERSION_9 } from "@/generated/constants";
import type { HostDesiredStateV3 } from "@/generated/contracts/bridge-message-v9";
import validateBridgeMessageV9 from "@/generated/contracts/bridge-message-v9.validate";
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
  const [host] = await db.select({ scope: agentHosts.scope, ownerUserId: agentHosts.userId, organizationId: agentHosts.organizationId, role: agentHosts.role })
    .from(agentHosts).where(eq(agentHosts.id, hostId)).limit(1);
  if (!host || !host.scope || !host.ownerUserId) throw new Error("host ownership is not enrolled");
  if (host.scope === "organization" && (!host.organizationId || host.role !== "agent")) throw new Error("invalid organization host");
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

/** Schema of the desired state bridge 9 serves (`HostDesiredStateV3`). */
export const HOST_DESIRED_STATE_SCHEMA_VERSION_V3 = 7;

export type StoredHostDesiredState = HostDesiredStateV2 | HostDesiredStateV3;

/**
 * The stored desired state in whichever schema it has; a missing one is
 * created in the old schema, as `loadOrCreateHostDesiredState` does. Only
 * what both schemas share (version, VM phases and leases, builds) is meant
 * to be read from it.
 */
export async function loadStoredHostDesiredState(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<StoredHostDesiredState> {
  const [row] = await db
    .select({ schema: sql<number | null>`json_extract(${hostDesiredState.docJson}, '$.schema_version')` })
    .from(hostDesiredState)
    .where(eq(hostDesiredState.hostId, hostId));
  return row?.schema === HOST_DESIRED_STATE_SCHEMA_VERSION_V3
    ? (await mutateHostDesiredStateV3(db, hostId, nowUnixMs)).state
    : loadOrCreateHostDesiredState(db, hostId, nowUnixMs);
}

export function isHostDesiredStateV3(state: StoredHostDesiredState): state is HostDesiredStateV3 {
  return state.schema_version === HOST_DESIRED_STATE_SCHEMA_VERSION_V3;
}

/**
 * Loads the host's desired state in the bridge 9 schema, applies `mutator`
 * and stores the result at the next version when anything changed. A
 * document of the old schema is replaced by an empty one at its version
 * plus one, once: nothing in it is valid under bridge 9. A missing one is
 * created at version 0. Every stored document is validated first.
 */
export async function mutateHostDesiredStateV3(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
  mutator?: (draft: HostDesiredStateV3, host: { role: "agent" | "builder" }) => void,
): Promise<{ state: HostDesiredStateV3; role: "agent" | "builder" }> {
  const [host] = await db.select({ scope: agentHosts.scope, ownerUserId: agentHosts.userId, organizationId: agentHosts.organizationId, role: agentHosts.role })
    .from(agentHosts).where(eq(agentHosts.id, hostId)).limit(1);
  if (!host || !host.scope || !host.ownerUserId) throw new Error("host ownership is not enrolled");
  if (host.scope === "organization" && (!host.organizationId || host.role !== "agent")) throw new Error("invalid organization host");
  for (let attempt = 0; attempt < MUTATE_DESIRED_STATE_MAX_ATTEMPTS; attempt++) {
    const [row] = await db
      .select({ version: hostDesiredState.version, docJson: sql<string>`${hostDesiredState.docJson}` })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, hostId))
      .limit(1);
    const stored = row ? (JSON.parse(row.docJson) as { schema_version?: unknown }) : null;
    const current: HostDesiredStateV3 | null =
      row && stored?.schema_version === HOST_DESIRED_STATE_SCHEMA_VERSION_V3
        ? checkedHostDesiredStateV3(stored, hostId, row.version)
        : null;
    if (current && (current.scope !== host.scope || current.owner_user_id !== host.ownerUserId)) {
      throw new Error("stored desired state has wrong host owner");
    }
    const base: HostDesiredStateV3 = current ?? {
      scope: host.scope,
      owner_user_id: host.ownerUserId,
      schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION_V3,
      host_id: hostId,
      version: row ? row.version + 1 : 0,
      generated_at_unix_ms: nowUnixMs,
      cached_images: [],
      vms: [],
      builds: [],
      source_compiles: [],
    };
    const draft = structuredClone(base);
    mutator?.(draft, { role: host.role });
    if (draft.scope !== base.scope || draft.owner_user_id !== base.owner_user_id || draft.host_id !== hostId) {
      throw new Error("host desired-state ownership is immutable");
    }
    if (current && JSON.stringify(draft) === JSON.stringify(current)) return { state: current, role: host.role };
    const next = checkedHostDesiredStateV3(
      { ...draft, version: current ? current.version + 1 : base.version, generated_at_unix_ms: nowUnixMs },
      hostId,
      current ? current.version + 1 : base.version,
    );
    const written = row
      ? await db.update(hostDesiredState)
          .set({ version: next.version, docJson: next as unknown as HostDesiredStateV2, updatedAt: nowUnixMs })
          .where(and(eq(hostDesiredState.hostId, hostId), eq(hostDesiredState.version, row.version)))
          .returning({ version: hostDesiredState.version })
      : await db.insert(hostDesiredState)
          .values({ hostId, version: next.version, docJson: next as unknown as HostDesiredStateV2, createdAt: nowUnixMs, updatedAt: nowUnixMs })
          .onConflictDoNothing()
          .returning({ version: hostDesiredState.version });
    if (written.length > 0) return { state: next, role: host.role };
  }
  throw new Error(
    `desired-state mutation for host ${hostId} lost ${MUTATE_DESIRED_STATE_MAX_ATTEMPTS} version races`,
  );
}

function checkedHostDesiredStateV3(document: unknown, hostId: string, rowVersion: number): HostDesiredStateV3 {
  const message = {
    type: "desired_state", protocol_version: BRIDGE_PROTOCOL_VERSION_9, host_id: hostId, desired_state: document,
  };
  if (!validateBridgeMessageV9(message) || message.type !== "desired_state") {
    throw new Error(`desired state schema is invalid for host ${hostId}`);
  }
  const state = message.desired_state;
  if (state.schema_version !== HOST_DESIRED_STATE_SCHEMA_VERSION_V3 || state.host_id !== hostId ||
    state.version !== rowVersion) {
    throw new Error(`desired state identity is invalid for host ${hostId}`);
  }
  return state;
}
