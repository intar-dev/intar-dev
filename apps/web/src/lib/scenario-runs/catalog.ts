import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import {
  member,
  scenarioCourseCatalogs,
  scenarioRuns,
  vmScenarios,
} from "@/db/schema";
import {
  listVisibleScenarioCourses,
  scenarioCourseCatalogScopeKey,
} from "@/lib/scenario-course-catalogs";
import { RUN_PHASE_ORDER, type RunPhase } from "@/lib/run-state";
import {
  deriveScenarioRunOutcome,
  deriveScenarioRunSolveDurationMs,
} from "@/lib/scenario-run-outcome";
import {
  type ScenarioCatalogEntry,
  type ScenarioDetail,
  type ScenarioRunRecord,
  type ScenarioRunListEntry,
  type ScenarioProgress,
  type ScenarioCatalogWireResponse,
  type ScenarioCatalogWireEntry,
  type ScenarioCatalogCourseWireEntry,
  type CourseLocation,
} from "./types";
import {
  loadEnabledScenarioRows,
  slugify,
  loadActiveRunRow,
  loadFinishedRuns,
  loadRunRow,
  toScenarioRunRecord,
  hydrateScenarioRunSavingStage,
  hydrateScenarioRunReplayArtifacts,
  parseRunState,
  scenarioRunDifficulty,
} from "./storage";
import {
  deriveScenarioRunActivity,
  deriveScenarioRunReplayState,
} from "./activity";

export async function listEnabledScenariosForUser(options?: {
  organizationId?: string | null;
}): Promise<ScenarioCatalogEntry[]> {
  const scenarios = await loadEnabledScenarioRows(
    undefined,
    options?.organizationId ?? null,
  );
  return scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    organizationId: scenario.organizationId,
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
  organizationId?: string | null;
}): Promise<ScenarioDetail | null> {
  const rows = await loadEnabledScenarioRows(
    params.scenarioId,
    params.organizationId ?? null,
  );
  const enabled = rows[0];
  if (!enabled) {
    return null;
  }

  const active = await loadActiveRunRow(params.userId);
  const activeHere =
    active &&
    active.scenarioId === enabled.scenarioId &&
    active.organizationId === (params.organizationId ?? null)
      ? active
      : null;
  const finishedRuns = await loadFinishedRuns(
    params.userId,
    enabled.scenarioId,
    params.organizationId ?? null,
  );
  return {
    scenarioId: enabled.scenarioId,
    organizationId: enabled.organizationId,
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
    courseLocation: await resolveScenarioCourseLocationForUser({
      userId: params.userId,
      scenarioId: enabled.scenarioId,
      organizationId: params.organizationId ?? null,
    }),
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
  const run = await hydrateScenarioRunSavingStage(
    toScenarioRunRecord(row),
    row.runtimeExecutionId,
  );
  // Recording artifacts are produced only after teardown starts. Keep the
  // startup/readiness poll to one run-row query without hiding artifact
  // upload progress from teardown and archive views.
  if (RUN_PHASE_ORDER[run.phase] < RUN_PHASE_ORDER.teardown_requested) {
    return withScenarioRunCourseLocation(run, params.userId);
  }
  return withScenarioRunCourseLocation(
    await hydrateScenarioRunReplayArtifacts(run),
    params.userId,
  );
}

export async function listScenarioRunsForUser(params: {
  userId: string;
}): Promise<ScenarioRunListEntry[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      scenarioId: scenarioRuns.scenarioId,
      organizationId: scenarioRuns.organizationId,
      scenarioName: scenarioRuns.scenarioName,
      title: scenarioRuns.title,
      difficulty: scenarioRuns.difficulty,
      state: scenarioRuns.state,
      stateJson: scenarioRuns.stateJson,
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

  const listedRuns = rows.map((row) => {
    const phase = row.state as RunPhase;
    const replayState = deriveScenarioRunReplayState(
      parseRunState(row.stateJson),
    );
    return {
      runId: row.runId,
      scenarioId: row.scenarioId,
      organizationId: row.organizationId,
      scenarioName: row.scenarioName,
      title: row.title,
      difficulty: scenarioRunDifficulty(row.runId, row.difficulty),
      phase,
      outcome: deriveScenarioRunOutcome({
        phase,
        solvedAt: row.solvedAt,
        deleteRequestedAt: row.deleteRequestedAt,
        failedAt: row.failedAt,
      }),
      active: row.activeKey !== null,
      activity: deriveScenarioRunActivity({
        activeKey: row.activeKey,
        phase,
      }),
      deleteRequestedAt: row.deleteRequestedAt,
      replayState,
      createdAt: row.createdAt,
      finishedAt: row.completedAt ?? row.failedAt ?? null,
      solvedAt: row.solvedAt,
      solveDurationMs: deriveScenarioRunSolveDurationMs({
        createdAt: row.createdAt,
        solvedAt: row.solvedAt,
      }),
      solutionAssisted: row.solutionAssisted,
      hasReplay: replayState === "ready",
    };
  });
  const locations = await resolveScenarioCourseLocationsForUser({
    userId: params.userId,
    targets: listedRuns.map((run) => ({
      scenarioId: run.scenarioId,
      organizationId: run.organizationId,
    })),
  });
  return listedRuns.map((run) => ({
    ...run,
    courseLocation:
      locations.get(courseLocationLookupKey(run.organizationId, run.scenarioId)) ??
      null,
  }));
}

export async function getScenarioProgressByScenario(
  userId: string,
  organizationId: string | null = null,
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
    .where(
      and(
        eq(scenarioRuns.userId, userId),
        organizationId
          ? eq(scenarioRuns.organizationId, organizationId)
          : isNull(scenarioRuns.organizationId),
      ),
    );

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

export function newScenarioProgress(): ScenarioProgress {
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
  organizationId: string | null = null,
): Promise<ScenarioCatalogWireResponse> {
  const [scenarios, progressByScenario] = await Promise.all([
    listEnabledScenariosForUser({ organizationId }),
    getScenarioProgressByScenario(userId, organizationId),
  ]);
  const wireScenarios: ScenarioCatalogWireEntry[] = scenarios.map(
    (scenario) => ({
      ...scenario,
      progress:
        progressByScenario.get(scenario.scenarioId) ?? newScenarioProgress(),
    }),
  );
  const courses = await listVisibleScenarioCourses(drizzle(env.DB), {
    organizationId,
    scenarios: wireScenarios,
  });
  const scenarioById = new Map(
    wireScenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const claimedScenarioIds = new Set<string>();
  const projectedCourses: ScenarioCatalogCourseWireEntry[] = [];

  for (const course of courses) {
    const courseScenarios: ScenarioCatalogWireEntry[] = [];
    for (const scenarioId of course.scenarioIds) {
      const scenario = scenarioById.get(scenarioId);
      if (!scenario || claimedScenarioIds.has(scenarioId)) continue;
      claimedScenarioIds.add(scenarioId);
      courseScenarios.push(scenario);
    }
    if (!courseScenarios.length) continue;
    projectedCourses.push({
      kind: "authored",
      courseId: course.courseId,
      organizationId: course.organizationId,
      title: course.title,
      description: course.description,
      scenarios: courseScenarios,
    });
  }

  const generalPracticeScenarios: ScenarioCatalogWireEntry[] = [];
  for (const scenario of wireScenarios) {
    if (claimedScenarioIds.has(scenario.scenarioId)) continue;
    claimedScenarioIds.add(scenario.scenarioId);
    generalPracticeScenarios.push(scenario);
  }
  if (generalPracticeScenarios.length) {
    projectedCourses.push({
      kind: "general-practice",
      courseId: null,
      organizationId: null,
      title: "General practice",
      description:
        "Standalone systems for focused practice outside a guided curriculum.",
      scenarios: generalPracticeScenarios,
    });
  }

  return { courses: projectedCourses };
}

/**
 * Finds a scenario's canonical learner location without hydrating every
 * enabled scenario. This is used by polled run and briefing views, so it reads
 * only the target scenario and the one or two catalog snapshots that can own
 * it.
 */
export async function resolveScenarioCourseLocationForUser(params: {
  userId: string;
  scenarioId: string;
  organizationId?: string | null;
}): Promise<CourseLocation | null> {
  const organizationId = params.organizationId ?? null;
  if (!(await canReadCourseCatalog(params.userId, organizationId))) {
    return null;
  }
  return resolveVisibleScenarioCourseLocation({
    scenarioId: params.scenarioId,
    organizationId,
  });
}

async function withScenarioRunCourseLocation(
  run: ScenarioRunRecord,
  userId: string,
): Promise<ScenarioRunRecord> {
  return {
    ...run,
    courseLocation: await resolveScenarioCourseLocationForUser({
      userId,
      scenarioId: run.scenarioId,
      organizationId: run.organizationId,
    }),
  };
}

async function resolveVisibleScenarioCourseLocation(input: {
  scenarioId: string;
  organizationId: string | null;
}): Promise<CourseLocation | null> {
  const locations = await resolveVisibleScenarioCourseLocations({
    scenarioIds: [input.scenarioId],
    organizationId: input.organizationId,
  });
  return locations.get(input.scenarioId) ?? null;
}

async function resolveScenarioCourseLocationsForUser(input: {
  userId: string;
  targets: Array<{ scenarioId: string; organizationId: string | null }>;
}): Promise<Map<string, CourseLocation | null>> {
  const scenarioIdsByOrganization = new Map<string | null, Set<string>>();
  for (const target of input.targets) {
    const scenarioIds =
      scenarioIdsByOrganization.get(target.organizationId) ?? new Set<string>();
    scenarioIds.add(target.scenarioId);
    scenarioIdsByOrganization.set(target.organizationId, scenarioIds);
  }

  const groupedLocations = await Promise.all(
    [...scenarioIdsByOrganization.entries()].map(
      async ([organizationId, scenarioIds]) => {
        if (!(await canReadCourseCatalog(input.userId, organizationId))) {
          return [organizationId, new Map<string, CourseLocation | null>()] as const;
        }
        return [
          organizationId,
          await resolveVisibleScenarioCourseLocations({
            scenarioIds: [...scenarioIds],
            organizationId,
          }),
        ] as const;
      },
    ),
  );

  const locations = new Map<string, CourseLocation | null>();
  for (const [organizationId, scenarios] of groupedLocations) {
    for (const [scenarioId, location] of scenarios) {
      locations.set(courseLocationLookupKey(organizationId, scenarioId), location);
    }
  }
  return locations;
}

async function resolveVisibleScenarioCourseLocations(input: {
  scenarioIds: readonly string[];
  organizationId: string | null;
}): Promise<Map<string, CourseLocation | null>> {
  const uniqueScenarioIds = [...new Set(input.scenarioIds)];
  const locations = new Map<string, CourseLocation | null>();
  if (!uniqueScenarioIds.length) return locations;

  const db = drizzle(env.DB);
  const scopeKeys = [
    scenarioCourseCatalogScopeKey(null),
    ...(input.organizationId
      ? [scenarioCourseCatalogScopeKey(input.organizationId)]
      : []),
  ];
  const [scenarioRows, catalogRows] = await Promise.all([
    db
      .select({
        scenarioId: vmScenarios.scenarioId,
        organizationId: vmScenarios.organizationId,
        enabledAt: vmScenarios.enabledAt,
      })
      .from(vmScenarios)
      .where(
        and(
          inArray(vmScenarios.scenarioId, uniqueScenarioIds),
          eq(vmScenarios.enabled, true),
          visibleInCatalogScope(vmScenarios.organizationId, input.organizationId),
        ),
      ),
    db
      .select({
        scopeKey: scenarioCourseCatalogs.scopeKey,
        organizationId: scenarioCourseCatalogs.organizationId,
        courses: scenarioCourseCatalogs.coursesJson,
      })
      .from(scenarioCourseCatalogs)
      .where(inArray(scenarioCourseCatalogs.scopeKey, scopeKeys)),
  ]);
  const rowsByScope = new Map(
    catalogRows.map((row) => [row.scopeKey, row]),
  );
  const publicCourses =
    rowsByScope.get(scenarioCourseCatalogScopeKey(null))?.courses ?? [];
  const organizationCourses = input.organizationId
    ? (rowsByScope.get(scenarioCourseCatalogScopeKey(input.organizationId))
        ?.courses ?? [])
    : [];
  const visibleTargetIds = new Set(
    scenarioRows
      .filter((scenario) => scenario.enabledAt !== null)
      .map((scenario) => scenario.scenarioId),
  );
  const claimedOrganizationScenarioIds = new Set(
    organizationCourses.flatMap((candidate) => candidate.scenarioIds),
  );
  const selectionByScenarioId = new Map<
    string,
    {
      course: (typeof publicCourses)[number];
      organizationCourse: boolean;
    }
  >();
  for (const scenarioId of uniqueScenarioIds) {
    if (!visibleTargetIds.has(scenarioId)) {
      locations.set(scenarioId, null);
      continue;
    }
    const organizationCourse = organizationCourses.find((course) =>
      course.scenarioIds.includes(scenarioId),
    );
    const publicCourse = organizationCourse
      ? undefined
      : publicCourses.find((course) => course.scenarioIds.includes(scenarioId));
    const course = organizationCourse ?? publicCourse;
    if (!course) {
      locations.set(scenarioId, {
        courseKind: "general-practice",
        scope: input.organizationId
          ? "organization-general-practice"
          : "public",
        organizationId: input.organizationId,
        courseId: null,
        courseTitle: "General practice",
        step: null,
        steps: null,
      });
      continue;
    }
    selectionByScenarioId.set(scenarioId, {
      course,
      organizationCourse: Boolean(organizationCourse),
    });
  }

  const neededScenarioIds = new Set<string>();
  for (const { course, organizationCourse } of selectionByScenarioId.values()) {
    for (const scenarioId of course.scenarioIds) {
      if (
        input.organizationId &&
        !organizationCourse &&
        claimedOrganizationScenarioIds.has(scenarioId)
      ) {
        continue;
      }
      neededScenarioIds.add(scenarioId);
    }
  }
  if (!neededScenarioIds.size) return locations;

  const memberRows = await db
    .select({
      scenarioId: vmScenarios.scenarioId,
      enabledAt: vmScenarios.enabledAt,
    })
    .from(vmScenarios)
    .where(
      and(
        inArray(vmScenarios.scenarioId, [...neededScenarioIds]),
        eq(vmScenarios.enabled, true),
        visibleInCatalogScope(vmScenarios.organizationId, input.organizationId),
      ),
    );
  const availableScenarioIds = new Set(
    memberRows
      .filter((row) => row.enabledAt !== null)
      .map((row) => row.scenarioId),
  );
  for (const [scenarioId, selection] of selectionByScenarioId) {
    const visibleCourseScenarioIds = selection.course.scenarioIds.filter(
      (courseScenarioId) =>
        availableScenarioIds.has(courseScenarioId) &&
        !(
          input.organizationId &&
          !selection.organizationCourse &&
          claimedOrganizationScenarioIds.has(courseScenarioId)
        ),
    );
    const position = visibleCourseScenarioIds.indexOf(scenarioId);
    locations.set(
      scenarioId,
      position < 0
        ? null
        : {
            courseKind: "authored",
            scope: input.organizationId
              ? selection.organizationCourse
                ? "organization-private"
                : "organization-public"
              : "public",
            organizationId: input.organizationId,
            courseId: selection.course.courseId,
            courseTitle: selection.course.title,
            step: position + 1,
            steps: visibleCourseScenarioIds.length,
          },
    );
  }
  return locations;
}

function courseLocationLookupKey(
  organizationId: string | null,
  scenarioId: string,
): string {
  return organizationId
    ? `organization:${organizationId}\u0000${scenarioId}`
    : `public\u0000${scenarioId}`;
}

function visibleInCatalogScope(
  column: typeof vmScenarios.organizationId,
  organizationId: string | null,
) {
  return organizationId
    ? or(isNull(column), eq(column, organizationId))
    : isNull(column);
}

async function canReadCourseCatalog(
  userId: string,
  organizationId: string | null,
): Promise<boolean> {
  if (!organizationId) return true;
  const rows = await drizzle(env.DB)
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, userId),
      ),
    )
    .limit(1);
  return rows.length === 1;
}
