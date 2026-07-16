import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  scenarioRunArtifacts,
  scenarioRunArtifactUploads,
  scenarioRuns,
} from "@/db/schema";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import {
  RUN_PHASE_ORDER,
  canAdvanceVmPhase,
  recomputeRunState,
  type RunStateDocument,
  type ScenarioReplayArtifact,
} from "@/lib/run-state";
import { nextSolvedAt } from "@/lib/scenario-run-outcome";

export interface AgentRunArtifactInput {
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

export interface ResolvedRunVm {
  runId: string;
  hostId: string;
  userId: string;
  scenarioId: string;
  vmId: string;
  runtimeVmName: string;
  artifactWritesSealed: boolean;
}

export interface SourceArtifactState {
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

export async function markArtifactUploaded(input: {
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

  if (
    input.artifact.kind !== "ssh_recording_segment" &&
    input.artifact.kind !== "ssh_recording_raw"
  ) {
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

  // A raw recording landing means session media is on its way — the run
  // page shows a "rendering" state until the timeline arrives.
  if (input.artifact.kind === "ssh_recording_raw") {
    const nextState = recomputeRunState({
      ...state,
      vms: state.vms.map((vm) =>
        vm.id === input.vmId ? { ...vm, hasRecording: true } : vm,
      ),
    });
    await input.db
      .update(scenarioRuns)
      .set({
        stateJson: JSON.stringify(nextState),
        updatedAt: input.uploadedAt,
      })
      .where(eq(scenarioRuns.runId, input.runId));
    return;
  }

  const replayArtifact: ScenarioReplayArtifact = {
    id: input.artifact.id,
    hostId: "",
    runId: input.runId,
    vmId: input.vmId,
    kind: input.artifact.kind,
    filename: input.artifact.filename,
    contentType: input.artifact.contentType,
    sizeBytes: input.artifact.sizeBytes,
  };

  // Segment uploads run concurrently, so this array's order is arbitrary —
  // the ordering authority is `vm.sessionTimeline`.
  const nextState = recomputeRunState({
    ...state,
    vms: state.vms.map((vm) => {
      if (vm.id !== input.vmId) {
        return vm;
      }

      const replayArtifacts = [
        ...vm.replayArtifacts.filter(
          (artifact) => artifact.id !== input.artifact.id,
        ),
        replayArtifact,
      ];
      return {
        ...vm,
        replayArtifacts,
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

export async function requireVerifiedRunVm(
  request: Request,
  env: Cloudflare.Env,
  runId: string,
  vmName: string,
  options?: { allowSealed?: boolean },
): Promise<
  | { ok: true; db: ReturnType<typeof drizzle>; runVm: ResolvedRunVm }
  | { ok: false; response: Response }
> {
  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) {
    return verified;
  }
  const db = drizzle(env.DB);
  const runVm = await resolveRunVm({
    db,
    runId,
    vmName,
    hostId: verified.agent.hostId,
  });
  if (!runVm) {
    return {
      ok: false,
      response: runPurgedResponse(),
    };
  }
  if (runVm.artifactWritesSealed && !options?.allowSealed) {
    return {
      ok: false,
      response: artifactWritesSealedResponse(),
    };
  }

  return {
    ok: true,
    db,
    runVm,
  };
}

export async function resolveRunVm(input: {
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
      and(
        eq(scenarioRuns.runId, input.runId),
        eq(scenarioRuns.hostId, input.hostId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }

  const state = parseRunState(row.stateJson);
  const vm = state.vms.find(
    (candidate) => candidate.runtimeVmName === input.vmName,
  );
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
    artifactWritesSealed: vm.phase === "completed",
  };
}

export async function loadArtifactForRunVm(
  db: ReturnType<typeof drizzle>,
  runId: string,
  vmId: string,
  ordinal: number,
) {
  const artifacts = await loadArtifactStatesForRunVm(db, runId, vmId);
  return artifacts.find((artifact) => artifact.ordinal === ordinal) ?? null;
}

export async function loadArtifactStatesForRunVm(
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
      and(
        eq(scenarioRunArtifacts.runId, runId),
        eq(scenarioRunArtifacts.vmId, vmId),
      ),
    )
    .orderBy(scenarioRunArtifacts.ordinal);

  return rows;
}

export async function transitionRunVmToArchiving(
  db: ReturnType<typeof drizzle>,
  runId: string,
  vmId: string,
  now: number,
): Promise<void> {
  const run = await loadStoredRunLifecycle(db, runId);
  if (!run) {
    return;
  }

  // An idempotent begin retry must not drag a completed VM back to archived.
  const nextState = recomputeRunState({
    ...run.state,
    vms: run.state.vms.map((vm) =>
      vm.id === vmId &&
      vm.phase !== "failed" &&
      canAdvanceVmPhase(vm.phase, "archived")
        ? {
            ...vm,
            phase: "archived",
          }
        : vm,
    ),
  });

  await persistStoredRunLifecycle(
    db,
    runId,
    run,
    {
      ...nextState,
      phase: deriveArchiveRunPhase(nextState.vms),
    },
    now,
  );
}

export async function transitionRunVmToCompleted(
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
      vm.id === vmId
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
      : nextState.vms.every(
            (vm) => vm.phase === "completed" || vm.phase === "failed",
          )
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

export async function loadStoredRunLifecycle(
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

export async function persistStoredRunLifecycle(
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
      activeKey:
        nextPhase === "completed" || nextPhase === "failed"
          ? null
          : run.activeKey,
      solvedAt,
      completedAt: nextPhase === "completed" ? (run.completedAt ?? now) : null,
      failedAt: nextPhase === "failed" ? (run.failedAt ?? now) : null,
      updatedAt: now,
    })
    .where(eq(scenarioRuns.runId, runId));
}

export function deriveArchiveRunPhase(
  vms: RunStateDocument["vms"],
): RunStateDocument["phase"] {
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

export function artifactMetadataMatches(
  existing: SourceArtifactState,
  artifact: {
    kind: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  },
): boolean {
  return (
    existing.kind === artifact.kind &&
    existing.filename === artifact.filename &&
    existing.contentType === artifact.contentType &&
    existing.sizeBytes === artifact.sizeBytes &&
    existing.sha256 === artifact.sha256
  );
}

export function normalizeArtifactInputs(
  inputs: AgentRunArtifactInput[],
): Array<{
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

export function parseUploadedParts(raw: string): UploadedPartRecord[] {
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

export function parseRunState(raw: string): RunStateDocument {
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
      terminalTarget: {
        host: null,
        port: 22,
        username: "ubuntu",
        hostKeyOpenssh: null,
        checkedAt: null,
      },
      vms: [],
    });
  }
}

export function normalizeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

export function artifactIdFor(vmId: string, ordinal: number) {
  return `${vmId}:${ordinal}`;
}

export function buildArtifactObjectKey(input: {
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

export function sanitizeObjectKeySegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
}

export function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return null;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function runPurgedResponse(): Response {
  return jsonResponse({ code: "run_purged", error: "run VM not found" }, 410);
}

export function artifactWritesSealedResponse(): Response {
  return jsonResponse(
    {
      code: "run_artifacts_sealed",
      error: "run artifact writes are sealed",
    },
    409,
  );
}
