import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import {
  bundles,
  machineBuilds,
  scenarioSourceCommits,
  scenarioSources,
} from "@/db/schema";
import type { VerifiedAgentHost } from "@/control-plane/auth";
import { type AppErrorResponseBody, appError, toErrorResponse } from "@/lib/app-error";
import { BodyLimitExceededError, readBoundedBody } from "@/lib/request-security";
import {
  acceptScenarioSourceUpload,
  endSourceCompiles,
  MAX_COMPILE_ATTEMPTS,
  MAX_SOURCE_UPLOAD_BYTES,
  scenarioSourceBindingPredicate,
  scenarioSourceScope,
  sourceRefusal,
  stagedSourceObjectPrefix,
} from "@/lib/scenario-sources";
import {
  jsonResponse,
  isRecord,
  isSafeBundleRev,
  isSafeBuildId,
} from "./shared";
import { currentAgentHost } from "./image-access";

export async function handleAgentBundleDownload(
  request: Request,
  env: Cloudflare.Env,
  rev: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!isSafeBundleRev(rev)) {
    return jsonResponse({ error: "invalid bundle rev" }, 400);
  }

  const db = drizzle(env.DB);
  const objectKey = await assignedBundleKey(db, verified.agent, rev);
  if (!objectKey) {
    return jsonResponse({ error: "bundle not found" }, 404);
  }

  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(objectKey);
  if (!object) {
    return jsonResponse({ error: "bundle object not found" }, 404);
  }

  // R2 can wait across a credential rotation or an assignment change. Check
  // the same assignment and object before exposing any source bytes.
  if ((await assignedBundleKey(db, verified.agent, rev)) !== objectKey) {
    await object.body.cancel();
    return jsonResponse({ error: "bundle not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-build-bundle-rev": rev,
    },
  });
}

/**
 * The object key of bundle `rev` while a machine build of it is assigned to
 * or running on this builder, else null.
 */
async function assignedBundleKey(
  db: DrizzleD1Database,
  agent: VerifiedAgentHost,
  rev: string,
): Promise<string | null> {
  const [build] = await db
    .select({ r2Key: bundles.r2Key })
    .from(machineBuilds)
    .innerJoin(bundles, eq(bundles.rev, machineBuilds.bundleRev))
    .where(and(
      currentAgentHost(agent),
      eq(machineBuilds.bundleRev, rev),
      eq(machineBuilds.hostId, agent.hostId),
      inArray(machineBuilds.state, ["assigned", "building"]),
    ))
    .limit(1);
  return build?.r2Key ?? null;
}

const MAX_DIAGNOSTICS_CHARS = 64 * 1024;

/** A pull compile's repository snapshot, for the builder the row names. */
export async function handleAgentSourceSnapshot(
  request: Request,
  env: Cloudflare.Env,
  compileId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;
  try {
    const { row, stillCompiling } = await fencedSourceCompile(
      env,
      verified.agent,
      request,
      compileId,
    );
    const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(sourceArchiveKey(row));
    if (!object) return jsonResponse({ error: "snapshot not found" }, 404);
    // R2 can wait across an expiry or a supersede. Check the same fence
    // before exposing any tenant bytes.
    const [current] = await drizzle(env.DB)
      .select({ id: scenarioSourceCommits.id })
      .from(scenarioSourceCommits)
      .where(stillCompiling)
      .limit(1);
    if (!current) {
      await object.body.cancel();
      throw fenced();
    }
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-length": String(object.size),
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    const refusal = toErrorResponse(error, "scenario source snapshot failed");
    return jsonResponse(refusal.body, refusal.status);
  }
}

/**
 * A pull compile's result: the multipart success runs the request half of
 * ingest with the pull claim, and a JSON `SourceCompileFailureV1` makes the
 * row invalid with its diagnostics. Scope, rev and sha come from the row,
 * never from the builder.
 */
export async function handleAgentSourceResult(
  request: Request,
  env: Cloudflare.Env,
  compileId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;
  const agent = verified.agent;
  try {
    const { row, attempt, stillCompiling } = await fencedSourceCompile(
      env,
      agent,
      request,
      compileId,
    );
    const response = (request.headers.get("content-type") ?? "").startsWith(
      "application/json",
    )
      ? await recordSourceCompileFailure(request, env, row, attempt, stillCompiling)
      : await acceptScenarioSourceUpload(request, env, {
          scope: scenarioSourceScope(row.organizationId),
          repositoryId: row.repositoryId,
          sha: row.sha,
          purpose: row.purpose,
          claim: { via: "pull", commitId: row.id, attempt, hostId: agent.hostId },
        }).catch((error: unknown) => {
          const refusal = toErrorResponse(error, "scenario source compile result failed");
          return jsonResponse(refusal.body, refusal.status);
        });
    const state = response.ok
      ? "ingesting"
      : await settleRefusedResult(env, stillCompiling, response.clone());
    if (state === null) return response;
    // An expiry-like return keeps the archive for the next delivery.
    if (state !== "fetching") {
      await env.VM_IMAGE_REGISTRY_BUCKET.delete(sourceArchiveKey(row));
    }
    await endSourceCompiles(env, [agent.hostId]);
    return response;
  } catch (error) {
    const refusal = toErrorResponse(error, "scenario source compile result failed");
    return jsonResponse(refusal.body, refusal.status);
  }
}

// The fence of both compile routes: the row is still compiling on this
// builder under this attempt, and its binding may still write.
async function fencedSourceCompile(
  env: Cloudflare.Env,
  agent: VerifiedAgentHost,
  request: Request,
  compileId: string,
) {
  const attemptParam = new URL(request.url).searchParams.get("attempt") ?? "";
  if (!isSafeBundleRev(compileId) || !/^\d{1,9}$/.test(attemptParam)) {
    throw appError(400, "compile_invalid", "invalid compile id or attempt");
  }
  const attempt = Number(attemptParam);
  const [row] = await drizzle(env.DB)
    .select({
      id: scenarioSourceCommits.id,
      scopeKey: scenarioSourceCommits.scopeKey,
      purpose: scenarioSourceCommits.purpose,
      sha: scenarioSourceCommits.sha,
      rev: scenarioSourceCommits.rev,
      attempt: scenarioSourceCommits.attempt,
      state: scenarioSourceCommits.state,
      compileHostId: scenarioSourceCommits.compileHostId,
      organizationId: scenarioSources.organizationId,
      repositoryId: scenarioSources.githubRepositoryId,
      active: sql<number>`${scenarioSourceBindingPredicate()}`,
    })
    .from(scenarioSourceCommits)
    .innerJoin(scenarioSources, eq(scenarioSources.scopeKey, scenarioSourceCommits.scopeKey))
    .where(and(eq(scenarioSourceCommits.id, compileId), currentAgentHost(agent)))
    .limit(1);
  if (!row) throw appError(404, "not_found", "compile not found");
  if (
    row.state !== "compiling" ||
    row.compileHostId !== agent.hostId ||
    row.attempt !== attempt
  ) {
    throw fenced();
  }
  if (!row.active) {
    throw sourceRefusal(
      409,
      "binding_inactive",
      "This scenario source is paused or disconnected.",
    );
  }
  const stillCompiling = and(
    eq(scenarioSourceCommits.id, compileId),
    eq(scenarioSourceCommits.attempt, attempt),
    eq(scenarioSourceCommits.compileHostId, agent.hostId),
    eq(scenarioSourceCommits.state, "compiling"),
    currentAgentHost(agent),
    sql`EXISTS (SELECT 1 FROM scenario_sources WHERE scope_key = ${row.scopeKey}
      AND ${scenarioSourceBindingPredicate()})`,
  );
  return { row, attempt, stillCompiling };
}

// A result the builder drops and would only repeat settles the row now, not
// at the lease: a content refusal is invalid with its reason, and a compiler
// mismatch returns the row like an expiry. The fence, a 5xx and a body cut off
// in transit (`multipart_required`) leave it compiling. Null when unchanged.
async function settleRefusedResult(
  env: Cloudflare.Env,
  stillCompiling: ReturnType<typeof and>,
  response: Response,
): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as AppErrorResponseBody | null;
  const outdated = body?.code === "compiler_outdated";
  if (
    !outdated &&
    ((response.status !== 400 && response.status !== 413) ||
      body?.code === "multipart_required")
  ) {
    return null;
  }
  const [settled] = await drizzle(env.DB)
    .update(scenarioSourceCommits)
    .set({
      state: outdated
        ? sql`CASE WHEN attempt - COALESCE(claimed_attempt, 0) >= ${MAX_COMPILE_ATTEMPTS}
            THEN 'failed' ELSE 'fetching' END`
        : "invalid",
      detail: body?.error ?? `refused with ${response.status}`,
      updatedAt: Date.now(),
    })
    .where(stillCompiling)
    .returning({ state: scenarioSourceCommits.state });
  return settled?.state ?? null;
}

function fenced() {
  return sourceRefusal(409, "fenced", "This compile is no longer assigned to this builder.");
}

function sourceArchiveKey(row: {
  scopeKey: string;
  rev: string;
  purpose: "deploy" | "validate";
}): string {
  return `${stagedSourceObjectPrefix(row.scopeKey, row.rev, row.purpose)}source.tar.gz`;
}

// Diagnostics are kept whole, in order, up to the column's 64 KiB.
async function recordSourceCompileFailure(
  request: Request,
  env: Cloudflare.Env,
  row: { id: string },
  attempt: number,
  stillCompiling: ReturnType<typeof and>,
): Promise<Response> {
  let failure: unknown;
  try {
    const body = request.body
      ? await readBoundedBody(request.body, MAX_SOURCE_UPLOAD_BYTES)
      : new Uint8Array();
    failure = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      throw appError(413, "payload_too_large", "The compile result is too large.");
    }
    throw appError(400, "compile_failure_invalid", "The compile failure is not JSON.");
  }
  if (
    !isRecord(failure) ||
    failure.compile_id !== row.id ||
    failure.attempt !== attempt ||
    !Array.isArray(failure.errors)
  ) {
    throw appError(400, "compile_failure_invalid", "The compile failure names another compile.");
  }
  const diagnostics: unknown[] = [];
  let size = 2;
  for (const entry of failure.errors) {
    if (!isRecord(entry) || typeof entry.message !== "string") continue;
    const text = JSON.stringify(entry);
    size += text.length + 1;
    if (size > MAX_DIAGNOSTICS_CHARS) break;
    diagnostics.push(entry);
  }
  const updated = await drizzle(env.DB)
    .update(scenarioSourceCommits)
    .set({
      state: "invalid",
      detail: "The repository did not compile.",
      diagnosticsJson: JSON.stringify(diagnostics),
      updatedAt: Date.now(),
    })
    .where(stillCompiling)
    .returning({ id: scenarioSourceCommits.id });
  if (!updated.length) throw fenced();
  return jsonResponse({ ok: true }, 202);
}

export async function handleAgentBuildLogUpload(
  request: Request,
  env: Cloudflare.Env,
  buildId: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!isSafeBuildId(buildId)) {
    return jsonResponse({ error: "invalid build id" }, 400);
  }

  if (!/^[0-9a-f]{64}$/.test(buildId)) {
    return jsonResponse({ error: "build not found" }, 404);
  }
  return putMachineBuildLog(request, env, buildId, verified.agent.hostId);
}

/** The builder logs two 4 MiB tails and an error line. */
const MAX_MACHINE_BUILD_LOG_BYTES = 9 * 1024 * 1024;

/** Stores the log of a machine build, keyed by its build key hex, for its assigned builder. */
async function putMachineBuildLog(
  request: Request,
  env: Cloudflare.Env,
  hex: string,
  hostId: string,
): Promise<Response> {
  const buildKey = `sha256:${hex}`;
  const assigned = await env.DB.prepare(
    "SELECT 1 FROM machine_builds WHERE build_key = ?1 AND host_id = ?2",
  ).bind(buildKey, hostId).first();
  if (!assigned) return jsonResponse({ error: "build is not assigned to this builder" }, 409);
  const length = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isSafeInteger(length) || length > MAX_MACHINE_BUILD_LOG_BYTES) {
    return jsonResponse({ error: "a log of at most 9 MiB with a Content-Length is required" }, 413);
  }
  const payload = await request.arrayBuffer();
  if (payload.byteLength > MAX_MACHINE_BUILD_LOG_BYTES) return jsonResponse({ error: "the log is too large" }, 413);
  const objectKey = `builds/logs/${hex}.log`;
  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { build_id: hex, host_id: hostId },
  });
  await env.DB.prepare(
    "UPDATE machine_builds SET log_key = ?3 WHERE build_key = ?1 AND host_id = ?2",
  ).bind(buildKey, hostId, objectKey).run();
  return jsonResponse({ ok: true, build_id: hex, log_key: objectKey });
}

export async function requireBuilderAgentRequest(
  request: Request,
  env: Cloudflare.Env,
) {
  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified;
  if (verified.agent.role !== "builder") {
    return {
      ok: false as const,
      response: jsonResponse({ error: "builder role required" }, 403),
    };
  }
  if (verified.agent.scope !== "platform") {
    return {
      ok: false as const,
      response: jsonResponse(
        { error: "Only platform servers can build images" },
        403,
      ),
    };
  }
  return verified;
}
