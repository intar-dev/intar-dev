import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { isRevisionScenarioId, isSafeScenarioId } from "@/lib/scenario-id";
import {
  courseLocationFromRunSnapshot,
  startScenarioRunForUser,
} from "@/lib/scenario-runs";
import { requireIdempotencyKey } from "@/lib/idempotency-key";
import { resolveOrganizationId } from "@/lib/organizations";

export const prerender = false;

/** A play page's `ref`: where its link was shared, as a short token. */
const PLAY_REF = /^[A-Za-z0-9._-]{1,64}$/;

interface StartScenarioBody {
  hostId?: unknown;
  organizationId?: unknown;
  launchSource?: unknown;
  ref?: unknown;
}

export const POST: APIRoute = async ({ request, params, locals }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  // Validate the idempotency key after authentication so an unauthenticated
  // caller sees the same 401 as any other protected route.
  let idempotencyKey: string;
  try {
    idempotencyKey = requireIdempotencyKey(
      request.headers.get("Idempotency-Key") ?? undefined,
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error, "invalid Idempotency-Key");
    return jsonResponse(body, { status });
  }

  // A revision-model id carries one encoded slash.
  const scenarioId = (params.scenarioId?.trim() ?? "").replace(/%2F/giu, "/");
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }
  if (!isSafeScenarioId(scenarioId) && !isRevisionScenarioId(scenarioId)) {
    return jsonResponse({ error: "invalid scenarioId" }, { status: 400 });
  }

  // The dispatch hint runs under the request lifetime, so the execution
  // context is a precondition of admission, not a detail of the response.
  // Validate it here: a missing context is a deployment fault, and refusing
  // before the commit never leaves a booting VM behind.
  const cfContext = locals.cfContext;
  if (!cfContext || typeof cfContext.waitUntil !== "function") {
    return jsonResponse(
      {
        error: "the request execution context is unavailable",
        code: "scenario_start_context_missing",
      },
      { status: 500 },
    );
  }

  let hostId: string | undefined;
  let organizationId: string | null = null;
  let play = false;
  let ref: string | undefined;
  if (request.headers.get("content-type")?.includes("application/json")) {
    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      return jsonResponse({ error: "invalid json body" }, { status: 400 });
    }
    if (
      typeof parsedBody !== "object" ||
      parsedBody === null ||
      Array.isArray(parsedBody)
    ) {
      return jsonResponse(
        { error: "json body must be an object" },
        { status: 400 },
      );
    }
    const body = parsedBody as StartScenarioBody;
    if (body.hostId !== undefined && typeof body.hostId !== "string") {
      return jsonResponse(
        { error: "hostId must be a string" },
        { status: 400 },
      );
    }
    if (
      body.organizationId !== undefined &&
      body.organizationId !== null &&
      typeof body.organizationId !== "string"
    ) {
      return jsonResponse(
        { error: "organizationId must be a string" },
        { status: 400 },
      );
    }
    if (body.launchSource !== undefined && body.launchSource !== "play") {
      return jsonResponse({ error: "launchSource must be play", code: "invalid_launch_source" }, { status: 400 });
    }
    play = body.launchSource === "play";
    if (body.ref !== undefined) {
      if (!play || typeof body.ref !== "string" || !PLAY_REF.test(body.ref)) {
        return jsonResponse(
          { error: "ref must be 1 to 64 letters, digits, dots, hyphens or underscores on a play start", code: "invalid_ref" },
          { status: 400 },
        );
      }
      ref = body.ref;
    }
    if (play && (body.organizationId != null || body.hostId !== undefined)) {
      return jsonResponse(
        { error: "a play start takes only a ref", code: "invalid_play_start" },
        { status: 400 },
      );
    }
    const organizationKey =
      typeof body.organizationId === "string"
        ? body.organizationId.trim() || null
        : null;
    organizationId = organizationKey
      ? await resolveOrganizationId(organizationKey)
      : null;
    if (
      (organizationKey && !organizationId) ||
      (organizationId && !authz.context.organizationIds.includes(organizationId))
    ) {
      return jsonResponse({ error: "scenario not found" }, { status: 404 });
    }
    hostId = typeof body.hostId === "string" ? body.hostId.trim() : undefined;
    if (body.hostId !== undefined && !hostId) {
      return jsonResponse(
        { error: "hostId must not be empty" },
        { status: 400 },
      );
    }
    if (hostId && !authz.context.isAdmin) {
      return jsonResponse({ error: "admin required" }, { status: 403 });
    }
  }

  try {
    const result = await startScenarioRunForUser({
      scenarioId,
      userId: authz.context.userId,
      idempotencyKey,
      ...(organizationId ? { organizationId } : {}),
      ...(hostId ? { hostId } : {}),
      ...(authz.context.isAdmin ? { allowDrainedAdminProof: true } : {}),
      ...(authz.context.isAdmin && !play ? { allowSequenceBypass: true } : {}),
      ...(play ? { launchSource: "play" as const } : {}),
      ...(ref ? { ref } : {}),
    });
    // The dispatch hint is background work, so it never enters the response
    // body and never delays it. The durable outbox sweep delivers the
    // committed version when this process dies before the wake.
    const { deliveryHint, ...accepted } = result;
    cfContext.waitUntil(deliveryHint);
    return jsonResponse(
      {
        ...accepted,
        run: {
          ...accepted.run,
          courseLocation: courseLocationFromRunSnapshot(accepted.run),
        },
      },
      {
      status: 202,
      headers: {
        Location: `/api/scenarios/runs/${result.runId}`,
        "Retry-After": "1",
      },
      },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to start scenario");
    return jsonResponse(body, {
      status,
      // A contended host is the one refusal that clears on its own: another
      // admission published a desired-state version between this request's
      // capacity read and its commit. The client retries the same idempotency
      // key, so a retry can never create a second VM set.
      ...(body.code === "scenario_host_capacity_contended"
        ? { headers: { "Retry-After": "1" } }
        : {}),
    });
  }
};
