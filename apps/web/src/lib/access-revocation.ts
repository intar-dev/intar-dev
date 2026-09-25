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
  revokeAccount,
} from "@/lib/access-revocation-store";
import { signOutStatements } from "@/lib/account-sign-out";
import { appError, AppError } from "@/lib/app-error";
import { retireHostRuntime, wakeHostRuntime } from "@/lib/host-runtime-wake";
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
 * Revokes access unless it already is, then finishes the revocation cleanup.
 * Repeating it retries an unfinished cleanup and leaves a finished one as is.
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
    try {
      await cleanupAccessRevocation({
        userId: params.userId,
        revocationId: revocation.revocationId,
        actorUserId: params.actorUserId,
      });
    } catch (error) {
      // The revocation itself is committed; only the cleanup needs a retry.
      console.warn(
        JSON.stringify({
          event: "access_revocation_cleanup_incomplete",
          userId: params.userId,
          revocationId: revocation.revocationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw appError(
        503,
        "access_cleanup_incomplete",
        "Access is revoked, but cleanup didn't finish. Try again.",
      );
    }
  }
  return { revocationId: revocation.revocationId };
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
    await env.DB.batch([
      // Every session and OAuth token, including any the revocation raced
      // with.
      ...signOutStatements(
        env.DB,
        (userColumn) => `${userColumn} = ?1 AND ${fence}`,
        [params.userId, params.revocationId, cleanupAttemptId],
      ),
      env.DB
        .prepare(`DELETE FROM oauth_consent WHERE user_id = ?1 AND ${fence}`)
        .bind(params.userId, params.revocationId, cleanupAttemptId),
      env.DB
        .prepare(
          `DELETE FROM verification
           WHERE CASE
                   WHEN json_valid(value)
                   THEN json_extract(value, '$.type')
                 END = 'authorization_code'
             AND CASE
                   WHEN json_valid(value)
                   THEN json_extract(value, '$.userId')
                 END = ?1
             AND ${fence}`,
        )
        .bind(params.userId, params.revocationId, cleanupAttemptId),
    ]);
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
