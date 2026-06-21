import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  scenarioRunArtifacts,
  scenarioRunArtifactUploads,
  scenarioRunUploadLeases,
  scenarioRuns,
} from "@/db/schema";
import { requireVerifiedAgentRequest, sha256Hex } from "@/control-plane/auth";
import {
  RUN_PHASE_ORDER,
  recomputeRunState,
  type RunStateDocument,
  type ScenarioReplayArtifact,
} from "@/lib/run-state";
import { nextSolvedAt } from "@/lib/scenario-run-outcome";

interface AgentRunBeginRequest {
  runId?: string;
  vmName?: string;
  createdAtMs?: number;
  deleteRequestedAtMs?: number;
  deletedAtMs?: number;
  artifacts?: AgentRunArtifactInput[];
}

interface AgentRunArtifactInput {
  ordinal?: number;
  kind?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  sha256?: string;
}

interface UploadedPartRecord {
  partNumber: number;
  etag: string;
}

interface UploadLeaseRow {
  id: string;
  runId: string;
  vmId: string;
  hostId: string;
  tokenHash: string;
  expiresAt: number;
  completedAt: number | null;
}

interface ResolvedRunVm {
  runId: string;
  hostId: string;
  userId: string;
  scenarioId: string;
  vmId: string;
  runtimeVmName: string;
}

interface SourceArtifactState {
  id: string;
  runId: string;
  vmId: string;
  ordinal: number;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  r2Key: string;
  uploadStatus: string;
  uploadedAt: number | null;
}

const UPLOAD_LEASE_TTL_MS = 30 * 60 * 1000;

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
    /^\/agent\/runs\/([^/]+)\/artifacts\/(\d+)\/multipart-begin$/,
  );
  if (multipartBeginMatch) {
    return handleMultipartBegin(
      request,
      env,
      multipartBeginMatch[1] ?? "",
      Number(multipartBeginMatch[2] ?? "0"),
    );
  }

  const partMatch = pathname.match(
    /^\/agent\/runs\/([^/]+)\/artifacts\/(\d+)\/parts\/(\d+)$/,
  );
  if (partMatch) {
    return handleMultipartPart(
      request,
      env,
      partMatch[1] ?? "",
      Number(partMatch[2] ?? "0"),
      Number(partMatch[3] ?? "0"),
    );
  }

  const artifactCompleteMatch = pathname.match(
    /^\/agent\/runs\/([^/]+)\/artifacts\/(\d+)\/complete$/,
  );
  if (artifactCompleteMatch) {
    return handleArtifactComplete(
      request,
      env,
      artifactCompleteMatch[1] ?? "",
      Number(artifactCompleteMatch[2] ?? "0"),
    );
  }

  const runCompleteMatch = pathname.match(/^\/agent\/runs\/([^/]+)\/complete$/);
  if (runCompleteMatch) {
    return handleRunComplete(request, env, runCompleteMatch[1] ?? "");
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
    return jsonResponse({ error: "run VM not found" }, 404);
  }

  const existingArtifacts = await loadArtifactStatesForRunVm(db, runVm.runId, runVm.vmId);
  const now = Date.now();

  for (const artifact of artifacts) {
    const existing = existingArtifacts.find((candidate) => candidate.ordinal === artifact.ordinal);
    const artifactId = existing?.id ?? artifactIdFor(runVm.vmId, artifact.ordinal);
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
      const matches =
        existing.kind === artifact.kind &&
        existing.filename === artifact.filename &&
        existing.contentType === artifact.contentType &&
        existing.sizeBytes === artifact.sizeBytes &&
        existing.sha256 === artifact.sha256;
      if (!matches) {
        return jsonResponse(
          { error: `artifact ${artifact.ordinal} metadata does not match existing upload` },
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

  const leaseToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const tokenHash = await sha256Hex(leaseToken);
  await db
    .insert(scenarioRunUploadLeases)
    .values({
      id: `lease:${runVm.vmId}`,
      runId: runVm.runId,
      vmId: runVm.vmId,
      hostId: runVm.hostId,
      tokenHash,
      expiresAt: now + UPLOAD_LEASE_TTL_MS,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: scenarioRunUploadLeases.vmId,
      set: {
        runId: runVm.runId,
        hostId: runVm.hostId,
        tokenHash,
        expiresAt: now + UPLOAD_LEASE_TTL_MS,
        completedAt: null,
        updatedAt: now,
      },
    });

  await transitionRunVmToArchiving(db, runVm.runId, runVm.vmId, now);

  return jsonResponse({ runId: runVm.runId, leaseToken });
}

async function handleMultipartBegin(
  request: Request,
  env: Cloudflare.Env,
  runId: string,
  ordinal: number,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) {
    return verified.response;
  }

  const lease = await requireRunUploadLease(request, env, verified.agent.hostId, runId);
  if (!lease.ok) {
    return lease.response;
  }

  const db = drizzle(env.DB);
  const artifact = await loadArtifactForRunVm(db, runId, lease.lease.vmId, ordinal);
  if (!artifact) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }

  if (artifact.uploadStatus === "uploaded") {
    return jsonResponse({ done: true, nextExpectedPart: 1 });
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
      vmId: lease.lease.vmId,
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
  ordinal: number,
  partNumber: number,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  if (!request.body) {
    return jsonResponse({ error: "request body is required" }, 400);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) {
    return verified.response;
  }

  const lease = await requireRunUploadLease(request, env, verified.agent.hostId, runId);
  if (!lease.ok) {
    return lease.response;
  }

  const db = drizzle(env.DB);
  const artifact = await loadArtifactForRunVm(db, runId, lease.lease.vmId, ordinal);
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
  ordinal: number,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) {
    return verified.response;
  }

  const lease = await requireRunUploadLease(request, env, verified.agent.hostId, runId);
  if (!lease.ok) {
    return lease.response;
  }

  const db = drizzle(env.DB);
  const artifact = await loadArtifactForRunVm(db, runId, lease.lease.vmId, ordinal);
  if (!artifact) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }
  if (artifact.uploadStatus === "uploaded") {
    return jsonResponse({ ok: true, uploaded: true });
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
      vmId: lease.lease.vmId,
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
    vmId: lease.lease.vmId,
    artifact,
    uploadedAt: now,
  });

  return jsonResponse({ ok: true, uploaded: true });
}

async function handleRunComplete(
  request: Request,
  env: Cloudflare.Env,
  runId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) {
    return verified.response;
  }

  const lease = await requireRunUploadLease(request, env, verified.agent.hostId, runId);
  if (!lease.ok) {
    return lease.response;
  }

  const db = drizzle(env.DB);
  const artifacts = await loadArtifactStatesForRunVm(db, runId, lease.lease.vmId);
  if (artifacts.some((artifact) => artifact.uploadStatus !== "uploaded")) {
    return jsonResponse(
      { error: "all artifacts must be uploaded before completing the run" },
      409,
    );
  }

  const now = Date.now();
  await db
    .update(scenarioRunUploadLeases)
    .set({
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(scenarioRunUploadLeases.id, lease.lease.id));

  await transitionRunVmToCompleted(db, runId, lease.lease.vmId, now);

  return jsonResponse({ ok: true });
}

async function markArtifactUploaded(input: {
  db: ReturnType<typeof drizzle>;
  runId: string;
  vmId: string;
  artifact: SourceArtifactState;
  uploadedAt: number;
}): Promise<void> {
  await input.db
    .update(scenarioRunArtifacts)
    .set({
      uploadStatus: "uploaded",
      uploadedAt: input.uploadedAt,
    })
    .where(eq(scenarioRunArtifacts.id, input.artifact.id));

  await input.db
    .delete(scenarioRunArtifactUploads)
    .where(eq(scenarioRunArtifactUploads.artifactId, input.artifact.id));

  if (input.artifact.kind !== "ssh_recording") {
    return;
  }

  const runRows = await input.db
    .select({
      runId: scenarioRuns.runId,
      stateJson: scenarioRuns.stateJson,
      updatedAt: scenarioRuns.updatedAt,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.runId, input.runId))
    .limit(1);
  const run = runRows[0];
  if (!run) {
    return;
  }

  const state = parseRunState(run.stateJson);
  const replayArtifact: ScenarioReplayArtifact = {
    id: input.artifact.id,
    hostId: "",
    runId: input.runId,
    vmId: input.vmId,
    filename: input.artifact.filename,
    contentType: input.artifact.contentType,
    sizeBytes: input.artifact.sizeBytes,
  };

  const nextState = recomputeRunState({
    ...state,
    vms: state.vms.map((vm) => {
      if (vm.id !== input.vmId) {
        return vm;
      }

      const replayArtifacts = [
        ...vm.replayArtifacts.filter((artifact) => artifact.id !== input.artifact.id),
        replayArtifact,
      ];
      return {
        ...vm,
        replayArtifacts,
        primaryReplayArtifactId: input.artifact.id,
      };
    }),
  });

  await input.db
    .update(scenarioRuns)
    .set({
      stateJson: JSON.stringify(nextState),
      updatedAt: input.uploadedAt,
    })
    .where(eq(scenarioRuns.runId, input.runId));
}

async function requireRunUploadLease(
  request: Request,
  env: Cloudflare.Env,
  hostId: string,
  runId: string,
): Promise<{ ok: true; lease: UploadLeaseRow } | { ok: false; response: Response }> {
  const leaseToken = request.headers.get("x-run-upload-lease")?.trim() ?? "";
  if (!leaseToken) {
    return {
      ok: false,
      response: jsonResponse({ error: "missing upload lease" }, 401),
    };
  }

  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: scenarioRunUploadLeases.id,
      runId: scenarioRunUploadLeases.runId,
      vmId: scenarioRunUploadLeases.vmId,
      hostId: scenarioRunUploadLeases.hostId,
      tokenHash: scenarioRunUploadLeases.tokenHash,
      expiresAt: scenarioRunUploadLeases.expiresAt,
      completedAt: scenarioRunUploadLeases.completedAt,
    })
    .from(scenarioRunUploadLeases)
    .where(
      and(
        eq(scenarioRunUploadLeases.runId, runId),
        eq(scenarioRunUploadLeases.hostId, hostId),
      ),
    )
    .limit(1);

  const lease = rows[0] ?? null;
  if (!lease) {
    return {
      ok: false,
      response: jsonResponse({ error: "upload lease not found" }, 404),
    };
  }
  if (lease.completedAt !== null || lease.expiresAt <= Date.now()) {
    return {
      ok: false,
      response: jsonResponse({ error: "upload lease expired" }, 401),
    };
  }
  if ((await sha256Hex(leaseToken)) !== lease.tokenHash) {
    return {
      ok: false,
      response: jsonResponse({ error: "invalid upload lease" }, 401),
    };
  }

  return {
    ok: true,
    lease,
  };
}

async function resolveRunVm(input: {
  db: ReturnType<typeof drizzle>;
  runId: string;
  vmName: string;
  hostId: string;
}): Promise<ResolvedRunVm | null> {
  const rows = await input.db
    .select({
      runId: scenarioRuns.runId,
      hostId: scenarioRuns.hostId,
      userId: scenarioRuns.userId,
      scenarioId: scenarioRuns.scenarioId,
      stateJson: scenarioRuns.stateJson,
    })
    .from(scenarioRuns)
    .innerJoin(agentHosts, eq(agentHosts.id, scenarioRuns.hostId))
    .where(
      and(eq(scenarioRuns.runId, input.runId), eq(scenarioRuns.hostId, input.hostId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }

  const state = parseRunState(row.stateJson);
  const vm = state.vms.find((candidate) => candidate.runtimeVmName === input.vmName);
  if (!vm) {
    return null;
  }

  return {
    runId: row.runId,
    hostId: row.hostId,
    userId: row.userId,
    scenarioId: row.scenarioId,
    vmId: vm.id,
    runtimeVmName: vm.runtimeVmName,
  };
}

async function loadArtifactForRunVm(
  db: ReturnType<typeof drizzle>,
  runId: string,
  vmId: string,
  ordinal: number,
) {
  const artifacts = await loadArtifactStatesForRunVm(db, runId, vmId);
  return artifacts.find((artifact) => artifact.ordinal === ordinal) ?? null;
}

async function loadArtifactStatesForRunVm(
  db: ReturnType<typeof drizzle>,
  runId: string,
  vmId: string,
): Promise<SourceArtifactState[]> {
  const rows = await db
    .select({
      id: scenarioRunArtifacts.id,
      runId: scenarioRunArtifacts.runId,
      vmId: scenarioRunArtifacts.vmId,
      ordinal: scenarioRunArtifacts.ordinal,
      kind: scenarioRunArtifacts.kind,
      filename: scenarioRunArtifacts.filename,
      contentType: scenarioRunArtifacts.contentType,
      sizeBytes: scenarioRunArtifacts.sizeBytes,
      sha256: scenarioRunArtifacts.sha256,
      r2Key: scenarioRunArtifacts.r2Key,
      uploadStatus: scenarioRunArtifacts.uploadStatus,
      uploadedAt: scenarioRunArtifacts.uploadedAt,
    })
    .from(scenarioRunArtifacts)
    .where(
      and(eq(scenarioRunArtifacts.runId, runId), eq(scenarioRunArtifacts.vmId, vmId)),
    )
    .orderBy(scenarioRunArtifacts.ordinal);

  return rows;
}

async function transitionRunVmToArchiving(
  db: ReturnType<typeof drizzle>,
  runId: string,
  vmId: string,
  now: number,
): Promise<void> {
  const run = await loadStoredRunLifecycle(db, runId);
  if (!run) {
    return;
  }

  const nextState = recomputeRunState({
    ...run.state,
    vms: run.state.vms.map((vm) =>
      vm.id === vmId && vm.phase !== "failed"
        ? {
            ...vm,
            phase: "archived",
          }
        : vm,
    ),
  });

  await persistStoredRunLifecycle(db, runId, run, {
    ...nextState,
    phase: deriveArchiveRunPhase(nextState.vms),
  }, now);
}

async function transitionRunVmToCompleted(
  db: ReturnType<typeof drizzle>,
  runId: string,
  vmId: string,
  now: number,
): Promise<void> {
  const run = await loadStoredRunLifecycle(db, runId);
  if (!run) {
    return;
  }

  const nextState = recomputeRunState({
    ...run.state,
    vms: run.state.vms.map((vm) =>
      vm.id === vmId && vm.phase !== "failed"
        ? {
            ...vm,
            phase: "completed",
          }
        : vm,
    ),
  });

  const nextPhase =
    nextState.phase === "failed"
      ? "failed"
      : nextState.vms.every((vm) => vm.phase === "completed" || vm.phase === "failed")
        ? "completed"
        : deriveArchiveRunPhase(nextState.vms);

  await persistStoredRunLifecycle(
    db,
    runId,
    run,
    {
      ...nextState,
      phase: nextPhase,
    },
    now,
  );
}

async function loadStoredRunLifecycle(
  db: ReturnType<typeof drizzle>,
  runId: string,
): Promise<{
  activeKey: string | null;
  solvedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  state: RunStateDocument;
} | null> {
  const rows = await db
    .select({
      activeKey: scenarioRuns.activeKey,
      solvedAt: scenarioRuns.solvedAt,
      completedAt: scenarioRuns.completedAt,
      failedAt: scenarioRuns.failedAt,
      stateJson: scenarioRuns.stateJson,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.runId, runId))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) {
    return null;
  }

  return {
    activeKey: row.activeKey,
    solvedAt: row.solvedAt,
    completedAt: row.completedAt,
    failedAt: row.failedAt,
    state: parseRunState(row.stateJson),
  };
}

async function persistStoredRunLifecycle(
  db: ReturnType<typeof drizzle>,
  runId: string,
  run: {
    activeKey: string | null;
    solvedAt: number | null;
    completedAt: number | null;
    failedAt: number | null;
    state: RunStateDocument;
  },
  state: RunStateDocument,
  now: number,
): Promise<void> {
  const nextState = recomputeRunState(state);
  const nextPhase = nextState.phase;
  const solvedAt = nextSolvedAt({
    currentPhase: run.state.phase,
    nextPhase,
    existingSolvedAt: run.solvedAt,
    now,
  });
  await db
    .update(scenarioRuns)
    .set({
      state: nextPhase,
      stateRank: RUN_PHASE_ORDER[nextPhase],
      stateJson: JSON.stringify(nextState),
      activeKey: nextPhase === "completed" || nextPhase === "failed" ? null : run.activeKey,
      solvedAt,
      completedAt: nextPhase === "completed" ? run.completedAt ?? now : null,
      failedAt: nextPhase === "failed" ? run.failedAt ?? now : null,
      updatedAt: now,
    })
    .where(eq(scenarioRuns.runId, runId));
}

function deriveArchiveRunPhase(vms: RunStateDocument["vms"]): RunStateDocument["phase"] {
  if (vms.some((vm) => vm.phase === "failed")) {
    return "failed";
  }
  if (vms.every((vm) => vm.phase === "completed" || vm.phase === "failed")) {
    return "completed";
  }
  if (vms.some((vm) => vm.phase === "destroying")) {
    return "tearing_down";
  }
  if (vms.some((vm) => vm.phase === "archived" || vm.phase === "completed")) {
    return "archiving";
  }
  return "tearing_down";
}

function normalizeArtifactInputs(inputs: AgentRunArtifactInput[]): Array<{
  ordinal: number;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}> | null {
  const normalized = inputs
    .map((input) => {
      const ordinal = normalizeInteger(input.ordinal);
      const sizeBytes = normalizeInteger(input.sizeBytes);
      const kind = input.kind?.trim() ?? "";
      const filename = input.filename?.trim() ?? "";
      const contentType = input.contentType?.trim() ?? "";
      const sha256 = input.sha256?.trim().toLowerCase() ?? "";
      if (
        ordinal === null ||
        sizeBytes === null ||
        ordinal <= 0 ||
        sizeBytes < 0 ||
        !kind ||
        !filename ||
        !contentType ||
        !sha256
      ) {
        return null;
      }
      return {
        ordinal,
        kind,
        filename,
        contentType,
        sizeBytes,
        sha256,
      };
    })
    .filter(
      (
        value,
      ): value is {
        ordinal: number;
        kind: string;
        filename: string;
        contentType: string;
        sizeBytes: number;
        sha256: string;
      } => value !== null,
    );

  if (normalized.length !== inputs.length) {
    return null;
  }

  normalized.sort((a, b) => a.ordinal - b.ordinal);
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index]?.ordinal !== index + 1) {
      return null;
    }
  }

  return normalized;
}

function parseUploadedParts(raw: string): UploadedPartRecord[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          Array.isArray(entry) ||
          typeof (entry as { partNumber?: unknown }).partNumber !== "number" ||
          typeof (entry as { etag?: unknown }).etag !== "string"
        ) {
          return null;
        }
        return {
          partNumber: Math.floor((entry as { partNumber: number }).partNumber),
          etag: (entry as { etag: string }).etag,
        };
      })
      .filter(Boolean) as UploadedPartRecord[];
  } catch {
    return [];
  }
}

function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return recomputeRunState({
      phase: "queued",
      phaseTitle: "Queued",
      phaseDetail: "Waiting for host delivery.",
      progressPercent: 0,
      terminalPhase: "pending",
      canOpenTerminal: false,
      canDestroy: true,
      bootProbes: [],
      scenarioProbes: [],
      replayArtifacts: [],
      primaryReplayArtifactId: null,
      terminalTarget: {
        host: null,
        port: 22,
        username: "ubuntu",
        checkedAt: null,
      },
      vms: [],
    });
  }
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

function artifactIdFor(vmId: string, ordinal: number) {
  return `${vmId}:${ordinal}`;
}

function buildArtifactObjectKey(input: {
  runId: string;
  vmId: string;
  ordinal: number;
  kind: string;
  filename: string;
}) {
  return [
    sanitizeObjectKeySegment(input.runId),
    sanitizeObjectKeySegment(input.vmId),
    `${input.ordinal}-${sanitizeObjectKeySegment(input.kind)}-${sanitizeObjectKeySegment(input.filename)}`,
  ].join("/");
}

function sanitizeObjectKeySegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
