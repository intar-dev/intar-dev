import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull } from "drizzle-orm";
import { scenarioRunArtifacts, scenarioRuns } from "@/db/schema";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { applyArtifactDeliveryHeaders } from "@/lib/artifact-delivery";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const forceDownload =
    new URL(request.url).searchParams.get("download") === "1";

  const rawRunId = params.runId?.trim() ?? "";
  const rawArtifactId = params.artifactId?.trim() ?? "";
  let runId = rawRunId;
  let artifactId = rawArtifactId;

  try {
    runId = rawRunId ? decodeURIComponent(rawRunId) : "";
    artifactId = rawArtifactId ? decodeURIComponent(rawArtifactId) : "";
  } catch {
    return jsonResponse(
      { error: "invalid run or artifact id" },
      { status: 400 },
    );
  }

  if (!runId || !artifactId) {
    return jsonResponse(
      { error: "runId and artifactId are required" },
      { status: 400 },
    );
  }

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
        eq(scenarioRunArtifacts.id, artifactId),
        eq(scenarioRunArtifacts.runId, runId),
        eq(scenarioRuns.userId, authz.context.userId),
        isNull(scenarioRuns.hiddenAt),
      ),
    )
    .limit(1);

  const artifact = rows[0];
  if (!artifact || artifact.uploadStatus !== "uploaded") {
    return jsonResponse({ error: "artifact not found" }, { status: 404 });
  }

  const object = await env.VM_RUN_ARTIFACTS_BUCKET.get(
    artifact.r2Key,
    request.headers.get("range")
      ? {
          range: request.headers,
        }
      : undefined,
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
  if (object.range && "offset" in object.range) {
    const start = object.range.offset;
    const length = object.range.length ?? Math.max(0, object.size - start);
    const end = start + Math.max(0, length - 1);
    headers.set("content-range", `bytes ${start}-${end}/${artifact.sizeBytes}`);
    headers.set("content-length", `${length}`);
    status = 206;
  } else {
    headers.set("content-length", `${artifact.sizeBytes}`);
  }

  return new Response(object.body, {
    status,
    headers,
  });
};
