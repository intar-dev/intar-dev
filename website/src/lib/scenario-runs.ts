import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import type { HostDesiredStateV2 } from "@/generated/bridge";
import { strictCpuCapacity } from "@/control-plane/host-cpu-reservations";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  scenarioRunArtifacts,
  scenarioRunArtifactUploads,
  scenarioRuns,
  scenarioRunSshKeys,
  type ScenarioRunHintSnapshot,
} from "@/db/schema";
import {
  desiredVmFromRunVm,
  markDesiredVmAbsent,
  upsertDesiredCachedImage,
  upsertDesiredVm,
} from "@/lib/desired-state";
import {
  loadOrCreateHostDesiredState,
  mutateStoredHostDesiredState,
} from "@/lib/desired-state-store";
import { hostHealth } from "@/lib/host-health";
import {
  acquireBenchmarkHostLeaseAndReserveCpu,
  commitHostCpu,
  reserveHostCpu,
  rollbackHostCpu,
} from "@/lib/host-cpu-reservation-client";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { createAppId } from "@/lib/id";
import { revokeAllRoutes } from "@/lib/route-revocation";
import { deleteScenarioArtifactStorage } from "@/lib/scenario-artifact-storage";
import {
  runVmsRequiringDesiredAbsence,
  scenarioRunPurgeBlockReason,
} from "@/lib/scenario-run-cleanup";
import {
  buildScenarioLaunchSpecs,
  deriveScenarioBriefing,
  parseScenarioDifficulty,
  type ScenarioBriefing,
  type ScenarioDifficulty,
  type ScenarioObjective,
} from "@/lib/scenario-model";
import {
  RUN_PHASE_ORDER,
  buildInitialVmState,
  buildInitialRunState,
  recomputeRunState,
  runPhaseAcceptsTerminalSessions,
  type RunPhase,
  type ScenarioReplayArtifact,
  type RunStateDocument,
  type RunVmStateDocument,
} from "@/lib/run-state";
import {
  buildScenarioRunHintViews,
  buildScenarioRunSolutionView,
  type ScenarioRunHintView,
  type ScenarioRunSolutionView,
} from "@/lib/scenario-run-content";
import {
  deriveScenarioRunOutcome,
  deriveScenarioRunSolveDurationMs,
  nextSolvedAt,
  type ScenarioRunOutcome,
} from "@/lib/scenario-run-outcome";
import {
  listEnabledScenarios,
  loadEnabledScenario,
  type ScenarioDetailRecord,
} from "@/lib/scenarios";
import {
  hostHasImagesReady,
  imageKeyIdentity,
  type RequiredScenarioImage,
} from "@/lib/scenario-host-readiness";
import { selectOverdueRunLeases } from "@/lib/scenario-run-leases";
import {
  isAvailableScenarioLaunchHost,
  isFreshHostHeartbeat,
  isScenarioLaunchHost,
} from "@/lib/scenario-hosts";
import {
  deleteStargateRoute,
  issueStargateTerminalSession,
  stargateRouteTtlMs,
  type BrowserTerminalSessionResult,
  type NativeTerminalSessionResult,
} from "@/lib/stargate";
import {
  generateScenarioRunSshKeyDraft,
  loadScenarioRunSshKey,
  prepareScenarioRunSshKeyRows,
} from "@/lib/scenario-run-ssh-keys";
import { listUserAuthorizedSshKeysForNativeRoutes } from "@/lib/user-ssh-keys";

export interface ScenarioCatalogEntry {
  scenarioId: string;
  slug: string;
  title: string;
  tagline: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  tags: string[];
  category: string;
  scenarioName: string;
  enabledAt: number;
  vmCount: number;
}

export interface ScenarioProgress {
  status: "new" | "in_progress" | "attempted" | "completed";
  activeRunId: string | null;
  attemptCount: number;
  completedCount: number;
  bestSolveMs: number | null;
  lastPlayedAt: number | null;
}

export interface ScenarioCatalogWireEntry extends ScenarioCatalogEntry {
  progress: ScenarioProgress;
}

export interface ScenarioDetail {
  scenarioId: string;
  slug: string;
  enabledAt: number;
  scenarioName: string;
  briefing: ScenarioBriefing;
  vmCount: number;
  hasActiveRun: boolean;
  activeRunId: string | null;
  activeRun: {
    runId: string;
    phase: RunStateDocument["phase"];
    phaseTitle: string;
    phaseDetail: string;
    canOpenTerminal: boolean;
    terminalPhase: RunStateDocument["terminalPhase"];
    updatedAt: number;
  } | null;
  blockingRun: {
    runId: string;
    scenarioId: string;
    slug: string;
    title: string;
  } | null;
  finishedRuns: Array<{
    runId: string;
    phase: "completed" | "failed";
    outcome: Exclude<ScenarioRunOutcome, "in_progress">;
    createdAt: number;
    finishedAt: number;
    solvedAt: number | null;
    solveDurationMs: number | null;
    solutionAssisted: boolean;
    hasReplay: boolean;
  }>;
}

export interface ScenarioRunRecord extends RunStateDocument {
  id: string;
  scenarioId: string;
  scenarioName: string;
  title: string;
  tagline: string;
  briefingMarkdown: string;
  objectives: ScenarioObjective[];
  tags: string[];
  hints: ScenarioRunHintView[];
  solution: ScenarioRunSolutionView;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  solvedAt: number | null;
  solveDurationMs: number | null;
  outcome: ScenarioRunOutcome;
  createdAt: number;
  updatedAt: number;
}

interface ScenarioRunContentSnapshot {
  tags: string[];
  hints: ScenarioRunHintSnapshot[];
  solutionMarkdown: string;
}

const HOST_HEARTBEAT_TTL_MS = 90_000;

type HostSelectionResult =
  | { ok: true; hostIds: string[] }
  | { ok: false; reason: "unavailable" | "image_not_ready" };

type ScenarioRouteType = "browser" | "native_profile_keys";

export type ScenarioTerminalSessionResult =
  | BrowserTerminalSessionResult
  | NativeTerminalSessionResult;

export async function listEnabledScenariosForUser(): Promise<
  ScenarioCatalogEntry[]
> {
  const scenarios = await loadEnabledScenarioRows();
  return scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    slug: slugify(scenario.scenarioId),
    title: scenario.briefing.title,
    tagline: scenario.briefing.tagline,
    difficulty: scenario.briefing.difficulty,
    estimatedMinutes: scenario.briefing.estimatedMinutes,
    tags: scenario.briefing.tags,
    category: scenario.briefing.category,
    scenarioName: scenario.scenarioId,
    enabledAt: scenario.enabledAt,
    vmCount: scenario.launchSpecs.length,
  }));
}

export async function loadEnabledScenarioForUser(params: {
  scenarioId: string;
  userId: string;
}): Promise<ScenarioDetail | null> {
  const rows = await loadEnabledScenarioRows(params.scenarioId);
  const enabled = rows[0];
  if (!enabled) {
    return null;
  }

  const active = await loadActiveRunRow(params.userId);
  const activeHere =
    active && active.scenarioId === enabled.scenarioId ? active : null;
  const finishedRuns = await loadFinishedRuns(
    params.userId,
    enabled.scenarioId,
  );
  return {
    scenarioId: enabled.scenarioId,
    slug: slugify(enabled.scenarioId),
    enabledAt: enabled.enabledAt,
    scenarioName: enabled.scenarioId,
    briefing: enabled.briefing,
    vmCount: enabled.launchSpecs.length,
    hasActiveRun: activeHere !== null,
    activeRunId: activeHere?.runId ?? null,
    activeRun: activeHere
      ? {
          runId: activeHere.runId,
          phase: activeHere.state.phase,
          phaseTitle: activeHere.state.phaseTitle,
          phaseDetail: activeHere.state.phaseDetail,
          canOpenTerminal: activeHere.state.canOpenTerminal,
          terminalPhase: activeHere.state.terminalPhase,
          updatedAt: activeHere.updatedAt,
        }
      : null,
    blockingRun:
      active && !activeHere
        ? {
            runId: active.runId,
            scenarioId: active.scenarioId,
            slug: slugify(active.scenarioId),
            title: active.title,
          }
        : null,
    finishedRuns,
  };
}

export async function getScenarioRunForUser(params: {
  runId: string;
  userId: string;
}): Promise<ScenarioRunRecord> {
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }
  const run = toScenarioRunRecord(row);
  // Recording artifacts are produced only after teardown starts. Keep the
  // 100 ms boot/readiness poll to one run-row query without hiding artifact
  // upload progress from teardown and archive views.
  if (
    RUN_PHASE_ORDER[run.phase] < RUN_PHASE_ORDER.teardown_requested
  ) {
    return run;
  }
  return hydrateScenarioRunReplayArtifacts(run);
}

export interface ScenarioRunListEntry {
  runId: string;
  scenarioId: string;
  scenarioName: string;
  title: string;
  difficulty: ScenarioDifficulty;
  phase: RunPhase;
  outcome: ScenarioRunOutcome;
  active: boolean;
  createdAt: number;
  finishedAt: number | null;
  solvedAt: number | null;
  solveDurationMs: number | null;
  solutionAssisted: boolean;
  hasReplay: boolean;
}

export async function listScenarioRunsForUser(params: {
  userId: string;
}): Promise<ScenarioRunListEntry[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      scenarioId: scenarioRuns.scenarioId,
      scenarioName: scenarioRuns.scenarioName,
      title: scenarioRuns.title,
      difficulty: scenarioRuns.difficulty,
      state: scenarioRuns.state,
      activeKey: scenarioRuns.activeKey,
      createdAt: scenarioRuns.createdAt,
      completedAt: scenarioRuns.completedAt,
      solvedAt: scenarioRuns.solvedAt,
      failedAt: scenarioRuns.failedAt,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      solutionAssisted: scenarioRuns.solutionAssisted,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.userId, params.userId))
    .orderBy(desc(scenarioRuns.createdAt))
    .limit(100);

  const replayRunIds = await loadRunIdsWithUploadedReplayArtifacts(
    db,
    rows.map((row) => row.runId),
  );
  return rows.map((row) => ({
    runId: row.runId,
    scenarioId: row.scenarioId,
    scenarioName: row.scenarioName,
    title: row.title,
    difficulty: scenarioRunDifficulty(row.runId, row.difficulty),
    phase: row.state as RunPhase,
    outcome: deriveScenarioRunOutcome({
      phase: row.state as RunPhase,
      solvedAt: row.solvedAt,
      deleteRequestedAt: row.deleteRequestedAt,
      failedAt: row.failedAt,
    }),
    active: row.activeKey !== null,
    createdAt: row.createdAt,
    finishedAt: row.completedAt ?? row.failedAt ?? null,
    solvedAt: row.solvedAt,
    solveDurationMs: deriveScenarioRunSolveDurationMs({
      createdAt: row.createdAt,
      solvedAt: row.solvedAt,
    }),
    solutionAssisted: row.solutionAssisted,
    hasReplay: replayRunIds.has(row.runId),
  }));
}

export async function getScenarioProgressByScenario(
  userId: string,
): Promise<Map<string, ScenarioProgress>> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      scenarioId: scenarioRuns.scenarioId,
      state: scenarioRuns.state,
      activeKey: scenarioRuns.activeKey,
      createdAt: scenarioRuns.createdAt,
      updatedAt: scenarioRuns.updatedAt,
      completedAt: scenarioRuns.completedAt,
      solvedAt: scenarioRuns.solvedAt,
      failedAt: scenarioRuns.failedAt,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.userId, userId));

  const progressByScenario = new Map<string, ScenarioProgress>();
  for (const row of rows) {
    const current =
      progressByScenario.get(row.scenarioId) ?? newScenarioProgress();
    const outcome = deriveScenarioRunOutcome({
      phase: row.state as RunPhase,
      solvedAt: row.solvedAt,
      deleteRequestedAt: row.deleteRequestedAt,
      failedAt: row.failedAt,
    });
    const finished =
      row.activeKey === null &&
      (row.state === "completed" || row.state === "failed");
    const finishedAt = row.completedAt ?? row.failedAt ?? null;
    const solveDurationMs = deriveScenarioRunSolveDurationMs({
      createdAt: row.createdAt,
      solvedAt: row.solvedAt,
    });

    if (row.activeKey !== null) {
      current.activeRunId = row.runId;
    }
    // A run cancelled before it was ever solved is not an attempt, and a
    // genuine solve counts as completed even when teardown later failed or
    // the user destroyed the run (outcome would report failed/cancelled).
    const solved = row.solvedAt !== null;
    if (finished && (outcome !== "cancelled" || solved)) {
      current.attemptCount += 1;
    }
    if (finished && solved) {
      current.completedCount += 1;
      if (solveDurationMs !== null) {
        current.bestSolveMs =
          current.bestSolveMs === null
            ? solveDurationMs
            : Math.min(current.bestSolveMs, solveDurationMs);
      }
    }
    current.lastPlayedAt = Math.max(
      current.lastPlayedAt ?? 0,
      row.updatedAt,
      finishedAt ?? 0,
      row.createdAt,
    );
    progressByScenario.set(row.scenarioId, current);
  }

  for (const progress of progressByScenario.values()) {
    progress.status =
      progress.activeRunId !== null
        ? "in_progress"
        : progress.completedCount > 0
          ? "completed"
          : progress.attemptCount > 0
            ? "attempted"
            : "new";
  }

  return progressByScenario;
}

function newScenarioProgress(): ScenarioProgress {
  return {
    status: "new",
    activeRunId: null,
    attemptCount: 0,
    completedCount: 0,
    bestSolveMs: null,
    lastPlayedAt: null,
  };
}

export async function listScenarioCatalogForUser(
  userId: string,
): Promise<ScenarioCatalogWireEntry[]> {
  const [scenarios, progressByScenario] = await Promise.all([
    listEnabledScenariosForUser(),
    getScenarioProgressByScenario(userId),
  ]);
  return scenarios.map((scenario) => ({
    ...scenario,
    progress:
      progressByScenario.get(scenario.scenarioId) ?? newScenarioProgress(),
  }));
}

export async function startScenarioRunForUser(params: {
  scenarioId: string;
  userId: string;
  hostId?: string;
  admissionMode?: "benchmark";
  benchmarkCredentialWindow?: {
    notBeforeUnixMs: number;
    expiresAtUnixMs: number;
  };
}): Promise<{
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}> {
  return startScenarioRunInternal(params);
}

export async function destroyScenarioRunForUser(params: {
  runId: string;
  userId: string;
}): Promise<{
  accepted: true;
  runId: string;
  acceptedAt: number;
}> {
  const db = drizzle(env.DB);
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }

  const acceptedAt = Date.now();
  const teardownVms = runVmsRequiringDesiredAbsence(row.state);
  if (!["completed", "failed"].includes(row.state.phase)) {
    const teardownVmIds = new Set(teardownVms.map((vm) => vm.id));
    await updateRunState(row.runId, {
      mutate: (current) =>
        recomputeRunState({
          ...current,
          phase: "teardown_requested",
          phaseTitle: "Teardown requested",
          phaseDetail: "Waiting for the host to acknowledge teardown.",
          vms: current.vms.map((vm) =>
            teardownVmIds.has(vm.id)
              ? {
                  ...vm,
                  phaseDetail: "Teardown requested. Waiting for host delivery.",
                }
              : vm,
          ),
        }),
      deleteRequestedAt: acceptedAt,
    });
  } else if (teardownVms.length > 0) {
    // A failed outcome is terminal for scoring, not for infrastructure. Keep
    // the original failure state while recording that teardown was requested.
    await db
      .update(scenarioRuns)
      .set({
        deleteRequestedAt: row.deleteRequestedAt ?? acceptedAt,
        updatedAt: acceptedAt,
      })
      .where(
        and(
          eq(scenarioRuns.runId, row.runId),
          eq(scenarioRuns.userId, params.userId),
        ),
      );
  }

  if (teardownVms.length > 0) {
    await markRunVmsAbsentInDesiredState({
      hostId: row.hostId,
      runId: row.runId,
      vms: teardownVms,
      nowUnixMs: acceptedAt,
      db,
    });
  }

  const routeRevocationFailure = await revokeScenarioRunRoutes(row).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  await tryWakeHostRuntime(row.hostId);
  if (routeRevocationFailure) {
    throw routeRevocationFailure.error;
  }

  return {
    accepted: true,
    runId: row.runId,
    acceptedAt,
  };
}

export async function deleteFinishedScenarioRunForUser(params: {
  runId: string;
  userId: string;
}): Promise<void> {
  const db = drizzle(env.DB);
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }
  if (!["completed", "failed"].includes(row.state.phase)) {
    throw appError(
      409,
      "scenario_run_delete_conflict",
      "scenario run is not in a terminal state",
    );
  }
  const storageRecords = await db
    .select({
      r2Key: scenarioRunArtifacts.r2Key,
      r2UploadId: scenarioRunArtifactUploads.r2UploadId,
      uploadStatus: scenarioRunArtifacts.uploadStatus,
    })
    .from(scenarioRunArtifacts)
    .leftJoin(
      scenarioRunArtifactUploads,
      eq(scenarioRunArtifactUploads.artifactId, scenarioRunArtifacts.id),
    )
    .where(eq(scenarioRunArtifacts.runId, row.runId));
  const purgeBlockReason = scenarioRunPurgeBlockReason(
    row.state,
    storageRecords,
  );
  if (purgeBlockReason) {
    throw appError(
      409,
      "scenario_run_delete_conflict",
      purgeBlockReason === "vm_teardown_pending"
        ? "scenario run teardown is not complete"
        : "scenario run artifact uploads are not complete",
    );
  }

  await revokeScenarioRunRoutes(row);
  const storageCleanup = await deleteScenarioArtifactStorage(
    env.VM_RUN_ARTIFACTS_BUCKET,
    storageRecords,
  );
  if (storageCleanup.failedMultipartAborts > 0) {
    console.warn("scenario artifact multipart cleanup was incomplete", {
      runId: row.runId,
      failedMultipartAborts: storageCleanup.failedMultipartAborts,
    });
  }

  await db.delete(scenarioRuns).where(eq(scenarioRuns.runId, row.runId));
}

export async function expireOverdueRunLeases(
  hostId: string,
  nowUnixMs: number,
  options?: {
    db?: DrizzleD1Database;
    wakeHostRuntime?: boolean;
  },
): Promise<{ expiredRunIds: string[] }> {
  const db = options?.db ?? drizzle(env.DB);
  const desiredState = await loadOrCreateHostDesiredState(
    db,
    hostId,
    nowUnixMs,
  );
  const overdue = selectOverdueRunLeases(desiredState, nowUnixMs);
  const expiredRunIds: string[] = [];

  for (const lease of overdue) {
    const row = await loadRunRow(lease.runId);
    const expiredVmNames = new Set(lease.vmNames);
    if (
      row &&
      row.hostId === hostId &&
      row.completedAt === null &&
      row.failedAt === null &&
      row.state.vms.some((vm) => expiredVmNames.has(vm.runtimeVmName))
    ) {
      await updateRunState(row.runId, {
        mutate: (current) =>
          recomputeRunState({
            ...current,
            phase: "failed",
            phaseDetail: "The run lease expired before teardown completed.",
            vms: current.vms.map((vm) =>
              expiredVmNames.has(vm.runtimeVmName)
                ? {
                    ...vm,
                    phase: "failed",
                    phaseDetail: "The run lease expired.",
                    terminalPhase: "failed",
                    terminalReason: "The run lease expired.",
                  }
                : vm,
            ),
          }),
        deleteRequestedAt: row.deleteRequestedAt,
      });
    }

    // Clear the expired VMs from the desired doc even when the run row is
    // missing, on another host, or already terminal: a leftover overdue lease
    // re-arms the host alarm immediately and leaves the VM running forever.
    await mutateStoredHostDesiredState(db, hostId, nowUnixMs, (draft) => {
      for (const vmName of lease.vmNames) {
        markDesiredVmAbsent(draft, { runId: lease.runId, vmName });
      }
    });
    expiredRunIds.push(lease.runId);
  }

  if (expiredRunIds.length && options?.wakeHostRuntime !== false) {
    await tryWakeHostRuntime(hostId);
  }

  return { expiredRunIds };
}

export async function createScenarioSshSessionForUser(params: {
  runId: string;
  vmId: string;
  userId: string;
  mode?: "browser" | "native";
}): Promise<ScenarioTerminalSessionResult> {
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }
  if (
    !runPhaseAcceptsTerminalSessions(row.state.phase) ||
    row.completedAt !== null ||
    row.failedAt !== null
  ) {
    throw appError(
      409,
      "scenario_terminal_closed",
      "terminal sessions are closed unless the run is active",
    );
  }
  const vm = row.state.vms.find((candidate) => candidate.id === params.vmId);
  if (!vm) {
    throw appError(404, "scenario_vm_not_found", "scenario VM not found");
  }
  if (!vm.canOpenTerminal || vm.terminalPhase !== "ready") {
    throw appError(
      409,
      "scenario_shell_not_ready",
      "terminal target is still warming up",
    );
  }

  const host =
    vm.terminalTarget.host?.trim() ||
    (await loadHostTerminalAddress(row.hostId)) ||
    "";
  const port =
    typeof vm.terminalTarget.port === "number" && vm.terminalTarget.port > 0
      ? vm.terminalTarget.port
      : 0;
  const targetUsername = vm.terminalTarget.username?.trim() || "ubuntu";
  const targetHostKeyOpenssh = vm.terminalTarget.hostKeyOpenssh?.trim() ?? "";
  if (!host || !port || !targetHostKeyOpenssh) {
    throw appError(
      409,
      "scenario_shell_not_ready",
      "terminal target is still warming up",
    );
  }

  const requestedMode = params.mode ?? "browser";
  const profileKeys =
    requestedMode === "native"
      ? await listUserAuthorizedSshKeysForNativeRoutes(params.userId)
      : [];
  if (requestedMode === "native" && profileKeys.length === 0) {
    throw appError(
      409,
      "scenario_native_ssh_key_required",
      "add an SSH key to your profile before opening a native SSH route",
    );
  }
  const routeType =
    requestedMode === "browser" ? "browser" : "native_profile_keys";
  const routeUsername = buildRunVmRouteUsername(
    row.runId,
    row.state.vms,
    vm.id,
    routeType,
  );
  const targetKey = await loadScenarioRunSshKey({
    runId: row.runId,
    vmId: vm.id,
  });
  return issueStargateTerminalSession({
    routeUsername,
    targetUsername,
    targetHost: host,
    targetPort: port,
    targetHostKeyOpenssh,
    targetPrivateKeyOpenssh: targetKey.privateKeyOpenssh,
    expiresAt: new Date(Date.now() + stargateRouteTtlMs()),
    mode: requestedMode,
    authorizedClientPublicKeysOpenssh: profileKeys.map(
      (key) => key.publicKeyOpenssh,
    ),
    metadata: {
      hostId: row.hostId,
      runId: row.runId,
      vmId: vm.id,
      userId: row.userId,
    },
  });
}

export async function listHostRunsForUser(params: {
  hostId: string;
  userId: string;
}): Promise<ScenarioRunRecord[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.hostId, params.hostId),
        eq(scenarioRuns.userId, params.userId),
        isNull(scenarioRuns.hiddenAt),
      ),
    )
    .orderBy(desc(scenarioRuns.createdAt));
  const parsedRows = rows.map((row) => fromDbRow(row));
  return parsedRows.map((row) => toScenarioRunRecord(row));
}

async function startScenarioRunInternal(params: {
  scenarioId: string;
  userId: string;
  hostId?: string;
  admissionMode?: "benchmark";
  benchmarkCredentialWindow?: {
    notBeforeUnixMs: number;
    expiresAtUnixMs: number;
  };
}): Promise<{
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}> {
  if (params.admissionMode === "benchmark" && !params.hostId) {
    throw appError(
      400,
      "benchmark_host_required",
      "benchmark admission requires an explicit host",
    );
  }
  if (
    params.admissionMode === "benchmark" &&
    (!params.benchmarkCredentialWindow ||
      !Number.isSafeInteger(
        params.benchmarkCredentialWindow.notBeforeUnixMs,
      ) ||
      !Number.isSafeInteger(params.benchmarkCredentialWindow.expiresAtUnixMs) ||
      params.benchmarkCredentialWindow.notBeforeUnixMs <= 0 ||
      params.benchmarkCredentialWindow.expiresAtUnixMs <=
        params.benchmarkCredentialWindow.notBeforeUnixMs)
  ) {
    throw appError(
      400,
      "benchmark_credential_window_required",
      "benchmark admission requires an authenticated credential window",
    );
  }
  const [[scenario], active] = await Promise.all([
    loadEnabledScenarioRows(params.scenarioId),
    loadActiveRunRow(params.userId),
  ]);
  if (!scenario) {
    throw appError(404, "scenario_not_found", "scenario not found");
  }
  if (active) {
    if (params.admissionMode === "benchmark") {
      throw appError(
        409,
        "benchmark_host_not_drained",
        "benchmark admission requires the caller to have no active scenario run",
      );
    }
    if (active.scenarioId === scenario.scenarioId) {
      if (params.hostId && active.hostId !== params.hostId) {
        throw appError(
          409,
          "scenario_run_host_conflict",
          "the active scenario run is assigned to a different host",
        );
      }
      return {
        accepted: true,
        runId: active.runId,
        scenarioId: active.scenarioId,
        acceptedAt: Date.now(),
        reused: true,
      };
    }
    throw activeRunConflictError(active.title);
  }

  const runId = createAppId();
  const createdAt = Date.now();
  const requiredImages = requiredImagesForScenarioLaunch(scenario.launchSpecs);
  const steadyCpuMillisByVm = scenario.launchSpecs.map(
    (spec) => spec.resources.cpuMillis,
  );
  const guestVcpuCountByVm = scenario.launchSpecs.map(
    (spec) => spec.resources.vcpuCount,
  );
  const steadyCpuMillis = steadyCpuMillisByVm.reduce(
    (total, cpuMillis) => total + cpuMillis,
    0,
  );
  if (!Number.isSafeInteger(steadyCpuMillis) || steadyCpuMillis <= 0) {
    throw appError(
      500,
      "scenario_catalog_invalid",
      "scenario CPU entitlement is invalid",
    );
  }
  const runVmStates = scenario.launchSpecs.map((spec, index) => {
    const vmId = createAppId();
    const runtimeVmName = deterministicRuntimeVmName(
      spec.runtimeVmNamePrefix,
      runId,
      index,
    );
    const vm = buildInitialVmState({
      id: vmId,
      ordinal: index,
      scenarioVmId: spec.scenarioVmId,
      scenarioVmName: spec.scenarioVmName,
      runtimeVmName,
      hostname: spec.hostname,
      launchSummary: spec.summary,
    });
    return {
      ...vm,
      provisioning: {
        ...vm.provisioning,
        image: spec.image,
        imageKey: spec.imageKey,
        imageSha256: spec.imageSha256,
        resources: spec.resources,
        leaseDurationSeconds: spec.leaseDurationSeconds,
        status: "pending",
      },
    } satisfies RunVmStateDocument;
  });
  const sshKeyDrafts = runVmStates.map((vm) =>
    generateScenarioRunSshKeyDraft({
      runId,
      vmId: vm.id,
      runtimeVmName: vm.runtimeVmName,
    }),
  );
  const sshAuthorizedKeysByVmId = new Map(
    sshKeyDrafts.map((draft) => [draft.vmId, [draft.publicKeyOpenssh]]),
  );
  const sshKeyRowsPromise = prepareScenarioRunSshKeyRows(
    sshKeyDrafts,
    createdAt,
  ).then(
    (rows) => ({ ok: true as const, rows }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const initial = buildInitialRunState({
    vms: runVmStates.map((vm) => ({
      id: vm.id,
      ordinal: vm.ordinal,
      scenarioVmId: vm.scenarioVmId,
      scenarioVmName: vm.scenarioVmName,
      runtimeVmName: vm.runtimeVmName,
      hostname: vm.hostname,
      launchSummary: vm.launchSummary,
    })),
  });
  const state = recomputeRunState({
    ...initial,
    phase: "provisioning",
    phaseTitle: "Provisioning",
    phaseDetail: "Queueing launch delivery.",
    vms: runVmStates,
  });

  const provisionedState = recomputeRunState({
    ...state,
    vms: state.vms.map(
      (vm) =>
        ({
          ...vm,
          provisioning: {
            ...vm.provisioning,
            status: "queued",
            error: null,
          },
        }) satisfies RunVmStateDocument,
    ),
  });

  let hostId: string;
  let benchmarkDesiredState: HostDesiredStateV2 | undefined;
  if (params.hostId) {
    if (params.admissionMode === "benchmark") {
      const reservation = await acquireBenchmarkBootCpuWithJitter({
        hostId: params.hostId,
        runId,
        userId: params.userId,
        steadyCpuMillisByVm,
        guestVcpuCountByVm,
        requiredImages,
        credentialNotBeforeUnixMs:
          params.benchmarkCredentialWindow!.notBeforeUnixMs,
        credentialExpiresAtUnixMs:
          params.benchmarkCredentialWindow!.expiresAtUnixMs,
      });
      if (!reservation.ok) {
        if (reservation.reason === "image_not_ready") {
          throw appError(
            409,
            "image_not_ready",
            "scenario images are not ready on this host",
          );
        }
        if (reservation.reason === "boot_capacity_pending") {
          throw bootCapacityPendingError();
        }
        if (reservation.reason === "benchmark_credential_window_invalid") {
          throw appError(
            403,
            "benchmark_credential_window_invalid",
            "benchmark credential window is not valid for this admission",
          );
        }
        if (reservation.reason === "benchmark_run_limit_reached") {
          throw appError(
            409,
            "benchmark_run_limit_reached",
            "benchmark credential has already admitted its maximum run count",
          );
        }
        if (
          reservation.reason === "benchmark_host_not_drained" ||
          reservation.reason === "host_benchmark_leased"
        ) {
          throw appError(
            409,
            "benchmark_host_not_drained",
            "benchmark host is not exclusively drained",
          );
        }
        throw appError(
          409,
          "scenario_host_unavailable",
          "host cannot provide strict CPU isolation",
        );
      }
      hostId = params.hostId;
      benchmarkDesiredState = reservation.desiredState;
    } else {
      await assertScenarioLaunchHostForUser(
        params.hostId,
        params.userId,
        requiredImages,
      );
      const reservation = await reserveScenarioBootCpuWithJitter({
        hostIds: [params.hostId],
        runId,
        steadyCpuMillisByVm,
      });
      if (!reservation.ok) {
        throw reservation.reason === "boot_capacity_pending"
          ? bootCapacityPendingError()
          : appError(
              409,
              "scenario_host_unavailable",
              "host cannot provide strict CPU isolation",
            );
      }
      hostId = reservation.hostId;
    }
  } else {
    const selection = await selectScenarioHosts(requiredImages);
    if (!selection.ok) {
      if (selection.reason === "image_not_ready") {
        throw appError(
          409,
          "image_not_ready",
          "scenario images are not ready on any available host",
        );
      }
      throw appError(
        409,
        "scenario_host_unavailable",
        "no scenario host available",
      );
    }

    const reservation = await reserveScenarioBootCpuWithJitter({
      hostIds: selection.hostIds,
      runId,
      steadyCpuMillisByVm,
    });
    if (!reservation.ok) {
      throw reservation.reason === "boot_capacity_pending"
        ? bootCapacityPendingError()
        : appError(
            409,
            "scenario_host_unavailable",
            "no scenario host can provide strict CPU isolation",
          );
    }
    hostId = reservation.hostId;
  }

  const db = drizzle(env.DB);
  try {
    const preparedSshKeys = await sshKeyRowsPromise;
    if (!preparedSshKeys.ok) {
      throw preparedSshKeys.error;
    }
    const sshKeyRows = preparedSshKeys.rows;
    if (sshKeyRows.length === 0) {
      throw new Error("scenario run has no SSH key rows");
    }
    await db.batch([
      db.insert(scenarioRuns).values({
        runId,
        userId: params.userId,
        hostId,
        scenarioId: scenario.scenarioId,
        scenarioName: scenario.scenarioId,
        title: scenario.briefing.title,
        tagline: scenario.briefing.tagline,
        briefingMarkdown: scenario.briefing.briefingMarkdown,
        objectivesJson: JSON.stringify(scenario.briefing.objectives),
        difficulty: scenario.briefing.difficulty,
        estimatedMinutes: scenario.briefing.estimatedMinutes,
        tagsJson: scenario.content.tags,
        hintsJson: scenario.content.hints,
        solutionMarkdown: scenario.content.solutionMarkdown,
        revealedHintsJson: [],
        solutionRevealedAt: null,
        solutionAssisted: false,
        vmCount: provisionedState.vms.length,
        state: provisionedState.phase,
        stateRank: RUN_PHASE_ORDER[provisionedState.phase],
        activeKey: activeKeyFor(params.userId),
        stateJson: JSON.stringify(provisionedState),
        deleteRequestedAt: null,
        completedAt: null,
        solvedAt: null,
        failedAt: null,
        hiddenAt: null,
        createdAt,
        updatedAt: createdAt,
      }),
      db.insert(scenarioRunSshKeys).values(sshKeyRows),
    ]);
    await upsertRunVmsIntoDesiredState({
      hostId,
      runId,
      vms: provisionedState.vms,
      nowUnixMs: createdAt,
      sshAuthorizedKeysByVmId,
      ...(benchmarkDesiredState
        ? { initialDesiredState: benchmarkDesiredState }
        : {}),
    });
    await commitHostCpu({ hostId, runId });
  } catch (error) {
    await Promise.allSettled([
      markRunVmsAbsentInDesiredState({
        hostId,
        runId,
        vms: provisionedState.vms,
        nowUnixMs: Date.now(),
        db,
      }),
    ]);
    await db.delete(scenarioRuns).where(eq(scenarioRuns.runId, runId));
    await Promise.allSettled([rollbackHostCpu({ hostId, runId })]);
    if (params.admissionMode === "benchmark") {
      // If desired state was already mutated, a fresh applied-empty report is
      // the only authority that may release the fail-closed benchmark lease.
      // Direct dispatch advances that recovery fence; the HostRuntime alarm is
      // the durable fallback if the agent is temporarily disconnected.
      await Promise.allSettled([tryWakeHostRuntime(hostId)]);
    }
    // Two concurrent starts race past the pre-check; the unique index on
    // active_key rejects the loser.
    if (isActiveKeyUniqueViolation(error)) {
      throw activeRunConflictError();
    }
    throw error;
  }

  return {
    accepted: true,
    runId,
    scenarioId: scenario.scenarioId,
    acceptedAt: createdAt,
    reused: false,
  };
}

async function assertScenarioLaunchHostForUser(
  hostId: string,
  userId: string,
  requiredImages: RequiredScenarioImage[],
  admissionMode?: "benchmark",
): Promise<void> {
  const now = Date.now();
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenarioEnabled: agentHosts.scenarioEnabled,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      desiredVersion: hostDesiredState.version,
      desiredState: hostDesiredState.docJson,
      appliedDesiredVersion: hostActualState.appliedDesiredVersion,
      actualReportedAt: hostActualState.updatedAt,
      actualReport: hostActualState.reportJson,
    })
    .from(agentHosts)
    .leftJoin(hostDesiredState, eq(hostDesiredState.hostId, agentHosts.id))
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(and(eq(agentHosts.id, hostId), eq(agentHosts.userId, userId)))
    .limit(1);
  const host = rows[0];
  if (!host) {
    throw appError(404, "scenario_host_not_found", "host not found");
  }
  if (host.disabled) {
    throw appError(403, "scenario_host_disabled", "host is disabled");
  }
  const benchmarkAdmission = admissionMode === "benchmark";
  if (host.role !== "agent") {
    throw appError(
      403,
      "scenario_host_not_launchable",
      "host cannot run scenarios",
    );
  }
  if (benchmarkAdmission && host.scenarioEnabled) {
    throw appError(
      409,
      "benchmark_host_not_drained",
      "benchmark admission requires scenario scheduling to be disabled on the host",
    );
  }
  if (
    !benchmarkAdmission &&
    !isScenarioLaunchHost({
      role: host.role,
      disabled: host.disabled,
      scenarioEnabled: host.scenarioEnabled,
    })
  ) {
    throw appError(
      403,
      "scenario_host_not_launchable",
      "host cannot run scenarios",
    );
  }
  if (
    !host.connected ||
    !isFreshHostHeartbeat(host.lastHeartbeatAt, now, HOST_HEARTBEAT_TTL_MS) ||
    hostHealth(host.actualReportedAt ?? null, now) !== "healthy"
  ) {
    throw appError(409, "scenario_host_unavailable", "host is not connected");
  }
  if (benchmarkAdmission && (host.actualReport?.vms.length ?? 0) !== 0) {
    throw appError(
      409,
      "benchmark_host_not_drained",
      "benchmark admission requires an empty host actual-state VM inventory",
    );
  }
  if (
    benchmarkAdmission &&
    (host.desiredVersion === null ||
      host.desiredState === null ||
      host.appliedDesiredVersion === null ||
      host.appliedDesiredVersion < host.desiredVersion ||
      host.desiredState.vms.some((vm) => vm.desired_phase === "running"))
  ) {
    throw appError(
      409,
      "benchmark_host_not_drained",
      "benchmark admission requires an empty, fully applied host desired state",
    );
  }
  if (!hostHasImagesReady(host.actualReport, requiredImages)) {
    throw appError(
      409,
      "image_not_ready",
      "scenario images are not ready on this host",
    );
  }
  if (strictCpuCapacity(host.actualReport) === null) {
    throw appError(
      409,
      "scenario_host_not_performance_ready",
      "host does not attest the required v2 template, boot-quota, and fast-filesystem launch path",
    );
  }
}

async function loadEnabledScenarioRows(scenarioId?: string) {
  const scenarios = scenarioId
    ? [await loadEnabledScenario(scenarioId)].filter(
        (scenario): scenario is ScenarioDetailRecord => Boolean(scenario),
      )
    : await listEnabledScenarios();

  return scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    enabledAt: scenario.enabledAt ?? Date.now(),
    briefing: deriveScenarioBriefing(scenario),
    content: scenarioRunContentSnapshot(scenario),
    launchSpecs: buildScenarioLaunchSpecs(scenario),
  }));
}

function scenarioRunContentSnapshot(
  scenario: ScenarioDetailRecord,
): ScenarioRunContentSnapshot {
  return {
    tags: scenario.tags,
    solutionMarkdown: scenario.solutionMarkdown,
    hints: [
      ...scenario.hints.map((hint) => ({
        key: `scenario:${hint.id}`,
        scope: "scenario" as const,
        probeName: null,
        id: hint.id,
        title: hint.title ?? null,
        bodyMarkdown: hint.body_markdown,
      })),
      ...scenario.probes.flatMap((probe) =>
        probe.hints.map((hint) => ({
          key: `probe:${probe.name}:${hint.id}`,
          scope: "probe" as const,
          probeName: probe.name,
          id: hint.id,
          title: hint.title ?? null,
          bodyMarkdown: hint.body_markdown,
        })),
      ),
    ],
  };
}

async function loadActiveRunRow(userId: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioRuns)
    .where(eq(scenarioRuns.activeKey, activeKeyFor(userId)))
    .limit(1);
  return rows[0] ? fromDbRow(rows[0]) : null;
}

async function loadFinishedRuns(userId: string, scenarioId: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      state: scenarioRuns.state,
      createdAt: scenarioRuns.createdAt,
      completedAt: scenarioRuns.completedAt,
      solvedAt: scenarioRuns.solvedAt,
      failedAt: scenarioRuns.failedAt,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      solutionAssisted: scenarioRuns.solutionAssisted,
    })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.userId, userId),
        eq(scenarioRuns.scenarioId, scenarioId),
        isNull(scenarioRuns.activeKey),
        inArray(scenarioRuns.state, ["completed", "failed"]),
      ),
    )
    .orderBy(desc(scenarioRuns.createdAt));

  const replayRunIds = await loadRunIdsWithUploadedReplayArtifacts(
    db,
    rows.map((row) => row.runId),
  );
  return rows.map((row) => ({
    runId: row.runId,
    phase: row.state as "completed" | "failed",
    outcome: toFinishedRunOutcome(
      deriveScenarioRunOutcome({
        phase: row.state as RunPhase,
        solvedAt: row.solvedAt,
        deleteRequestedAt: row.deleteRequestedAt,
        failedAt: row.failedAt,
      }),
    ),
    createdAt: row.createdAt,
    finishedAt: row.completedAt ?? row.failedAt ?? row.createdAt,
    solvedAt: row.solvedAt,
    solveDurationMs: deriveScenarioRunSolveDurationMs({
      createdAt: row.createdAt,
      solvedAt: row.solvedAt,
    }),
    solutionAssisted: row.solutionAssisted,
    hasReplay: replayRunIds.has(row.runId),
  }));
}

async function loadRunRow(runId: string, userId?: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioRuns)
    .where(
      userId
        ? and(eq(scenarioRuns.runId, runId), eq(scenarioRuns.userId, userId))
        : eq(scenarioRuns.runId, runId),
    )
    .limit(1);
  return rows[0] ? fromDbRow(rows[0]) : null;
}

async function updateRunState(
  runId: string,
  input: {
    mutate: (current: RunStateDocument) => RunStateDocument;
    deleteRequestedAt?: number | null;
  },
): Promise<void> {
  const db = drizzle(env.DB);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await loadRunRow(runId);
    if (!row) {
      return;
    }
    const current = recomputeRunState(row.state);
    const nextState = recomputeRunState(input.mutate(current));
    const terminal =
      nextState.phase === "completed" || nextState.phase === "failed";
    const now = Math.max(Date.now(), row.updatedAt + 1);
    const updated = await db
      .update(scenarioRuns)
      .set({
        state: nextState.phase,
        stateRank: RUN_PHASE_ORDER[nextState.phase],
        stateJson: JSON.stringify(nextState),
        activeKey: terminal ? null : row.activeKey,
        deleteRequestedAt:
          input.deleteRequestedAt === undefined
            ? row.deleteRequestedAt
            : input.deleteRequestedAt,
        solvedAt: nextSolvedAt({
          currentPhase: current.phase,
          nextPhase: nextState.phase,
          existingSolvedAt: row.solvedAt,
          now,
        }),
        completedAt:
          nextState.phase === "completed" ? (row.completedAt ?? now) : null,
        failedAt: nextState.phase === "failed" ? (row.failedAt ?? now) : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(scenarioRuns.runId, runId),
          eq(scenarioRuns.updatedAt, row.updatedAt),
        ),
      )
      .returning({ runId: scenarioRuns.runId });
    if (updated.length) {
      return;
    }
  }
  throw new Error(`run state CAS did not converge for ${runId}`);
}

function fromDbRow(row: typeof scenarioRuns.$inferSelect) {
  return {
    runId: row.runId,
    userId: row.userId,
    hostId: row.hostId,
    scenarioId: row.scenarioId,
    scenarioName: row.scenarioName,
    title: row.title,
    tagline: row.tagline,
    briefingMarkdown: row.briefingMarkdown,
    objectives: parseObjectives(row.objectivesJson),
    tags: row.tagsJson,
    hints: buildScenarioRunHintViews({
      hints: row.hintsJson,
      revealedHintKeys: row.revealedHintsJson,
    }),
    solution: buildScenarioRunSolutionView({
      solutionMarkdown: row.solutionMarkdown,
      solutionRevealedAt: row.solutionRevealedAt,
      solutionAssisted: row.solutionAssisted,
      state: parseRunState(row.stateJson),
      solvedAt: row.solvedAt,
    }),
    difficulty: scenarioRunDifficulty(row.runId, row.difficulty),
    estimatedMinutes: row.estimatedMinutes,
    activeKey: row.activeKey,
    deleteRequestedAt: row.deleteRequestedAt,
    solvedAt: row.solvedAt,
    completedAt: row.completedAt,
    failedAt: row.failedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    state: parseRunState(row.stateJson),
  };
}

function toScenarioRunRecord(
  row: ReturnType<typeof fromDbRow>,
): ScenarioRunRecord {
  return {
    id: row.runId,
    scenarioId: row.scenarioId,
    scenarioName: row.scenarioName,
    title: row.title,
    tagline: row.tagline,
    briefingMarkdown: row.briefingMarkdown,
    objectives: row.objectives,
    tags: row.tags,
    hints: row.hints,
    solution: row.solution,
    difficulty: row.difficulty,
    estimatedMinutes: row.estimatedMinutes,
    solvedAt: row.solvedAt,
    solveDurationMs: deriveScenarioRunSolveDurationMs({
      createdAt: row.createdAt,
      solvedAt: row.solvedAt,
    }),
    outcome: deriveScenarioRunOutcome({
      phase: row.state.phase,
      solvedAt: row.solvedAt,
      deleteRequestedAt: row.deleteRequestedAt,
      failedAt: row.failedAt,
    }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...row.state,
  };
}

function toFinishedRunOutcome(
  outcome: ScenarioRunOutcome,
): Exclude<ScenarioRunOutcome, "in_progress"> {
  return outcome === "in_progress" ? "cancelled" : outcome;
}

function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return buildInitialRunState({ vms: [] });
  }
}

// The unique index on active_key allows one active run per user across all
// scenarios; the key is the user id while a run is active, null once finished.
function activeKeyFor(userId: string) {
  return userId;
}

function activeRunConflictError(activeRunTitle?: string) {
  return appError(
    409,
    "scenario_run_active_conflict",
    activeRunTitle
      ? `you already have an active run for "${activeRunTitle}" — finish or destroy it before starting another scenario`
      : "you already have an active scenario run — finish or destroy it before starting another scenario",
  );
}

const BOOT_CAPACITY_RESERVATION_ATTEMPTS = 4;
const BOOT_CAPACITY_RETRY_MIN_MS = 15;
const BOOT_CAPACITY_RETRY_JITTER_MS = 30;

async function acquireBenchmarkBootCpuWithJitter(input: {
  hostId: string;
  runId: string;
  userId: string;
  steadyCpuMillisByVm: readonly number[];
  guestVcpuCountByVm: readonly number[];
  requiredImages: readonly RequiredScenarioImage[];
  credentialNotBeforeUnixMs: number;
  credentialExpiresAtUnixMs: number;
}): Promise<
  | { ok: true; desiredState: HostDesiredStateV2 }
  | {
      ok: false;
      reason:
        | "host_not_ready"
        | "image_not_ready"
        | "benchmark_host_not_drained"
        | "host_benchmark_leased"
        | "benchmark_credential_window_invalid"
        | "benchmark_run_limit_reached"
        | "boot_capacity_pending"
        | "conflict";
    }
> {
  for (
    let attempt = 0;
    attempt < BOOT_CAPACITY_RESERVATION_ATTEMPTS;
    attempt += 1
  ) {
    const result = await acquireBenchmarkHostLeaseAndReserveCpu(input);
    if (result.ok) return { ok: true, desiredState: result.desiredState };
    if (
      result.reason !== "boot_capacity_pending" ||
      attempt === BOOT_CAPACITY_RESERVATION_ATTEMPTS - 1
    ) {
      return { ok: false, reason: result.reason };
    }
    await bootCapacityRetryJitter();
  }
  return { ok: false, reason: "boot_capacity_pending" };
}

async function reserveScenarioBootCpuWithJitter(input: {
  hostIds: readonly string[];
  runId: string;
  steadyCpuMillisByVm: readonly number[];
}): Promise<
  | { ok: true; hostId: string }
  | { ok: false; reason: "boot_capacity_pending" | "host_unavailable" }
> {
  let sawBootCapacityPending = false;
  for (
    let attempt = 0;
    attempt < BOOT_CAPACITY_RESERVATION_ATTEMPTS;
    attempt += 1
  ) {
    for (const hostId of input.hostIds) {
      const reservation = await reserveHostCpu({
        hostId,
        runId: input.runId,
        steadyCpuMillisByVm: input.steadyCpuMillisByVm,
      });
      if (reservation.ok) {
        return { ok: true, hostId };
      }
      if (reservation.reason === "boot_capacity_pending") {
        sawBootCapacityPending = true;
        continue;
      }
      if (reservation.reason === "conflict") {
        throw new Error(`CPU reservation conflict for run ${input.runId}`);
      }
    }
    if (
      !sawBootCapacityPending ||
      attempt === BOOT_CAPACITY_RESERVATION_ATTEMPTS - 1
    ) {
      break;
    }
    await bootCapacityRetryJitter();
  }
  return {
    ok: false,
    reason: sawBootCapacityPending
      ? "boot_capacity_pending"
      : "host_unavailable",
  };
}

async function bootCapacityRetryJitter(): Promise<void> {
  await new Promise<void>((resolve) => {
    const jitterMs =
      BOOT_CAPACITY_RETRY_MIN_MS +
      Math.floor(Math.random() * (BOOT_CAPACITY_RETRY_JITTER_MS + 1));
    setTimeout(resolve, jitterMs);
  });
}

function bootCapacityPendingError() {
  return appError(
    409,
    "boot_capacity_pending",
    "scenario boot CPU capacity is pending; retry shortly",
  );
}

function isActiveKeyUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed.*active_key|scenario_runs_active_key_uidx/.test(
      error.message,
    )
  );
}

function deterministicRuntimeVmName(
  prefix: string,
  runId: string,
  index: number,
) {
  return `${prefix}-${runId.slice(0, 6)}-${index + 1}`.slice(0, 63);
}

async function upsertRunVmsIntoDesiredState(input: {
  hostId: string;
  runId: string;
  vms: RunVmStateDocument[];
  nowUnixMs: number;
  sshAuthorizedKeysByVmId: Map<string, string[]>;
  initialDesiredState?: HostDesiredStateV2;
}): Promise<void> {
  const desiredVms = input.vms.map((vm) => {
    const desiredVm = desiredVmFromRunVm({
      runId: input.runId,
      vm,
      nowUnixMs: input.nowUnixMs,
      sshAuthorizedKeysOpenssh: input.sshAuthorizedKeysByVmId.get(vm.id) ?? [],
    });
    if (!desiredVm) {
      throw appError(
        500,
        "scenario_vm_desired_state_invalid",
        `missing desired-state image metadata for ${vm.runtimeVmName}`,
      );
    }
    return desiredVm;
  });

  await mutateStoredHostDesiredState(
    drizzle(env.DB),
    input.hostId,
    input.nowUnixMs,
    (draft) => {
      for (const desiredVm of desiredVms) {
        upsertDesiredCachedImage(draft, {
          image_key: desiredVm.image_key,
          image_sha256: desiredVm.image_sha256,
        });
        upsertDesiredVm(draft, desiredVm);
      }
    },
    input.initialDesiredState,
  );
}

async function markRunVmsAbsentInDesiredState(input: {
  hostId: string;
  runId: string;
  vms: RunVmStateDocument[];
  nowUnixMs: number;
  db?: DrizzleD1Database;
}): Promise<void> {
  if (!input.vms.length) {
    return;
  }

  await mutateStoredHostDesiredState(
    input.db ?? drizzle(env.DB),
    input.hostId,
    input.nowUnixMs,
    (draft) => {
      for (const vm of input.vms) {
        markDesiredVmAbsent(draft, {
          runId: input.runId,
          vmName: vm.runtimeVmName,
        });
      }
    },
  );
}

function requiredImagesForScenarioLaunch(
  launchSpecs: Array<{
    imageKey: RequiredScenarioImage["imageKey"] | null;
    imageSha256: string | null;
  }>,
): RequiredScenarioImage[] {
  const byIdentity = new Map<string, RequiredScenarioImage>();
  for (const spec of launchSpecs) {
    const imageSha256 = spec.imageSha256?.trim() ?? "";
    if (!spec.imageKey || !imageSha256) {
      throw appError(
        409,
        "image_not_ready",
        "scenario image metadata is not ready",
      );
    }
    byIdentity.set(imageKeyIdentity(spec.imageKey), {
      imageKey: spec.imageKey,
      imageSha256,
    });
  }
  return [...byIdentity.values()];
}

function buildRunVmRouteUsername(
  runId: string,
  vms: RunVmStateDocument[],
  vmId: string,
  routeType: ScenarioRouteType,
): string {
  const counts = new Map<string, number>();
  const aliases = new Map<string, string>();
  const runPrefix = slugifyVmAlias(runId) || runId.toLowerCase();
  const suffix = routeSuffixForType(routeType);

  for (const vm of [...vms].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    const baseSlug =
      slugifyVmAlias(vm.scenarioVmName) || `vm-${vm.ordinal + 1}`;
    const count = (counts.get(baseSlug) ?? 0) + 1;
    counts.set(baseSlug, count);
    const ordinalSuffix = count > 1 ? `-${count}` : "";
    aliases.set(
      vm.id,
      `${runPrefix}-${baseSlug}${ordinalSuffix}-${suffix}`.slice(0, 128),
    );
  }

  return aliases.get(vmId) ?? `${runPrefix}-vm-${suffix}`.slice(0, 128);
}

function slugifyVmAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function routeSuffixForType(routeType: ScenarioRouteType): string {
  switch (routeType) {
    case "browser":
      return "web";
    case "native_profile_keys":
      return "ssh-profile";
  }
}

async function revokeScenarioRunRoutes(row: {
  runId: string;
  state: RunStateDocument;
}): Promise<void> {
  const routeUsernames = new Set(
    row.state.vms.flatMap((vm) => [
      buildRunVmRouteUsername(row.runId, row.state.vms, vm.id, "browser"),
      buildRunVmRouteUsername(
        row.runId,
        row.state.vms,
        vm.id,
        "native_profile_keys",
      ),
    ]),
  );
  await revokeAllRoutes(routeUsernames, deleteStargateRoute);
}

export async function revokeScenarioNativeProfileRoutesForUser(
  userId: string,
): Promise<void> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      stateJson: scenarioRuns.stateJson,
    })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.userId, userId),
        isNull(scenarioRuns.hiddenAt),
        isNull(scenarioRuns.completedAt),
        isNull(scenarioRuns.failedAt),
      ),
    );

  const routeUsernames = new Set<string>();
  for (const row of rows) {
    const state = parseRunState(row.stateJson);
    for (const vm of state.vms) {
      routeUsernames.add(
        buildRunVmRouteUsername(
          row.runId,
          state.vms,
          vm.id,
          "native_profile_keys",
        ),
      );
    }
  }

  await revokeAllRoutes(routeUsernames, deleteStargateRoute);
}

async function selectScenarioHosts(
  requiredImages: RequiredScenarioImage[],
): Promise<HostSelectionResult> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const rows = await db
    .select({
      id: agentHosts.id,
      updatedAt: agentHosts.updatedAt,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      lastInventoryAt: agentHosts.lastInventoryAt,
      actualReportedAt: hostActualState.updatedAt,
      actualReport: hostActualState.reportJson,
    })
    .from(agentHosts)
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.disabled, false),
        eq(agentHosts.role, "agent"),
        eq(agentHosts.scenarioEnabled, true),
        eq(agentHosts.connected, true),
      ),
    )
    .orderBy(desc(agentHosts.updatedAt));

  const candidates = rows
    .map((row) => {
      // The bridge v6 state report is the live source of per-host VM load
      // and capacity; the legacy inventory upload no longer exists.
      const capacity = row.actualReport?.capacity ?? null;
      const inventoryVmCount = row.actualReport?.vms?.length ?? 0;
      const cpuCores = Math.max(1, (capacity?.total_cpu_millis ?? 0) / 1000);
      const loadPerCpu =
        typeof capacity?.load_avg_1m === "number" && capacity.load_avg_1m >= 0
          ? capacity.load_avg_1m / cpuCores
          : Number.POSITIVE_INFINITY;
      return {
        ...row,
        inventoryVmCount,
        loadPerCpu,
        memoryAvailableMib: capacity?.memory_available_mib ?? -1,
        reportedFreeCpuMillis: Math.max(
          0,
          (capacity?.schedulable_cpu_millis ?? 0) -
            (capacity?.committed_cpu_millis ?? 0),
        ),
      };
    })
    .filter(
      (row) =>
        isAvailableScenarioLaunchHost(
          {
            role: "agent",
            disabled: false,
            scenarioEnabled: true,
            connected: row.connected,
            lastHeartbeatAt: row.lastHeartbeatAt,
          },
          now,
          HOST_HEARTBEAT_TTL_MS,
        ) &&
        hostHealth(row.actualReportedAt ?? null, now) === "healthy" &&
        strictCpuCapacity(row.actualReport) !== null,
    );

  if (!candidates.length) {
    return { ok: false, reason: "unavailable" };
  }

  const imageReadyCandidates = candidates.filter((candidate) =>
    hostHasImagesReady(candidate.actualReport, requiredImages),
  );

  if (!imageReadyCandidates.length) {
    return { ok: false, reason: "image_not_ready" };
  }

  const activeRuns = await db
    .select({
      hostId: scenarioRuns.hostId,
    })
    .from(scenarioRuns)
    .where(
      and(
        inArray(
          scenarioRuns.hostId,
          imageReadyCandidates.map((candidate) => candidate.id),
        ),
        isNull(scenarioRuns.completedAt),
        isNull(scenarioRuns.failedAt),
      ),
    );

  const activeRunCounts = new Map<string, number>();
  for (const row of activeRuns) {
    activeRunCounts.set(row.hostId, (activeRunCounts.get(row.hostId) ?? 0) + 1);
  }

  imageReadyCandidates.sort((left, right) => {
    const leftRuns = activeRunCounts.get(left.id) ?? 0;
    const rightRuns = activeRunCounts.get(right.id) ?? 0;
    if (leftRuns !== rightRuns) {
      return leftRuns - rightRuns;
    }
    if (left.reportedFreeCpuMillis !== right.reportedFreeCpuMillis) {
      return right.reportedFreeCpuMillis - left.reportedFreeCpuMillis;
    }
    if (left.inventoryVmCount !== right.inventoryVmCount) {
      return left.inventoryVmCount - right.inventoryVmCount;
    }
    if (left.loadPerCpu !== right.loadPerCpu) {
      return left.loadPerCpu - right.loadPerCpu;
    }
    if (left.memoryAvailableMib !== right.memoryAvailableMib) {
      return right.memoryAvailableMib - left.memoryAvailableMib;
    }
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.id.localeCompare(right.id);
  });

  const hostIds = imageReadyCandidates.map((candidate) => candidate.id);
  return hostIds.length
    ? { ok: true, hostIds }
    : { ok: false, reason: "unavailable" };
}

function parseObjectives(raw: string): ScenarioObjective[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        typeof item.probeName !== "string" ||
        typeof item.vmName !== "string" ||
        typeof item.label !== "string"
      ) {
        return [];
      }
      return [
        {
          probeName: item.probeName,
          vmName: item.vmName,
          label: item.label,
          title: typeof item.title === "string" ? item.title : null,
          bodyMarkdown:
            typeof item.bodyMarkdown === "string" ? item.bodyMarkdown : null,
          hintCount:
            typeof item.hintCount === "number" &&
            Number.isFinite(item.hintCount)
              ? Math.max(0, Math.floor(item.hintCount))
              : 0,
        } satisfies ScenarioObjective,
      ];
    });
  } catch {
    return [];
  }
}

function scenarioRunDifficulty(
  runId: string,
  value: string,
): ScenarioDifficulty {
  const parsed = parseScenarioDifficulty(value);
  if (parsed) {
    return parsed;
  }
  throw appError(
    500,
    "scenario_run_invalid",
    `scenario run ${runId} has invalid difficulty`,
  );
}

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "scenario"
  );
}

async function hydrateScenarioRunReplayArtifacts(
  run: ScenarioRunRecord,
): Promise<ScenarioRunRecord> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: scenarioRunArtifacts.id,
      runId: scenarioRunArtifacts.runId,
      vmId: scenarioRunArtifacts.vmId,
      kind: scenarioRunArtifacts.kind,
      filename: scenarioRunArtifacts.filename,
      contentType: scenarioRunArtifacts.contentType,
      sizeBytes: scenarioRunArtifacts.sizeBytes,
    })
    .from(scenarioRunArtifacts)
    .where(
      and(
        eq(scenarioRunArtifacts.runId, run.id),
        eq(scenarioRunArtifacts.uploadStatus, "uploaded"),
        eq(scenarioRunArtifacts.kind, "ssh_recording_segment"),
      ),
    )
    .orderBy(asc(scenarioRunArtifacts.vmId), asc(scenarioRunArtifacts.ordinal));

  const artifactsByVm = new Map<string, ScenarioReplayArtifact[]>();
  for (const row of rows) {
    const artifact: ScenarioReplayArtifact = {
      id: row.id,
      hostId: "",
      runId: row.runId,
      vmId: row.vmId,
      kind: row.kind,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
    };
    const artifacts = artifactsByVm.get(row.vmId) ?? [];
    artifacts.push(artifact);
    artifactsByVm.set(row.vmId, artifacts);
  }
  const vms = run.vms.map((vm) => ({
    ...vm,
    replayArtifacts: artifactsByVm.get(vm.id) ?? [],
  }));
  return {
    ...run,
    vms,
    replayArtifacts: vms.flatMap((vm) => vm.replayArtifacts),
  };
}

async function loadRunIdsWithUploadedReplayArtifacts(
  db: DrizzleD1Database,
  runIds: string[],
): Promise<Set<string>> {
  const replayRunIds = new Set<string>();
  // D1 permits at most 100 bound parameters. The two constant filters below
  // leave room for 98 run IDs per query.
  for (let index = 0; index < runIds.length; index += 98) {
    const batch = runIds.slice(index, index + 98);
    const rows = await db
      .selectDistinct({ runId: scenarioRunArtifacts.runId })
      .from(scenarioRunArtifacts)
      .where(
        and(
          inArray(scenarioRunArtifacts.runId, batch),
          eq(scenarioRunArtifacts.uploadStatus, "uploaded"),
          eq(scenarioRunArtifacts.kind, "ssh_recording_segment"),
        ),
      );
    for (const row of rows) replayRunIds.add(row.runId);
  }
  return replayRunIds;
}

async function loadHostTerminalAddress(hostId: string): Promise<string | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      report: hostActualState.reportJson,
    })
    .from(hostActualState)
    .where(eq(hostActualState.hostId, hostId))
    .limit(1);
  const capacity = rows[0]?.report?.capacity;
  return (
    capacity?.primary_ipv4?.trim() || capacity?.primary_ipv6?.trim() || null
  );
}
