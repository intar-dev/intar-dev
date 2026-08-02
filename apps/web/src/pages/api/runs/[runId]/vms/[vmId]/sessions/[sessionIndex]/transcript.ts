import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull } from "drizzle-orm";
import { scenarioRunSessionTranscripts, scenarioRuns } from "@/db/schema";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const rawRunId = params.runId?.trim() ?? "";
  const rawVmId = params.vmId?.trim() ?? "";
  let runId = rawRunId;
  let vmId = rawVmId;
  try {
    runId = rawRunId ? decodeURIComponent(rawRunId) : "";
    vmId = rawVmId ? decodeURIComponent(rawVmId) : "";
  } catch {
    return jsonResponse({ error: "invalid run or vm id" }, { status: 400 });
  }
  const sessionIndex = Number(params.sessionIndex ?? "");
  if (!runId || !vmId || !Number.isInteger(sessionIndex) || sessionIndex < 1) {
    return jsonResponse(
      { error: "runId, vmId, and sessionIndex are required" },
      { status: 400 },
    );
  }

  const db = drizzle(env.DB);
  const rows = await db
    .select({ transcript: scenarioRunSessionTranscripts.transcript })
    .from(scenarioRunSessionTranscripts)
    .innerJoin(
      scenarioRuns,
      eq(scenarioRuns.runId, scenarioRunSessionTranscripts.runId),
    )
    .where(
      and(
        eq(scenarioRunSessionTranscripts.runId, runId),
        eq(scenarioRunSessionTranscripts.vmId, vmId),
        eq(scenarioRunSessionTranscripts.sessionIndex, sessionIndex),
        eq(scenarioRuns.userId, authz.context.userId),
        isNull(scenarioRuns.hiddenAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return jsonResponse({ error: "transcript not found" }, { status: 404 });
  }

  return new Response(row.transcript, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, max-age=60",
    },
  });
};
