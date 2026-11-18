// Local runs: the VMs run on the learner's own computer (#399).
//
// A run row needs a host. A local run points at a placeholder, one per
// learner, that can never connect, be scheduled or get a registry token.
// `scenario_runs.runtime = 'local'` is the truth; the host id only satisfies
// the foreign key. No host acknowledges anything for a local run, so the
// server ends one in a single write.

import { persistRunState } from "@/lib/run-projection";

/** The magic prefix of a placeholder host's id. */
export const LOCAL_HOST_PREFIX = "local:";

/** A local run with no change for this long is closed. */
// ponytail: one fixed window; make it per scenario once reports carry a heartbeat.
export const LOCAL_RUN_SILENCE_MS = 60 * 60_000;

export function localHostId(userId: string): string {
  return LOCAL_HOST_PREFIX + userId;
}

export function isLocalHostId(hostId: string | null | undefined): boolean {
  return hostId?.startsWith(LOCAL_HOST_PREFIX) === true;
}

/** Creates the learner's placeholder host unless it exists. */
export function ensureLocalHostStatement(
  d1: D1Database,
  userId: string,
  now: number,
): D1PreparedStatement {
  return d1.prepare(
    "INSERT INTO agent_hosts (id, user_id, name, scope, role, disabled," +
      " scenario_enabled, connected, credential_generation, created_at, updated_at)" +
      " SELECT ?1, owner.id, 'local', NULL, 'agent', 1, 0, 0, 0, ?3, ?3" +
      " FROM user owner WHERE owner.id = ?2" +
      " ON CONFLICT (id) DO NOTHING",
  ).bind(localHostId(userId), userId, now);
}

/**
 * Ends a local run at once: every VM is completed, so the run completes,
 * frees the learner's active slot and, if it was solved, counts for its
 * course. A run that already ended stays as it is.
 */
export async function endLocalRun(input: {
  d1: D1Database;
  runId: string;
  userId?: string;
}): Promise<boolean> {
  const run = await input.d1.prepare(
    "SELECT 1 FROM scenario_runs WHERE run_id = ?1 AND runtime = 'local'" +
      " AND (?2 IS NULL OR user_id = ?2)",
  ).bind(input.runId, input.userId ?? null).first();
  if (!run) return false;
  await persistRunState(input.d1, input.runId, (state) => ({
    ...state,
    vms: state.vms.map((vm) =>
      vm.phase === "failed" ? vm : { ...vm, phase: "completed" as const }),
  }));
  return true;
}

/** Closes local runs that have been silent for too long. Bounded per call. */
export async function reapSilentLocalRuns(
  d1: D1Database,
  now = Date.now(),
): Promise<number> {
  const { results } = await d1.prepare(
    "SELECT run_id FROM scenario_runs WHERE runtime = 'local'" +
      " AND active_key IS NOT NULL AND updated_at < ?1" +
      " ORDER BY updated_at LIMIT 50",
  ).bind(now - LOCAL_RUN_SILENCE_MS).all<{ run_id: string }>();
  for (const { run_id: runId } of results) await endLocalRun({ d1, runId });
  return results.length;
}
