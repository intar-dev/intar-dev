import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  runtimeArtifactUploads,
  runtimeArtifacts,
  runtimeExecutions,
  runtimeVms,
  scenarioRunArtifacts,
  scenarioRunArtifactUploads,
  scenarioRuns,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type RuntimeDomainKind,
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
import {
  drizzleQueryToD1Statement,
  executeScenarioRunRuntimeProjection,
} from "@/lib/runtime-executions";

export interface AgentRunArtifactInput {
  ordinal?: number;
  kind?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface UploadedPartRecord {
  partNumber: number;
  etag: string;
}

export interface ResolvedRunVm {
  domainKind: RuntimeDomainKind;
  domainId: string;
  runId: string;
  hostId: string;
  userId: string;
  scenarioId: string | null;
  workshopSessionId: string | null;
  vmId: string;
  runtimeVmId: string | null;
  runtimeVmName: string;
  artifactWritesSealed: boolean;
}

export interface SourceArtifactState {
  id: string;
  runId: string;
  vmId: string;
  runtimeVmId: string | null;
  storageKind: "runtime" | "scenario";
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
  runVm: ResolvedRunVm;
  artifact: SourceArtifactState;
  uploadedAt: number;
}): Promise<void> {
  const runtimeUpdate = input.db
    .update(runtimeArtifacts)
    .set({
      uploadStatus: "uploaded",
      uploadedAt: input.uploadedAt,
    })
    .where(eq(runtimeArtifacts.id, input.artifact.id));
  const runtimeUploadDelete = input.db
    .delete(runtimeArtifactUploads)
    .where(eq(runtimeArtifactUploads.artifactId, input.artifact.id));
  const scenarioUpdate = input.db
    .update(scenarioRunArtifacts)
    .set({
      uploadStatus: "uploaded",
      uploadedAt: input.uploadedAt,
    })
    .where(eq(scenarioRunArtifacts.id, input.artifact.id));
  const scenarioUploadDelete = input.db
    .delete(scenarioRunArtifactUploads)
    .where(eq(scenarioRunArtifactUploads.artifactId, input.artifact.id));

  if (
    input.artifact.storageKind === "runtime" &&
    input.runVm.domainKind === "scenario"
  ) {
    await input.db.batch([
      runtimeUpdate,
      runtimeUploadDelete,
      scenarioUpdate,
      scenarioUploadDelete,
    ]);
  } else if (input.artifact.storageKind === "runtime") {
    await input.db.batch([runtimeUpdate, runtimeUploadDelete]);
  } else {
    await input.db.batch([scenarioUpdate, scenarioUploadDelete]);
  }

  if (input.runVm.domainKind !== "scenario") {
    return;
  }
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
    .where(eq(scenarioRuns.runId, input.runVm.domainId))
    .limit(1);
  const run = runRows[0];
  if (!run) {
    return;
  }

  const state = parseRunState(run.stateJson);

  // A raw recording landing means session media is on its way. The durable
  // replay state remains preparing until the timeline arrives.
  if (input.artifact.kind === "ssh_recording_raw") {
    const nextState = recomputeRunState({
      ...state,
      vms: state.vms.map((vm) =>
        vm.id === input.runVm.vmId ? { ...vm, hasRecording: true } : vm,
      ),
    });
    await input.db
      .update(scenarioRuns)
      .set({
        stateJson: JSON.stringify(nextState),
        updatedAt: input.uploadedAt,
      })
      .where(eq(scenarioRuns.runId, input.runVm.domainId));
    return;
  }

  const replayArtifact: ScenarioReplayArtifact = {
    id: input.artifact.id,
    hostId: "",
    runId: input.runVm.domainId,
    vmId: input.runVm.vmId,
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
      if (vm.id !== input.runVm.vmId) {
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
    .where(eq(scenarioRuns.runId, input.runVm.domainId));
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
  const runtimeRows = await input.db
    .select({
      runId: runtimeExecutions.id,
      hostId: runtimeExecutions.hostId,
      organizationId: runtimeExecutions.organizationId,
      agentHostOrganizationId: agentHosts.organizationId,
      userId: runtimeExecutions.userId,
      domainKind: runtimeExecutions.domainKind,
      domainId: runtimeExecutions.domainId,
      generation: runtimeExecutions.generation,
      runtimeVmId: runtimeVms.id,
      vmId: runtimeVms.vmId,
      runtimeVmName: runtimeVms.runtimeVmName,
      artifactWritesSealed: runtimeVms.artifactWritesSealed,
    })
    .from(runtimeExecutions)
    .innerJoin(runtimeVms, eq(runtimeVms.executionId, runtimeExecutions.id))
    .innerJoin(agentHosts, eq(agentHosts.id, runtimeExecutions.hostId))
    .where(
      and(
        eq(runtimeExecutions.id, input.runId),
        eq(runtimeExecutions.hostId, input.hostId),
        eq(runtimeVms.runtimeVmName, input.vmName),
      ),
    )
    .limit(1);
  const runtime = runtimeRows[0];
  if (!runtime || !runtime.hostId) {
    return resolveLegacyScenarioRunVm(input);
  }

  if (runtime.domainKind === "workshop") {
    const generationRows = await input.db
      .select({
        generationId: workshopWorkspaceGenerations.id,
        generationOrdinal: workshopWorkspaceGenerations.ordinal,
        generationHostId: workshopWorkspaceGenerations.hostId,
        generationState: workshopWorkspaceGenerations.state,
        workspaceId: workshopWorkspaces.id,
        workspaceUserId: workshopWorkspaces.userId,
        currentGenerationId: workshopWorkspaces.currentGenerationId,
        sessionId: workshopWorkspaces.sessionId,
      })
      .from(workshopWorkspaceGenerations)
      .innerJoin(
        workshopWorkspaces,
        eq(
          workshopWorkspaces.id,
          workshopWorkspaceGenerations.workspaceId,
        ),
      )
      .where(
        eq(workshopWorkspaceGenerations.runtimeExecutionId, runtime.runId),
      )
      .limit(1);
    const generation = generationRows[0];
    const historicalArchive =
      generation?.generationState === "archiving" ||
      generation?.generationState === "archived" ||
      generation?.generationState === "failed";
    if (
      !generation ||
      generation.generationOrdinal !== runtime.generation ||
      generation.generationHostId !== runtime.hostId ||
      generation.workspaceId !== runtime.domainId ||
      generation.workspaceUserId !== runtime.userId ||
      runtime.organizationId === null ||
      runtime.agentHostOrganizationId !== runtime.organizationId ||
      (generation.currentGenerationId !== generation.generationId &&
        !historicalArchive)
    ) {
      return null;
    }
    return {
      domainKind: "workshop",
      domainId: runtime.domainId,
      runId: runtime.runId,
      hostId: runtime.hostId,
      userId: runtime.userId,
      scenarioId: null,
      workshopSessionId: generation.sessionId,
      vmId: runtime.vmId,
      runtimeVmId: runtime.runtimeVmId,
      runtimeVmName: runtime.runtimeVmName,
      artifactWritesSealed: runtime.artifactWritesSealed,
    };
  }

  const scenarioRows = await input.db
    .select({
      scenarioId: scenarioRuns.scenarioId,
      stateJson: scenarioRuns.stateJson,
    })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.runId, runtime.domainId),
        eq(scenarioRuns.runtimeExecutionId, runtime.runId),
      ),
    )
    .limit(1);
  const scenario = scenarioRows[0];
  if (!scenario) {
    return null;
  }
  const state = parseRunState(scenario.stateJson);
  const scenarioVm = state.vms.find(
    (candidate) => candidate.id === runtime.vmId,
  );
  if (!scenarioVm || scenarioVm.runtimeVmName !== runtime.runtimeVmName) {
    return null;
  }
  return {
    domainKind: "scenario",
    domainId: runtime.domainId,
    runId: runtime.runId,
    hostId: runtime.hostId,
    userId: runtime.userId,
    scenarioId: scenario.scenarioId,
    workshopSessionId: null,
    vmId: runtime.vmId,
    runtimeVmId: runtime.runtimeVmId,
    runtimeVmName: runtime.runtimeVmName,
    artifactWritesSealed:
      runtime.artifactWritesSealed || scenarioVm.phase === "completed",
  };
}

async function resolveLegacyScenarioRunVm(input: {
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
  if (!row) return null;
  const state = parseRunState(row.stateJson);
  const vm = state.vms.find(
    (candidate) => candidate.runtimeVmName === input.vmName,
  );
  if (!vm) return null;
  return {
    domainKind: "scenario",
    domainId: row.runId,
    runId: row.runId,
    hostId: row.hostId,
    userId: row.userId,
    scenarioId: row.scenarioId,
    workshopSessionId: null,
    vmId: vm.id,
    runtimeVmId: null,
    runtimeVmName: vm.runtimeVmName,
    artifactWritesSealed: vm.phase === "completed",
  };
}

export async function loadArtifactForRunVm(
  db: ReturnType<typeof drizzle>,
  runVm: ResolvedRunVm,
  ordinal: number,
) {
  const artifacts = await loadArtifactStatesForRunVm(db, runVm);
  return artifacts.find((artifact) => artifact.ordinal === ordinal) ?? null;
}

export async function loadArtifactStatesForRunVm(
  db: ReturnType<typeof drizzle>,
  runVm: ResolvedRunVm,
): Promise<SourceArtifactState[]> {
  if (runVm.runtimeVmId) {
    const rows = await db
      .select({
        id: runtimeArtifacts.id,
        runId: runtimeArtifacts.executionId,
        runtimeVmId: runtimeArtifacts.runtimeVmId,
        ordinal: runtimeArtifacts.ordinal,
        kind: runtimeArtifacts.kind,
        filename: runtimeArtifacts.filename,
        contentType: runtimeArtifacts.contentType,
        sizeBytes: runtimeArtifacts.sizeBytes,
        sha256: runtimeArtifacts.sha256,
        r2Key: runtimeArtifacts.r2Key,
        uploadStatus: runtimeArtifacts.uploadStatus,
        uploadedAt: runtimeArtifacts.uploadedAt,
      })
      .from(runtimeArtifacts)
      .where(
        and(
          eq(runtimeArtifacts.executionId, runVm.runId),
          eq(runtimeArtifacts.runtimeVmId, runVm.runtimeVmId),
        ),
      )
      .orderBy(runtimeArtifacts.ordinal);
    if (rows.length || runVm.domainKind === "workshop") {
      return rows.map((row) => ({
        ...row,
        vmId: runVm.vmId,
        storageKind: "runtime" as const,
      }));
    }
  }

  const legacyRows = await db
    .select({
      id: scenarioRunArtifacts.id,
      runId: scenarioRunArtifacts.runId,
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
        eq(scenarioRunArtifacts.runId, runVm.domainId),
        eq(scenarioRunArtifacts.vmId, runVm.vmId),
      ),
    )
    .orderBy(scenarioRunArtifacts.ordinal);

  return legacyRows.map((row) => ({
    ...row,
    vmId: runVm.vmId,
    runtimeVmId: null,
    storageKind: "scenario" as const,
  }));
}

export async function ensureArtifactState(input: {
  db: ReturnType<typeof drizzle>;
  runVm: ResolvedRunVm;
  artifact: {
    ordinal: number;
    kind: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  };
  existing?: SourceArtifactState;
  createdAt: number;
}): Promise<SourceArtifactState> {
  const identityVmId =
    input.runVm.domainKind === "scenario"
      ? input.runVm.vmId
      : input.runVm.runtimeVmId;
  if (!identityVmId) {
    throw new Error("runtime VM identity is missing");
  }
  const artifactId =
    input.existing?.id ?? artifactIdFor(identityVmId, input.artifact.ordinal);
  const r2Key =
    input.existing?.r2Key ??
    buildArtifactObjectKey({
      runId: input.runVm.runId,
      vmId: identityVmId,
      ordinal: input.artifact.ordinal,
      kind: input.artifact.kind,
      filename: input.artifact.filename,
    });

  if (input.runVm.runtimeVmId) {
    await input.db
      .insert(runtimeArtifacts)
      .values({
        id: artifactId,
        executionId: input.runVm.runId,
        runtimeVmId: input.runVm.runtimeVmId,
        ordinal: input.artifact.ordinal,
        kind: input.artifact.kind,
        filename: input.artifact.filename,
        contentType: input.artifact.contentType,
        sizeBytes: input.artifact.sizeBytes,
        sha256: input.artifact.sha256,
        r2Key,
        uploadStatus: input.existing?.uploadStatus ?? "pending",
        createdAt: input.createdAt,
        uploadedAt: input.existing?.uploadedAt ?? null,
      })
      .onConflictDoNothing();
  }

  if (input.runVm.domainKind === "scenario") {
    await input.db
      .insert(scenarioRunArtifacts)
      .values({
        id: artifactId,
        runId: input.runVm.domainId,
        vmId: input.runVm.vmId,
        ordinal: input.artifact.ordinal,
        kind: input.artifact.kind,
        filename: input.artifact.filename,
        contentType: input.artifact.contentType,
        sizeBytes: input.artifact.sizeBytes,
        sha256: input.artifact.sha256,
        r2Key,
        uploadStatus: input.existing?.uploadStatus ?? "pending",
        createdAt: input.createdAt,
        uploadedAt: input.existing?.uploadedAt ?? null,
      })
      .onConflictDoNothing();
  }

  const stored = await loadArtifactForRunVm(
    input.db,
    input.runVm,
    input.artifact.ordinal,
  );
  if (!stored || !artifactMetadataMatches(stored, input.artifact)) {
    throw new Error("artifact ledger did not converge");
  }
  return stored;
}

export async function loadArtifactUploadState(
  db: ReturnType<typeof drizzle>,
  artifact: SourceArtifactState,
): Promise<{
  r2UploadId: string | null;
  uploadedPartsJson: string;
  nextExpectedPart: number;
} | null> {
  if (artifact.storageKind === "runtime") {
    const rows = await db
      .select({
        r2UploadId: runtimeArtifactUploads.r2UploadId,
        uploadedParts: runtimeArtifactUploads.uploadedPartsJson,
        nextExpectedPart: runtimeArtifactUploads.nextExpectedPart,
      })
      .from(runtimeArtifactUploads)
      .where(eq(runtimeArtifactUploads.artifactId, artifact.id))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          r2UploadId: row.r2UploadId,
          uploadedPartsJson: JSON.stringify(row.uploadedParts),
          nextExpectedPart: row.nextExpectedPart,
        }
      : null;
  }
  const rows = await db
    .select({
      r2UploadId: scenarioRunArtifactUploads.r2UploadId,
      uploadedPartsJson: scenarioRunArtifactUploads.uploadedPartsJson,
      nextExpectedPart: scenarioRunArtifactUploads.nextExpectedPart,
    })
    .from(scenarioRunArtifactUploads)
    .where(eq(scenarioRunArtifactUploads.artifactId, artifact.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function initializeArtifactUpload(input: {
  db: ReturnType<typeof drizzle>;
  runVm: ResolvedRunVm;
  artifact: SourceArtifactState;
  r2UploadId: string;
  updatedAt: number;
}): Promise<void> {
  const runtimeInsert = input.db
    .insert(runtimeArtifactUploads)
    .values({
      artifactId: input.artifact.id,
      r2UploadId: input.r2UploadId,
      uploadedPartsJson: [],
      nextExpectedPart: 1,
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: runtimeArtifactUploads.artifactId,
      set: {
        r2UploadId: input.r2UploadId,
        uploadedPartsJson: [],
        nextExpectedPart: 1,
        updatedAt: input.updatedAt,
      },
    });
  const scenarioInsert = input.db
    .insert(scenarioRunArtifactUploads)
    .values({
      artifactId: input.artifact.id,
      r2UploadId: input.r2UploadId,
      uploadedPartsJson: "[]",
      nextExpectedPart: 1,
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: scenarioRunArtifactUploads.artifactId,
      set: {
        r2UploadId: input.r2UploadId,
        uploadedPartsJson: "[]",
        nextExpectedPart: 1,
        updatedAt: input.updatedAt,
      },
    });
  if (
    input.artifact.storageKind === "runtime" &&
    input.runVm.domainKind === "scenario"
  ) {
    await input.db.batch([runtimeInsert, scenarioInsert]);
    return;
  }
  if (input.artifact.storageKind === "runtime") {
    await runtimeInsert;
  } else {
    await scenarioInsert;
  }
}

export async function advanceArtifactUpload(input: {
  db: ReturnType<typeof drizzle>;
  runVm: ResolvedRunVm;
  artifact: SourceArtifactState;
  uploadedParts: UploadedPartRecord[];
  nextExpectedPart: number;
  updatedAt: number;
}): Promise<void> {
  const runtimeUpdate = input.db
    .update(runtimeArtifactUploads)
    .set({
      uploadedPartsJson: input.uploadedParts,
      nextExpectedPart: input.nextExpectedPart,
      updatedAt: input.updatedAt,
    })
    .where(eq(runtimeArtifactUploads.artifactId, input.artifact.id));
  const scenarioUpdate = input.db
    .update(scenarioRunArtifactUploads)
    .set({
      uploadedPartsJson: JSON.stringify(input.uploadedParts),
      nextExpectedPart: input.nextExpectedPart,
      updatedAt: input.updatedAt,
    })
    .where(eq(scenarioRunArtifactUploads.artifactId, input.artifact.id));
  if (
    input.artifact.storageKind === "runtime" &&
    input.runVm.domainKind === "scenario"
  ) {
    await input.db.batch([runtimeUpdate, scenarioUpdate]);
    return;
  }
  if (input.artifact.storageKind === "runtime") {
    await runtimeUpdate;
  } else {
    await scenarioUpdate;
  }
}

export async function transitionRunVmToArchiving(
  db: ReturnType<typeof drizzle>,
  runVm: ResolvedRunVm,
  now: number,
): Promise<void> {
  if (runVm.runtimeVmId) {
    await db
      .update(runtimeExecutions)
      .set({
        state: sql`CASE
          WHEN ${runtimeExecutions.state} IN ('queued', 'provisioning', 'ready')
            THEN 'archiving'
          ELSE ${runtimeExecutions.state}
        END`,
        archiveRequestedAt: sql`coalesce(${runtimeExecutions.archiveRequestedAt}, ${now})`,
        updatedAt: now,
      })
      .where(eq(runtimeExecutions.id, runVm.runId));
  }
  if (runVm.domainKind !== "scenario") return;

  const run = await loadStoredRunLifecycle(db, runVm.domainId);
  if (!run) {
    return;
  }

  // An idempotent begin retry must not drag a completed VM back to archived.
  const nextState = recomputeRunState({
    ...run.state,
    vms: run.state.vms.map((vm) =>
      vm.id === runVm.vmId &&
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
    runVm.domainId,
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
  runVm: ResolvedRunVm,
  now: number,
): Promise<void> {
  if (runVm.runtimeVmId) {
    await db
      .update(runtimeVms)
      .set({ artifactWritesSealed: true, updatedAt: now })
      .where(
        and(
          eq(runtimeVms.id, runVm.runtimeVmId),
          eq(runtimeVms.executionId, runVm.runId),
        ),
      );
    await archiveRuntimeExecutionWhenAllVmsSealed(db, runVm.runId, now);
  }
  if (runVm.domainKind !== "scenario") return;

  const run = await loadStoredRunLifecycle(db, runVm.domainId);
  if (!run) {
    return;
  }

  const nextState = recomputeRunState({
    ...run.state,
    vms: run.state.vms.map((vm) =>
      vm.id === runVm.vmId
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
    runVm.domainId,
    run,
    {
      ...nextState,
      phase: nextPhase,
    },
    now,
  );
  if (nextPhase === "completed" && run.state.phase !== "completed") {
    const vmAbsentAt = latestVmAbsenceAt(nextState);
    if (vmAbsentAt !== null) {
      console.log(
        JSON.stringify({
          event: "scenario_run_lifecycle_timing",
          metric: "vm_absent_to_archive_complete",
          runId: runVm.domainId,
          startedAt: vmAbsentAt,
          completedAt: now,
          durationMs: Math.max(0, now - vmAbsentAt),
        }),
      );
    }
  }
}

async function archiveRuntimeExecutionWhenAllVmsSealed(
  db: ReturnType<typeof drizzle>,
  executionId: string,
  now: number,
): Promise<void> {
  await db
    .update(runtimeExecutions)
    .set({
      state: "archived",
      archiveRequestedAt: sql`coalesce(${runtimeExecutions.archiveRequestedAt}, ${now})`,
      endedAt: sql`coalesce(${runtimeExecutions.endedAt}, ${now})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(runtimeExecutions.id, executionId),
        sql`NOT EXISTS (
          SELECT 1 FROM runtime_vms pending_vm
          WHERE pending_vm.execution_id = ${executionId}
            AND pending_vm.artifact_writes_sealed = 0
        )`,
      ),
    );
}

export async function loadStoredRunLifecycle(
  db: ReturnType<typeof drizzle>,
  runId: string,
): Promise<{
  activeKey: string | null;
  deleteRequestedAt: number | null;
  solvedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  state: RunStateDocument;
} | null> {
  const rows = await db
    .select({
      activeKey: scenarioRuns.activeKey,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
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
    deleteRequestedAt: row.deleteRequestedAt,
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
    deleteRequestedAt: number | null;
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
  const terminal = nextPhase === "completed" || nextPhase === "failed";
  const solvedAt = nextSolvedAt({
    currentPhase: run.state.phase,
    nextPhase,
    existingSolvedAt: run.solvedAt,
    now,
  });
  const mutation = db
    .update(scenarioRuns)
    .set({
      state: nextPhase,
      stateRank: RUN_PHASE_ORDER[nextPhase],
      stateJson: JSON.stringify(nextState),
      // Artifact callbacks can race teardown acceptance. Never restore a
      // stale active key, and only auto-release a terminal run when the
      // authoritative row still has no explicit teardown intent.
      activeKey: terminal
        ? sql<string | null>`CASE
            WHEN ${scenarioRuns.deleteRequestedAt} IS NULL THEN NULL
            ELSE ${scenarioRuns.activeKey}
          END`
        : sql<string | null>`${scenarioRuns.activeKey}`,
      solvedAt,
      completedAt: nextPhase === "completed" ? (run.completedAt ?? now) : null,
      failedAt: nextPhase === "failed" ? (run.failedAt ?? now) : null,
      updatedAt: now,
    })
    .where(eq(scenarioRuns.runId, runId));
  await executeScenarioRunRuntimeProjection({
    d1: db.$client,
    runId,
    statements: [drizzleQueryToD1Statement(db.$client, mutation)],
    mode: "update",
  });
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

function latestVmAbsenceAt(state: RunStateDocument): number | null {
  const observed = state.vms
    .filter((vm) => vm.runtimeState === "absent")
    .map((vm) => vm.runtimeObservedAt)
    .filter((value): value is number => value !== null);
  return observed.length ? Math.max(...observed) : null;
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
