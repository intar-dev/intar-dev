import type { APIRoute } from "astro";
import { and, eq, inArray } from "drizzle-orm";
import { member, workshopTemplates } from "@/db/schema";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import { resolveOrganizationId } from "@/lib/organizations";
import { requireWorkshopsEnabledForOrganization } from "@/lib/workshops/feature-flag";
import { getWorkshopSessionProjection } from "@/lib/workshops/projection";
import {
  createWorkshopSession,
  replaceWorkshopRoster,
} from "@/lib/workshops/sessions";
import { withWorkshopManagerRosterDefault } from "@/lib/workshops/roster-input";
import { parseRuntimeProviderSelection } from "@/lib/workshops/runtime-provider";
import { workshopDb } from "@/lib/workshops/shared";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as {
    templateId?: unknown;
    templateRevisionId?: unknown;
    title?: unknown;
    startsAt?: unknown;
    lobbyOpensAt?: unknown;
    members?: unknown;
    runtimeProvider?: unknown;
  } | null;
  try {
    await requireWorkshopsEnabledForOrganization(organizationId);
    const roster = withWorkshopManagerRosterDefault(
      parseRoster(body?.members),
      authz.context.userId,
    );
    const organizationMembers = await workshopDb()
      .select({ userId: member.userId })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          inArray(
            member.userId,
            roster.map((entry) => entry.userId),
          ),
        ),
      );
    if (organizationMembers.length !== roster.length) {
      throw appError(
        400,
        "workshop_roster_non_member",
        "every workshop roster entry must be an organization member",
      );
    }
    let templateRevisionId =
      typeof body?.templateRevisionId === "string"
        ? body.templateRevisionId.trim()
        : "";
    if (!templateRevisionId) {
      const templateId =
        typeof body?.templateId === "string" ? body.templateId.trim() : "";
      const templates = await workshopDb()
        .select({ currentRevisionId: workshopTemplates.currentRevisionId })
        .from(workshopTemplates)
        .where(
          and(
            eq(workshopTemplates.id, templateId),
            eq(workshopTemplates.organizationId, organizationId),
          ),
        )
        .limit(1);
      templateRevisionId = templates[0]?.currentRevisionId ?? "";
    }
    if (!templateRevisionId) {
      throw appError(
        404,
        "workshop_template_not_found",
        "workshop template not found",
      );
    }
    let runtimeProvider;
    try {
      runtimeProvider = parseRuntimeProviderSelection(body?.runtimeProvider);
    } catch (error) {
      throw appError(
        400,
        "workshop_runtime_provider_invalid",
        error instanceof Error ? error.message : "runtimeProvider is invalid",
      );
    }
    const session = await createWorkshopSession({
      organizationId,
      actorUserId: authz.context.userId,
      templateRevisionId,
      title: typeof body?.title === "string" ? body.title : "",
      scheduledStartAt:
        typeof body?.startsAt === "number" ? body.startsAt : Number.NaN,
      ...(body?.lobbyOpensAt === undefined
        ? {}
        : {
            lobbyOpensAt:
              typeof body.lobbyOpensAt === "number"
                ? body.lobbyOpensAt
                : Number.NaN,
          }),
      runtimeProvider,
    });
    await replaceWorkshopRoster({
      sessionId: session.id,
      actorUserId: authz.context.userId,
      members: roster,
    });
    return jsonResponse(
      await getWorkshopSessionProjection({
        sessionId: session.id,
        userId: authz.context.userId,
      }),
      { status: 201 },
    );
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to create workshop session",
    );
    return jsonResponse(errorBody, { status });
  }
};

function parseRoster(value: unknown): Array<{
  userId: string;
  role: "participant" | "helper" | "facilitator";
  workspaceEnabled: boolean;
}> {
  if (!Array.isArray(value)) {
    throw appError(
      400,
      "workshop_roster_invalid",
      "workshop members must be an array",
    );
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw appError(
        400,
        "workshop_roster_invalid",
        "workshop roster contains an invalid member",
      );
    }
    const userId = "userId" in entry && typeof entry.userId === "string"
      ? entry.userId.trim()
      : "";
    const role = "role" in entry ? entry.role : undefined;
    const workspaceEnabled =
      "workspaceEnabled" in entry ? entry.workspaceEnabled : undefined;
    if (
      !userId ||
      (role !== "participant" && role !== "helper" && role !== "facilitator") ||
      (workspaceEnabled !== undefined &&
        typeof workspaceEnabled !== "boolean")
    ) {
      throw appError(
        400,
        "workshop_roster_invalid",
        "workshop roster contains an invalid member",
      );
    }
    return {
      userId,
      role,
      workspaceEnabled:
        role === "participant" || workspaceEnabled === true,
    };
  });
}
