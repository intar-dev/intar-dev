import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  bundles,
  pipelineUploadSessions,
  scenarioSourceCommits,
  scenarioSources,
} from "@/db/schema";
import { appError, toErrorResponse } from "@/lib/app-error";
import { KEPT_REVISIONS_CTE } from "@/lib/kept-revisions";
import { encodeBase64Url } from "@/lib/base64url";
import { runnerMayPublish, verifyGithubActionsToken } from "@/lib/github-oidc";
import { createAppId } from "@/lib/id";
import {
  PIPELINE_SESSION_MAX_BYTES,
  PIPELINE_SESSION_TOKEN_PREFIX,
  pipelineSessionTokenHash,
  readBearer,
  readPipelineSessionToken,
} from "@/lib/pipeline-upload-sessions";
import {
  BodyLimitExceededError,
  canonicalApplicationOrigin,
  readBoundedBody,
} from "@/lib/request-security";
import {
  loadPushScenarioSource,
  scenarioSourceBindingPredicate,
  sourceRefusal,
} from "@/lib/scenario-sources";
import { isRecord, isSafeBundleRev, jsonResponse } from "./shared";

/**
 * The credential a scenario repository's pipeline pushes its images with
 * (#441). A GitHub OIDC token lives for minutes and an image uploads for
 * longer, so the pipeline trades one for a session token here. The session is
 * bound to what the OIDC token said and to the source's binding: it works
 * only while the source is connected and not paused.
 *
 * These two paths are not in `@/generated/constants`: no Rust contract names
 * them yet, so they are defined here.
 */
export const PIPELINE_SESSIONS_PATH = "/registry/v1/pipeline/sessions";
export const PIPELINE_SESSIONS_CLOSE_PATH = `${PIPELINE_SESSIONS_PATH}/close`;

/** Absolute: a session is never extended. */
export const PIPELINE_SESSION_TTL_MS = 60 * 60 * 1000;
/** Sessions of one scope that are neither closed nor expired. */
export const PIPELINE_OPEN_SESSIONS_PER_SCOPE = 8;
/** Sessions one scope may open in `PIPELINE_SESSION_WINDOW_MS`. */
export const PIPELINE_SESSIONS_PER_SCOPE_PER_WINDOW = 200;
export const PIPELINE_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Bytes the sessions one scope opened in the window may have stored. */
export const PIPELINE_BYTES_PER_SCOPE_PER_WINDOW = 400 * 1024 ** 3;
/** How long a pipeline waits before it asks again while its bundle is ingested. */
export const PIPELINE_BUNDLE_PENDING_RETRY_SECONDS = 5;
const MAX_SESSION_REQUEST_BYTES = 1024;

/**
 * The id of the session a token names, while the session may write: not
 * expired, not closed, and its source still the push-mode binding of the
 * repository that opened it: connected, not paused and with a binder that
 * holds the scope.
 */
export async function findPipelineSession(
  env: Cloudflare.Env,
  token: string,
): Promise<string | null> {
  const [session] = await drizzle(env.DB)
    .select({ id: pipelineUploadSessions.id })
    .from(pipelineUploadSessions)
    .innerJoin(
      scenarioSources,
      eq(scenarioSources.scopeKey, pipelineUploadSessions.scopeKey),
    )
    .where(
      and(
        eq(pipelineUploadSessions.tokenHash, await pipelineSessionTokenHash(token)),
        gt(pipelineUploadSessions.expiresAt, Date.now()),
        isNull(pipelineUploadSessions.closedAt),
        eq(scenarioSources.mode, "push"),
        eq(scenarioSources.githubRepositoryId, pipelineUploadSessions.githubRepositoryId),
        scenarioSourceBindingPredicate(),
      ),
    )
    .limit(1);
  return session?.id ?? null;
}

/**
 * Opens a session for the pipeline run a GitHub Actions OIDC token names.
 * Nothing is answered about a binding or a rev before the token verifies.
 */
export async function handlePipelineSessionOpen(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  try {
    const oidc = readBearer(request);
    if (!oidc) throw appError(401, "unauthorized", "unauthorized");
    const claims = await verifyGithubActionsToken(oidc, {
      audience: canonicalApplicationOrigin(env),
      workflowShas: env.SCENARIO_PUBLISH_WORKFLOW_SHAS,
    });
    const db = drizzle(env.DB);
    const binding = await loadPushScenarioSource(db, claims.repositoryId);
    // The same answers the bundle upload gives.
    if (!runnerMayPublish(claims, binding)) {
      throw appError(401, "unauthorized", "The GitHub Actions token was refused.");
    }
    if (!binding) {
      throw sourceRefusal(
        409,
        "binding_inactive",
        "No active push-mode scenario source is connected to this repository.",
      );
    }
    // A workflow on any branch can be at the default branch's commit, and its
    // image would be recorded for that commit's revisions. GitHub is not
    // asked: the binding names the branch.
    if (claims.ref !== `refs/heads/${binding.defaultBranch}`) {
      throw appError(
        403,
        "ref_not_default_branch",
        "Only a run on the default branch pushes images.",
      );
    }

    const rev = await readRev(request);
    if (
      rev === null ||
      !isSafeBundleRev(rev) ||
      !rev.startsWith(`git-${claims.repositoryId}-${claims.sha}-`)
    ) {
      throw appError(400, "rev_invalid", "The rev is not one of this run's commit.");
    }

    // The bundle's stamp decides, not what the source is set to now: a rev
    // keeps the producer it was ingested with.
    const [bundle] = await db
      .select({ imageProducer: bundles.imageProducer })
      .from(bundles)
      .where(and(eq(bundles.rev, rev), eq(bundles.scopeKey, binding.scopeKey)))
      .limit(1);
    if (bundle ? bundle.imageProducer !== "pipeline" : binding.imageProducer !== "pipeline") {
      throw appError(
        409,
        "pipeline_images_disabled",
        "This source's images are not built by its pipeline.",
      );
    }
    if (!bundle) {
      const [commit] = await db
        .select({ state: scenarioSourceCommits.state })
        .from(scenarioSourceCommits)
        .where(
          and(
            eq(scenarioSourceCommits.scopeKey, binding.scopeKey),
            eq(scenarioSourceCommits.rev, rev),
            eq(scenarioSourceCommits.purpose, "deploy"),
          ),
        )
        .limit(1);
      if (commit?.state !== "ingesting") throw superseded();
      const response = jsonResponse(
        { error: "The bundle of this commit is still being read. Try again.", code: "bundle_pending" },
        409,
      );
      response.headers.set("retry-after", String(PIPELINE_BUNDLE_PENDING_RETRY_SECONDS));
      return response;
    }
    // A revision that already has its amd64 images is ready, and its arm64
    // ones are still to come. It must be one that is kept: the sweep keeps a
    // scope's images, and the quota counts them, by the keys of kept
    // revisions, so a run of a rev nothing uses any more records nothing.
    const wanted = await env.DB.prepare(
      `WITH ${KEPT_REVISIONS_CTE}
       SELECT 1 AS kept FROM kept_revisions kept
         JOIN scenarios scenario ON scenario.id = kept.scenario_id
         JOIN scenario_revisions revision ON revision.scenario_id = kept.scenario_id AND revision.rev = kept.rev
        WHERE kept.rev = ?1 AND scenario.scope_key = ?2
          AND revision.state IN ('building', 'ready', 'verified')
        LIMIT 1`,
    ).bind(rev, binding.scopeKey).first();
    if (!wanted) throw superseded();

    const now = Date.now();
    const expiresAt = now + PIPELINE_SESSION_TTL_MS;
    const token =
      PIPELINE_SESSION_TOKEN_PREFIX +
      encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    // The limits are part of the insert, so two opens at once cannot both
    // take the last place.
    const opened = await env.DB.prepare(
      `INSERT INTO pipeline_upload_sessions
         (id, token_hash, scope_key, github_repository_id, github_repository,
          ref, sha, rev, run_id, run_attempt, runner_environment,
          job_workflow_sha, bytes_put, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, ?14
        WHERE (SELECT COUNT(*) FROM pipeline_upload_sessions
                WHERE scope_key = ?3 AND closed_at IS NULL AND expires_at > ?13) < ?15
          AND (SELECT COUNT(*) FROM pipeline_upload_sessions
                WHERE scope_key = ?3 AND created_at > ?16) < ?17
          AND (SELECT COALESCE(SUM(bytes_put), 0) FROM pipeline_upload_sessions
                WHERE scope_key = ?3 AND created_at > ?16) < ?18
       RETURNING id`,
    )
      .bind(
        createAppId(),
        await pipelineSessionTokenHash(token),
        binding.scopeKey,
        binding.githubRepositoryId,
        binding.githubRepository,
        claims.ref,
        claims.sha,
        rev,
        claims.runId,
        claims.runAttempt,
        claims.runnerEnvironment,
        claims.jobWorkflowSha,
        now,
        expiresAt,
        PIPELINE_OPEN_SESSIONS_PER_SCOPE,
        now - PIPELINE_SESSION_WINDOW_MS,
        PIPELINE_SESSIONS_PER_SCOPE_PER_WINDOW,
        PIPELINE_BYTES_PER_SCOPE_PER_WINDOW,
      )
      .first();
    if (!opened) {
      throw appError(
        429,
        "pipeline_session_limit",
        "This source has reached its upload limits. Close a session or try again later.",
      );
    }
    return jsonResponse(
      {
        ok: true,
        token,
        expires_at_unix_ms: expiresAt,
        max_bytes: PIPELINE_SESSION_MAX_BYTES,
      },
      201,
    );
  } catch (error) {
    const refusal = toErrorResponse(error, "pipeline session open failed");
    return jsonResponse(refusal.body, refusal.status);
  }
}

/**
 * Closes the session its own token names. A closed or expired session closes
 * again with the same answer, so a pipeline's cleanup step never fails on a
 * retry.
 */
export async function handlePipelineSessionClose(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const token = readPipelineSessionToken(request);
  const closed = token
    ? await env.DB.prepare(
        `UPDATE pipeline_upload_sessions
            SET closed_at = COALESCE(closed_at, ?1)
          WHERE token_hash = ?2
          RETURNING id`,
      )
        .bind(Date.now(), await pipelineSessionTokenHash(token))
        .first()
    : null;
  return closed
    ? jsonResponse({ ok: true })
    : jsonResponse({ error: "unauthorized" }, 401);
}

function superseded() {
  return sourceRefusal(
    409,
    "superseded",
    "No revision of this commit is waiting for images.",
  );
}

/** The `rev` of a `{"rev"}` body, or null. */
async function readRev(request: Request): Promise<string | null> {
  try {
    const body: unknown = JSON.parse(
      new TextDecoder().decode(
        request.body
          ? await readBoundedBody(request.body, MAX_SESSION_REQUEST_BYTES)
          : new Uint8Array(),
      ),
    );
    return isRecord(body) && typeof body.rev === "string" ? body.rev : null;
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      throw appError(413, "payload_too_large", "The request is too large.");
    }
    return null;
  }
}
