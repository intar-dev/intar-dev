import { env } from "cloudflare:workers";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { scenarioRunArtifacts, scenarioRuns } from "@/db/schema";
import { jsonResponse } from "@/lib/agent-bridge";
import { applyArtifactDeliveryHeaders } from "@/lib/artifact-delivery";

const ARCHIVE_PHASES = ["archiving", "completed", "failed"];

export function decodeScenarioRunArtifactRouteParams(
  rawRunId: string | undefined,
  rawArtifactId: string | undefined,
):
  | { ok: true; runId: string; artifactId: string }
  | { ok: false; response: Response } {
  let runId = rawRunId?.trim() ?? "";
  let artifactId = rawArtifactId?.trim() ?? "";
  try {
    runId = runId ? decodeURIComponent(runId) : "";
    artifactId = artifactId ? decodeURIComponent(artifactId) : "";
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        { error: "invalid run or artifact id" },
        { status: 400 },
      ),
    };
  }
  if (!runId || !artifactId) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "runId and artifactId are required" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, runId, artifactId };
}

export async function serveScenarioRunArtifactContent(params: {
  request: Request;
  runId: string;
  artifactId: string;
  ownerUserId?: string;
  archiveOnly?: boolean;
}): Promise<Response> {
  const forceDownload =
    new URL(params.request.url).searchParams.get("download") === "1";
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: scenarioRunArtifacts.id,
      contentType: scenarioRunArtifacts.contentType,
      filename: scenarioRunArtifacts.filename,
      r2Key: scenarioRunArtifacts.r2Key,
      sizeBytes: scenarioRunArtifacts.sizeBytes,
      uploadStatus: scenarioRunArtifacts.uploadStatus,
    })
    .from(scenarioRunArtifacts)
    .innerJoin(scenarioRuns, eq(scenarioRuns.runId, scenarioRunArtifacts.runId))
    .where(
      and(
        eq(scenarioRunArtifacts.id, params.artifactId),
        eq(scenarioRunArtifacts.runId, params.runId),
        params.ownerUserId
          ? eq(scenarioRuns.userId, params.ownerUserId)
          : undefined,
        params.archiveOnly
          ? inArray(scenarioRuns.state, ARCHIVE_PHASES)
          : undefined,
        isNull(scenarioRuns.hiddenAt),
      ),
    )
    .limit(1);

  const artifact = rows[0];
  if (!artifact || artifact.uploadStatus !== "uploaded") {
    return jsonResponse({ error: "artifact not found" }, { status: 404 });
  }

  const requestedRange = params.request.headers.get("range");
  const object = await env.VM_RUN_ARTIFACTS_BUCKET.get(
    artifact.r2Key,
    requestedRange ? { range: params.request.headers } : undefined,
  );
  if (!object) {
    return jsonResponse(
      { error: "artifact object not found" },
      { status: 404 },
    );
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  applyArtifactDeliveryHeaders(headers, {
    contentType: artifact.contentType,
    filename: artifact.filename,
    forceDownload,
  });

  let status = 200;
  if (requestedRange && object.range && "offset" in object.range) {
    const start = object.range.offset;
    const length = object.range.length ?? Math.max(0, object.size - start);
    const end = start + Math.max(0, length - 1);
    headers.set("content-range", `bytes ${start}-${end}/${artifact.sizeBytes}`);
    headers.set("content-length", `${length}`);
    status = 206;
  } else {
    headers.set("content-length", `${artifact.sizeBytes}`);
  }

  return new Response(object.body, { status, headers });
}
