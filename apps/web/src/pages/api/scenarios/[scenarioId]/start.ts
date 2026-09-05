import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  isSafeBuildId,
  isSafeBundleRev,
} from "@/control-plane/image-registry/shared";
import { isSafeScenarioId } from "@/lib/scenario-id";
import {
  courseLocationFromRunSnapshot,
  startScenarioRunForUser,
} from "@/lib/scenario-runs";
import { resolveOrganizationId } from "@/lib/organizations";

export const prerender = false;

interface StartScenarioBody {
  hostId?: unknown;
  organizationId?: unknown;
  candidateRevision?: unknown;
  candidateBuildId?: unknown;
}

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarioId = params.scenarioId?.trim() ?? "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }
  if (!isSafeScenarioId(scenarioId)) {
    return jsonResponse({ error: "invalid scenarioId" }, { status: 400 });
  }

  let hostId: string | undefined;
  let organizationId: string | null = null;
  let candidateRevision: string | undefined;
  let candidateBuildId: string | undefined;
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
    if (
      body.candidateRevision !== undefined &&
      typeof body.candidateRevision !== "string"
    ) {
      return jsonResponse(
        { error: "candidateRevision must be a string" },
        { status: 400 },
      );
    }
    if (
      body.candidateBuildId !== undefined &&
      typeof body.candidateBuildId !== "string"
    ) {
      return jsonResponse(
        { error: "candidateBuildId must be a string" },
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
    if (
      body.candidateRevision !== undefined ||
      body.candidateBuildId !== undefined
    ) {
      if (
        typeof body.candidateRevision !== "string" ||
        typeof body.candidateBuildId !== "string"
      ) {
        return jsonResponse(
          { error: "candidateRevision and candidateBuildId are required" },
          { status: 400 },
        );
      }
      candidateRevision = body.candidateRevision.trim();
      candidateBuildId = body.candidateBuildId.trim();
      if (
        !isSafeBundleRev(candidateRevision) ||
        !isSafeBuildId(candidateBuildId)
      ) {
        return jsonResponse(
          { error: "candidateRevision or candidateBuildId is invalid" },
          { status: 400 },
        );
      }
      if (!authz.context.isAdmin) {
        return jsonResponse({ error: "admin required" }, { status: 403 });
      }
    }
  }

  try {
    const result = await startScenarioRunForUser({
      scenarioId,
      userId: authz.context.userId,
      betaAdmission: authz.context.betaAdmission,
      ...(organizationId ? { organizationId } : {}),
      ...(hostId ? { hostId } : {}),
      ...(candidateRevision && candidateBuildId
        ? { candidateRevision, candidateBuildId }
        : {}),
      ...(authz.context.isAdmin ? { allowDrainedAdminProof: true } : {}),
      ...(authz.context.isAdmin ? { allowSequenceBypass: true } : {}),
    });
    return jsonResponse(
      {
        ...result,
        run: {
          ...result.run,
          courseLocation: courseLocationFromRunSnapshot(result.run),
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
      ...(body.code === "boot_capacity_pending"
        ? { headers: { "Retry-After": "2" } }
        : {}),
    });
  }
};
