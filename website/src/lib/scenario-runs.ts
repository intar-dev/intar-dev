import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import {
  agentHosts,
  hostActualState,
  scenarioRunArtifacts,
  scenarioRuns,
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
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { createAppId } from "@/lib/id";
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
  type RunPhase,
  type RunStateDocument,
  type RunVmStateDocument,
} from "@/lib/run-state";
import {
  buildScenarioRunHintViews,
  buildScenarioRunSolutionView,
  nextScenarioRunHintKey,
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
import { isAvailableScenarioLaunchHost } from "@/lib/scenario-hosts";
import {
  deleteStargateRoute,
  issueStargateTerminalSession,
  stargateRouteTtlMs,
  type BrowserTerminalSessionResult,
  type NativeTerminalSessionResult,
} from "@/lib/stargate";
import {
  generateScenarioRunSshKeyDraft,
  insertScenarioRunSshKeyDrafts,
  loadScenarioRunSshKey,
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
  nextHintKey: string | null;
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
  | { ok: true; hostId: string }
  | { ok: false; reason: "unavailable" | "image_not_ready" };

type ScenarioRouteType =
  | "browser"
  | "native_profile_keys";

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

  const active = await loadActiveRunRow(params.userId, enabled.scenarioId);
  const finishedRuns = await loadFinishedRuns(params.userId, enabled.scenarioId);
  return {
    scenarioId: enabled.scenarioId,
    slug: slugify(enabled.scenarioId),
    enabledAt: enabled.enabledAt,
    scenarioName: enabled.scenarioId,
    briefing: enabled.briefing,
    vmCount: enabled.launchSpecs.length,
    hasActiveRun: active !== null,
    activeRunId: active?.runId ?? null,
    activeRun: active
      ? {
          runId: active.runId,
          phase: active.state.phase,
          phaseTitle: active.state.phaseTitle,
          phaseDetail: active.state.phaseDetail,
          canOpenTerminal: active.state.canOpenTerminal,
          terminalPhase: active.state.terminalPhase,
          updatedAt: active.updatedAt,
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
  return toScenarioRunRecord(row);
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
      stateJson: scenarioRuns.stateJson,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.userId, params.userId))
    .orderBy(desc(scenarioRuns.createdAt))
    .limit(100);

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
    hasReplay: hasReplayArtifacts(row.stateJson),
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
    progress: progressByScenario.get(scenario.scenarioId) ?? newScenarioProgress(),
  }));
}

export async function startScenarioRunForUser(params: {
  scenarioId: string;
  userId: string;
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
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }

  const acceptedAt = Date.now();
  if (!["completed", "failed"].includes(row.state.phase)) {
    const destroyableVmIds = new Set(
      row.state.vms
        .filter((vm) => !["destroying", "archived", "completed", "failed"].includes(vm.phase))
        .map((vm) => vm.id),
    );
    const next = recomputeRunState({
      ...row.state,
      phase: "teardown_requested",
      phaseTitle: "Teardown requested",
      phaseDetail: "Waiting for the host to acknowledge teardown.",
      vms: row.state.vms.map((vm) =>
        destroyableVmIds.has(vm.id)
          ? {
              ...vm,
              phaseDetail: "Teardown requested. Waiting for host delivery.",
            }
          : vm,
      ),
    });
    await updateRunState(row.runId, {
      state: next,
      activeKey: row.activeKey,
      deleteRequestedAt: acceptedAt,
      solvedAt: row.solvedAt,
      currentPhase: row.state.phase,
    });

    const destroyableVms = row.state.vms.filter((vm) =>
      destroyableVmIds.has(vm.id),
    );
    if (destroyableVms.length) {
      await markRunVmsAbsentInDesiredState({
        hostId: row.hostId,
        runId: row.runId,
        vms: destroyableVms,
        nowUnixMs: acceptedAt,
      });
    }
  }

  await revokeScenarioRunRoutes(row).catch(() => undefined);
  await tryWakeHostRuntime(row.hostId);

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
  await revokeScenarioRunRoutes(row).catch(() => undefined);
  await db.delete(scenarioRunArtifacts).where(eq(scenarioRunArtifacts.runId, row.runId));
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
  const desiredState = await loadOrCreateHostDesiredState(db, hostId, nowUnixMs);
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
      const next = recomputeRunState({
        ...row.state,
        phase: "failed",
        phaseDetail: "The run lease expired before teardown completed.",
        vms: row.state.vms.map((vm) =>
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
      });

      await updateRunState(row.runId, {
        state: next,
        activeKey: row.activeKey,
        deleteRequestedAt: row.deleteRequestedAt,
        solvedAt: row.solvedAt,
        currentPhase: row.state.phase,
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
  if (row.completedAt !== null || row.failedAt !== null) {
    throw appError(
      409,
      "scenario_terminal_closed",
      "terminal sessions are closed for finished runs",
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
    requestedMode === "browser"
      ? "browser"
      : "native_profile_keys";
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
}): Promise<{
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}> {
  const [scenario] = await loadEnabledScenarioRows(params.scenarioId);
  if (!scenario) {
    throw appError(404, "scenario_not_found", "scenario not found");
  }

  const active = await loadActiveRunRow(params.userId, scenario.scenarioId);
  if (active) {
    return {
      accepted: true,
      runId: active.runId,
      scenarioId: active.scenarioId,
      acceptedAt: Date.now(),
      reused: true,
    };
  }

  const requiredImages = requiredImagesForScenarioLaunch(scenario.launchSpecs);
  const selection = await selectScenarioHost(requiredImages);
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
  const hostId = selection.hostId;

  const runId = createAppId();
  const createdAt = Date.now();
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
    sshKeyDrafts.map((draft) => [
      draft.vmId,
      [draft.publicKeyOpenssh],
    ]),
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

  const db = drizzle(env.DB);
  try {
    await db.insert(scenarioRuns).values({
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
      activeKey: activeKeyFor(params.userId, scenario.scenarioId),
      stateJson: JSON.stringify(provisionedState),
      deleteRequestedAt: null,
      completedAt: null,
      solvedAt: null,
      failedAt: null,
      hiddenAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    await insertScenarioRunSshKeyDrafts(sshKeyDrafts, createdAt);
    await upsertRunVmsIntoDesiredState({
      hostId,
      runId,
      vms: provisionedState.vms,
      nowUnixMs: createdAt,
      sshAuthorizedKeysByVmId,
    });
  } catch (error) {
    await Promise.allSettled([
      db.delete(scenarioRuns).where(eq(scenarioRuns.runId, runId)),
    ]);
    throw error;
  }

  await tryWakeHostRuntime(hostId);

  return {
    accepted: true,
    runId,
    scenarioId: scenario.scenarioId,
    acceptedAt: createdAt,
    reused: false,
  };
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

async function loadActiveRunRow(userId: string, scenarioId: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioRuns)
    .where(eq(scenarioRuns.activeKey, activeKeyFor(userId, scenarioId)))
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
      stateJson: scenarioRuns.stateJson,
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
    hasReplay: hasReplayArtifacts(row.stateJson),
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
    state: RunStateDocument;
    activeKey: string | null;
    deleteRequestedAt?: number | null;
    solvedAt?: number | null;
    currentPhase?: RunPhase;
  },
): Promise<void> {
  const db = drizzle(env.DB);
  const nextState = recomputeRunState(input.state);
  const terminal = nextState.phase === "completed" || nextState.phase === "failed";
  const now = Date.now();
  await db
    .update(scenarioRuns)
    .set({
      state: nextState.phase,
      stateRank: RUN_PHASE_ORDER[nextState.phase],
      stateJson: JSON.stringify(nextState),
      activeKey: terminal ? null : input.activeKey,
      deleteRequestedAt: input.deleteRequestedAt ?? null,
      solvedAt: nextSolvedAt({
        currentPhase: input.currentPhase ?? nextState.phase,
        nextPhase: nextState.phase,
        existingSolvedAt: input.solvedAt ?? null,
        now,
      }),
      completedAt: nextState.phase === "completed" ? now : null,
      failedAt: nextState.phase === "failed" ? now : null,
      updatedAt: now,
    })
    .where(eq(scenarioRuns.runId, runId));
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
    nextHintKey: nextScenarioRunHintKey(row.hintsJson, row.revealedHintsJson),
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

function toScenarioRunRecord(row: ReturnType<typeof fromDbRow>): ScenarioRunRecord {
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
    nextHintKey: row.nextHintKey,
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

function activeKeyFor(userId: string, scenarioId: string) {
  return `${userId}:${scenarioId}`;
}

function deterministicRuntimeVmName(prefix: string, runId: string, index: number) {
  return `${prefix}-${runId.slice(0, 6)}-${index + 1}`.slice(0, 63);
}

async function upsertRunVmsIntoDesiredState(input: {
  hostId: string;
  runId: string;
  vms: RunVmStateDocument[];
  nowUnixMs: number;
  sshAuthorizedKeysByVmId: Map<string, string[]>;
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
  launchSpecs: Array<{ imageKey: RequiredScenarioImage["imageKey"] | null; imageSha256: string | null }>,
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

  for (const vm of [...vms].sort((left, right) => left.ordinal - right.ordinal)) {
    const baseSlug = slugifyVmAlias(vm.scenarioVmName) || `vm-${vm.ordinal + 1}`;
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
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96)
  );
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
  await Promise.allSettled(
    [...routeUsernames].map((routeUsername) =>
      deleteStargateRoute(routeUsername).catch(() => undefined),
    ),
  );
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

  await Promise.allSettled(
    [...routeUsernames].map((routeUsername) => deleteStargateRoute(routeUsername)),
  );
}

async function selectScenarioHost(
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
      // The bridge v5 state report is the live source of per-host VM load
      // and capacity; the legacy inventory upload no longer exists.
      const capacity = row.actualReport?.capacity ?? null;
      const inventoryVmCount = row.actualReport?.vms?.length ?? 0;
      const cpuCores = Math.max(1, capacity?.cpu_count ?? 0);
      const loadPerCpu =
        typeof capacity?.load_avg_1m === "number" && capacity.load_avg_1m >= 0
          ? capacity.load_avg_1m / cpuCores
          : Number.POSITIVE_INFINITY;
      return {
        ...row,
        inventoryVmCount,
        loadPerCpu,
        memoryAvailableMib: capacity?.memory_available_mib ?? -1,
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
        ) && hostHealth(row.actualReportedAt ?? null, now) === "healthy",
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

  const hostId = imageReadyCandidates[0]?.id;
  return hostId ? { ok: true, hostId } : { ok: false, reason: "unavailable" };
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
      return [{
        probeName: item.probeName,
        vmName: item.vmName,
        label: item.label,
        title: typeof item.title === "string" ? item.title : null,
        bodyMarkdown:
          typeof item.bodyMarkdown === "string" ? item.bodyMarkdown : null,
        hintCount:
          typeof item.hintCount === "number" && Number.isFinite(item.hintCount)
            ? Math.max(0, Math.floor(item.hintCount))
            : 0,
      } satisfies ScenarioObjective];
    });
  } catch {
    return [];
  }
}

function scenarioRunDifficulty(runId: string, value: string): ScenarioDifficulty {
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

function hasReplayArtifacts(rawStateJson: string): boolean {
  try {
    const parsed = JSON.parse(rawStateJson) as RunStateDocument;
    return Array.isArray(parsed.replayArtifacts) && parsed.replayArtifacts.length > 0;
  } catch {
    return false;
  }
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
