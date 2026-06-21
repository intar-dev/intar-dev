import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import {
  scenarioRunArtifacts,
  scenarioRuns,
  agentHosts,
  hostRpcCalls,
} from "@/db/schema";
import { parseHostInfo, parseInventory } from "@/lib/agent-bridge";
import { createServerRpcCalls, tryWakeHostRuntime } from "@/lib/host-rpc";
import { createAppId } from "@/lib/id";
import {
  buildScenarioLaunchSpecs,
  deriveScenarioBriefing,
  type ScenarioBriefing,
  type ScenarioDifficulty,
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
  deleteStargateRoute,
  issueStargateTerminalSession,
  stargateRouteTtlMs,
  type BrowserTerminalSessionResult,
  type NativeTerminalSessionResult,
} from "@/lib/stargate";
import { listUserAuthorizedSshKeysForNativeRoutes } from "@/lib/user-ssh-keys";

export interface ScenarioCatalogEntry {
  scenarioId: string;
  slug: string;
  title: string;
  tagline: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  scenarioName: string;
  enabledAt: number;
  vmCount: number;
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
  objectives: string[];
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  solvedAt: number | null;
  solveDurationMs: number | null;
  outcome: ScenarioRunOutcome;
  createdAt: number;
  updatedAt: number;
}

const HOST_HEARTBEAT_TTL_MS = 90_000;

interface ProvisionedVmLaunch {
  vmId: string;
  launchRequest: Record<string, unknown>;
}

type ScenarioRouteType =
  | "browser"
  | "native_profile_keys"
  | "native_issued_key";

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

export async function startScenarioRunForUserOnHost(params: {
  scenarioId: string;
  userId: string;
  hostId: string;
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

    const destroyCalls = row.state.vms
      .filter((vm) => destroyableVmIds.has(vm.id))
      .map((vm) => ({
        hostId: row.hostId,
        userId: row.userId,
        runId: row.runId,
        vmId: vm.id,
        method: "vm.destroy" as const,
        request: {
          run_id: row.runId,
          name: vm.runtimeVmName,
        },
        idempotencyKey: `${row.runId}:${vm.id}:destroy`,
      }));
    if (destroyCalls.length) {
      await createServerRpcCalls(destroyCalls);
    }
  }

  await revokeScenarioRunRoutes(row).catch(() => undefined);

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
  if (!host || !port) {
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
  const routeType =
    requestedMode === "browser"
      ? "browser"
      : profileKeys.length > 0
        ? "native_profile_keys"
        : "native_issued_key";
  const routeUsername = buildRunVmRouteUsername(
    row.runId,
    row.state.vms,
    vm.id,
    routeType,
  );
  return issueStargateTerminalSession({
    routeUsername,
    targetUsername,
    targetHost: host,
    targetPort: port,
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

  const hostId = params.hostId ?? (await selectScenarioHost());
  if (!hostId) {
    throw appError(409, "scenario_host_unavailable", "no scenario host available");
  }

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
        resources: spec.resources,
        leaseDurationSeconds: spec.leaseDurationSeconds,
        status: "pending",
      },
    } satisfies RunVmStateDocument;
  });

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

  const provisionedLaunches = await provisionRunLaunches({
    runId,
    vms: state.vms,
  });
  const provisionedByVmId = new Map(
    provisionedLaunches.map((launch) => [launch.vmId, launch]),
  );
  const provisionedState = recomputeRunState({
    ...state,
    vms: state.vms.map((vm) => {
      const launch = provisionedByVmId.get(vm.id);
      if (!launch) {
        return vm;
      }

      return {
        ...vm,
        provisioning: {
          ...vm.provisioning,
          status: "queued",
          error: null,
        },
      } satisfies RunVmStateDocument;
    }),
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

    await createServerRpcCalls(
      provisionedLaunches.map((launch) => ({
        hostId,
        userId: params.userId,
        runId,
        vmId: launch.vmId,
        method: "vm.launch" as const,
        request: launch.launchRequest,
        idempotencyKey: `${runId}:${launch.vmId}:launch`,
      })),
    );
  } catch (error) {
    await Promise.allSettled([
      db.delete(scenarioRuns).where(eq(scenarioRuns.runId, runId)),
      db.delete(hostRpcCalls).where(eq(hostRpcCalls.runId, runId)),
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
    launchSpecs: buildScenarioLaunchSpecs(scenario),
  }));
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
    objectives: safeStringArray(row.objectivesJson),
    difficulty: normalizeDifficulty(row.difficulty),
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

async function provisionRunLaunches(input: {
  runId: string;
  vms: RunVmStateDocument[];
}): Promise<ProvisionedVmLaunch[]> {
  const provisioned: ProvisionedVmLaunch[] = [];

  for (const vm of input.vms) {
    const launchRequest = buildVmLaunchRequest(input.runId, vm);
    if (!launchRequest) {
      throw appError(
        500,
        "scenario_vm_launch_invalid",
        `missing launch data for ${vm.runtimeVmName}`,
      );
    }

    provisioned.push({
      vmId: vm.id,
      launchRequest,
    });
  }

  return provisioned;
}

function buildVmLaunchRequest(
  runId: string,
  vm: RunVmStateDocument,
): Record<string, unknown> | null {
  const image = vm.provisioning.image?.trim() ?? "";
  const resources = vm.provisioning.resources;
  const leaseDurationSeconds = vm.provisioning.leaseDurationSeconds;
  if (!image || !resources || typeof leaseDurationSeconds !== "number") {
    return null;
  }

  return {
    name: vm.runtimeVmName,
    run_id: runId,
    image,
    resources: {
      vcpus: resources.vcpus,
      memory_mib: resources.memoryMib,
      disk_mib: resources.diskMib,
    },
    hostname: vm.hostname,
    lease_duration_seconds: leaseDurationSeconds,
    runtime: {
      stargate_target_public_key_openssh: requiredStargateTargetPublicKey(),
    },
  };
}

function requiredStargateTargetPublicKey(): string {
  const trimmed = env.STARGATE_TARGET_PUBLIC_KEY_OPENSSH?.trim();
  if (!trimmed) {
    throw new Error("STARGATE_TARGET_PUBLIC_KEY_OPENSSH is required");
  }
  return trimmed;
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
    case "native_issued_key":
      return "ssh-issued";
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
      buildRunVmRouteUsername(
        row.runId,
        row.state.vms,
        vm.id,
        "native_issued_key",
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

async function selectScenarioHost(): Promise<string | null> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const rows = await db
    .select({
      id: agentHosts.id,
      updatedAt: agentHosts.updatedAt,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      lastInventoryAt: agentHosts.lastInventoryAt,
      hostInfoJson: agentHosts.hostInfoJson,
      inventoryJson: agentHosts.inventoryJson,
    })
    .from(agentHosts)
    .where(
      and(
        eq(agentHosts.disabled, false),
        eq(agentHosts.scenarioEnabled, true),
        eq(agentHosts.connected, true),
      ),
    )
    .orderBy(desc(agentHosts.updatedAt));

  const candidates = rows
    .map((row) => {
      const hostInfo = parseHostInfo(row.hostInfoJson);
      const inventory = parseInventory(row.inventoryJson);
      const inventoryVmCount = Array.isArray(inventory?.vms) ? inventory.vms.length : 0;
      const cpuCores = Math.max(1, hostInfo?.cpuCores ?? 0);
      const loadPerCpu =
        typeof hostInfo?.loadAvg1m === "number" && hostInfo.loadAvg1m >= 0
          ? hostInfo.loadAvg1m / cpuCores
          : Number.POSITIVE_INFINITY;
      return {
        ...row,
        inventoryVmCount,
        loadPerCpu,
        memoryAvailableMib: hostInfo?.memoryAvailableMib ?? -1,
      };
    })
    .filter(
      (row) =>
        row.connected &&
        isFreshTimestamp(row.lastHeartbeatAt, now, HOST_HEARTBEAT_TTL_MS),
    );

  if (!candidates.length) {
    return null;
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
          candidates.map((candidate) => candidate.id),
        ),
        isNull(scenarioRuns.completedAt),
        isNull(scenarioRuns.failedAt),
      ),
    );

  const activeRunCounts = new Map<string, number>();
  for (const row of activeRuns) {
    activeRunCounts.set(row.hostId, (activeRunCounts.get(row.hostId) ?? 0) + 1);
  }

  candidates.sort((left, right) => {
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

  return candidates[0]?.id ?? null;
}

function safeStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeDifficulty(value: string): ScenarioDifficulty {
  return value === "hard" || value === "medium" ? value : "easy";
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

function isFreshTimestamp(
  value: number | null,
  now: number,
  maxAgeMs: number,
): boolean {
  return typeof value === "number" && now - value <= maxAgeMs;
}

async function loadHostTerminalAddress(hostId: string): Promise<string | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      hostInfoJson: agentHosts.hostInfoJson,
    })
    .from(agentHosts)
    .where(eq(agentHosts.id, hostId))
    .limit(1);
  const hostInfo = parseHostInfo(rows[0]?.hostInfoJson ?? null);
  return hostInfo?.primaryIpv4?.trim() || hostInfo?.primaryIpv6?.trim() || null;
}
