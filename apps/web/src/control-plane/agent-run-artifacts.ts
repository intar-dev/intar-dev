import { drizzle } from "drizzle-orm/d1";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import { type SessionTimelineEntry } from "@/lib/run-state";
import {
  advanceRunVmArchiveStage,
  advanceArtifactUpload,
  artifactMetadataMatches,
  artifactWritesSealedResponse,
  decodePathSegment,
  ensureArtifactStates,
  inspectExistingArtifactManifestRetry,
  initializeArtifactUpload,
  jsonResponse,
  loadArtifactForRunVm,
  loadArtifactStatesForRunVm,
  loadArtifactUploadState,
  markArtifactUploaded,
  normalizeArtifactInputs,
  parseUploadedParts,
  requireVerifiedRunVm,
  resolveRunVm,
  runPurgedResponse,
  transitionRunVmToArchiving,
  transitionRunVmToCompleted,
  type ResolvedRunVm,
} from "./agent-run-artifacts/storage";
import {
  archiveStageRankForAgentStage,
  type AgentArchiveStage,
} from "@/lib/scenario-runs/saving-stage";

interface AgentRunBeginRequest {
  runId?: string;
  vmName?: string;
  /** Opt-in capability so a newer web deployment stays compatible with old agents. */
  archiveProgressVersion?: number;
  createdAtMs?: number;
  deleteRequestedAtMs?: number;
  deletedAtMs?: number;
  artifacts?: unknown;
}

interface AgentRunTimelineRequest {
  version?: number;
  sessions?: AgentRunTimelineSessionInput[];
}

interface AgentRunArchiveStageRequest {
  stage?: AgentArchiveStage;
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
// The archive has one raw recording plus two rendered files per terminal
// session. Leave room for that complete 3 + (2 * 500) manifest.
const MAX_BEGIN_ARTIFACTS = 1024;
// A bounded exception lets an agent which registered its archive before this
// limit was deployed retry the exact same manifest. It never reserves new
// rows, and the 2 MiB request cap remains the primary memory bound.
const MAX_LEGACY_BEGIN_RETRY_ARTIFACTS = 4_096;
const MAX_BEGIN_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RUN_IDENTIFIER_BYTES = 128;
const MAX_VM_NAME_BYTES = 128;
/** The agent caps transcripts around 1 MB; leave headroom but stay well
 * under D1's ~2 MB per-value limit. */
const MAX_TRANSCRIPT_BYTES = 1_500_000;
// Timeline JSON must be materialized for validation, so cap the aggregate
// transcript bytes well below the Worker memory limit too.
const MAX_TOTAL_TIMELINE_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
// Metadata is small relative to transcripts. This hard body limit also covers
// malformed or malicious JSON before it can be fully materialized in memory.
const MAX_TIMELINE_REQUEST_BYTES = 9 * 1024 * 1024;
// D1 allows 100 bound parameters per query. These multi-row statements keep
// the worst-case 500-session scenario publication at 89 statements: 56
// terminal-session inserts + 32 transcript inserts + one state update.
const MAX_D1_BOUND_PARAMETERS = 100;
const TERMINAL_SESSION_COLUMNS_PER_ROW = 11;
const SCENARIO_TRANSCRIPT_COLUMNS_PER_ROW = 6;
const MAX_TERMINAL_SESSIONS_PER_STATEMENT = Math.floor(
  MAX_D1_BOUND_PARAMETERS / TERMINAL_SESSION_COLUMNS_PER_ROW,
);
const MAX_SCENARIO_TRANSCRIPTS_PER_STATEMENT = Math.floor(
  MAX_D1_BOUND_PARAMETERS / SCENARIO_TRANSCRIPT_COLUMNS_PER_ROW,
);
// Transcript objects are independent. A small fixed fan-out avoids unbounded
// R2 subrequests while leaving headroom below Workers' six-connection limit.
const MAX_CONCURRENT_TRANSCRIPT_PUTS = 4;
const timelineTextEncoder = new TextEncoder();
const timelineTextDecoder = new TextDecoder();

interface NormalizedTimelineSession {
  entry: SessionTimelineEntry;
  transcript: string;
}

interface TimelineSessionWork {
  session: NormalizedTimelineSession;
  recordingArtifact:
    Awaited<ReturnType<typeof loadArtifactStatesForRunVm>>[number] | null;
  transcriptR2Key: string | null;
}

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

  const archiveStageMatch = pathname.match(
    /^\/agent\/runs\/([^/]+)\/vms\/([^/]+)\/archive-stage$/,
  );
  if (archiveStageMatch) {
    const runId = decodePathSegment(archiveStageMatch[1] ?? "");
    const vmName = decodePathSegment(archiveStageMatch[2] ?? "");
    if (!runId || !vmName) {
      return jsonResponse({ error: "invalid run or vm path" }, 400);
    }
    return handleRunArchiveStage(request, env, runId, vmName);
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

  const parsedBody = await parseBoundedJsonRequest<AgentRunBeginRequest>(
    request,
    MAX_BEGIN_REQUEST_BYTES,
    "begin payload",
  );
  if (!parsedBody.ok) {
    return jsonResponse({ error: parsedBody.error }, parsedBody.status);
  }
  const body = parsedBody.body;
  if (!isJsonObject(body)) {
    return jsonResponse({ error: "invalid json body" }, 400);
  }

  const runId = normalizeBoundedIdentifier(
    body.runId,
    MAX_RUN_IDENTIFIER_BYTES,
  );
  const vmName = normalizeBoundedIdentifier(body.vmName, MAX_VM_NAME_BYTES);
  if (!runId || !vmName) {
    return jsonResponse({ error: "runId and vmName are required" }, 400);
  }

  const artifactPayload = body.artifacts ?? [];
  if (
    !Array.isArray(artifactPayload) ||
    artifactPayload.length > MAX_LEGACY_BEGIN_RETRY_ARTIFACTS
  ) {
    return jsonResponse({ error: "invalid artifacts payload" }, 400);
  }
  const oversizedManifestRetry = artifactPayload.length > MAX_BEGIN_ARTIFACTS;
  const artifacts = normalizeArtifactInputs(
    artifactPayload,
    MAX_LEGACY_BEGIN_RETRY_ARTIFACTS,
  );
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
  // This is a private capability negotiation, not learner-facing state. A
  // new agent can distinguish an upgraded control plane from an older one
  // that silently ignored the request field.
  const archiveProgressVersion =
    body.archiveProgressVersion === 1 ? 1 : undefined;

  if (oversizedManifestRetry) {
    // The post-deploy compatibility path never reserves or changes manifest
    // rows. It accepts a complete exact match in every ledger that owns this
    // VM, so an oversized request can never extend a manifest.
    const retry = await inspectExistingArtifactManifestRetry({
      db,
      runVm,
      artifacts,
    });
    if (retry.status === "exact") {
      if (runVm.artifactWritesSealed && !retry.allUploaded) {
        return artifactWritesSealedResponse();
      }
      if (!runVm.artifactWritesSealed) {
        await transitionRunVmToArchiving(db, runVm, Date.now(), {
          recordArchiveProgress: archiveProgressVersion === 1,
        });
      }
      return runBeginSuccessResponse(runVm, archiveProgressVersion);
    }
    return retry.status === "absent" || retry.status === "new_reservation"
      ? jsonResponse({ error: "invalid artifacts payload" }, 400)
      : jsonResponse(
          { error: "artifact manifest does not match existing upload" },
          409,
        );
  }

  if (runVm.artifactWritesSealed) {
    const existingArtifacts = await loadArtifactStatesForRunVm(db, runVm);
    const existingByOrdinal = new Map(
      existingArtifacts.map((artifact) => [artifact.ordinal, artifact]),
    );
    const isIdempotentRetry = artifacts.every((artifact) => {
      const existing = existingByOrdinal.get(artifact.ordinal);
      return (
        existing?.uploadStatus === "uploaded" &&
        artifactMetadataMatches(existing, artifact)
      );
    });
    return isIdempotentRetry
      ? runBeginSuccessResponse(runVm, archiveProgressVersion)
      : artifactWritesSealedResponse();
  }
  const now = Date.now();

  const ensured = await ensureArtifactStates({
    db,
    runVm,
    artifacts,
    createdAt: now,
  });
  if (ensured.invalidManifest) {
    return jsonResponse({ error: "invalid artifacts payload" }, 400);
  }
  if (ensured.conflictOrdinal !== null) {
    return jsonResponse(
      {
        error: `artifact ${ensured.conflictOrdinal} metadata does not match existing upload`,
      },
      409,
    );
  }

  await transitionRunVmToArchiving(db, runVm, now, {
    // Detailed archive milestones are a versioned agent capability. Keeping
    // this opt-in means an older agent still receives the established coarse
    // save flow rather than getting stranded at the first new step.
    recordArchiveProgress: archiveProgressVersion === 1,
  });

  return runBeginSuccessResponse(runVm, archiveProgressVersion);
}

function runBeginSuccessResponse(
  runVm: { runId: string; runtimeVmName: string },
  archiveProgressVersion: 1 | undefined,
): Response {
  return jsonResponse({
    runId: runVm.runId,
    vmName: runVm.runtimeVmName,
    ...(archiveProgressVersion === 1 ? { archiveProgressVersion: 1 } : {}),
  });
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
  const artifact = await loadArtifactForRunVm(db, runVm, ordinal);
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
      runVm,
      artifact,
      uploadedAt: now,
    });
    return jsonResponse({ done: true, nextExpectedPart: 1 });
  }

  const existingUpload = await loadArtifactUploadState(db, artifact);
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

  await initializeArtifactUpload({
    db,
    runVm,
    artifact,
    r2UploadId: multipart.uploadId,
    updatedAt: now,
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
  const artifact = await loadArtifactForRunVm(db, runVm, ordinal);
  if (!artifact) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }

  const upload = await loadArtifactUploadState(db, artifact);
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

  await advanceArtifactUpload({
    db,
    runVm,
    artifact,
    uploadedParts,
    nextExpectedPart: partNumber + 1,
    updatedAt: Date.now(),
  });

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
  const artifact = await loadArtifactForRunVm(db, runVm, ordinal);
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
      runVm,
      artifact,
      uploadedAt: now,
    });
    return jsonResponse({ ok: true, uploaded: true });
  }

  const upload = await loadArtifactUploadState(db, artifact);
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
    runVm,
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
  if (runVm.artifactWritesSealed) {
    await transitionRunVmToCompleted(db, runVm, Date.now());
    return jsonResponse({ ok: true });
  }

  const artifacts = await loadArtifactStatesForRunVm(db, runVm);
  if (artifacts.some((artifact) => artifact.uploadStatus !== "uploaded")) {
    return jsonResponse(
      { error: "all artifacts must be uploaded before completing the run" },
      409,
    );
  }

  const now = Date.now();
  await transitionRunVmToCompleted(db, runVm, now);

  return jsonResponse({ ok: true });
}

async function handleRunArchiveStage(
  request: Request,
  env: Cloudflare.Env,
  runId: string,
  vmName: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const resolved = await requireVerifiedRunVm(request, env, runId, vmName, {
    // A lost response can make a stage report arrive after /complete. It
    // remains safe and idempotent because the SQL update is monotonic.
    allowSealed: true,
  });
  if (!resolved.ok) {
    return resolved.response;
  }

  let body: AgentRunArchiveStageRequest;
  try {
    body = (await request.json()) as AgentRunArchiveStageRequest;
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  if (!isAgentArchiveStage(body.stage)) {
    return jsonResponse({ error: "invalid archive stage" }, 400);
  }

  await advanceRunVmArchiveStage({
    db: resolved.db,
    runVm: resolved.runVm,
    stageRank: archiveStageRankForAgentStage(body.stage),
    now: Date.now(),
  });
  return jsonResponse({ ok: true });
}

function isAgentArchiveStage(value: unknown): value is AgentArchiveStage {
  return (
    value === "raw_files_saved" ||
    value === "replay_prepared" ||
    value === "replay_skipped"
  );
}

/**
 * Receives the rendered session timeline (metadata + transcripts) after the
 * cast uploads pass. Transcripts land in their own table; the metadata is
 * projected into the run state document as `vm.sessionTimeline`, which is
 * the authority for replay readiness. Idempotent: retries upsert the same
 * rows and overwrite the same state field.
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

  const parsedBody = await parseBoundedTimelineRequest(request);
  if (!parsedBody.ok) {
    return jsonResponse({ error: parsedBody.error }, parsedBody.status);
  }
  const body = parsedBody.body;
  if (!isJsonObject(body)) {
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
  const artifactRows = await loadArtifactStatesForRunVm(db, runVm);
  const castArtifactByFilename = new Map(
    artifactRows
      .filter((artifact) => artifact.kind === "ssh_recording_segment")
      .map((artifact) => [artifact.filename, artifact]),
  );
  for (const session of sessions) {
    const castArtifact = castArtifactByFilename.get(session.entry.castFilename);
    if (!castArtifact || castArtifact.uploadStatus !== "uploaded") {
      return jsonResponse(
        { error: "timeline cast artifact is not uploaded" },
        409,
      );
    }
    session.entry.castArtifactId = castArtifact.id;
  }

  const now = Date.now();
  const artifactById = new Map(
    artifactRows.map((artifact) => [artifact.id, artifact]),
  );
  const runtimeVmId = runVm.runtimeVmId;
  const timelineWork: TimelineSessionWork[] = sessions.map((session) => {
    const recordingArtifact =
      session.entry.castArtifactId === null
        ? null
        : (artifactById.get(session.entry.castArtifactId) ?? null);
    const transcriptR2Key =
      runVm.domainKind === "workshop" && runtimeVmId
        ? buildTerminalTranscriptObjectKey({
            runId: runVm.runId,
            runtimeVmId,
            sessionIndex: session.entry.index,
          })
        : null;
    return { session, recordingArtifact, transcriptR2Key };
  });

  const scenarioTimelineJson =
    runVm.domainKind === "scenario"
      ? JSON.stringify(sessions.map((session) => session.entry))
      : null;

  // R2 is not transactional, so make every transcript landing succeed before
  // publishing its ledger. A retry overwrites the same keys. If D1 later
  // rejects the atomic publication, these objects remain undiscoverable.
  await runBounded(
    timelineWork.filter((work) => work.transcriptR2Key !== null),
    MAX_CONCURRENT_TRANSCRIPT_PUTS,
    async (work) => {
      const transcriptR2Key = work.transcriptR2Key;
      if (transcriptR2Key === null) return;
      await env.VM_RUN_ARTIFACTS_BUCKET.put(
        transcriptR2Key,
        work.session.transcript,
        { httpMetadata: { contentType: "text/plain; charset=utf-8" } },
      );
    },
  );

  const publication = await publishTimelineAtomically({
    d1: db.$client,
    runVm,
    runtimeVmId,
    timelineWork,
    now,
    scenarioTimelineJson,
  });
  if (publication === "scenario_target_missing") {
    return runPurgedResponse();
  }

  return jsonResponse({ ok: true });
}

/**
 * Do not let a rejected `Promise.all()` abandon sibling R2 puts. This worker
 * pool awaits every in-flight operation, stops scheduling after the first
 * failure, and only then rethrows it.
 */
async function runBounded<T>(
  values: readonly T[],
  maxConcurrent: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        await operation(values[index]!);
      } catch (error) {
        failed = true;
        failure = error;
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrent, values.length) }, () =>
      worker(),
    ),
  );
  if (failed) {
    throw failure;
  }
}

/**
 * D1 `batch()` is one transaction. Keep this as one call: a failed transcript
 * group, target guard, or state update must roll back all terminal-session
 * rows too.
 */
async function publishTimelineAtomically(input: {
  d1: D1Database;
  runVm: ResolvedRunVm;
  runtimeVmId: string | null;
  timelineWork: readonly TimelineSessionWork[];
  now: number;
  scenarioTimelineJson: string | null;
}): Promise<"published" | "scenario_target_missing"> {
  const statements: D1PreparedStatement[] = [];
  if (input.runVm.domainKind === "scenario") {
    if (input.scenarioTimelineJson === null) {
      throw new Error("scenario timeline JSON is missing");
    }
    statements.push(
      buildScenarioTimelineTargetGuardStatement({
        d1: input.d1,
        runVm: input.runVm,
      }),
    );
  }
  if (input.runtimeVmId) {
    statements.push(
      ...buildRuntimeTerminalSessionStatements({
        d1: input.d1,
        runId: input.runVm.runId,
        runtimeVmId: input.runtimeVmId,
        work: input.timelineWork,
        now: input.now,
      }),
    );
  }
  if (input.runVm.domainKind === "scenario") {
    statements.push(
      ...buildScenarioTranscriptStatements({
        d1: input.d1,
        runId: input.runVm.domainId,
        vmId: input.runVm.vmId,
        work: input.timelineWork,
        now: input.now,
      }),
    );
    statements.push(
      buildScenarioTimelineStateUpdateStatement({
        d1: input.d1,
        runId: input.runVm.domainId,
        vmId: input.runVm.vmId,
        timelineJson: input.scenarioTimelineJson!,
        now: input.now,
      }),
    );
  }

  // At 500 sessions this is at most 90 statements, comfortably below the
  // paid-plan 1,000-query invocation limit. Each individual statement stays
  // at or below D1's 100 bind-parameter limit by construction.
  if (statements.length > 90) {
    throw new Error("timeline publication statement budget exceeded");
  }
  if (statements.length === 0) {
    return "published";
  }
  try {
    await input.d1.batch(statements);
  } catch (error) {
    if (
      input.runVm.domainKind === "scenario" &&
      !(await scenarioTimelineTargetExists(
        input.d1,
        input.runVm.domainId,
        input.runVm.vmId,
      ))
    ) {
      return "scenario_target_missing";
    }
    throw error;
  }
  return "published";
}

/**
 * The state update below deliberately has a zero-row `WHERE` when its target
 * disappears. This first statement turns that condition into a CHECK failure
 * so D1 rolls back every later terminal/transcript statement in the batch.
 */
function buildScenarioTimelineTargetGuardStatement(input: {
  d1: D1Database;
  runVm: ResolvedRunVm;
}): D1PreparedStatement {
  return input.d1
    .prepare(
      `WITH target AS (
        SELECT 1
        FROM scenario_runs
        WHERE run_id = ?
          AND EXISTS (
            SELECT 1
            FROM json_each(state_json, '$.vms') AS vm
            WHERE json_extract(vm.value, '$.id') = ?
          )
      )
      INSERT INTO runtime_artifacts (
        id, execution_id, runtime_vm_id, ordinal, kind, filename,
        content_type, size_bytes, sha256, r2_key, upload_status,
        created_at, uploaded_at
      )
      SELECT
        '__scenario_timeline_target_missing__', ?, ?, -1,
        'scenario_timeline_guard', 'scenario_timeline_guard',
        'application/octet-stream', 0,
        '0000000000000000000000000000000000000000000000000000000000000000',
        '__scenario_timeline_target_missing__', 'pending', 0, NULL
      WHERE NOT EXISTS (SELECT 1 FROM target)`,
    )
    .bind(
      input.runVm.domainId,
      input.runVm.vmId,
      input.runVm.runId,
      input.runVm.runtimeVmId ?? "",
    );
}

function buildScenarioTimelineStateUpdateStatement(input: {
  d1: D1Database;
  runId: string;
  vmId: string;
  timelineJson: string;
  now: number;
}): D1PreparedStatement {
  return input.d1
    .prepare(
      `WITH target AS (
        SELECT
          '$.vms[' || vm.key || '].sessionTimeline' AS timeline_path
        FROM scenario_runs AS scenario
        CROSS JOIN json_each(scenario.state_json, '$.vms') AS vm
        WHERE scenario.run_id = ?
          AND json_extract(vm.value, '$.id') = ?
        LIMIT 1
      )
      UPDATE scenario_runs
      SET
        state_json = json_set(
          state_json,
          (SELECT timeline_path FROM target),
          json(?)
        ),
        updated_at = ?
      WHERE run_id = ?
        AND EXISTS (SELECT 1 FROM target)`,
    )
    .bind(input.runId, input.vmId, input.timelineJson, input.now, input.runId);
}

async function scenarioTimelineTargetExists(
  d1: D1Database,
  runId: string,
  vmId: string,
): Promise<boolean> {
  const row = await d1
    .prepare(
      `SELECT 1
      FROM scenario_runs
      WHERE run_id = ?
        AND EXISTS (
          SELECT 1
          FROM json_each(state_json, '$.vms') AS vm
          WHERE json_extract(vm.value, '$.id') = ?
        )
      LIMIT 1`,
    )
    .bind(runId, vmId)
    .first();
  return row !== null;
}

function buildRuntimeTerminalSessionStatements(input: {
  d1: D1Database;
  runId: string;
  runtimeVmId: string;
  work: readonly TimelineSessionWork[];
  now: number;
}): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const group of chunked(
    input.work,
    MAX_TERMINAL_SESSIONS_PER_STATEMENT,
  )) {
    const params = group.flatMap((work) => {
      const { entry } = work.session;
      return [
        `${input.runtimeVmId}:session:${entry.index}`,
        input.runId,
        input.runtimeVmId,
        entry.index,
        Math.floor(entry.startTimestampMs),
        Math.floor(entry.startTimestampMs + entry.durationMs),
        entry.exitCode,
        work.recordingArtifact?.storageKind === "runtime"
          ? work.recordingArtifact.id
          : null,
        work.transcriptR2Key,
        input.now,
        input.now,
      ];
    });
    assertD1ParameterBudget(params.length);
    statements.push(
      input.d1
        .prepare(
          `INSERT INTO runtime_terminal_sessions (
            id, execution_id, runtime_vm_id, ordinal, started_at, ended_at,
            exit_code, recording_artifact_id, transcript_r2_key, created_at,
            updated_at
          ) VALUES ${sqlValueTuples(
            group.length,
            TERMINAL_SESSION_COLUMNS_PER_ROW,
          )}
          ON CONFLICT(runtime_vm_id, ordinal) DO UPDATE SET
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            exit_code = excluded.exit_code,
            recording_artifact_id = excluded.recording_artifact_id,
            transcript_r2_key = excluded.transcript_r2_key,
            updated_at = excluded.updated_at`,
        )
        .bind(...params),
    );
  }
  return statements;
}

function buildScenarioTranscriptStatements(input: {
  d1: D1Database;
  runId: string;
  vmId: string;
  work: readonly TimelineSessionWork[];
  now: number;
}): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const group of chunked(
    input.work,
    MAX_SCENARIO_TRANSCRIPTS_PER_STATEMENT,
  )) {
    const params = group.flatMap((work) => [
      `${input.vmId}:session:${work.session.entry.index}`,
      input.runId,
      input.vmId,
      work.session.entry.index,
      work.session.transcript,
      input.now,
    ]);
    assertD1ParameterBudget(params.length);
    statements.push(
      input.d1
        .prepare(
          `INSERT INTO scenario_run_session_transcripts (
            id, run_id, vm_id, session_index, transcript, created_at
          ) VALUES ${sqlValueTuples(
            group.length,
            SCENARIO_TRANSCRIPT_COLUMNS_PER_ROW,
          )}
          ON CONFLICT(run_id, vm_id, session_index) DO UPDATE SET
            transcript = excluded.transcript`,
        )
        .bind(...params),
    );
  }
  return statements;
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

function sqlValueTuples(rows: number, columns: number): string {
  return Array.from(
    { length: rows },
    () => `(${Array.from({ length: columns }, () => "?").join(", ")})`,
  ).join(", ");
}

function assertD1ParameterBudget(parameterCount: number): void {
  if (parameterCount > MAX_D1_BOUND_PARAMETERS) {
    throw new Error("D1 parameter budget exceeded");
  }
}

async function parseBoundedTimelineRequest(
  request: Request,
): Promise<
  | { ok: true; body: AgentRunTimelineRequest }
  | { ok: false; status: 400 | 413; error: string }
> {
  return parseBoundedJsonRequest(
    request,
    MAX_TIMELINE_REQUEST_BYTES,
    "timeline payload",
  );
}

async function parseBoundedJsonRequest<T>(
  request: Request,
  maxBytes: number,
  payloadName: string,
): Promise<
  { ok: true; body: T } | { ok: false; status: 400 | 413; error: string }
> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    return {
      ok: false,
      status: 413,
      error: `${payloadName} is too large`,
    };
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, status: 400, error: "invalid json body" };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // A cancellation failure must not turn a bounded rejection into a
          // server error after the request limit was already crossed.
        }
        return {
          ok: false,
          status: 413,
          error: `${payloadName} is too large`,
        };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "invalid json body" };
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      body: JSON.parse(timelineTextDecoder.decode(bodyBytes)) as T,
    };
  } catch {
    return { ok: false, status: 400, error: "invalid json body" };
  }
}

function normalizeBoundedIdentifier(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") return "";
  if (timelineTextEncoder.encode(value).byteLength > maxBytes) return "";
  const normalized = value.trim();
  return normalized || "";
}

function isJsonObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildTerminalTranscriptObjectKey(input: {
  runId: string;
  runtimeVmId: string;
  sessionIndex: number;
}): string {
  return [
    "runtime-transcripts",
    sanitizeTranscriptKeySegment(input.runId),
    sanitizeTranscriptKeySegment(input.runtimeVmId),
    `${input.sessionIndex}.txt`,
  ].join("/");
}

function sanitizeTranscriptKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
}

function normalizeTimelineSessions(
  inputs: AgentRunTimelineSessionInput[],
): NormalizedTimelineSession[] | null {
  if (!Array.isArray(inputs) || inputs.length > MAX_TIMELINE_SESSIONS) {
    return null;
  }
  const sessions: NormalizedTimelineSession[] = [];
  let totalTranscriptBytes = 0;
  for (const [offset, input] of inputs.entries()) {
    const index = input.index;
    const startTimestampMs = input.startTimestampMs;
    const durationMs = input.durationMs;
    const castFilename = input.castFilename?.trim() ?? "";
    const transcript = input.transcript;
    const transcriptBytes =
      typeof transcript === "string"
        ? timelineTextEncoder.encode(transcript).byteLength
        : null;
    if (
      !Number.isSafeInteger(index) ||
      index === undefined ||
      index < 1 ||
      index !== offset + 1 ||
      !Number.isSafeInteger(startTimestampMs) ||
      startTimestampMs === undefined ||
      !Number.isSafeInteger(durationMs) ||
      durationMs === undefined ||
      durationMs < 0 ||
      !castFilename ||
      typeof transcript !== "string" ||
      transcriptBytes === null ||
      transcriptBytes > MAX_TRANSCRIPT_BYTES ||
      totalTranscriptBytes + transcriptBytes >
        MAX_TOTAL_TIMELINE_TRANSCRIPT_BYTES
    ) {
      return null;
    }
    totalTranscriptBytes += transcriptBytes;
    if (input.exitCode !== undefined && input.exitCode !== null) {
      if (!Number.isSafeInteger(input.exitCode)) {
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
