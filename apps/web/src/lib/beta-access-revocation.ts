import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  scenarioRuns,
} from "@/db/schema";
import {
  acquireBetaRevocationCleanup,
  completeBetaRevocationCleanup,
  recordBetaRevocationCleanupFailure,
  recordBetaRevocationCleanupStall,
} from "@/lib/access-invites";
import { appError } from "@/lib/app-error";
import { auth } from "@/lib/auth";
import { retireHostRuntime } from "@/lib/host-runtime-wake";
import {
  destroyScenarioRunForUser,
  revokeScenarioRoutesForUser,
} from "@/lib/scenario-runs";
import { revokeLiveWorkshopCapabilitiesForBetaUser } from "@/lib/workshops/membership-revocation";

interface CurrentRevocation {
  revocation_id: string;
  cleanup_attempt_id: string | null;
  cleanup_started_at: number | null;
  cleanup_completed_at: number | null;
}

/**
 * Completes the operational half of a beta revocation. The blocked registry
 * row is authoritative immediately; this cleanup is retryable and fenced by
 * its revocation id so an old retry cannot affect a later admission.
 */
export async function cleanupBetaRevocation(params: {
  userId: string;
  revocationId: string;
  actorUserId: string;
}): Promise<void> {
  const cleanup = await acquireBetaRevocationCleanup({
    d1: env.DB,
    userId: params.userId,
    revocationId: params.revocationId,
  });
  if (cleanup.status === "completed") return;
  const cleanupAttemptId = cleanup.cleanupAttemptId;
  let externalCleanupDispatched = false;

  try {
    // The internal adapter is Better Auth's lifecycle-aware deletion seam:
    // deleteUserSessions runs session delete hooks, OAuth revocation, and
    // back-channel logout without depending on the target's now-blocked
    // browser session (which also makes multi-admin self-revocation safe).
    const authContext = await auth.$context;
    await authContext.internalAdapter.deleteUserSessions(params.userId);
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
          isNull(agentHosts.organizationId),
        ),
      );
    const activeUserRuns = await db
      .select({ runId: scenarioRuns.runId })
      .from(scenarioRuns)
      .where(
        and(
          eq(scenarioRuns.userId, params.userId),
          isNull(scenarioRuns.hiddenAt),
          isNull(scenarioRuns.completedAt),
          isNull(scenarioRuns.failedAt),
        ),
      );

    // Each statement carries the same fence. D1 batch transactionality keeps
    // OAuth and personal-agent credential cleanup together.
    const fence = `EXISTS (
      SELECT 1 FROM access_allowlist
      WHERE user_id = ?1
        AND state = 'blocked'
        AND revocation_id = ?2
        AND revocation_cleanup_attempt_id = ?3
        AND revocation_cleanup_completed_at IS NULL
    )`;
    await env.DB.batch([
      env.DB
        .prepare(`DELETE FROM oauth_access_token WHERE user_id = ?1 AND ${fence}`)
        .bind(params.userId, params.revocationId, cleanupAttemptId),
      env.DB
        .prepare(`DELETE FROM oauth_refresh_token WHERE user_id = ?1 AND ${fence}`)
        .bind(params.userId, params.revocationId, cleanupAttemptId),
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
      env.DB
        .prepare(
          `UPDATE workshop_registry_tokens
           SET revoked_at = coalesce(revoked_at, cast(unixepoch('subsecond') * 1000 as integer))
           WHERE created_by = ?1 AND ${fence}`,
        )
        .bind(params.userId, params.revocationId, cleanupAttemptId),
      env.DB
        .prepare(
          `UPDATE agent_bootstrap_tokens
           SET revoked_at = coalesce(revoked_at, unixepoch('subsec') * 1000)
           WHERE host_id IN (
             SELECT id FROM agent_hosts
             WHERE user_id = ?1 AND organization_id IS NULL
           ) AND ${fence}`,
        )
        .bind(params.userId, params.revocationId, cleanupAttemptId),
      env.DB
        .prepare(
          `UPDATE agent_hosts
           SET disabled = 1,
               scenario_enabled = 0,
               connected = 0,
               active_session_id = NULL,
               disconnected_at = coalesce(disconnected_at, unixepoch('subsec') * 1000),
               updated_at = unixepoch('subsec') * 1000
           WHERE user_id = ?1 AND organization_id IS NULL AND ${fence}`,
        )
        .bind(params.userId, params.revocationId, cleanupAttemptId),
    ]);
    await assertRevocationFence(
      params.userId,
      params.revocationId,
      cleanupAttemptId,
    );

    // Every run is a user-owned capability even when an organization runner
    // hosts it. Tear down only that user's VMs; never disable the organization
    // host or disturb another member's workloads.
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
      });
    }
    await assertRevocationFence(
      params.userId,
      params.revocationId,
      cleanupAttemptId,
    );
    externalCleanupDispatched = true;
    await revokeScenarioRoutesForUser(params.userId);
    await revokeLiveWorkshopCapabilitiesForBetaUser({
      userId: params.userId,
      actorUserId: params.actorUserId,
    });

    for (const host of personalHosts) {
      await assertRevocationFence(
        params.userId,
        params.revocationId,
        cleanupAttemptId,
      );
      await retireHostRuntime(host.id);
    }

    await completeBetaRevocationCleanup({
      d1: env.DB,
      userId: params.userId,
      revocationId: params.revocationId,
      cleanupAttemptId,
    });
  } catch (error) {
    const recordFailure = externalCleanupDispatched
      ? recordBetaRevocationCleanupStall
      : recordBetaRevocationCleanupFailure;
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

export async function getBetaRevocationStatus(
  userId: string,
): Promise<{
  revocationId: string;
  cleanup: "pending" | "running" | "completed";
} | null> {
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
    `SELECT revocation_id,
            revocation_cleanup_attempt_id AS cleanup_attempt_id,
            revocation_cleanup_started_at AS cleanup_started_at,
            revocation_cleanup_completed_at AS cleanup_completed_at
     FROM access_allowlist
     WHERE user_id = ?1 AND state = 'blocked'
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
    "stale_beta_revocation",
    "the beta revocation is no longer current",
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
