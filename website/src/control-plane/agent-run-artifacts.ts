import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  scenarioRunArtifacts,
  scenarioRunArtifactUploads,
  scenarioRuns,
  scenarioRunSessionTranscripts,
} from "@/db/schema";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import { recomputeRunState, type SessionTimelineEntry } from "@/lib/run-state";
import {
  artifactIdFor,
  artifactMetadataMatches,
  artifactWritesSealedResponse,
  buildArtifactObjectKey,
  decodePathSegment,
  jsonResponse,
  loadArtifactForRunVm,
  loadArtifactStatesForRunVm,
  loadStoredRunLifecycle,
  markArtifactUploaded,
  normalizeArtifactInputs,
  parseRunState,
  parseUploadedParts,
  requireVerifiedRunVm,
  resolveRunVm,
  runPurgedResponse,
  transitionRunVmToArchiving,
  transitionRunVmToCompleted,
  type AgentRunArtifactInput,
} from "./agent-run-artifacts/storage";

interface AgentRunBeginRequest {
  runId?: string;
  vmName?: string;
  createdAtMs?: number;
  deleteRequestedAtMs?: number;
  deletedAtMs?: number;
  artifacts?: AgentRunArtifactInput[];
}

interface AgentRunTimelineRequest {
  version?: number;
  sessions?: AgentRunTimelineSessionInput[];
}

interface AgentRunTimelineSessionInput {
  index?: number;
  startTimestampMs?: number;
  durationMs?: number;
  exitCode?: number | null;
  castFilename?: string;
  transcript?: string;
  transcriptTruncated?: boolean;
}

const RUN_TIMELINE_VERSION = 1;
const MAX_TIMELINE_SESSIONS = 500;
/** The agent caps transcripts around 1 MB; leave headroom but stay well
 * under D1's ~2 MB per-value limit. */
const MAX_TRANSCRIPT_BYTES = 1_500_000;

export async function handleAgentRunArtifactRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/agent/runs/begin") {
    return handleBeginRunUpload(request, env);
  }

  const multipartBeginMatch = pathname.match(
    /^\/agent\/runs\/([^/]+)\/vms\/([^/]+)\/artifacts\/(\d+)\/multipart-begin$/,
  );
  if (multipartBeginMatch) {
    const runId = decodePathSegment(multipartBeginMatch[1] ?? "");
    const vmName = decodePathSegment(multipartBeginMatch[2] ?? "");
    if (!runId || !vmName) {
      return jsonResponse({ error: "invalid run or vm path" }, 400);
    }
    return handleMultipartBegin(
      request,
      env,
      runId,
      vmName,
      Number(multipartBeginMatch[3] ?? "0"),
    );
  }

  const partMatch = pathname.match(
    /^\/agent\/runs\/([^/]+)\/vms\/([^/]+)\/artifacts\/(\d+)\/parts\/(\d+)$/,
  );
  if (partMatch) {
    const runId = decodePathSegment(partMatch[1] ?? "");
    const vmName = decodePathSegment(partMatch[2] ?? "");
    if (!runId || !vmName) {
      return jsonResponse({ error: "invalid run or vm path" }, 400);
    }
    return handleMultipartPart(
      request,
      env,
      runId,
      vmName,
      Number(partMatch[3] ?? "0"),
      Number(partMatch[4] ?? "0"),
    );
  }

  const artifactCompleteMatch = pathname.match(
    /^\/agent\/runs\/([^/]+)\/vms\/([^/]+)\/artifacts\/(\d+)\/complete$/,
  );
  if (artifactCompleteMatch) {
    const runId = decodePathSegment(artifactCompleteMatch[1] ?? "");
    const vmName = decodePathSegment(artifactCompleteMatch[2] ?? "");
    if (!runId || !vmName) {
      return jsonResponse({ error: "invalid run or vm path" }, 400);
    }
    return handleArtifactComplete(
      request,
      env,
      runId,
      vmName,
      Number(artifactCompleteMatch[3] ?? "0"),
    );
  }

  const runCompleteMatch = pathname.match(
    /^\/agent\/runs\/([^/]+)\/vms\/([^/]+)\/complete$/,
  );
  if (runCompleteMatch) {
    const runId = decodePathSegment(runCompleteMatch[1] ?? "");
    const vmName = decodePathSegment(runCompleteMatch[2] ?? "");
    if (!runId || !vmName) {
      return jsonResponse({ error: "invalid run or vm path" }, 400);
    }
    return handleRunComplete(request, env, runId, vmName);
  }

  const timelineMatch = pathname.match(
    /^\/agent\/runs\/([^/]+)\/vms\/([^/]+)\/timeline$/,
  );
  if (timelineMatch) {
    const runId = decodePathSegment(timelineMatch[1] ?? "");
    const vmName = decodePathSegment(timelineMatch[2] ?? "");
    if (!runId || !vmName) {
      return jsonResponse({ error: "invalid run or vm path" }, 400);
    }
    return handleRunTimeline(request, env, runId, vmName);
  }

  return null;
}

async function handleBeginRunUpload(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) {
    return verified.response;
  }

  let body: AgentRunBeginRequest;
  try {
    body = (await request.json()) as AgentRunBeginRequest;
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }

  const runId = body.runId?.trim() ?? "";
  const vmName = body.vmName?.trim() ?? "";
  if (!runId || !vmName) {
    return jsonResponse({ error: "runId and vmName are required" }, 400);
  }

  const artifacts = normalizeArtifactInputs(body.artifacts ?? []);
  if (artifacts === null) {
    return jsonResponse({ error: "invalid artifacts payload" }, 400);
  }

  const db = drizzle(env.DB);
  const runVm = await resolveRunVm({
    db,
    runId,
    vmName,
    hostId: verified.agent.hostId,
  });
  if (!runVm) {
    return runPurgedResponse();
  }

  const existingArtifacts = await loadArtifactStatesForRunVm(
    db,
    runVm.runId,
    runVm.vmId,
  );
  if (runVm.artifactWritesSealed) {
    const isIdempotentRetry = artifacts.every((artifact) => {
      const existing = existingArtifacts.find(
        (candidate) => candidate.ordinal === artifact.ordinal,
      );
      return (
        existing?.uploadStatus === "uploaded" &&
        artifactMetadataMatches(existing, artifact)
      );
    });
    return isIdempotentRetry
      ? jsonResponse({ runId: runVm.runId, vmName: runVm.runtimeVmName })
      : artifactWritesSealedResponse();
  }
  const now = Date.now();

  for (const artifact of artifacts) {
    const existing = existingArtifacts.find(
      (candidate) => candidate.ordinal === artifact.ordinal,
    );
    const artifactId =
      existing?.id ?? artifactIdFor(runVm.vmId, artifact.ordinal);
    const r2Key =
      existing?.r2Key ??
      buildArtifactObjectKey({
        runId: runVm.runId,
        vmId: runVm.vmId,
        ordinal: artifact.ordinal,
        kind: artifact.kind,
        filename: artifact.filename,
      });

    if (existing) {
      if (!artifactMetadataMatches(existing, artifact)) {
        return jsonResponse(
          {
            error: `artifact ${artifact.ordinal} metadata does not match existing upload`,
          },
          409,
        );
      }
      continue;
    }

    await db.insert(scenarioRunArtifacts).values({
      id: artifactId,
      runId: runVm.runId,
      vmId: runVm.vmId,
      ordinal: artifact.ordinal,
      kind: artifact.kind,
      filename: artifact.filename,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      r2Key,
      uploadStatus: "pending",
      createdAt: now,
      uploadedAt: null,
    });
  }

  await transitionRunVmToArchiving(db, runVm.runId, runVm.vmId, now);

  return jsonResponse({ runId: runVm.runId, vmName: runVm.runtimeVmName });
}

async function handleMultipartBegin(
  request: Request,
  env: Cloudflare.Env,
  runId: string,
  vmName: string,
  ordinal: number,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const resolved = await requireVerifiedRunVm(request, env, runId, vmName, {
    allowSealed: true,
  });
  if (!resolved.ok) {
    return resolved.response;
  }

  const { db, runVm } = resolved;
  const artifact = await loadArtifactForRunVm(db, runId, runVm.vmId, ordinal);
  if (!artifact) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }

  if (artifact.uploadStatus === "uploaded") {
    return jsonResponse({ done: true, nextExpectedPart: 1 });
  }
  if (runVm.artifactWritesSealed) {
    return artifactWritesSealedResponse();
  }

  const now = Date.now();
  if (artifact.sizeBytes === 0) {
    await env.VM_RUN_ARTIFACTS_BUCKET.put(artifact.r2Key, new Uint8Array(), {
      httpMetadata: {
        contentType: artifact.contentType,
      },
    });
    await markArtifactUploaded({
      db,
      runId,
      vmId: runVm.vmId,
      artifact,
      uploadedAt: now,
    });
    return jsonResponse({ done: true, nextExpectedPart: 1 });
  }

  const existingUploadRows = await db
    .select({
      r2UploadId: scenarioRunArtifactUploads.r2UploadId,
      nextExpectedPart: scenarioRunArtifactUploads.nextExpectedPart,
    })
    .from(scenarioRunArtifactUploads)
    .where(eq(scenarioRunArtifactUploads.artifactId, artifact.id))
    .limit(1);
  const existingUpload = existingUploadRows[0];
  if (existingUpload?.r2UploadId) {
    return jsonResponse({
      done: false,
      nextExpectedPart: existingUpload.nextExpectedPart,
    });
  }

  const multipart = await env.VM_RUN_ARTIFACTS_BUCKET.createMultipartUpload(
    artifact.r2Key,
    {
      httpMetadata: {
        contentType: artifact.contentType,
      },
    },
  );

  await db
    .insert(scenarioRunArtifactUploads)
    .values({
      artifactId: artifact.id,
      r2UploadId: multipart.uploadId,
      uploadedPartsJson: "[]",
      nextExpectedPart: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: scenarioRunArtifactUploads.artifactId,
      set: {
        r2UploadId: multipart.uploadId,
        uploadedPartsJson: "[]",
        nextExpectedPart: 1,
        updatedAt: now,
      },
    });

  return jsonResponse({ done: false, nextExpectedPart: 1 });
}

async function handleMultipartPart(
  request: Request,
  env: Cloudflare.Env,
  runId: string,
  vmName: string,
  ordinal: number,
  partNumber: number,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  if (!request.body) {
    return jsonResponse({ error: "request body is required" }, 400);
  }

  const resolved = await requireVerifiedRunVm(request, env, runId, vmName);
  if (!resolved.ok) {
    return resolved.response;
  }

  const { db, runVm } = resolved;
  if (runVm.artifactWritesSealed) {
    return artifactWritesSealedResponse();
  }
  const artifact = await loadArtifactForRunVm(db, runId, runVm.vmId, ordinal);
  if (!artifact) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }

  const uploadRows = await db
    .select({
      r2UploadId: scenarioRunArtifactUploads.r2UploadId,
      uploadedPartsJson: scenarioRunArtifactUploads.uploadedPartsJson,
      nextExpectedPart: scenarioRunArtifactUploads.nextExpectedPart,
    })
    .from(scenarioRunArtifactUploads)
    .where(eq(scenarioRunArtifactUploads.artifactId, artifact.id))
    .limit(1);
  const upload = uploadRows[0];
  if (!upload?.r2UploadId) {
    return jsonResponse({ error: "multipart upload not initialized" }, 409);
  }
  if (partNumber !== upload.nextExpectedPart) {
    return jsonResponse(
      { error: `expected part ${upload.nextExpectedPart}, got ${partNumber}` },
      409,
    );
  }

  const multipart = env.VM_RUN_ARTIFACTS_BUCKET.resumeMultipartUpload(
    artifact.r2Key,
    upload.r2UploadId,
  );
  const uploadedPart = await multipart.uploadPart(partNumber, request.body);
  const uploadedParts = parseUploadedParts(upload.uploadedPartsJson);
  uploadedParts.push({
    partNumber,
    etag: uploadedPart.etag,
  });

  await db
    .update(scenarioRunArtifactUploads)
    .set({
      uploadedPartsJson: JSON.stringify(uploadedParts),
      nextExpectedPart: partNumber + 1,
      updatedAt: Date.now(),
    })
    .where(eq(scenarioRunArtifactUploads.artifactId, artifact.id));

  return jsonResponse({ ok: true, nextExpectedPart: partNumber + 1 });
}

async function handleArtifactComplete(
  request: Request,
  env: Cloudflare.Env,
  runId: string,
  vmName: string,
  ordinal: number,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const resolved = await requireVerifiedRunVm(request, env, runId, vmName, {
    allowSealed: true,
  });
  if (!resolved.ok) {
    return resolved.response;
  }

  const { db, runVm } = resolved;
  const artifact = await loadArtifactForRunVm(db, runId, runVm.vmId, ordinal);
  if (!artifact) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }
  if (artifact.uploadStatus === "uploaded") {
    return jsonResponse({ ok: true, uploaded: true });
  }
  if (runVm.artifactWritesSealed) {
    return artifactWritesSealedResponse();
  }

  const now = Date.now();
  if (artifact.sizeBytes === 0) {
    await env.VM_RUN_ARTIFACTS_BUCKET.put(artifact.r2Key, new Uint8Array(), {
      httpMetadata: {
        contentType: artifact.contentType,
      },
    });
    await markArtifactUploaded({
      db,
      runId,
      vmId: runVm.vmId,
      artifact,
      uploadedAt: now,
    });
    return jsonResponse({ ok: true, uploaded: true });
  }

  const uploadRows = await db
    .select({
      r2UploadId: scenarioRunArtifactUploads.r2UploadId,
      uploadedPartsJson: scenarioRunArtifactUploads.uploadedPartsJson,
    })
    .from(scenarioRunArtifactUploads)
    .where(eq(scenarioRunArtifactUploads.artifactId, artifact.id))
    .limit(1);
  const upload = uploadRows[0];
  if (!upload?.r2UploadId) {
    return jsonResponse({ error: "multipart upload not initialized" }, 409);
  }

  const uploadedParts = parseUploadedParts(upload.uploadedPartsJson);
  if (!uploadedParts.length) {
    return jsonResponse({ error: "no uploaded parts recorded" }, 409);
  }

  const multipart = env.VM_RUN_ARTIFACTS_BUCKET.resumeMultipartUpload(
    artifact.r2Key,
    upload.r2UploadId,
  );
  await multipart.complete(uploadedParts);

  await markArtifactUploaded({
    db,
    runId,
    vmId: runVm.vmId,
    artifact,
    uploadedAt: now,
  });

  return jsonResponse({ ok: true, uploaded: true });
}

async function handleRunComplete(
  request: Request,
  env: Cloudflare.Env,
  runId: string,
  vmName: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const resolved = await requireVerifiedRunVm(request, env, runId, vmName, {
    allowSealed: true,
  });
  if (!resolved.ok) {
    return resolved.response;
  }

  const { db, runVm } = resolved;

  // Completion is idempotent so a lost response does not strand the agent's
  // durable archive job after artifact writes have been sealed.
  const lifecycle = await loadStoredRunLifecycle(db, runId);
  const alreadyCompleted = lifecycle?.state.vms.some(
    (vm) => vm.id === runVm.vmId && vm.phase === "completed",
  );
  if (alreadyCompleted) {
    return jsonResponse({ ok: true });
  }

  const artifacts = await loadArtifactStatesForRunVm(db, runId, runVm.vmId);
  if (artifacts.some((artifact) => artifact.uploadStatus !== "uploaded")) {
    return jsonResponse(
      { error: "all artifacts must be uploaded before completing the run" },
      409,
    );
  }

  const now = Date.now();
  await transitionRunVmToCompleted(db, runId, runVm.vmId, now);

  return jsonResponse({ ok: true });
}

/**
 * Receives the rendered session timeline (metadata + transcripts) after the
 * cast uploads pass. Transcripts land in their own table; the metadata is
 * projected into the run state document as `vm.sessionTimeline`, which is
 * what flips the run page from "rendering" to the timeline. Idempotent:
 * retries upsert the same rows and overwrite the same state field.
 */
async function handleRunTimeline(
  request: Request,
  env: Cloudflare.Env,
  runId: string,
  vmName: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const resolved = await requireVerifiedRunVm(request, env, runId, vmName);
  if (!resolved.ok) {
    return resolved.response;
  }
  const { db, runVm } = resolved;
  if (runVm.artifactWritesSealed) {
    return artifactWritesSealedResponse();
  }

  let body: AgentRunTimelineRequest;
  try {
    body = (await request.json()) as AgentRunTimelineRequest;
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  if (body.version !== RUN_TIMELINE_VERSION) {
    return jsonResponse({ error: "unsupported timeline version" }, 400);
  }
  const sessions = normalizeTimelineSessions(body.sessions ?? []);
  if (sessions === null) {
    return jsonResponse({ error: "invalid timeline payload" }, 400);
  }

  // Resolve each session's cast artifact id from the ledger. The timeline
  // arrives after the cast uploads pass, so the rows exist; resolving here
  // keeps the UI off `replayArtifacts`, whose concurrent read-modify-write
  // appends can lose entries.
  const artifactRows = await loadArtifactStatesForRunVm(
    db,
    runVm.runId,
    runVm.vmId,
  );
  const castIdByFilename = new Map(
    artifactRows
      .filter((artifact) => artifact.kind === "ssh_recording_segment")
      .map((artifact) => [artifact.filename, artifact.id]),
  );
  for (const session of sessions) {
    session.entry.castArtifactId =
      castIdByFilename.get(session.entry.castFilename) ?? null;
  }

  const now = Date.now();
  for (const session of sessions) {
    await db
      .insert(scenarioRunSessionTranscripts)
      .values({
        id: `${runVm.vmId}:session:${session.entry.index}`,
        runId: runVm.runId,
        vmId: runVm.vmId,
        sessionIndex: session.entry.index,
        transcript: session.transcript,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [
          scenarioRunSessionTranscripts.runId,
          scenarioRunSessionTranscripts.vmId,
          scenarioRunSessionTranscripts.sessionIndex,
        ],
        set: {
          transcript: session.transcript,
        },
      });
  }

  const runRows = await db
    .select({ stateJson: scenarioRuns.stateJson })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.runId, runVm.runId))
    .limit(1);
  const run = runRows[0];
  if (!run) {
    return runPurgedResponse();
  }

  const state = parseRunState(run.stateJson);
  const nextState = recomputeRunState({
    ...state,
    vms: state.vms.map((vm) =>
      vm.id === runVm.vmId
        ? { ...vm, sessionTimeline: sessions.map((session) => session.entry) }
        : vm,
    ),
  });
  await db
    .update(scenarioRuns)
    .set({
      stateJson: JSON.stringify(nextState),
      updatedAt: now,
    })
    .where(eq(scenarioRuns.runId, runVm.runId));

  return jsonResponse({ ok: true });
}

function normalizeTimelineSessions(
  inputs: AgentRunTimelineSessionInput[],
): Array<{ entry: SessionTimelineEntry; transcript: string }> | null {
  if (!Array.isArray(inputs) || inputs.length > MAX_TIMELINE_SESSIONS) {
    return null;
  }
  const sessions: Array<{ entry: SessionTimelineEntry; transcript: string }> =
    [];
  for (const input of inputs) {
    const index = input.index;
    const startTimestampMs = input.startTimestampMs;
    const durationMs = input.durationMs;
    const castFilename = input.castFilename?.trim() ?? "";
    const transcript = input.transcript;
    if (
      !Number.isInteger(index) ||
      index === undefined ||
      index < 1 ||
      !Number.isFinite(startTimestampMs) ||
      startTimestampMs === undefined ||
      !Number.isFinite(durationMs) ||
      durationMs === undefined ||
      durationMs < 0 ||
      !castFilename ||
      typeof transcript !== "string" ||
      transcript.length > MAX_TRANSCRIPT_BYTES
    ) {
      return null;
    }
    if (input.exitCode !== undefined && input.exitCode !== null) {
      if (!Number.isInteger(input.exitCode)) {
        return null;
      }
    }
    sessions.push({
      entry: {
        index,
        startTimestampMs,
        durationMs,
        exitCode: input.exitCode ?? null,
        castFilename,
        castArtifactId: null,
        transcriptTruncated: input.transcriptTruncated === true,
      },
      transcript,
    });
  }
  return sessions;
}
