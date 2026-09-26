import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  scenarioRuns,
} from "@/db/schema";
import {
  acquireAccessRevocationCleanup,
  completeAccessRevocationCleanup,
  recordAccessRevocationCleanupFailure,
  recordAccessRevocationCleanupStall,
  restoreAccount,
  revokeAccount,
} from "@/lib/access-revocation-store";
import { accountCredentialSweepStatements } from "@/lib/account-sign-out";
import { appError, AppError } from "@/lib/app-error";
import { retireHostRuntime, wakeHostRuntime } from "@/lib/host-runtime-wake";
import { cleanupRemovedHost } from "@/lib/host-workload-retirement";
import {
  destroyScenarioRunForUser,
  revokeScenarioRoutesForUser,
} from "@/lib/scenario-runs";

interface CurrentRevocation {
  revocation_id: string;
  cleanup_attempt_id: string | null;
  cleanup_started_at: number | null;
  cleanup_completed_at: number | null;
}

export interface AccessRevocationStatus {
  revocationId: string;
  cleanup: "pending" | "running" | "completed";
}

/**
 * Revokes access, then runs the revocation cleanup. An account that is already
 * revoked is refused rather than reused: a request made against an older view
 * must not report, or finish, a revocation an administrator restored since.
 */
export async function revokeAccess(params: {
  userId: string;
  actorUserId: string;
  reason: string;
}): Promise<{ revocationId: string }> {
  const { revocationId } = await revokeAccount({
    d1: env.DB,
    userId: params.userId,
    actorUserId: params.actorUserId,
    reason: params.reason,
  });
  // A retry of this request would be refused as already revoked, so the
  // failure points at finishing the cleanup instead.
  await runRevocationCleanup(
    { ...params, revocationId },
    "Access is revoked, but cleanup didn't finish. Finish the cleanup to retry it.",
  );
  return { revocationId };
}

/**
 * Finishes the cleanup of the named revocation, which must still be the
 * account's current one. Repeating it after it finished changes nothing.
 */
export async function finishAccessRevocationCleanup(params: {
  userId: string;
  revocationId: string;
  actorUserId: string;
}): Promise<void> {
  const revocation = await getAccessRevocationStatus(params.userId);
  if (revocation?.revocationId !== params.revocationId) throw staleRevocation();
  if (revocation.cleanup === "completed") return;
  await runRevocationCleanup(params);
}

/**
 * Revokes access unless it already is, then finishes the revocation cleanup.
 * Repeating it retries an unfinished cleanup and leaves a finished one as is.
 * User deletion uses it, and its final batch rechecks the revocation.
 */
export async function ensureAccessRevoked(params: {
  userId: string;
  actorUserId: string;
  reason: string;
}): Promise<{ revocationId: string }> {
  let revocation = await getAccessRevocationStatus(params.userId);
  if (!revocation) {
    try {
      const created = await revokeAccount({
        d1: env.DB,
        userId: params.userId,
        actorUserId: params.actorUserId,
        reason: params.reason,
      });
      revocation = { revocationId: created.revocationId, cleanup: "pending" };
    } catch (error) {
      // A concurrent administrator may have revoked first. Continue with that
      // revocation instead of failing the request.
      if (!(error instanceof AppError) || error.code !== "access_already_revoked") {
        throw error;
      }
      revocation = await getAccessRevocationStatus(params.userId);
      if (!revocation) throw error;
    }
  }

  if (revocation.cleanup !== "completed") {
    await runRevocationCleanup({
      userId: params.userId,
      revocationId: revocation.revocationId,
      actorUserId: params.actorUserId,
    });
  }
  return { revocationId: revocation.revocationId };
}

async function runRevocationCleanup(
  params: {
    userId: string;
    revocationId: string;
    actorUserId: string;
  },
  incompleteMessage = "Access is revoked, but cleanup didn't finish. Try again.",
): Promise<void> {
  try {
    await cleanupAccessRevocation(params);
  } catch (error) {
    // Another attempt holds the cleanup, or the revocation is no longer the
    // current one (finished, or restored). Say so rather than claim access is
    // revoked with an unfinished cleanup.
    if (error instanceof AppError && error.status === 409) throw error;
    // The revocation itself is committed; only the cleanup needs a retry.
    console.warn(
      JSON.stringify({
        event: "access_revocation_cleanup_incomplete",
        userId: params.userId,
        revocationId: params.revocationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw appError(503, "access_cleanup_incomplete", incompleteMessage);
  }
}

/**
 * Restores a revoked account's access as a fresh start (see restoreAccount),
 * then finishes removing its personal servers as a server removal does. A
 * server whose cleanup fails stays "removing" in My servers, where removing it
 * again finishes; the restore itself is committed either way.
 */
export async function restoreAccess(params: {
  userId: string;
  actorUserId: string;
  revocationId: string;
}): Promise<{ serversPendingCleanup: number }> {
  await restoreAccount({ d1: env.DB, ...params });
  const retired = await env.DB.prepare(
    `SELECT id FROM agent_hosts
     WHERE user_id = ?1 AND scope = 'personal' AND disabled = 1
       AND owner_removal_id IS NOT NULL AND owner_removal_completed_at IS NULL`,
  )
    .bind(params.userId)
    .all<{ id: string }>();
  let serversPendingCleanup = 0;
  for (const host of retired.results) {
    try {
      await cleanupRemovedHost(host.id);
      await env.DB.prepare(
        `UPDATE agent_hosts SET owner_removal_completed_at = ?3
         WHERE id = ?1 AND user_id = ?2 AND scope = 'personal' AND disabled = 1
           AND owner_removal_id IS NOT NULL AND owner_removal_completed_at IS NULL`,
      )
        .bind(host.id, params.userId, Date.now())
        .run();
    } catch (error) {
      serversPendingCleanup += 1;
      console.warn(
        JSON.stringify({
          event: "access_restore_server_cleanup_incomplete",
          userId: params.userId,
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return { serversPendingCleanup };
}

/**
 * Completes the operational half of a revocation. The ban is authoritative
 * immediately; this cleanup is retryable and fenced by its cleanup attempt so
 * an abandoned attempt cannot write after a newer one.
 */
export async function cleanupAccessRevocation(params: {
  userId: string;
  revocationId: string;
  actorUserId: string;
}): Promise<void> {
  const cleanup = await acquireAccessRevocationCleanup({
    d1: env.DB,
    userId: params.userId,
    revocationId: params.revocationId,
  });
  if (cleanup.status === "completed") return;
  const cleanupAttemptId = cleanup.cleanupAttemptId;
  let externalCleanupDispatched = false;

  try {
    await assertRevocationFence(
      params.userId,
      params.revocationId,
      cleanupAttemptId,
    );

    const db = drizzle(env.DB);
    const personalHosts = await db
      .select({ id: agentHosts.id })
      .from(agentHosts)
      .where(
        and(
          eq(agentHosts.userId, params.userId),
          eq(agentHosts.scope, "personal"),
        ),
      );
    const activeUserRuns = await db
      .select({ runId: scenarioRuns.runId, hostId: scenarioRuns.hostId })
      .from(scenarioRuns)
      .where(
        and(
          eq(scenarioRuns.userId, params.userId),
          isNull(scenarioRuns.hiddenAt),
          isNull(scenarioRuns.completedAt),
          isNull(scenarioRuns.failedAt),
        ),
      );

    // Host credentials were invalidated by the revocation transaction. These
    // OAuth cleanup writes carry the same fence as the external cleanup.
    const fence = `EXISTS (
      SELECT 1 FROM access_revocations AS revocation
      WHERE revocation.user_id = ?1
        AND revocation.revocation_id = ?2
        AND revocation.cleanup_attempt_id = ?3
        AND revocation.cleanup_completed_at IS NULL
    )`;
    // Every session, OAuth grant, and registration token, including any the
    // revocation raced with.
    await env.DB.batch(
      accountCredentialSweepStatements(
        env.DB,
        fence,
        [params.userId, params.revocationId, cleanupAttemptId],
        Date.now(),
      ),
    );
    await assertRevocationFence(
      params.userId,
      params.revocationId,
      cleanupAttemptId,
    );

    // One failed shutdown must not block other runs or independent host wakes.
    // Every run remains a user-owned capability, including on shared hosts.
    const failures: unknown[] = [];
    for (const run of activeUserRuns) {
      await assertRevocationFence(
        params.userId,
        params.revocationId,
        cleanupAttemptId,
      );
      externalCleanupDispatched = true;
      await destroyScenarioRunForUser({
        runId: run.runId,
        userId: params.userId,
      }).catch(error => { failures.push(error); });
    }
    await assertRevocationFence(
      params.userId,
      params.revocationId,
      cleanupAttemptId,
    );
    externalCleanupDispatched = true;
    await revokeScenarioRoutesForUser(params.userId).catch(error => { failures.push(error); });

    for (const host of personalHosts) {
      await assertRevocationFence(
        params.userId,
        params.revocationId,
        cleanupAttemptId,
      );
      await retireHostRuntime(host.id).catch(error => { failures.push(error); });
    }

    // Retirement clears DO storage. Restore finite-lease cleanup even after a
    // lost response, and wake shared hosts without retiring other users' VMs.
    const hostIds = new Set([...personalHosts.map(host => host.id), ...activeUserRuns.map(run => run.hostId)]);
    for (const hostId of hostIds) {
      await assertRevocationFence(params.userId, params.revocationId, cleanupAttemptId);
      await wakeHostRuntime(hostId).catch(error => { failures.push(error); });
    }
    if (failures.length) throw failures[0];

    await completeAccessRevocationCleanup({
      d1: env.DB,
      userId: params.userId,
      revocationId: params.revocationId,
      cleanupAttemptId,
    });
  } catch (error) {
    const recordFailure = externalCleanupDispatched
      ? recordAccessRevocationCleanupStall
      : recordAccessRevocationCleanupFailure;
    await recordFailure({
      d1: env.DB,
      userId: params.userId,
      revocationId: params.revocationId,
      cleanupAttemptId,
      actorUserId: params.actorUserId,
      reason: externalCleanupDispatched
        ? ambiguousCleanupFailureReason(error)
        : cleanupFailureReason(error),
    }).catch(() => undefined);
    throw error;
  }
}

export async function getAccessRevocationStatus(
  userId: string,
): Promise<AccessRevocationStatus | null> {
  const current = await readCurrentRevocation(userId);
  if (!current) return null;
  return {
    revocationId: current.revocation_id,
    cleanup:
      current.cleanup_completed_at !== null
        ? "completed"
        : current.cleanup_attempt_id !== null
          ? "running"
          : "pending",
  };
}

async function readCurrentRevocation(
  userId: string,
): Promise<CurrentRevocation | null> {
  return env.DB.prepare(
    `SELECT revocation_id, cleanup_attempt_id, cleanup_started_at,
            cleanup_completed_at
     FROM access_revocations
     WHERE user_id = ?1
     LIMIT 1`,
  )
    .bind(userId)
    .first<CurrentRevocation>();
}

async function assertRevocationFence(
  userId: string,
  revocationId: string,
  cleanupAttemptId: string,
): Promise<void> {
  const current = await readCurrentRevocation(userId);
  if (
    current?.revocation_id !== revocationId ||
    current.cleanup_attempt_id !== cleanupAttemptId ||
    current.cleanup_completed_at !== null
  ) {
    throw staleRevocation();
  }
}

function staleRevocation() {
  return appError(
    409,
    "stale_access_revocation",
    "The access revocation is no longer current",
  );
}

function cleanupFailureReason(error: unknown): string {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "unexpected_error";
  const normalized = code.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "_");
  return `cleanup_${normalized || "unexpected_error"}`.slice(0, 120);
}

function ambiguousCleanupFailureReason(error: unknown): string {
  return `ambiguous_${cleanupFailureReason(error)}`.slice(0, 120);
}
