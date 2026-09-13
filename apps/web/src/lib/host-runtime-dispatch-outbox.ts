import { env } from "cloudflare:workers";
import { tryWakeHostRuntimeViaNamespace } from "@/lib/host-runtime-wake-client";

/**
 * The durable dispatch outbox is the committed host desired-state row.
 *
 * There is no separate outbox table: an admission or any other desired-state
 * mutation commits a new version in the same D1 transaction as its own
 * records, and the host acknowledges by reporting
 * host_actual_state.applied_desired_version. A host whose applied version is
 * behind the committed version has undelivered work, so a crash between the
 * commit and the wake, a lost alarm, or a dead socket all converge on the
 * next sweep.
 */
export const HOST_DESIRED_DISPATCH_SWEEP_LIMIT = 25;

/**
 * A just-committed version is delivered by its own request path. The lag keeps
 * the sweep from racing that delivery with a redundant wake.
 */
export const HOST_DESIRED_DISPATCH_SWEEP_MIN_LAG_MS = 15_000;

export interface UndeliveredHostRow {
  host_id: string;
  desired_version: number;
  applied_version: number | null;
}

export async function listHostsWithUndeliveredDesiredState(input?: {
  limit?: number;
  now?: number;
}): Promise<UndeliveredHostRow[]> {
  const now = input?.now ?? Date.now();
  const limit = input?.limit ?? HOST_DESIRED_DISPATCH_SWEEP_LIMIT;
  const rows = await env.DB.prepare(
    "SELECT host.id AS host_id," +
      " desired.version AS desired_version," +
      " actual.applied_desired_version AS applied_version" +
      " FROM agent_hosts host" +
      " INNER JOIN host_desired_state desired ON desired.host_id = host.id" +
      " LEFT JOIN host_actual_state actual ON actual.host_id = host.id" +
      " WHERE host.connected = 1 AND host.disabled = 0" +
      " AND (actual.applied_desired_version IS NULL" +
      " OR actual.applied_desired_version < desired.version)" +
      " AND desired.updated_at <= ?1" +
      " ORDER BY desired.updated_at ASC" +
      " LIMIT ?2",
  )
    .bind(now - HOST_DESIRED_DISPATCH_SWEEP_MIN_LAG_MS, limit)
    .all<UndeliveredHostRow>();
  return rows.results ?? [];
}

/** Wakes one host runtime so it pushes the committed version to its socket. */
export async function wakeUndeliveredHostDesiredState(hostId: string): Promise<void> {
  await tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId);
}

export async function sweepUndeliveredHostDesiredState(input?: {
  limit?: number;
  now?: number;
}): Promise<{ scanned: number; woken: number }> {
  const hosts = await listHostsWithUndeliveredDesiredState(input);
  let woken = 0;
  for (const host of hosts) {
    const before = woken;
    await wakeUndeliveredHostDesiredState(host.host_id);
    woken = before + 1;
  }
  if (woken > 0) {
    console.info(
      JSON.stringify({
        event: "host_desired_dispatch_sweep_wake",
        hosts: woken,
        scanned: hosts.length,
      }),
    );
  }
  return { scanned: hosts.length, woken };
}
