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
import { recordLinkedCourseUnitCompletionForRun } from "@/lib/course-catalogs";

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

const MAX_ARTIFACTS_PER_BEGIN = 1024;
const MAX_ARTIFACT_VM_ID_BYTES = 128;
const MAX_R2_OBJECT_KEY_BYTES = 1024;
// D1 permits 2,000,000 bytes for one string/BLOB value. Leave a little
// headroom for the bound JSON manifest itself.
const MAX_D1_MANIFEST_BYTES = 1_900_000;
const MAX_ARTIFACT_KIND_BYTES = 64;
const MAX_ARTIFACT_FILENAME_BYTES = 255;
const MAX_ARTIFACT_CONTENT_TYPE_BYTES = 255;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const artifactTextEncoder = new TextEncoder();

interface ArtifactManifestEntry {
  id: string;
  ordinal: number;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  r2Key: string;
  createdAt: number;
}

export type ExistingArtifactManifestRetry =
  | { status: "exact"; allUploaded: boolean }
  | { status: "absent" | "new_reservation" | "mismatch" };

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
  const isRawRecording =
    input.artifact.kind === "ssh_recording_raw" ||
    input.artifact.kind === "ssh_recording_raw_bundle";
  if (input.artifact.kind !== "ssh_recording_segment" && !isRawRecording) {
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

  // A raw recording or bounded raw bundle landing means session media is on
  // its way. The durable replay state remains preparing until the timeline
  // arrives.
  if (isRawRecording) {
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
): Promise<SourceArtifactState | null> {
  const runtimeVmId = runVm.runtimeVmId;
  if (runtimeVmId) {
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
          eq(runtimeArtifacts.runtimeVmId, runtimeVmId),
          eq(runtimeArtifacts.ordinal, ordinal),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row) {
      return {
        ...row,
        vmId: runVm.vmId,
        storageKind: "runtime",
      };
    }
    // Runtime rows take precedence as soon as that ledger exists. Preserve
    // the migration fallback used by `loadArtifactStatesForRunVm` without
    // reloading its full ordered list for every multipart request.
    const runtimeLedgerRows = await db
      .select({ id: runtimeArtifacts.id })
      .from(runtimeArtifacts)
      .where(
        and(
          eq(runtimeArtifacts.executionId, runVm.runId),
          eq(runtimeArtifacts.runtimeVmId, runtimeVmId),
        ),
      )
      .limit(1);
    if (runtimeLedgerRows[0]) {
      return null;
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
        eq(scenarioRunArtifacts.ordinal, ordinal),
      ),
    )
    .limit(1);
  const legacy = legacyRows[0];
  return legacy
    ? {
        ...legacy,
        vmId: runVm.vmId,
        runtimeVmId: null,
        storageKind: "scenario",
      }
    : null;
}

async function loadRuntimeArtifactStatesForRunVm(
  db: ReturnType<typeof drizzle>,
  runVm: ResolvedRunVm,
): Promise<SourceArtifactState[]> {
  if (!runVm.runtimeVmId) return [];
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
  return rows.map((row) => ({
    ...row,
    vmId: runVm.vmId,
    storageKind: "runtime" as const,
  }));
}

async function loadLegacyArtifactStatesForRunVm(
  db: ReturnType<typeof drizzle>,
  runVm: ResolvedRunVm,
): Promise<SourceArtifactState[]> {
  if (runVm.domainKind !== "scenario") return [];
  const rows = await db
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
  return rows.map((row) => ({
    ...row,
    vmId: runVm.vmId,
    runtimeVmId: null,
    storageKind: "scenario" as const,
  }));
}

export async function loadArtifactStatesForRunVm(
  db: ReturnType<typeof drizzle>,
  runVm: ResolvedRunVm,
): Promise<SourceArtifactState[]> {
  const runtimeRows = await loadRuntimeArtifactStatesForRunVm(db, runVm);
  if (runtimeRows.length) {
    return runtimeRows;
  }
  return loadLegacyArtifactStatesForRunVm(db, runVm);
}

/**
 * Reserves an entire manifest in one guarded D1 transaction. The guard reads
 * both scenario ledgers before either receives a new ordinal, so a racing
 * mismatch cannot leave a partial superseding manifest behind.
 */
export async function ensureArtifactStates(input: {
  db: ReturnType<typeof drizzle>;
  runVm: ResolvedRunVm;
  artifacts: Array<{
    ordinal: number;
    kind: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }>;
  createdAt: number;
}): Promise<{ conflictOrdinal: number | null; invalidManifest?: boolean }> {
  if (input.artifacts.length === 0) {
    return { conflictOrdinal: null };
  }
  const manifest = buildArtifactManifest({
    runVm: input.runVm,
    artifacts: input.artifacts,
    createdAt: input.createdAt,
  });
  const manifestJson = JSON.stringify(manifest);
  if (
    artifactTextEncoder.encode(manifestJson).byteLength > MAX_D1_MANIFEST_BYTES
  ) {
    return { conflictOrdinal: null, invalidManifest: true };
  }
  const statements: D1PreparedStatement[] = [
    buildArtifactManifestConflictGuard({
      d1: input.db.$client,
      runVm: input.runVm,
      manifestJson,
      checkRuntimeLedger: input.runVm.runtimeVmId !== null,
      checkLegacyLedger: input.runVm.domainKind === "scenario",
    }),
  ];
  if (input.runVm.runtimeVmId) {
    statements.push(
      buildArtifactManifestInsertStatement({
        d1: input.db.$client,
        runVm: input.runVm,
        manifestJson,
        target: "runtime",
      }),
    );
  }
  if (input.runVm.domainKind === "scenario") {
    statements.push(
      buildArtifactManifestInsertStatement({
        d1: input.db.$client,
        runVm: input.runVm,
        manifestJson,
        target: "scenario",
      }),
    );
  }
  let batchError: unknown = null;
  try {
    await input.db.$client.batch(statements);
  } catch (error) {
    batchError = error;
  }

  const [runtimeRows, legacyRows] = await Promise.all([
    loadRuntimeArtifactStatesForRunVm(input.db, input.runVm),
    loadLegacyArtifactStatesForRunVm(input.db, input.runVm),
  ]);
  const conflictOrdinal = findArtifactManifestConflict({
    runVm: input.runVm,
    manifest,
    runtimeRows,
    legacyRows,
  });
  if (batchError !== null && conflictOrdinal === null) {
    throw batchError;
  }
  return { conflictOrdinal };
}

/**
 * Checks a previously persisted manifest without reserving or changing
 * anything. This is only used to keep an in-flight old agent retry working
 * after the new-request manifest ceiling was introduced.
 */
export async function inspectExistingArtifactManifestRetry(input: {
  db: ReturnType<typeof drizzle>;
  runVm: ResolvedRunVm;
  artifacts: ReadonlyArray<{
    ordinal: number;
    kind: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }>;
}): Promise<ExistingArtifactManifestRetry> {
  const manifest = buildArtifactManifest({
    runVm: input.runVm,
    artifacts: input.artifacts,
    // The persisted timestamp is deliberately not part of idempotence.
    // Retries must prove the immutable artifact identity and metadata only.
    createdAt: 0,
  });
  const [runtimeRows, legacyRows] = await Promise.all([
    loadRuntimeArtifactStatesForRunVm(input.db, input.runVm),
    loadLegacyArtifactStatesForRunVm(input.db, input.runVm),
  ]);
  const requiresRuntime = input.runVm.runtimeVmId !== null;
  const requiresLegacy = input.runVm.domainKind === "scenario";
  const hasExistingArtifacts =
    (requiresRuntime && runtimeRows.length > 0) ||
    (requiresLegacy && legacyRows.length > 0);
  if (!hasExistingArtifacts) {
    return { status: "absent" };
  }

  const runtimeByOrdinal = new Map(
    runtimeRows.map((artifact) => [artifact.ordinal, artifact]),
  );
  const legacyByOrdinal = new Map(
    legacyRows.map((artifact) => [artifact.ordinal, artifact]),
  );
  const manifestByOrdinal = new Map(
    manifest.map((artifact) => [artifact.ordinal, artifact]),
  );
  const storedRowsMatchRequest = (
    rows: ReadonlyArray<SourceArtifactState>,
  ): boolean =>
    rows.every((stored) => {
      const expected = manifestByOrdinal.get(stored.ordinal);
      return (
        expected !== undefined &&
        artifactLedgerMatchesManifest(stored, expected)
      );
    });
  const storedLedgersMatch =
    !requiresRuntime ||
    !requiresLegacy ||
    (runtimeRows.length === legacyRows.length &&
      runtimeRows.every((runtime) => {
        const legacy = legacyByOrdinal.get(runtime.ordinal);
        return legacy !== undefined && artifactLedgersMatch(runtime, legacy);
      }));
  // A matching shorter prefix is an attempt to extend a manifest. Keep the
  // new-request ceiling absolute: report it as invalid instead of treating it
  // as an existing-manifest conflict.
  if (
    (!requiresRuntime || runtimeRows.length < manifest.length) &&
    (!requiresLegacy || legacyRows.length < manifest.length) &&
    (!requiresRuntime || storedRowsMatchRequest(runtimeRows)) &&
    (!requiresLegacy || storedRowsMatchRequest(legacyRows)) &&
    storedLedgersMatch
  ) {
    return { status: "new_reservation" };
  }
  const runtimeMatches =
    !requiresRuntime ||
    (runtimeRows.length === manifest.length &&
      manifest.every((expected) => {
        const runtime = runtimeByOrdinal.get(expected.ordinal);
        return (
          runtime !== undefined &&
          artifactLedgerMatchesManifest(runtime, expected)
        );
      }));
  const legacyMatches =
    !requiresLegacy ||
    (legacyRows.length === manifest.length &&
      manifest.every((expected) => {
        const legacy = legacyByOrdinal.get(expected.ordinal);
        return (
          legacy !== undefined &&
          artifactLedgerMatchesManifest(legacy, expected)
        );
      }));
  const ledgersMatch = storedLedgersMatch;
  if (!runtimeMatches || !legacyMatches || !ledgersMatch) {
    return { status: "mismatch" };
  }

  return {
    status: "exact",
    allUploaded: [...runtimeRows, ...legacyRows].every(
      (artifact) => artifact.uploadStatus === "uploaded",
    ),
  };
}

function buildArtifactManifest(input: {
  runVm: ResolvedRunVm;
  artifacts: ReadonlyArray<{
    ordinal: number;
    kind: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }>;
  createdAt: number;
}): ArtifactManifestEntry[] {
  const identityVmId =
    input.runVm.domainKind === "scenario"
      ? input.runVm.vmId
      : input.runVm.runtimeVmId;
  if (!identityVmId) {
    throw new Error("runtime VM identity is missing");
  }
  assertArtifactIdentityWithinR2KeyBudget(input.runVm.runId, identityVmId);
  return input.artifacts.map((artifact) => ({
    id: artifactIdFor(identityVmId, artifact.ordinal),
    ...artifact,
    r2Key: buildArtifactObjectKey({
      runId: input.runVm.runId,
      vmId: identityVmId,
      ordinal: artifact.ordinal,
      kind: artifact.kind,
      filename: artifact.filename,
    }),
    createdAt: input.createdAt,
  }));
}

function buildArtifactManifestConflictGuard(input: {
  d1: D1Database;
  runVm: ResolvedRunVm;
  manifestJson: string;
  checkRuntimeLedger: boolean;
  checkLegacyLedger: boolean;
}): D1PreparedStatement {
  const conflicts = [
    input.checkRuntimeLedger ? runtimeArtifactOrdinalConflictSql() : null,
    input.checkRuntimeLedger ? runtimeArtifactIdConflictSql() : null,
    input.checkLegacyLedger ? scenarioArtifactOrdinalConflictSql() : null,
    input.checkLegacyLedger ? scenarioArtifactIdConflictSql() : null,
    input.checkRuntimeLedger && input.checkLegacyLedger
      ? runtimeArtifactMissingLegacyCounterpartSql()
      : null,
    input.checkRuntimeLedger && input.checkLegacyLedger
      ? scenarioArtifactMissingRuntimeCounterpartSql()
      : null,
    input.checkRuntimeLedger && input.checkLegacyLedger
      ? artifactLedgerMetadataDivergenceSql()
      : null,
  ].filter((query): query is string => query !== null);
  const conflictPredicate = conflicts
    .map((query) => `EXISTS (${query})`)
    .join("\n      OR ");
  const query = `${artifactManifestCteSql()}
    INSERT INTO runtime_artifacts (
      id, execution_id, runtime_vm_id, ordinal, kind, filename, content_type,
      size_bytes, sha256, r2_key, upload_status, created_at, uploaded_at
    )
    SELECT
      '__artifact_manifest_conflict__', context.execution_id,
      context.runtime_vm_id, -1, 'artifact_manifest_guard',
      'artifact_manifest_guard', 'application/octet-stream', 0,
      '0000000000000000000000000000000000000000000000000000000000000000',
      '__artifact_manifest_conflict__', 'pending', 0, NULL
    FROM context
    WHERE ${conflictPredicate}`;
  return bindArtifactManifestStatement(
    input.d1,
    query,
    input.runVm,
    input.manifestJson,
  );
}

function buildArtifactManifestInsertStatement(input: {
  d1: D1Database;
  runVm: ResolvedRunVm;
  manifestJson: string;
  target: "runtime" | "scenario";
}): D1PreparedStatement {
  const targetSql =
    input.target === "runtime"
      ? runtimeArtifactReservationSql()
      : scenarioArtifactReservationSql();
  return bindArtifactManifestStatement(
    input.d1,
    `${artifactManifestCteSql()}
    ${targetSql}`,
    input.runVm,
    input.manifestJson,
  );
}

function artifactManifestCteSql(): string {
  return `WITH
    context AS (
      SELECT ? AS execution_id, ? AS runtime_vm_id,
        ? AS scenario_run_id, ? AS scenario_vm_id
    ),
    manifest AS (
      SELECT
        json_extract(value, '$.id') AS id,
        CAST(json_extract(value, '$.ordinal') AS INTEGER) AS ordinal,
        json_extract(value, '$.kind') AS kind,
        json_extract(value, '$.filename') AS filename,
        json_extract(value, '$.contentType') AS content_type,
        CAST(json_extract(value, '$.sizeBytes') AS INTEGER) AS size_bytes,
        json_extract(value, '$.sha256') AS sha256,
        json_extract(value, '$.r2Key') AS r2_key,
        CAST(json_extract(value, '$.createdAt') AS INTEGER) AS created_at
      FROM json_each(?)
    )`;
}

function bindArtifactManifestStatement(
  d1: D1Database,
  query: string,
  runVm: ResolvedRunVm,
  manifestJson: string,
): D1PreparedStatement {
  return d1
    .prepare(query)
    .bind(
      runVm.runId,
      runVm.runtimeVmId ?? "",
      runVm.domainId,
      runVm.vmId,
      manifestJson,
    );
}

function runtimeArtifactReservationSql(): string {
  return `INSERT INTO runtime_artifacts (
      id, execution_id, runtime_vm_id, ordinal, kind, filename, content_type,
      size_bytes, sha256, r2_key, upload_status, created_at, uploaded_at
    )
    SELECT
      manifest.id, context.execution_id, context.runtime_vm_id,
      manifest.ordinal, manifest.kind, manifest.filename,
      manifest.content_type, manifest.size_bytes, manifest.sha256,
      manifest.r2_key, 'pending', manifest.created_at, NULL
    FROM manifest CROSS JOIN context
    WHERE NOT EXISTS (
        SELECT 1 FROM runtime_artifacts AS stored
        WHERE stored.execution_id = context.execution_id
          AND stored.runtime_vm_id = context.runtime_vm_id
          AND stored.ordinal = manifest.ordinal
      )`;
}

function scenarioArtifactReservationSql(): string {
  return `INSERT INTO scenario_run_artifacts (
      id, run_id, vm_id, ordinal, kind, filename, content_type, size_bytes,
      sha256, r2_key, upload_status, created_at, uploaded_at
    )
    SELECT
      manifest.id, context.scenario_run_id, context.scenario_vm_id,
      manifest.ordinal, manifest.kind, manifest.filename,
      manifest.content_type, manifest.size_bytes, manifest.sha256,
      manifest.r2_key, 'pending', manifest.created_at, NULL
    FROM manifest CROSS JOIN context
    WHERE NOT EXISTS (
        SELECT 1 FROM scenario_run_artifacts AS stored
        WHERE stored.run_id = context.scenario_run_id
          AND stored.vm_id = context.scenario_vm_id
          AND stored.ordinal = manifest.ordinal
      )`;
}

function runtimeArtifactOrdinalConflictSql(): string {
  return `SELECT 1
    FROM runtime_artifacts AS stored
    JOIN manifest ON stored.ordinal = manifest.ordinal
    CROSS JOIN context
    WHERE stored.execution_id = context.execution_id
      AND stored.runtime_vm_id = context.runtime_vm_id
      AND (
        stored.id <> manifest.id OR stored.kind <> manifest.kind OR
        stored.filename <> manifest.filename OR
        stored.content_type <> manifest.content_type OR
        stored.size_bytes <> manifest.size_bytes OR
        stored.sha256 <> manifest.sha256 OR stored.r2_key <> manifest.r2_key
      )`;
}

function runtimeArtifactIdConflictSql(): string {
  return `SELECT 1
    FROM runtime_artifacts AS stored
    JOIN manifest ON stored.id = manifest.id
    CROSS JOIN context
    WHERE stored.execution_id <> context.execution_id
      OR stored.runtime_vm_id <> context.runtime_vm_id
      OR stored.ordinal <> manifest.ordinal
      OR stored.kind <> manifest.kind
      OR stored.filename <> manifest.filename
      OR stored.content_type <> manifest.content_type
      OR stored.size_bytes <> manifest.size_bytes
      OR stored.sha256 <> manifest.sha256
      OR stored.r2_key <> manifest.r2_key`;
}

function scenarioArtifactOrdinalConflictSql(): string {
  return `SELECT 1
    FROM scenario_run_artifacts AS stored
    JOIN manifest ON stored.ordinal = manifest.ordinal
    CROSS JOIN context
    WHERE stored.run_id = context.scenario_run_id
      AND stored.vm_id = context.scenario_vm_id
      AND (
        stored.id <> manifest.id OR stored.kind <> manifest.kind OR
        stored.filename <> manifest.filename OR
        stored.content_type <> manifest.content_type OR
        stored.size_bytes <> manifest.size_bytes OR
        stored.sha256 <> manifest.sha256 OR stored.r2_key <> manifest.r2_key
      )`;
}

function scenarioArtifactIdConflictSql(): string {
  return `SELECT 1
    FROM scenario_run_artifacts AS stored
    JOIN manifest ON stored.id = manifest.id
    CROSS JOIN context
    WHERE stored.run_id <> context.scenario_run_id
      OR stored.vm_id <> context.scenario_vm_id
      OR stored.ordinal <> manifest.ordinal
      OR stored.kind <> manifest.kind
      OR stored.filename <> manifest.filename
      OR stored.content_type <> manifest.content_type
      OR stored.size_bytes <> manifest.size_bytes
      OR stored.sha256 <> manifest.sha256
      OR stored.r2_key <> manifest.r2_key`;
}

function runtimeArtifactMissingLegacyCounterpartSql(): string {
  return `SELECT 1
    FROM runtime_artifacts AS runtime
    CROSS JOIN context
    WHERE runtime.execution_id = context.execution_id
      AND runtime.runtime_vm_id = context.runtime_vm_id
      AND NOT EXISTS (
        SELECT 1 FROM scenario_run_artifacts AS legacy
        WHERE legacy.run_id = context.scenario_run_id
          AND legacy.vm_id = context.scenario_vm_id
          AND legacy.ordinal = runtime.ordinal
      )`;
}

function scenarioArtifactMissingRuntimeCounterpartSql(): string {
  return `SELECT 1
    FROM scenario_run_artifacts AS legacy
    CROSS JOIN context
    WHERE legacy.run_id = context.scenario_run_id
      AND legacy.vm_id = context.scenario_vm_id
      AND NOT EXISTS (
        SELECT 1 FROM runtime_artifacts AS runtime
        WHERE runtime.execution_id = context.execution_id
          AND runtime.runtime_vm_id = context.runtime_vm_id
          AND runtime.ordinal = legacy.ordinal
      )`;
}

function artifactLedgerMetadataDivergenceSql(): string {
  return `SELECT 1
    FROM runtime_artifacts AS runtime
    JOIN scenario_run_artifacts AS legacy
      ON legacy.ordinal = runtime.ordinal
    CROSS JOIN context
    WHERE runtime.execution_id = context.execution_id
      AND runtime.runtime_vm_id = context.runtime_vm_id
      AND legacy.run_id = context.scenario_run_id
      AND legacy.vm_id = context.scenario_vm_id
      AND (
        runtime.id <> legacy.id OR runtime.kind <> legacy.kind OR
        runtime.filename <> legacy.filename OR
        runtime.content_type <> legacy.content_type OR
        runtime.size_bytes <> legacy.size_bytes OR
        runtime.sha256 <> legacy.sha256 OR runtime.r2_key <> legacy.r2_key OR
        runtime.upload_status <> legacy.upload_status
      )`;
}

function findArtifactManifestConflict(input: {
  runVm: ResolvedRunVm;
  manifest: readonly ArtifactManifestEntry[];
  runtimeRows: readonly SourceArtifactState[];
  legacyRows: readonly SourceArtifactState[];
}): number | null {
  const runtimeByOrdinal = new Map(
    input.runtimeRows.map((artifact) => [artifact.ordinal, artifact]),
  );
  const legacyByOrdinal = new Map(
    input.legacyRows.map((artifact) => [artifact.ordinal, artifact]),
  );
  for (const expected of input.manifest) {
    const runtime = runtimeByOrdinal.get(expected.ordinal);
    if (
      input.runVm.runtimeVmId &&
      (!runtime || !artifactLedgerMatchesManifest(runtime, expected))
    ) {
      return expected.ordinal;
    }
    const legacy = legacyByOrdinal.get(expected.ordinal);
    if (
      input.runVm.domainKind === "scenario" &&
      (!legacy || !artifactLedgerMatchesManifest(legacy, expected))
    ) {
      return expected.ordinal;
    }
    if (
      input.runVm.domainKind === "scenario" &&
      input.runVm.runtimeVmId &&
      runtime &&
      legacy &&
      !artifactLedgersMatch(runtime, legacy)
    ) {
      return expected.ordinal;
    }
  }

  if (input.runVm.domainKind === "scenario" && input.runVm.runtimeVmId) {
    const allOrdinals = new Set([
      ...input.runtimeRows.map((artifact) => artifact.ordinal),
      ...input.legacyRows.map((artifact) => artifact.ordinal),
    ]);
    for (const ordinal of [...allOrdinals].sort(
      (left, right) => left - right,
    )) {
      const runtime = runtimeByOrdinal.get(ordinal);
      const legacy = legacyByOrdinal.get(ordinal);
      if (!runtime || !legacy || !artifactLedgersMatch(runtime, legacy)) {
        return ordinal;
      }
    }
  }
  return null;
}

function artifactLedgerMatchesManifest(
  stored: SourceArtifactState,
  expected: ArtifactManifestEntry,
): boolean {
  return (
    stored.id === expected.id &&
    stored.r2Key === expected.r2Key &&
    artifactMetadataMatches(stored, expected)
  );
}

function artifactLedgersMatch(
  runtime: SourceArtifactState,
  legacy: SourceArtifactState,
): boolean {
  return (
    runtime.id === legacy.id &&
    runtime.r2Key === legacy.r2Key &&
    runtime.uploadStatus === legacy.uploadStatus &&
    runtime.kind === legacy.kind &&
    runtime.filename === legacy.filename &&
    runtime.contentType === legacy.contentType &&
    runtime.sizeBytes === legacy.sizeBytes &&
    runtime.sha256 === legacy.sha256
  );
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
  options?: { recordArchiveProgress?: boolean },
): Promise<void> {
  if (runVm.runtimeVmId) {
    const executionUpdate = db
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
    if (options?.recordArchiveProgress === true) {
      // The durable artifact manifest is the archive hand-off. Recording this
      // first stage in the same D1 batch means a successful version-one
      // /begin response never depends on a second best-effort callback.
      const vmStageUpdate = db
        .update(runtimeVms)
        .set({
          archiveStageRank: sql<number>`CASE
            WHEN ${runtimeVms.archiveStageRank} IS NULL
              OR ${runtimeVms.archiveStageRank} < 1 THEN 1
            ELSE ${runtimeVms.archiveStageRank}
          END`,
          updatedAt: now,
        })
        .where(
          and(
            eq(runtimeVms.id, runVm.runtimeVmId),
            eq(runtimeVms.executionId, runVm.runId),
          ),
        );
      await db.batch([executionUpdate, vmStageUpdate]);
    } else {
      await executionUpdate;
    }
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

/**
 * Advances, never replaces, the durable archive stage for one modern runtime
 * VM. Archive callbacks are intentionally independent and can arrive out of
 * order, so the SQL comparison must remain atomic.
 */
export async function advanceRunVmArchiveStage(input: {
  db: ReturnType<typeof drizzle>;
  runVm: ResolvedRunVm;
  stageRank: number;
  now: number;
}): Promise<void> {
  if (!input.runVm.runtimeVmId) {
    // Historical scenario rows do not have a runtime VM ledger. Their
    // learner view keeps using the existing coarse lifecycle mapping.
    return;
  }
  if (
    !Number.isInteger(input.stageRank) ||
    input.stageRank < 1 ||
    input.stageRank > 4
  ) {
    throw new Error("archive stage rank must be an integer from 1 to 4");
  }
  const priorRank = input.stageRank - 1;
  const canAdvance =
    input.stageRank === 1
      ? sql`(${runtimeVms.archiveStageRank} IS NULL OR ${runtimeVms.archiveStageRank} < 1)`
      : sql`${runtimeVms.archiveStageRank} >= ${priorRank}
          AND ${runtimeVms.archiveStageRank} < ${input.stageRank}`;
  await input.db
    .update(runtimeVms)
    .set({
      archiveStageRank: input.stageRank,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(runtimeVms.id, input.runVm.runtimeVmId),
        eq(runtimeVms.executionId, input.runVm.runId),
        canAdvance,
      ),
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
      .set({
        artifactWritesSealed: true,
        archiveStageRank: sql<number>`CASE
          WHEN ${runtimeVms.archiveStageRank} IS NULL
            THEN NULL
          WHEN ${runtimeVms.archiveStageRank} < 4 THEN 4
          ELSE ${runtimeVms.archiveStageRank}
        END`,
        updatedAt: now,
      })
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
      archiveEnteredAt: ["archiving", "completed", "failed"].includes(nextPhase)
        ? sql<number>`coalesce(${scenarioRuns.archiveEnteredAt}, ${now})`
        : sql<number | null>`${scenarioRuns.archiveEnteredAt}`,
      updatedAt: now,
    })
    .where(eq(scenarioRuns.runId, runId));
  await executeScenarioRunRuntimeProjection({
    d1: db.$client,
    runId,
    statements: [drizzleQueryToD1Statement(db.$client, mutation)],
    mode: "update",
  });
  if (nextPhase === "completed" && solvedAt !== null) {
    await recordLinkedCourseUnitCompletionForRun(db, { runId, nowUnixMs: now });
  }
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
  inputs: unknown,
  maxArtifacts = MAX_ARTIFACTS_PER_BEGIN,
): Array<{
  ordinal: number;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}> | null {
  if (!Array.isArray(inputs) || inputs.length > maxArtifacts) {
    return null;
  }

  const normalized: Array<{
    ordinal: number;
    kind: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }> = [];
  for (const input of inputs) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const descriptor = input as AgentRunArtifactInput;
    const ordinal = normalizeInteger(descriptor.ordinal);
    const sizeBytes = normalizeInteger(descriptor.sizeBytes);
    const kind = normalizeArtifactText(
      descriptor.kind,
      MAX_ARTIFACT_KIND_BYTES,
    );
    const filename = normalizeArtifactText(
      descriptor.filename,
      MAX_ARTIFACT_FILENAME_BYTES,
    );
    const contentType = normalizeArtifactText(
      descriptor.contentType,
      MAX_ARTIFACT_CONTENT_TYPE_BYTES,
    );
    const sha256 = descriptor.sha256;
    if (
      ordinal === null ||
      sizeBytes === null ||
      ordinal <= 0 ||
      sizeBytes < 0 ||
      kind === null ||
      filename === null ||
      contentType === null ||
      typeof sha256 !== "string" ||
      !SHA256_HEX.test(sha256)
    ) {
      return null;
    }
    normalized.push({
      ordinal,
      kind,
      filename,
      contentType,
      sizeBytes,
      sha256,
    });
  }

  normalized.sort((a, b) => a.ordinal - b.ordinal);
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index]?.ordinal !== index + 1) {
      return null;
    }
  }

  return normalized;
}

function normalizeArtifactText(
  value: unknown,
  maxBytes: number,
): string | null {
  if (typeof value !== "string") return null;
  if (artifactTextEncoder.encode(value).byteLength > maxBytes) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) return null;
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
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return null;
  }
  return value;
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
  const key = [
    sanitizeObjectKeySegment(input.runId),
    sanitizeObjectKeySegment(input.vmId),
    `${input.ordinal}-${sanitizeObjectKeySegment(input.kind)}-${sanitizeObjectKeySegment(input.filename)}`,
  ].join("/");
  if (artifactTextEncoder.encode(key).byteLength > MAX_R2_OBJECT_KEY_BYTES) {
    throw new Error("artifact object key exceeds the R2 key byte limit");
  }
  return key;
}

function assertArtifactIdentityWithinR2KeyBudget(
  runId: string,
  vmId: string,
): void {
  if (
    artifactTextEncoder.encode(runId).byteLength > MAX_ARTIFACT_VM_ID_BYTES ||
    artifactTextEncoder.encode(vmId).byteLength > MAX_ARTIFACT_VM_ID_BYTES
  ) {
    throw new Error("artifact identity exceeds the R2 key byte budget");
  }
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
